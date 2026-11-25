"""backend/mysql_db.php の接続リトライ (MySQL 再起動時の自動復旧) の検証。

MySQL は起動せず、TCP を受けて即座に切るスタブを相手に、
  - 既定 (3回) は接続をやり直す
  - TUNEDROP_MYSQL_CONNECT_RETRIES=1 なら1回で諦める
  - 待ち時間 (TUNEDROP_MYSQL_CONNECT_RETRY_DELAY_MS) が入る
を確認する。API は 1回の瞬断で 500 を返さなくなる。
"""
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PHP = os.environ.get('PHP_BIN', 'php')


class RefusingServer:
    """TCP 接続を受け付けてすぐ閉じる (MySQL のハンドシェイクを返さない)。"""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.accepted = 0
        self._stop = False
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while not self._stop:
            try:
                connection, _ = self.sock.accept()
            except OSError:
                return
            self.accepted += 1
            try:
                connection.close()
            except OSError:
                pass

    def close(self):
        self._stop = True
        try:
            self.sock.close()
        except OSError:
            pass
        self._thread.join(timeout=2)


def attempt(server, env_file, **overrides):
    env = {
        **os.environ,
        'TUNEDROP_ENV_FILE': str(env_file),   # .env の MySQL 設定を読ませない
        'TUNEDROP_MYSQL_HOST': '127.0.0.1',
        'TUNEDROP_MYSQL_PORT': str(server.port),
        'TUNEDROP_MYSQL_DATABASE': 'tunedrop_test',
        'TUNEDROP_MYSQL_USER': 'tester',
        'TUNEDROP_MYSQL_PASSWORD': '',
        **overrides,
    }
    code = (
        'require $argv[1];'
        'try { tunedrop_mysql_db(); echo "connected"; }'
        'catch (Throwable $error) { echo get_class($error); }'
    )
    before = server.accepted
    started = time.monotonic()
    result = subprocess.run(
        [PHP, '-r', code, str(ROOT / 'backend' / 'mysql_db.php')],
        cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=60,
    )
    elapsed = time.monotonic() - started
    return result.stdout.strip(), elapsed, server.accepted - before


def pdo_mysql_available():
    result = subprocess.run([PHP, '-m'], capture_output=True, text=True, timeout=30)
    return 'pdo_mysql' in result.stdout.lower()


if not pdo_mysql_available():
    # 環境に pdo_mysql が無い場合は、この検証だけスキップする (他のテストは動く)。
    print('SKIP: pdo_mysql が無いため MySQL 接続リトライは検証できません。')
    sys.exit(0)

with tempfile.TemporaryDirectory() as directory:
    env_file = Path(directory) / '.env'   # 存在しない (読ませない)
    server = RefusingServer()
    try:
        # 既定: 3回試行し、待ち時間は 150ms + 300ms
        output, elapsed, attempts = attempt(server, env_file)
        assert output.startswith('PDOException'), (output, attempts)
        assert attempts == 3, attempts
        assert elapsed >= 0.3, f'待ち時間が入っていない ({elapsed:.2f}s)'

        # 1回だけにすると即座に諦める (再試行しない)
        output, elapsed, attempts = attempt(server, env_file, TUNEDROP_MYSQL_CONNECT_RETRIES='1')
        assert output.startswith('PDOException'), (output, attempts)
        assert attempts == 1, attempts

        # 待ち時間を 0 にできる (テストや高負荷時に再試行だけ行う)
        output, _, attempts = attempt(
            server, env_file,
            TUNEDROP_MYSQL_CONNECT_RETRIES='2',
            TUNEDROP_MYSQL_CONNECT_RETRY_DELAY_MS='0',
        )
        assert output.startswith('PDOException'), (output, attempts)
        assert attempts == 2, attempts
    finally:
        server.close()

print('PASS: mysql_db.php retries transient MySQL connection failures with backoff.')
