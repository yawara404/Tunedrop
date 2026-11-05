"""メンテナンスモード (503 + メンテナンス画面 / JSON) の検証。

backend/maintenance.sh が作る maintenance.flag (または TUNEDROP_MAINTENANCE_FLAG) を
router.php / api.php が検出し、画面は maintenance.html、API は JSON の 503 を返すこと。
管理画面 (/admin) は解除作業のため止めないこと。フラグを消せば通常運転に戻ること。
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PHP = os.environ.get('PHP_BIN', 'php')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_port(process, port):
    for _ in range(60):
        if process.poll() is not None:
            raise RuntimeError(process.stderr.read().decode())
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.1):
                return
        except OSError:
            time.sleep(.05)
    raise RuntimeError('server did not start')


def request(url):
    try:
        with urllib.request.urlopen(url) as response:
            return response.status, response.headers, response.read().decode('utf-8')
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read().decode('utf-8')


with tempfile.TemporaryDirectory() as directory:
    flag = Path(directory) / 'maintenance.flag'
    flag.write_text('データ移行のため停止中です <b>30分</b>', encoding='utf-8')
    port = free_port()
    env = {
        **os.environ,
        'TUNEDROP_MAINTENANCE_FLAG': str(flag),
        'TUNEDROP_DB': str(Path(directory) / 'db.sqlite'),
    }
    process = subprocess.Popen(
        [PHP, '-S', f'127.0.0.1:{port}', '-t', str(ROOT), str(ROOT / 'backend' / 'router.php')],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    try:
        wait_port(process, port)
        base = f'http://127.0.0.1:{port}'

        # 画面は 503 + メンテナンスページ。フラグのメッセージはHTMLとして解釈させない。
        status, headers, body = request(base + '/')
        assert status == 503, (status, body[:200])
        assert headers.get('Retry-After') == '300', headers
        assert 'メンテナンス中' in body, body[:300]
        assert 'データ移行のため停止中です' in body, body[:300]
        assert '&lt;b&gt;30分&lt;/b&gt;' in body and '<b>30分</b>' not in body, body[:300]

        # API は 503 + JSON (maintenance: true)。health も状態を返す。
        status, _, body = request(base + '/api.php?action=health')
        assert status == 503, (status, body[:200])
        data = json.loads(body)
        assert data['status'] == 'maintenance' and data['maintenance'] is True, data
        assert data['features'] == ['auth_proxy', 'auth_guest'], data

        status, _, body = request(base + '/api.php?action=get_playlists')
        assert status == 503, (status, body[:200])
        data = json.loads(body)
        assert data['maintenance'] is True and data['retry_after'] == 300, data

        # メンテナンスページ自体は配信する
        status, _, body = request(base + '/maintenance.html')
        assert status == 200, (status, body[:200])
        assert 'MAINTENANCE' in body, body[:200]

        # 管理画面は解除作業のため止めない (503 以外)
        status, _, _ = request(base + '/admin/admin.php')
        assert status != 503, status

        # フラグを消せば通常運転に戻る
        flag.unlink()
        status, _, body = request(base + '/')
        assert status == 200, (status, body[:200])
        status, _, body = request(base + '/api.php?action=health')
        assert status == 200, (status, body[:200])
        assert json.loads(body)['status'] == 'ok', body
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()

    # api.php を直接実行した場合も同じ判定になる (CLI)
    flag.write_text('', encoding='utf-8')
    code = '$_SERVER["REQUEST_METHOD"]="GET"; $_GET=["action"=>"health"]; require $argv[1];'
    out = subprocess.check_output(
        [PHP, '-r', code, str(ROOT / 'backend' / 'api.php')],
        env={**os.environ, 'TUNEDROP_MAINTENANCE_FLAG': str(flag)}, text=True,
    )
    assert json.loads(out)['status'] == 'maintenance', out

print('PASS: メンテナンス中は 503 + 画面/JSON、管理画面は継続、解除で通常運転に戻る。')
