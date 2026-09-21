"""Isolated security regressions: no production database or secret is touched."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PHP = os.environ.get('PHP_BIN', 'php')
with tempfile.TemporaryDirectory() as directory:
    secret_file = Path(directory) / 'secret'
    os.environ['TUNEDROP_ENV_FILE'] = str(Path(directory) / 'absent.env')
    os.environ.pop('SECRET_KEY', None)
    os.environ['TUNEDROP_SECRET_FILE'] = str(secret_file)
    os.environ['TUNEDROP_DB'] = str(Path(directory) / 'test.sqlite')
    import runtime_config
    secret = runtime_config.load_secret()
    assert len(secret) == 64 and runtime_config.load_secret() == secret
    assert secret_file.stat().st_mode & 0o777 == 0o600
    with patch.dict(os.environ, {'SECRET_KEY': 'tunedrop-secret-jwt-key-2026-secure'}):
        try:
            runtime_config.load_secret()
            raise AssertionError('legacy secret accepted')
        except RuntimeError:
            pass
    import app
    import jwt
    app.init_db_if_needed()
    # Load only the PHP verifier to avoid touching application state.
    code = (ROOT / 'api.php').read_text()
    start = code.index('function jwt_b64url_decode')
    end = code.index('/**\n * Authorization', start)
    verifier = Path(directory) / 'verify.php'
    verifier.write_text('<?php\n' + code[start:end] + '\necho json_encode(jwt_user_id_from_token($argv[1]));')
    def verify(token, **env):
        return json.loads(subprocess.check_output([PHP, str(verifier), token], env={**os.environ, **env}, text=True))
    assert verify(app.generate_token(7, 'test')) == 7
    assert verify(jwt.encode({'user_id': 7, 'exp': time.time()+60}, 'tunedrop-secret-jwt-key-2026-secure', algorithm='HS256')) is None
    assert verify(jwt.encode({'user_id': 7}, secret, algorithm='HS256')) is None
    assert verify(jwt.encode({'user_id': 7, 'exp': time.time()-1}, secret, algorithm='HS256')) is None
    assert verify(app.generate_token(7, 'test'), TUNEDROP_SECRET_FILE=str(Path(directory)/'missing')) is None
    # Isolate Google's external verifier; test our integration and failure handling.
    verifier_mock = types.ModuleType('google.oauth2.id_token')
    request_module = types.ModuleType('google.auth.transport.requests')
    request_module.Request = lambda: object()
    oauth = types.ModuleType('google.oauth2')
    oauth.id_token = verifier_mock
    modules = {'google': types.ModuleType('google'), 'google.oauth2': oauth,
               'google.oauth2.id_token': verifier_mock, 'google.auth': types.ModuleType('google.auth'),
               'google.auth.transport': types.ModuleType('google.auth.transport'),
               'google.auth.transport.requests': request_module}
    client = app.app.test_client()
    app.GOOGLE_CLIENT_ID = ''
    assert client.post('/auth/google', json={'credential': 'forged'}).status_code == 503
    app.GOOGLE_CLIENT_ID = 'test-client'
    with patch.dict(sys.modules, modules):
        for failure in [ValueError('bad signature/audience/issuer/expiry'), OSError('network unavailable')]:
            with patch.object(verifier_mock, 'verify_oauth2_token', create=True, side_effect=failure):
                assert client.post('/auth/google', json={'credential': 'forged'}).status_code == 401
        with patch.object(verifier_mock, 'verify_oauth2_token', create=True, return_value={'sub': 'verified-google-user'}) as mocked:
            response = client.post('/auth/google', json={'credential': 'valid'})
            assert response.status_code == 200, response.json
            assert mocked.call_args.args[2] == 'test-client'
    with app.get_db() as db:
        assert db.execute('SELECT count(*) FROM users').fetchone()[0] == 1
print('PASS: random shared key, PHP/Python JWT compatibility, legacy/expired/missing-key rejection, Google failure closed and verified login.')
