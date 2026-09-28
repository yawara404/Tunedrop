"""Login uses the registered login ID (users.username), not the display name.

表示名 (display_name) はプロフィールで自由に変えられるが、ログインIDは登録時の
username (メールアドレスなど) のまま。画面に表示されるのは表示名なので、
「表示名でログインできなくなった」と詰まらないよう API は両方を返し、
失敗メッセージでもログインIDであることを案内する。
"""
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

with tempfile.TemporaryDirectory() as directory:
    os.environ['TUNEDROP_DB'] = str(Path(directory) / 'login-id.sqlite')
    os.environ['SECRET_KEY'] = 'login-id-test-secret-at-least-32-bytes'
    os.environ['TUNEDROP_ENV_FILE'] = str(Path(directory) / 'none')
    import app

    app.init_db_if_needed()
    client = app.app.test_client()

    login_id = 'user@example.com'
    password = 'test-password'
    registered = client.post('/auth/register', json={'username': login_id, 'password': password}).json
    assert registered['success'], registered
    assert registered['user']['login_id'] == login_id, registered
    token = registered['token']

    # 表示名を変更する (ログイン後にプロフィールで変更できる想定の値)
    renamed = client.post('/auth/profile', json={'username': 'demo-user'}, headers={'Authorization': f'Bearer {token}'}).json
    assert renamed['success'], renamed
    assert renamed['user']['username'] == 'demo-user', renamed

    # 表示名ではログインできない (ログインIDは username のまま)
    denied = client.post('/auth/login', json={'username': 'demo-user', 'password': password})
    assert denied.status_code == 401, denied.json
    assert 'ログインID' in denied.json['error'], denied.json
    assert '表示名とは別' in denied.json['error'], denied.json

    # ログインIDならログインでき、応答にログインIDと表示名の両方が入る
    signed_in = client.post('/auth/login', json={'username': login_id, 'password': password})
    assert signed_in.status_code == 200, signed_in.json
    body = signed_in.json
    assert body['user']['login_id'] == login_id, body
    assert body['user']['username'] == 'demo-user', body

    # プロフィール取得でも両方を返す (画面にログインIDを出せるように)
    me = client.get('/auth/me', headers={'Authorization': f"Bearer {body['token']}"}).json['user']
    assert me['login_id'] == login_id, me
    assert me['username'] == 'demo-user', me

print('PASS: ログインは登録時のログインIDのみ受け付け、応答とプロフィールでログインID/表示名の両方を返す。')
