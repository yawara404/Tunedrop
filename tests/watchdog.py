"""backend/watchdog.sh のヘルスチェックと復旧判断の検証。

実際のサーバーは起動せず、HTTPスタブを相手に次を確認する:
  - 正常時は check が終了コード0、異常時は1
  - メンテナンス中 (503 + status=maintenance) は異常扱いしない
  - deep=1 の database=error を検知する
  - DRY_RUN では実際に start.sh / tunnel.sh を起動しない (ログに計画だけ残す)
  - 公開URLだけ落ちているときはトンネル再起動の判断になる

本番の start.py / tunnel.sh を誤って起動しないよう、必ず
TUNEDROP_WATCHDOG_DRY_RUN=1 と一時 STATE_DIR を使う。
"""
import json
import os
import re
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WATCHDOG = ROOT / 'backend' / 'watchdog.sh'


class StubHandler(BaseHTTPRequestHandler):
    """server.response = (status, dict) をそのまま返すだけのスタブ。"""

    def do_GET(self):
        status, payload = self.server.response
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def start_stub(status=200, payload=None):
    server = ThreadingHTTPServer(('127.0.0.1', 0), StubHandler)
    server.response = (status, payload if payload is not None else {'status': 'ok'})
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def stop_stub(server):
    server.shutdown()
    server.server_close()


def run_watchdog(args, local_port, auth_port, state_dir, public_port=None):
    env = {
        **os.environ,
        'TUNEDROP_WATCHDOG_LOCAL_URL': f'http://127.0.0.1:{local_port}/api.php?action=health&deep=1',
        'TUNEDROP_WATCHDOG_AUTH_URL': f'http://127.0.0.1:{auth_port}/health',
        'TUNEDROP_WATCHDOG_STATE_DIR': str(state_dir),
        'TUNEDROP_WATCHDOG_DRY_RUN': '1',
        'TUNEDROP_WATCHDOG_COOLDOWN': '0',
        # ネットワーク疎通確認もスタブへ向ける (外部通信に依存しない)
        'TUNEDROP_WATCHDOG_ONLINE_URL': f'http://127.0.0.1:{local_port}/health',
    }
    if public_port is None:
        env['TUNEDROP_WATCHDOG_SKIP_PUBLIC'] = '1'
    else:
        env['TUNEDROP_WATCHDOG_PUBLIC_URL'] = f'http://127.0.0.1:{public_port}/api.php'
    return subprocess.run(
        ['/bin/bash', str(WATCHDOG), *args],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=90,
    )


def has_ok(output, name):
    return re.search(rf'^{name}\s*:\s*OK', output, re.MULTILINE) is not None


def has_ng(output, name):
    return re.search(rf'^{name}\s*:\s*NG', output, re.MULTILINE) is not None


healthy = (200, {'status': 'ok', 'service': 'TuneDrop PHP API', 'database': 'ok'})
auth_ok = (200, {'status': 'ok', 'service': 'Tune drop Auth Server'})

local, local_port = start_stub(*healthy)
auth, auth_port = start_stub(*auth_ok)
public, public_port = start_stub(200, {'status': 'ok', 'database': 'ok'})
try:
    with tempfile.TemporaryDirectory() as directory:
        state = Path(directory)

        # 1) 全部正常
        local.response = healthy
        auth.response = auth_ok
        result = run_watchdog(['check'], local_port, auth_port, state)
        assert result.returncode == 0, result.stderr + result.stdout
        assert has_ok(result.stdout, 'local'), result.stdout
        assert has_ok(result.stdout, 'auth'), result.stdout
        assert 'DB ok' in result.stdout, result.stdout

        # 2) ローカルWebが500
        local.response = (500, {'status': 'error'})
        result = run_watchdog(['check'], local_port, auth_port, state)
        assert result.returncode != 0, result.stdout
        assert has_ng(result.stdout, 'local'), result.stdout

        # 3) メンテナンス中は正常扱い (再起動しない)
        local.response = (503, {'status': 'maintenance', 'service': 'TuneDrop PHP API'})
        result = run_watchdog(['check'], local_port, auth_port, state)
        assert result.returncode == 0, result.stderr + result.stdout
        assert has_ok(result.stdout, 'local'), result.stdout
        assert 'メンテナンス中' in result.stdout, result.stdout

        # 4) DBだけ落ちている (deep=1 の database=error)
        local.response = (200, {'status': 'ok', 'service': 'TuneDrop PHP API', 'database': 'error'})
        result = run_watchdog(['check'], local_port, auth_port, state)
        assert result.returncode != 0, result.stdout
        assert has_ng(result.stdout, 'local'), result.stdout
        assert 'DBに接続できません' in result.stdout, result.stdout

        # 5) 認証サーバーだけ落ちている
        local.response = healthy
        auth.response = (500, {'status': 'error'})
        result = run_watchdog(['check'], local_port, auth_port, state)
        assert result.returncode != 0, result.stdout
        assert has_ng(result.stdout, 'auth'), result.stdout

        # 6) ローカルが落ちている → once はスタック再起動を計画するが、DRY_RUN では実行しない
        auth.response = auth_ok
        local.response = (500, {'status': 'error'})
        result = run_watchdog(['once'], local_port, auth_port, state)
        assert result.returncode != 0, result.stdout
        log = (state / 'watchdog.log').read_text(encoding='utf-8')
        assert 'stack: Web/認証サーバーを再起動します' in log, log
        assert 'stack: DRY_RUN' in log, log
        assert not (state / 'stack.pid').exists(), 'DRY_RUN で stack を起動してはいけない'

        # 7) ローカルは正常で公開URLだけ落ちている → トンネル再起動を計画する
        local.response = healthy
        public.response = (502, {'status': 'error'})
        result = run_watchdog(['once'], local_port, auth_port, state, public_port)
        assert result.returncode != 0, result.stdout
        log = (state / 'watchdog.log').read_text(encoding='utf-8')
        assert 'tunnel: 公開トンネルを再起動します' in log, log
        assert 'tunnel: DRY_RUN' in log, log

        # 8) 公開URLが正常なら once は復旧動作をしない
        public.response = (200, {'status': 'ok', 'database': 'ok'})
        log_path = state / 'watchdog.log'
        before = log_path.read_text(encoding='utf-8') if log_path.exists() else ''
        result = run_watchdog(['once'], local_port, auth_port, state, public_port)
        assert result.returncode == 0, result.stderr + result.stdout
        assert not (state / 'stack.pid').exists(), '正常時に stack を起動してはいけない'
        appended = log_path.read_text(encoding='utf-8')[len(before):]
        assert 'tunnel: 公開トンネルを再起動します' not in appended, '正常時に再起動してはいけない'
finally:
    stop_stub(local)
    stop_stub(auth)
    stop_stub(public)

print('PASS: backend/watchdog.sh detects outages, ignores maintenance mode, checks DB, and only plans recovery in DRY_RUN.')
