"""api.php must not relay a non-JSON (HTML) auth-server body as application/json.

古い app.py が動いていると /auth/guest などの新エンドポイントが無く、Flask は
HTML の 404 を返す。api.php は先頭で Content-Type: application/json を送っているため、
そのまま中継するとフロントの response.json() が
`Unexpected token '<', "<!doctype "... is not valid JSON` で落ちて何も表示できなくなる。
JSON 以外の本文は、対処法の分かる JSON エラーへ置き換えること (正常なJSONはそのまま中継)。
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

ROOT = Path(__file__).resolve().parents[1]
HTML_404 = ('<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n'
            '<h1>Not Found</h1>\n<p>The requested URL was not found on the server.</p>\n')


class StaleAuthServer(BaseHTTPRequestHandler):
    """古い app.py の代役: /health だけ答え、未実装のエンドポイントは HTML の 404 を返す。"""

    def do_GET(self):
        if self.path.startswith('/health'):
            self.respond(200, json.dumps({'service': 'Tune drop Auth Server', 'status': 'ok'}), 'application/json')
        else:
            self.respond(404, HTML_404, 'text/html; charset=utf-8')

    def do_POST(self):
        # login は新しい実装と同じ JSON (正常系の中継が壊れていないことの確認用)。
        # それ以外のエンドポイントは「古い app.py に無い」= HTML の 404 を返す。
        if self.path.startswith('/auth/login'):
            self.respond(200, json.dumps({'success': True, 'token': 'stub-token'}), 'application/json')
        else:
            self.respond(404, HTML_404, 'text/html; charset=utf-8')

    def respond(self, status, body, content_type):
        payload = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


with tempfile.TemporaryDirectory() as directory:
    work = Path(directory)
    # api.php は __DIR__ の .auth_port を最優先で見るため、複製した api.php と同じ
    # フォルダにスタブサーバーのポートを書いて、実サーバーに依存しないようにする。
    (work / 'api.php').write_bytes((ROOT / 'api.php').read_bytes())
    port = free_port()
    server = HTTPServer(('127.0.0.1', port), StaleAuthServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (work / '.auth_port').write_text(str(port))

    database = work / 'database.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())

    def call_auth(endpoint):
        code = ('$_SERVER["REQUEST_METHOD"]="POST"; $_GET=["action"=>"auth","endpoint"=>$argv[1]];'
                ' require $argv[2];')
        output = subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', code, endpoint, str(work / 'api.php')],
            env={**os.environ, 'TUNEDROP_DB': str(database)}, text=True,
        )
        return output

    # 正常系: JSON はそのまま中継する
    passthrough = json.loads(call_auth('login'))
    assert passthrough == {'success': True, 'token': 'stub-token'}, passthrough

    # 異常系: 古いサーバーが返す HTML は JSON エラーへ置き換える
    # (フロントが response.json() で「is not valid JSON」に落ちないようにする)
    raw = call_auth('register')
    assert not raw.lstrip().startswith('<'), f'HTMLをそのまま返している: {raw[:80]}'
    error = json.loads(raw)
    assert error['success'] is False, error
    assert '再起動' in error['error'], error
    assert 'app.py' in error['error'], error

    server.shutdown()

print('PASS: api.php は HTML 応答を JSON エラーに置き換え、正常な JSON はそのまま中継する。')
