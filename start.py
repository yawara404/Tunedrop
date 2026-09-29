#!/usr/bin/env python3
"""Tune drop クロスプラットフォーム・ランチャー (Windows / macOS / Linux)。

`start.sh` と同じ処理を Python で実装し、Windows (ネイティブ) でもそのまま使える:
  1. 画面 (frontend/) が新しければ npm run build (node_modules があるときだけ)
  2. 認証・解析サーバー (app.py) を起動 (未起動なら)
  3. PHP ビルトインサーバー (router.php) を起動して画面と API を配信

使い方:
  python start.py          起動 (macOS/Linux は ./start.sh でも同じ)
  python start.py --setup  初回セットアップ (.venv 作成 + pip install + npm install + .env 作成)
  python start.py --help   このヘルプ

環境変数:
  PYTHON_BIN            使用する Python (未指定は .venv → 実行中の Python)
  PHP_BIN               PHP の実行ファイル (未指定は PATH から php)
  TUNEDROP_PORT         Webサーバーの第一候補ポート (既定 8888)
  TUNEDROP_PHP_WORKERS  PHPビルトインサーバーのワーカー数 (POSIX のみ有効。既定 8)
  TUNEDROP_PIP_PROXY    --setup の pip に渡すプロキシ (http://user:pass@host:port)
  TUNEDROP_PIP_INDEX_URL / TUNEDROP_PIP_EXTRA_ARGS   pip の index-url / 追加引数
  (プロジェクト直下に wheelhouse/ があれば --setup は --no-index でオフライン導入する)
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IS_WINDOWS = os.name == 'nt'
# 画面のビルド元 (start.sh と同じ監視対象)
FRONTEND_SOURCES = (
    'frontend/index.html', 'frontend/main.js', 'frontend/app.js',
    'frontend/config.js', 'frontend/style.css',
)


def reconfigure_streams() -> None:
    """Windows のコンソール (cp932 等) でも落ちないよう、エンコード不可文字を置換する。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except Exception:
            pass


def venv_python() -> Path | None:
    for rel in ('Scripts/python.exe', 'bin/python'):
        candidate = ROOT / '.venv' / rel
        if candidate.exists():
            return candidate
    return None


def resolve_python() -> str:
    override = (os.environ.get('PYTHON_BIN') or '').strip()
    if override:
        return override
    venv = venv_python()
    if venv:
        return str(venv)
    return sys.executable


def resolve_php() -> str | None:
    """PHP の実行ファイルを探す (PHP_BIN → PATH → よくあるインストール先)。

    winget / ZIP / XAMPP などで入れた直後は PATH がまだ効いていないことが多いため、
    代表的な場所も見に行く。
    """
    override = (os.environ.get('PHP_BIN') or '').strip()
    if override:
        return override
    found = shutil.which('php') or shutil.which('php.exe')
    if found:
        return found
    # PATH に無い場合のよくある場所 (Windows)
    candidates = [Path('C:\\php') / 'php.exe', Path('C:\\php8') / 'php.exe',
                  Path('C:\\php7') / 'php.exe', Path('C:\\tools\\php') / 'php.exe',
                  Path('C:\\xampp\\php') / 'php.exe',
                  Path('C:\\Program Files\\PHP') / 'php.exe',
                  Path('C:\\Program Files (x86)\\PHP') / 'php.exe',
                  Path('C:\\ProgramData\\chocolatey\\bin') / 'php.exe']
    local = os.environ.get('LOCALAPPDATA')
    if local:
        candidates.append(Path(local) / 'Microsoft' / 'WinGet' / 'Links' / 'php.exe')
        candidates.append(Path(local) / 'Programs' / 'php' / 'php.exe')
    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    # winget のパッケージフォルダを浅く探索
    if local:
        packages = Path(local) / 'Microsoft' / 'WinGet' / 'Packages'
        if packages.is_dir():
            try:
                for pattern in ('PHP.PHP*/**/php.exe', '*/php.exe'):
                    for match in packages.glob(pattern):
                        if match.is_file():
                            return str(match)
            except OSError:
                pass
    return None


def resolve_npm() -> str | None:
    return shutil.which('npm') or shutil.which('npm.cmd')


