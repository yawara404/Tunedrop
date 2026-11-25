#!/usr/bin/env python3
"""backend/supervisor.py: 子プロセス (PHP / 認証サーバー) の常駐監視と自動復旧。

`start.py` から使う。`watchdog.sh` は「スタックの外」から 30 秒ごとに全体を見張るが、
こちらは `start.py` が生きている間ずっと子プロセスを直接見張るため、PHP や app.py が
落ちたときに数秒で復旧できる (再起動のたびにポートを探し直す必要もない)。

復旧の方針:
  - 子プロセスが終了したら再起動する
  - health probe (HTTP) が連続して失敗したら、ハングとみなしてプロセスグループごと
    終了してから再起動する
  - 再起動間隔は指数バックオフ (1 → 2 → 4 → 8 … 最大 max_delay 秒)。
    十分長く動いていたらバックオフを戻す (単発のクラッシュで間隔が伸び続けない)
  - 連続で max_restarts 回失敗したら諦めて 1 を返す
    (呼び出し元の `start.py` が終了し、`watchdog.sh` がスタックごと起動し直す)

このモジュールは外部ライブラリに依存しない (テストは tests/supervisor.py)。
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Callable

IS_WINDOWS = os.name == 'nt'


def log_line(message: str) -> None:
    """復旧の経過を 1 行で残す (start.py の標準出力 → watchdog の stack.log)。"""
    print(f'[supervisor] {message}', flush=True)


def popen_server(cmd, env, cwd=None) -> subprocess.Popen:
    """サーバープロセスを子プロセスグループ (session) で起動する。

    PHPビルトインサーバーは `PHP_CLI_SERVER_WORKERS` でワーカーを fork する。
    メインプロセスだけを terminate するとワーカーが残るため、独立グループで起動し、
    停止時はグループごと終了する (POSIX: killpg / Windows: taskkill /T)。
    """
    kwargs = {'cwd': str(cwd) if cwd is not None else None, 'env': env}
    if IS_WINDOWS:
        kwargs['creationflags'] = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    else:
        kwargs['start_new_session'] = True
    return subprocess.Popen(cmd, **kwargs)


def terminate_tree(proc, timeout: float = 5.0) -> None:
    """プロセスとその子 (PHP ワーカー等) をまとめて終了する。"""
    if not proc or proc.poll() is not None:
        return
    if IS_WINDOWS:
        subprocess.run(
            ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            proc.wait(timeout=timeout)
        except Exception:
            pass
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=timeout)
    except Exception:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def _process_group_id(proc) -> int | None:
    """起動直後のプロセスのグループID (POSIX のみ)。"""
    if IS_WINDOWS or proc is None:
        return None
    try:
        return os.getpgid(proc.pid)
    except OSError:
        return None


@dataclass
class Service:
    """監視する 1 プロセス。probe が None なら終了だけを見張る。"""

    name: str
    command: list
    env: dict | None = None
    cwd: str | None = None
    # 正常なら True を返す関数 (例外は異常扱い)。HTTP health を想定。
    probe: Callable[[], bool] | None = None
    # probe の実行間隔と、起動直後に probe を待つ時間 (起動途中の失敗を数えない)。
    probe_interval: float = 20.0
    startup_grace: float = 15.0
    # 連続でこの回数 probe に失敗したらハングとみなして再起動する。
    max_probe_failures: int = 3
    process: subprocess.Popen | None = None
    pgid: int | None = None   # 起動時のプロセスグループ (PHP ワーカーも一緒に止める)
    restarts: int = 0
    probe_failures: int = 0
    started_at: float = 0.0
    next_probe: float = 0.0
    next_start: float = 0.0
    restart_reason: str = ''
    stopped: bool = False
    history: list = field(default_factory=list)   # テスト・ログ用 (直近の再起動理由)


class Supervisor:
    """複数の Service をまとめて監視する。

    interval ごとに tick() を呼ぶだけで、実際の待機は run() が行う。
    テストは tick() を直接呼べる (実時間を待たない)。
    """

    def __init__(self, services, *, interval: float = 2.0, base_delay: float = 1.0,
                 max_delay: float = 30.0, max_restarts: int = 6,
                 stable_after: float = 120.0, log: Callable[[str], None] | None = None):
        self.services = list(services)
        self.interval = max(0.05, float(interval))
        self.base_delay = max(0.0, float(base_delay))
        self.max_delay = max(self.base_delay, float(max_delay))
        self.max_restarts = max(1, int(max_restarts))
        self.stable_after = max(0.0, float(stable_after))
        self._log = log or log_line
        self._running = False

    # ----------------------------------------------------------
    # 起動 / 停止
    # ----------------------------------------------------------
    def start(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        for service in self.services:
            self._spawn(service, now)
        self._running = True

    def _spawn(self, service: Service, now: float) -> None:
        service.process = popen_server(service.command, service.env, service.cwd)
        service.pgid = _process_group_id(service.process)
        service.started_at = now
        service.probe_failures = 0
        service.next_probe = now + service.startup_grace
        service.next_start = 0.0
        service.stopped = False
        self._log(f'{service.name}: 起動しました (PID {service.process.pid})')

    def _stop_group(self, service: Service) -> None:
        """プロセスと取り残された子 (PHP ワーカー) をグループごと止める。

        PHP ビルトインサーバーはメインプロセスが落ちてもワーカーが残り、
        ポートを掴んだままになる。残すと再起動が "Address already in use" で
        失敗し続けるため、終了済みでもグループへ SIGTERM を送る。
        """
        proc = service.process
        service.process = None
        terminate_tree(proc)
        if IS_WINDOWS or not service.pgid:
            service.pgid = None
            return
        try:
            os.killpg(service.pgid, signal.SIGTERM)
        except OSError:
            service.pgid = None
            return
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                os.killpg(service.pgid, 0)
            except OSError:
                service.pgid = None
                return
            time.sleep(0.05)
        try:
            os.killpg(service.pgid, signal.SIGKILL)
        except OSError:
            pass
        service.pgid = None

    def stop(self) -> None:
        for service in self.services:
            service.stopped = True
            self._stop_group(service)
        self._running = False

    # ----------------------------------------------------------
    # 監視
    # ----------------------------------------------------------
    def tick(self, now: float | None = None) -> int:
        """1回分の点検。継続できるなら 0、諦めるなら 1。"""
        now = time.monotonic() if now is None else now
        healthy = True
        for service in self.services:
            if service.stopped:
                continue
            if service.next_start > now:
                continue   # バックオフ待ち
            proc = service.process
            if proc is None:
                # 再起動待ちの時間が来たので起動する (バックオフ明け)。
                if not self._try_spawn(service, now):
                    healthy = False
                continue
            if proc.poll() is not None:
                # メインプロセスが落ちても PHP ワーカーが残ることがあるため、
                # グループごと止めてから再起動する (ポートを空ける)。
                self._stop_group(service)
                if not self._restart(service, now, f'終了しました (exit={proc.returncode})'):
                    healthy = False
                continue
            if service.probe is not None and now >= service.next_probe:
                service.next_probe = now + service.probe_interval
                if self._probe(service):
                    if service.probe_failures:
                        self._log(f'{service.name}: health が回復しました')
                    service.probe_failures = 0
                    if now - service.started_at >= self.stable_after:
                        # 安定して動いているので、次の障害は初回の間隔からやり直す。
                        service.restarts = 0
                else:
                    service.probe_failures += 1
                    self._log(
                        f'{service.name}: health NG '
                        f'({service.probe_failures}/{service.max_probe_failures})'
                    )
                    if service.probe_failures >= service.max_probe_failures:
                        self._log(f'{service.name}: 応答がないため再起動します')
                        self._stop_group(service)
                        if not self._restart(service, now, 'health check が失敗し続けました'):
                            healthy = False
        return 0 if healthy else 1

    def _probe(self, service: Service) -> bool:
        try:
            return bool(service.probe())
        except Exception:
            return False

    def _try_spawn(self, service: Service, now: float) -> bool:
        try:
            self._spawn(service, now)
            return True
        except OSError as error:
            self._log(f'{service.name}: 起動できません ({error})')
            return self._restart(service, now, '起動に失敗しました')

    def _restart(self, service: Service, now: float, reason: str) -> bool:
        service.process = None
        service.restarts += 1
        service.restart_reason = reason
        service.history.append(reason)
        if len(service.history) > 20:
            del service.history[:-20]
        if service.restarts > self.max_restarts:
            self._log(
                f'{service.name}: {reason}。再起動が {service.restarts} 回続いたため'
                '自動復旧を諦めます (watchdog.sh がスタックごと再起動します)'
            )
            service.stopped = True
            return False
        delay = min(self.base_delay * (2 ** (service.restarts - 1)), self.max_delay)
        service.next_start = now + delay
        self._log(f'{service.name}: {reason} → {delay:g}秒後に再起動します')
        return True

    def run(self, stop_event=None) -> int:
        """start() して stop_event がセットされるまで監視を続ける。

        戻り値 0: 正常終了 (stop_event) / 1: 自動復旧を諦めた (呼び出し元が終了する)。
        """
        self.start()
        while True:
            if stop_event is not None and stop_event.is_set():
                return 0
            if self.tick() != 0:
                return 1
            self._wait(stop_event)

    def _wait(self, stop_event) -> None:
        if stop_event is not None:
            stop_event.wait(self.interval)
        else:
            time.sleep(self.interval)


def supervisor_settings_from_env(environ=None) -> dict:
    """環境変数から Supervisor の設定を読む (運用で調整できるようにする)。"""
    env = os.environ if environ is None else environ

    def number(name: str, default: float) -> float:
        raw = (env.get(name) or '').strip()
        try:
            return float(raw)
        except ValueError:
            return default

    return {
        'interval': number('TUNEDROP_SUPERVISOR_INTERVAL', 2.0),
        'base_delay': number('TUNEDROP_SUPERVISOR_RETRY_BASE', 1.0),
        'max_delay': number('TUNEDROP_SUPERVISOR_RETRY_MAX', 30.0),
        'max_restarts': int(number('TUNEDROP_SUPERVISOR_MAX_RESTARTS', 6)),
        'stable_after': number('TUNEDROP_SUPERVISOR_STABLE_AFTER', 120.0),
    }


__all__ = [
    'IS_WINDOWS', 'Service', 'Supervisor', 'log_line', 'popen_server',
    'supervisor_settings_from_env', 'terminate_tree',
]

if __name__ == '__main__':   # pragma: no cover - 手動確認用
    import pathlib
    print(f'supervisor.py: {pathlib.Path(__file__).resolve().parent} (start.py から使います)',
          file=sys.stderr)
