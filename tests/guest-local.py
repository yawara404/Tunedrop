"""Guest state survives a Flask restart and is isolated through the PHP API."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

with tempfile.TemporaryDirectory() as directory:
    os.environ['TUNEDROP_DB'] = str(Path(directory) / 'guest.sqlite')
    os.environ['SECRET_KEY'] = 'guest-local-test-secret-at-least-32-bytes'
    os.environ['TUNEDROP_ENV_FILE'] = str(Path(directory) / 'none')
    import app

    app.init_db_if_needed()
    client = app.app.test_client()
    first = client.post('/auth/guest', json={}).json
    second = client.post('/auth/guest', json={}).json
    assert first['user']['id'] != second['user']['id']
    assert client.post('/auth/guest', json={'credential': first['credential']}).json['user']['id'] == first['user']['id']
    assert client.post('/auth/guest', json={'credential': second['credential']}).json['user']['id'] == second['user']['id']
    wrong_credential = first['credential'][:-1] + ('0' if first['credential'][-1] != '0' else '1')
    assert client.post('/auth/guest', json={'credential': wrong_credential}).status_code == 401
    with app.get_db() as db:
        guest_name = db.execute('SELECT username FROM users WHERE id=?', (first['user']['id'],)).fetchone()[0]
    assert client.post('/auth/login', json={'username': guest_name, 'password': first['credential']}).status_code == 401

    api = Path(directory) / 'api.php'
    api.write_text((ROOT / 'api.php').read_text().replace("file_get_contents('php://input')", "getenv('TEST_BODY')"))

    def request(action, token=None, body=None):
        code = ('$_SERVER["REQUEST_METHOD"]=$argv[1]; $_GET=["action"=>$argv[2]]; '
                'if ($argv[4] !== "-") $_SERVER["HTTP_AUTHORIZATION"]="Bearer ".$argv[4]; require $argv[3];')
        return json.loads(subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', code,
             'POST' if body is not None else 'GET', action, str(api), token or '-'],
            env={**os.environ, 'TEST_BODY': json.dumps(body)}, text=True))

    assert request('get_playlists')['error'] == 'ゲストセッションを初期化してください。'
    created = request('create_playlist', first['token'], {'name': 'Only first browser'})
    assert created['success'], created
    assert any(p['name'] == 'Only first browser' for p in request('get_playlists', first['token']))
    assert not any(p['name'] == 'Only first browser' for p in request('get_playlists', second['token']))
    restored = client.post('/auth/guest', json={'credential': first['credential']}).json
    assert any(p['name'] == 'Only first browser' for p in request('get_playlists', restored['token']))

print('PASS: Flask guest creation, restoration, rejected credential, PHP authorization and browser isolation.')
