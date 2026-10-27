"""api.php は全曲再解析の対象を「呼び出し元のライブラリ」に固定する。

Flask (app.py) の /radar/analyze_all は user_id 未指定だと _db_bookmarks() の全件
(= 全ユーザーのブックマーク) を対象にする。api.php が user_id を素通ししていたため、
未ログインでも「全ユーザーぶんの音源DLと再解析」を起動できてしまっていた
(負荷攻撃・他人データの書き換え)。

修正後は、認証済みの呼び出し元 user_id を必ず付けて転送し、
クエリで指定された他人の user_id は無視する。未認証は 401 で転送しない。

実行: PHP_BIN="$(command -v php)" .venv/bin/python tests/radar-analyze-scope.py
"""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from php_auth_fixture import bearer, SECRET

ROOT = Path(__file__).resolve().parents[1]

received = []


class StubAuthServer(BaseHTTPRequestHandler):
    """/health に応答し、/radar/analyze_all への転送クエリを記録する Flask の代役。"""

    def do_GET(self):
        received.append(self.path)
        if self.path.startswith('/health'):
            body = {'service': 'Tune drop Auth Server', 'status': 'ok'}
        elif self.path.startswith('/radar/analyze_all'):
            body = {'success': True, 'queued': []}
        else:
            body = {'success': True}
        payload = json.dumps(body).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def call(work, database, query, token=None):
    """api.php を CLI で実行し、標準出力 (JSON) を返す。

    正常系は実行後に {"code":..., "body":...} を出力する。未認証時は
    require_user_or_guest() が exit するため、出力は 401 の JSON 本文そのものになる。
    """
    script = ('$_SERVER["REQUEST_METHOD"]="GET"; $_SERVER["HTTP_AUTHORIZATION"]=$argv[4];'
              '$_GET=json_decode($argv[2], true);'
              'ob_start(); require $argv[3]; $out = ob_get_clean();'
              'echo json_encode(["code" => http_response_code(), "body" => json_decode($out, true)]);')
    completed = subprocess.run(
        [os.environ.get('PHP_BIN', 'php'), '-r', script, 'GET', json.dumps(query),
         str(work / 'api.php'), token or ''],
        env={**os.environ, 'TUNEDROP_DB': str(database), 'SECRET_KEY': SECRET},
        text=True, capture_output=True, check=True,
    )
    return json.loads(completed.stdout)


with tempfile.TemporaryDirectory() as directory:
    work = Path(directory)
    # api.php は __DIR__ の .auth_port を最優先で見るため、複製と同じ場所に
    # スタブサーバーのポートを書いて、実サーバーに依存しないようにする。
    (work / 'api.php').write_bytes((ROOT / 'backend' / 'api.php').read_bytes())
    port = free_port()
    server = HTTPServer(('127.0.0.1', port), StubAuthServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (work / '.auth_port').write_text(str(port))

    database = work / 'database.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'backend' / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'me','test-only')")

    # [1] 他人の user_id を指定しても、転送されるのは呼び出し元の user_id
    received.clear()
    result = call(work, database, {'action': 'radar_analyze_all', 'user_id': '1', 'force': '1'},
                  bearer(99))
    assert result['body']['success'] is True, result
    forwarded = [path for path in received if path.startswith('/radar/analyze_all')]
    assert forwarded, ('Flask へ転送されていない', received)
    assert 'user_id=99' in forwarded[0], ('呼び出し元の user_id が付いていない', forwarded[0])
    assert 'user_id=1&' not in forwarded[0] and not forwarded[0].endswith('user_id=1'), forwarded[0]

    # [2] 未認証は 401 で、Flask へは転送しない
    #     (require_user_or_guest() が exit するため、出力は 401 の JSON 本文そのもの)
    received.clear()
    result = call(work, database, {'action': 'radar_analyze_all', 'force': '1'})
    assert 'error' in result, ('未認証が拒否されていない', result)
    assert 'ゲスト' in result['error'], result
    assert not [path for path in received if path.startswith('/radar/analyze_all')], received

    server.shutdown()

print('PASS: 全曲再解析は呼び出し元のライブラリに固定され、他人の user_id と未認証は拒否される。')
