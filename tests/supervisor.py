"""backend/supervisor.py (PHP / 認証サーバーの自動復旧) の検証。

実際の PHP / Flask は起動せず、短命・長命のダミープロセスで次を確認する:
  - 落ちた子プロセスは指数バックオフで再起動される
  - health probe が連続で失敗したら (ハング)、プロセスを止めて再起動する
  - 正常な子プロセスは再起動しない
  - 再起動が続いたら諦めて 1 を返す (watchdog に任せる)
  - stop() で子プロセスが残らない
"""
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from supervisor import Service, Supervisor  # noqa: E402

PY = sys.executable

# 1回起動するたびにファイルへ1文字追記して終了する (クラッシュを模す)
CRASH = (
    'import pathlib, sys\n'
    'p = pathlib.Path(sys.argv[1])\n'
    'with p.open("a") as f:\n'
    '    f.write("x")\n'
    'sys.exit(3)\n'
)
# 終了しないプロセス (ハング・正常を模す)
SLEEP = 'import time\ntime.sleep(60)\n'


def wait_until(predicate, timeout=8.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def pump(supervisor, predicate, timeout=8.0):
    """監視ループの代わりに tick() を回し、条件が満たされるまで待つ。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        supervisor.tick()
        if predicate():
            return True
        time.sleep(0.01)
    return False


def quiet(_message):
    pass


def cases():
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)

        # 1) 落ちたプロセスは再起動される (バックオフ待ちの間は起動しない)
        marker = work / 'crashes'
        crash = Service(name='crash', command=[PY, '-c', CRASH, str(marker)])
        supervisor = Supervisor([crash], interval=0.01, base_delay=0.02, max_delay=0.05,
                                max_restarts=20, log=quiet)
        supervisor.start()
        try:
            assert wait_until(marker.exists), '起動時に1回実行される'
            assert pump(supervisor, lambda: len(marker.read_text()) >= 3), marker.read_text()
            assert crash.restarts >= 2, crash.restarts
            assert '終了しました' in crash.restart_reason, crash.restart_reason
        finally:
            supervisor.stop()

        # 2) health probe が失敗し続けたらハングとみなして再起動する
        hung = Service(name='hung', command=[PY, '-c', SLEEP], startup_grace=0.0,
                       probe_interval=0.01, max_probe_failures=3,
                       probe=lambda: False)
        supervisor = Supervisor([hung], interval=0.01, base_delay=0.02, max_delay=0.05,
                                max_restarts=20, log=quiet)
        supervisor.start()
        first_pid = hung.process.pid
        try:
            assert pump(supervisor, lambda: hung.restarts >= 1 and hung.process is not None)
            assert hung.process.pid != first_pid, '再起動で新しいプロセスになる'
            assert 'health check' in hung.restart_reason, hung.restart_reason
            # 再起動のトリガーになった古いプロセスは終了している
            assert wait_until(lambda: not _alive(first_pid)), '古いプロセスが残っている'
        finally:
            supervisor.stop()

        # 3) 正常なプロセスは触らない
        healthy = Service(name='healthy', command=[PY, '-c', SLEEP], startup_grace=0.0,
                          probe_interval=0.01, max_probe_failures=1,
                          probe=lambda: True)
        supervisor = Supervisor([healthy], interval=0.01, base_delay=0.02, max_delay=0.05,
                                max_restarts=5, log=quiet)
        supervisor.start()
        try:
            pid = healthy.process.pid
            deadline = time.monotonic() + 0.3
            while time.monotonic() < deadline:
                assert supervisor.tick() == 0
                time.sleep(0.01)
            assert healthy.restarts == 0, healthy.restarts
            assert healthy.process.pid == pid
            assert _alive(pid)
        finally:
            supervisor.stop()
        assert wait_until(lambda: not _alive(pid)), 'stop() で子プロセスを止める'

        # 4) 再起動が続いたら諦める (watchdog.sh にスタックごと任せる)
        give_up = Service(name='broken', command=[PY, '-c', CRASH, str(work / 'broken')])
        supervisor = Supervisor([give_up], interval=0.01, base_delay=0.01, max_delay=0.02,
                                max_restarts=1, log=quiet)
        supervisor.start()
        try:
            gave_up = False
            deadline = time.monotonic() + 8.0
            while time.monotonic() < deadline:
                if supervisor.tick() != 0:
                    gave_up = True
                    break
                time.sleep(0.01)
            assert gave_up, '諦めたら 1 を返す'
        finally:
            supervisor.stop()


def _alive(pid):
    """PID が動いているか (ゾンビは終了扱い)。"""
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open(f'/proc/{pid}/stat', encoding='utf-8') as handle:
            return handle.read().split()[2] != 'Z'
    except OSError:
        return True   # /proc が無い macOS では kill(0) の結果を信じる


cases()
print('PASS: supervisor restarts crashed/hung services, leaves healthy ones alone, '
      'and gives up after repeated failures.')