def run_command(cmd, env=None, check=True):
    """npm は Windows では npm.cmd のため、cmd 経由 (shell=True) で実行する。

    表示時はプロキシURLの資格情報 (`user:pass@`) をマスクする。
    """
    display = re.sub(r'://[^@/\s]*@', '://***@', ' '.join(str(part) for part in cmd))
    print('+ ' + display, flush=True)
    if IS_WINDOWS:
        line = subprocess.list2cmdline([str(part) for part in cmd])
        return subprocess.run(line, cwd=str(ROOT), env=env, shell=True, check=check)
    return subprocess.run([str(part) for part in cmd], cwd=str(ROOT), env=env, check=check)


def pip_works(python: str) -> bool:
    return subprocess.run(
        [python, '-m', 'pip', '--version'],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0


def ensure_pip(python: str) -> bool:
    """pip が無ければ同梱の ensurepip で導入する (オフラインでも動く)。

    それでも入らない場合は、プロジェクト直下に置いた get-pip.py を使ってみる。
    """
    if pip_works(python):
        return True
    print('pip が見つかりません。同梱の ensurepip で導入を試みます...', flush=True)
    subprocess.run(
        [python, '-m', 'ensurepip', '--upgrade', '--default-pip'],
        cwd=str(ROOT), check=False,
    )
    if pip_works(python):
        return True
    get_pip = ROOT / 'get-pip.py'
    if get_pip.exists():
        print('ensurepip が使えないため get-pip.py を実行します...', flush=True)
        subprocess.run([python, str(get_pip)], cwd=str(ROOT), check=False)
    return pip_works(python)


def pip_args() -> list:
    """プロキシ / 社内ミラー / オフライン (wheelhouse) を環境変数とフォルダで切り替える。

    - TUNEDROP_PIP_INDEX_URL   社内 PyPI などの index-url
    - TUNEDROP_PIP_PROXY       プロキシ (例 http://user:pass@proxy:8080)
    - TUNEDROP_PIP_EXTRA_ARGS  追加引数 (例 "--trusted-host pypi.org")
    - wheelhouse/ フォルダに wheel があれば --no-index --find-links でオフライン導入
    """
    args = []
    index = (os.environ.get('TUNEDROP_PIP_INDEX_URL') or '').strip()
    if index:
        args += ['--index-url', index]
    proxy = (os.environ.get('TUNEDROP_PIP_PROXY') or '').strip()
    if proxy:
        args += ['--proxy', proxy]
    wheelhouse = ROOT / 'wheelhouse'
    if wheelhouse.is_dir() and any(wheelhouse.iterdir()):
        args += ['--no-index', '--find-links', str(wheelhouse)]
    extra = (os.environ.get('TUNEDROP_PIP_EXTRA_ARGS') or '').strip()
    if extra:
        args += shlex.split(extra)
    return args


def popen_server(cmd, env) -> subprocess.Popen:
    """サーバープロセスを子プロセスグループ (session) で起動する。

    PHPビルトインサーバーは `PHP_CLI_SERVER_WORKERS` でワーカーを fork する。
    メインプロセスだけを terminate するとワーカーが残るため、独立グループで起動し、
    停止時はグループごと終了する (POSIX: killpg / Windows: taskkill /T)。
    """
    kwargs = {'cwd': str(ROOT), 'env': env}
    if IS_WINDOWS:
        kwargs['creationflags'] = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    else:
        kwargs['start_new_session'] = True
    return subprocess.Popen(cmd, **kwargs)


def terminate_tree(proc) -> None:
    """プロセスとその子 (PHP ワーカー等) をまとめて終了する。"""
    if not proc or proc.poll() is not None:
        return
    if IS_WINDOWS:
        subprocess.run(
            ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def python_deps_ok(python: str) -> bool:
    result = subprocess.run(
        [python, '-c', 'import flask, flask_cors, jwt, dotenv'],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def ensure_env_file() -> None:
    env_path = ROOT / '.env'
    example = ROOT / '.env.example'
    if not env_path.exists() and example.exists():
        shutil.copyfile(example, env_path)
        print('== .env を作成しました (.env.example からコピー)。APIキー等は必要なら記入してください ==')


def load_project_env() -> dict:
    """`.env` の内容を環境変数へ取り込む (PHP へ渡すため)。dotenv が無くても起動できる。"""
    env = os.environ.copy()
    try:
        sys.path.insert(0, str(ROOT))
        from runtime_config import load_environment  # noqa: WPS433 (実行時 import)
        load_environment()
        env = os.environ.copy()
    except Exception:
        pass
    return env


def needs_frontend_build() -> bool:
    index = ROOT / 'index.html'
    if not index.exists() or not (ROOT / 'assets').is_dir():
        return True
    index_mtime = index.stat().st_mtime
    return any(
        (ROOT / rel).exists() and (ROOT / rel).stat().st_mtime > index_mtime
        for rel in FRONTEND_SOURCES
    )


def build_frontend_if_needed() -> bool:
    """戻り値: 起動してよければ True。"""
    if (ROOT / 'node_modules').is_dir():
        if not needs_frontend_build():
            return True
        npm = resolve_npm()
        if not npm:
            print('npm が見つからないため画面をビルドできません (npm install を実行してください)。', file=sys.stderr)
            return False
        print('画面をビルドしています (npm run build)...', flush=True)
        try:
            run_command([npm, 'run', 'build'])
        except subprocess.CalledProcessError:
            return False
        return True
    # node_modules が無い場合は同梱のビルド成果物 (index.html + assets/) を使う。
    if not (ROOT / 'index.html').exists():
        print('画面 (index.html) がありません。npm install && npm run build を実行してください。', file=sys.stderr)
        return False
    return True


def auth_server_running() -> bool:
    """`.auth_port` のポートに /health を投げて、認証サーバーが動いているか確認する。"""
    port_file = ROOT / '.auth_port'
    if not port_file.exists():
        return False
    digits = ''.join(ch for ch in port_file.read_text(encoding='utf-8', errors='ignore') if ch.isdigit())
    if not digits:
        return False
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{digits}/health', timeout=2) as response:
            payload = json.load(response)
    except Exception:
        return False
    return payload.get('service') == 'Tune drop Auth Server'


def pick_web_port() -> int | None:
    """安全に bind できるポートを探す (8888 を第一候補に、使用中なら順に切り替え)。"""
    candidates = []
    preferred = (os.environ.get('TUNEDROP_PORT') or '').strip()
    if preferred.isdigit():
        candidates.append(int(preferred))
    candidates += [8888, 8000, 8001, 8002, 8003, 8010, 8080]
    tried = set()
    for port in candidates:
        if port in tried:
            continue
        tried.add(port)
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind(('127.0.0.1', port))
        except OSError:
            continue
        return port
    return None


def setup() -> int:
    """初回セットアップ: venv 作成 → pip 導入(必要なら) → pip install → .env 作成 → npm install。"""
    print('== 初回セットアップ ==', flush=True)

    # 1) venv (既にあれば再利用)
    python = str(venv_python()) if venv_python() else sys.executable
    if not venv_python():
        print('-- .venv を作成 --', flush=True)
        result = subprocess.run([sys.executable, '-m', 'venv', str(ROOT / '.venv')], cwd=str(ROOT))
        if result.returncode != 0 or not venv_python():
            print('!! .venv を作成できませんでした。', file=sys.stderr)
            print('   Python 本体に venv が含まれていない可能性があります。', file=sys.stderr)
            print('   https://www.python.org/downloads/ の公式版を入れ直してください (Add python.exe to PATH を有効化)。', file=sys.stderr)
            return 1
        python = str(venv_python())

    # 2) pip (無ければ ensurepip で復旧。オフラインでも ensurepip は動作する)
    if not ensure_pip(python):
        print('!! pip を導入できませんでした。', file=sys.stderr)
        print('   対処:', file=sys.stderr)
        print('   - https://www.python.org/downloads/ の公式版を入れ直す (Microsoft Store 版は避ける)', file=sys.stderr)
        print('   - 設定 → アプリ → アプリ実行エイリアス で python.exe / python3.exe を OFF にする', file=sys.stderr)
        print(f'   - オフラインなら get-pip.py をプロジェクト直下に置き "{python}" get-pip.py を実行', file=sys.stderr)
        return 1

    # 3) Python 依存関係 (プロキシ / オフライン wheelhouse に対応)
    args = pip_args()
    print('-- Python 依存関係をインストール --', flush=True)
    try:
        run_command([python, '-m', 'pip', 'install', '--upgrade', 'pip', *args])
        run_command([python, '-m', 'pip', 'install', '-r', str(ROOT / 'requirements.txt'), *args])
    except subprocess.CalledProcessError:
        print('!! pip install に失敗しました。', file=sys.stderr)
        print('   ネットワーク / SSL / プロキシが原因のことが多いです。次のいずれかを試してください:', file=sys.stderr)
        print('     set TUNEDROP_PIP_PROXY=http://user:pass@proxy:8080     (cmd)', file=sys.stderr)
        print('     set TUNEDROP_PIP_EXTRA_ARGS=--trusted-host pypi.org --trusted-host files.pythonhosted.org', file=sys.stderr)
        print('     オフライン: 別PCで `pip download -r requirements.txt -d wheelhouse` して wheelhouse/ をコピー', file=sys.stderr)
        return 1

    # 4) .env と npm
    ensure_env_file()
    npm = resolve_npm()
    if npm and (ROOT / 'package.json').exists():
        print('-- フロントエンド依存関係をインストール (npm install) --', flush=True)
        run_command([npm, 'install'])
    else:
        print('npm が見つからないため npm install をスキップします (同梱のビルド成果物を使用)。')

    print('セットアップ完了。`python start.py` で起動してください。')
    print('音源解析を使う場合は librosa / yt-dlp / ffmpeg も別途インストールしてください。')
    return 0


def serve(argv) -> int:
    if argv and argv[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    if argv and argv[0] in ('--setup', 'setup'):
        return setup()

    mode = argv[0] if argv else 'standalone'
    if mode not in ('standalone', 'start', 'serve'):
        print('Usage: python start.py   (Web配信 + 認証・解析サーバーを起動)', file=sys.stderr)
        print('       python start.py --setup   (初回セットアップ)', file=sys.stderr)
        return 1

    os.chdir(str(ROOT))
    python = resolve_python()
    if not python_deps_ok(python):
        print('Python依存関係が必要です。先に `python start.py --setup` を実行してください。', file=sys.stderr)
        return 1
    php = resolve_php()
    if not php:
        print('PHPが見つかりません。PHPをインストールして新しいターミナルで再実行するか、'
              'PHP_BIN=C:\\php\\php.exe のように指定してください。', file=sys.stderr)
        return 1
    if not build_frontend_if_needed():
        return 1
    ensure_env_file()

    start_auth = not auth_server_running()
    if not start_auth:
        print('認証・解析サーバーは既に起動しています。既存プロセスを使い、Webサーバーだけを起動します。', file=sys.stderr)

    web_port = pick_web_port()
    if web_port is None:
        print('空きポートが見つかりませんでした。TUNEDROP_PORT=8001 のように指定してください。', file=sys.stderr)
        return 1
    if web_port != 8888:
        print(f'注意: ポート8888は使用中のため、Webサーバーはポート{web_port}で起動します。', file=sys.stderr)

    env = load_project_env()
    # PHPビルトインサーバーは既定で1リクエストずつ処理するため、ワーカーを増やす。
    # (PHP 7.4+ の POSIX 機能。Windows では無視される)
    env['PHP_CLI_SERVER_WORKERS'] = env.get('TUNEDROP_PHP_WORKERS') or '8'
    # 子プロセス (app.py) の絵文字出力が Windows の cp932 コンソールで落ちないようにする。
    env['PYTHONIOENCODING'] = 'utf-8'

    # SIGTERM (kill / タスク終了) でも finally を通して子プロセスを片付ける。
    def _request_stop(signum, frame):
        raise KeyboardInterrupt

    for _sig in (getattr(signal, 'SIGTERM', None),):
        if _sig is not None:
            try:
                signal.signal(_sig, _request_stop)
            except Exception:
                pass

    auth_proc = None
    php_proc = None
    try:
        if start_auth:
            auth_proc = popen_server([python, str(ROOT / 'app.py')], env)
        try:
            (ROOT / '.web_port').write_text(f'{web_port}\n', encoding='utf-8')
        except OSError as exc:
            print(f'Notice: .web_port を書き込めませんでした: {exc}', file=sys.stderr)

        print(f'TuneDrop: http://localhost:{web_port} (Ctrl+C で停止)', flush=True)
        if (ROOT / 'admin' / 'admin.php').exists():
            print('管理者ページ: admin/admin.php (ローカル専用。admin.sh から開けます)', flush=True)
        print('開発時: 別ターミナルで npm run dev (Vite: http://localhost:5173/)', flush=True)

        php_proc = popen_server(
            [php, '-S', f'127.0.0.1:{web_port}', '-t', str(ROOT), str(ROOT / 'router.php')],
            env,
        )
        php_proc.wait()
        return php_proc.returncode or 0
    except KeyboardInterrupt:
        print('\n停止します...', flush=True)
        return 0
    finally:
        terminate_tree(php_proc)
        terminate_tree(auth_proc)


def main() -> int:
    reconfigure_streams()
    return serve(sys.argv[1:])


if __name__ == '__main__':
    raise SystemExit(main())
