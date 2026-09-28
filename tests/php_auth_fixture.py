"""Small JWT fixture for PHP API CLI tests."""
import base64
import hashlib
import hmac
import json
import time

SECRET = 'php-api-test-secret-at-least-thirty-two-bytes'


def bearer(user_id=99):
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=').decode()
    signed = encode({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encode({'user_id': user_id, 'exp': int(time.time()) + 3600})
    signature = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), signed.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
    return 'Bearer ' + signed + '.' + signature
