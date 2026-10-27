#!/usr/bin/env python3
"""Tune drop クロスプラットフォーム・ランチャー (Windows / macOS / Linux)。

`start.sh` と同じ処理を Python で実装し、Windows (ネイティブ) でもそのまま使える:
  1. 画面 (frontend/) が新しければ frontend/ で npm run build (node_modules があるときだけ)
  2. 認証・解析サーバー (backend/app.py) を起動 (未起動なら)
  3. PHP ビルトインサーバー (backend/router.php、docroot はプロジェクト直下) を起動して画面と API を配信

構成 (公開URLは変えない):
  https://<host>/tunedrop/         → frontend/dist/index.html
  https://<host>/tunedrop/assets/* → frontend/dist/assets/*
  https://<host>/tunedrop/api.php  → backend/api.php (実行)
  https://<host>/tunedrop/ogp.php  → backend/ogp.php (実行)

使い方:
  python backend/start.py          起動 (macOS/Linux は ./backend/start.sh でも同じ)
  python backend/start.py --setup  初回セットアップ (.venv 作成 + pip install + npm install + .env 作成)
  python backend/start.py --help   このヘルプ

環境変数:
  PYTHON_BIN            使用する Python (未指定は .venv → 実行中の Python)
  PHP_BIN               PHP の実行ファイル (未指定は .php/ → PATH から php)
  TUNEDROP_PORT         Webサーバーの第一候補ポート (既定 8888)
  TUNEDROP_PHP_WORKERS  PHPビルトインサーバーのワーカー数 (POSIX のみ有効。既定 16)
  TUNEDROP_ALLOW_VULNERABLE_PHP  1 で未修正 PHP でも起動する (ローカル検証専用)
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

# このスクリプトは backend/ にあり、配信の docroot はプロジェクト直下 (その親)。
#   ROOT        … プロジェクト直下。docroot であり、.env / .venv / .php / admin/ /
#                 tests/ / robots.txt / sitemap.xml の置き場でもある
#   BACKEND_DIR … サーバー側 (このスクリプト、app.py、api.php、router.php、SQL)
#   FRONTEND_DIR/DIST_DIR … 画面のソースとビルド成果物 (dist/ が配信される)
BACKEND_DIR = Path(__file__).resolve().parent
ROOT = BACKEND_DIR.parent
FRONTEND_DIR = ROOT / 'frontend'
DIST_DIR = FRONTEND_DIR / 'dist'
IS_WINDOWS = os.name == 'nt'
# 画面のビルド元 (start.sh と同じ監視対象)
FRONTEND_SOURCES = (
    'frontend/index.html', 'frontend/main.js', 'frontend/app.js',
    'frontend/config.js', 'frontend/style.css',
)

# 2026-10-21 の PHP セキュリティアドバイザリで修正されたバージョン。
#   CVE-2026-109618: OOM 処理中に内部リクエストデータが未初期化のままになり、
#                    後始末で不正なデータを有効として扱う (未認証 RCE)
#   CVE-2026-109619: 解放済みメモリ上の古いグローバル状態を同じワーカーの
#                    後続リクエストが使う (未認証 RCE)
# PHP-FPM / mod_php / php-cgi / FrankenPHP / LiteSpeed と、このプロジェクトが使う
# ビルトインサーバー (CLI) が対象。公開経路では修正版以外で起動しない。
PHP_SECURITY_FIXES = {(8, 5): 12, (8, 4): 27, (8, 3): 36, (8, 2): 35}
PHP_SECURITY_MINIMUM = (8, 2, 35)
PHP_SECURITY_FIXED_LABEL = 'PHP 8.5.12 / 8.4.27 / 8.3.36 / 8.2.35'
PHP_SECURITY_ADVISORY = 'https://www.php.net/archive/2026.php#2026-10-21'

# 修正版へ上げるまでの緩和策。CLI の memory_limit は既定で無制限 (-1) のため、
# OOM でホストごと落ちないよう有限にする。display_errors は内部パスや設定を
# 応答へ出さない (api.php / admin/admin.php も同じ設定をしている)。
#
# OPcache は CLI SAPI では既定で無効 (opcache.enable_cli=Off) のため、ビルトイン
# サーバーは api.php (約1400行) と router.php を毎リクエスト読み直してコンパイル
# していた。共有メモリへ載せて使い回し、ホットな関数は JIT でネイティブ化する。
# validate_timestamps=1 / revalidate_freq=2 はソース編集が2秒以内に反映される
# ようにするため (運用では ./start.sh の再起動で即時反映)。opcache を持たない
# PHP では未知の -d は無視されるだけで、起動は妨げない。
PHP_HARDENING_FLAGS = (
    '-d', 'memory_limit=256M',
    '-d', 'display_errors=0',
    '-d', 'log_errors=1',
    '-d', 'expose_php=0',
    '-d', 'opcache.enable_cli=1',
    '-d', 'opcache.memory_consumption=128',
    '-d', 'opcache.max_accelerated_files=20000',
    '-d', 'opcache.validate_timestamps=1',
    '-d', 'opcache.revalidate_freq=2',
    '-d', 'opcache.jit=tracing',
    '-d', 'opcache.jit_buffer_size=64M',
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
    """PHP の実行ファイルを探す (PHP_BIN → プロジェクト内 .php → PATH → よくあるインストール先)。

    プロジェクト直下の `.php/bin/php` は、修正版を公式ソースからビルドして隔離した
    ランタイム (gitignore 対象)。システムの PHP より優先する。
    winget / ZIP / XAMPP などで入れた直後は PATH がまだ効いていないことが多いため、
    代表的な場所も見に行く。
    """
    override = (os.environ.get('PHP_BIN') or '').strip()
    if override:
        return override
    project_php = ROOT / '.php' / 'bin' / ('php.exe' if IS_WINDOWS else 'php')
    try:
        if project_php.is_file():
            return str(project_php)
    except OSError:
        pass
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


def parse_php_version(text: str | None) -> tuple[int, int, int] | None:
    """'PHP 8.5.11 (cli)' のような文字列から (8, 5, 11) を取り出す。"""
    if not text:
        return None
    match = re.search(r'(\d+)\.(\d+)\.(\d+)', text)
    if not match:
        return None
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def php_security_issue(version: tuple[int, int, int] | None) -> str | None:
    """2026-10-21 の 2 件の RCE 修正を含まない PHP なら、その理由を返す。

    8.2〜8.5 は系統ごとの修正版と比較する (例: 8.5.12 未満の 8.5 系は未修正)。
    8.1 以前は PHP プロジェクトのサポートが終了しており、修正版が無いため拒否する。
    8.6 以降の次期版は修正が取り込まれている前提で許可する (開発版は非推奨)。
    """
    if version is None:
        return 'PHP のバージョンを取得できませんでした'
    major, minor, patch = version
    fixed = PHP_SECURITY_FIXES.get((major, minor))
    if fixed is not None:
        if patch < fixed:
            return f'PHP {major}.{minor}.{patch} は修正版 {major}.{minor}.{fixed} 未満です'
        return None
    if version < PHP_SECURITY_MINIMUM:
        return f'PHP {major}.{minor}.{patch} はサポート終了 (8.1 以前) で修正版がありません'
    return None


def detect_php_version(php: str) -> str | None:
    """PHP のバージョン文字列を取得する (実行できない場合は None)。"""
    try:
        result = subprocess.run(
            [php, '-r', 'echo PHP_VERSION;'], cwd=str(ROOT),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.decode('utf-8', 'replace').strip()


def check_php_security(php: str) -> bool:
    """未修正の PHP では起動を止める (公開時の未認証 RCE を防ぐ)。

    ローカルでどうしても動かす場合だけ TUNEDROP_ALLOW_VULNERABLE_PHP=1 を使う。
    """
    version = detect_php_version(php)
    issue = php_security_issue(parse_php_version(version))
    if issue is None:
        return True
    print(f'!! 危険: {issue}', file=sys.stderr)
    print(f'   2026-10-21 発表の 2 件の RCE (CVE-2026-109618 / CVE-2026-109619) は '
          f'{PHP_SECURITY_FIXED_LABEL} で修正されています。', file=sys.stderr)
    print(f'   詳細: {PHP_SECURITY_ADVISORY}', file=sys.stderr)
    print('   更新例: macOS(Homebrew) `brew update && brew upgrade php` / '
          'Windows `winget upgrade PHP.PHP` / Debian系 `sudo apt update && sudo apt upgrade php`',
          file=sys.stderr)
    print('   配布パッケージへの反映には時間がかかります。未修正の間は Cloudflare Tunnel を止めて公開しないでください。',
          file=sys.stderr)
    if (os.environ.get('TUNEDROP_ALLOW_VULNERABLE_PHP') or '').strip() == '1':
        print('   TUNEDROP_ALLOW_VULNERABLE_PHP=1 が指定されているため続行します (ローカル検証専用)。',
              file=sys.stderr)
        return True
    print('   ローカルで動作確認するだけなら TUNEDROP_ALLOW_VULNERABLE_PHP=1 python start.py で起動できます。',
          file=sys.stderr)
    return False


def resolve_npm() -> str | None:
    return shutil.which('npm') or shutil.which('npm.cmd')


def run_command(cmd, env=None, check=True, cwd=None):
    """npm は Windows では npm.cmd のため、cmd 経由 (shell=True) で実行する。

    表示時はプロキシURLの資格情報 (`user:pass@`) をマスクする。
    cwd を省略するとプロジェクト直下で実行する (npm は frontend/ で実行する)。
    """
    display = re.sub(r'://[^@/\s]*@', '://***@', ' '.join(str(part) for part in cmd))
    print('+ ' + display, flush=True)
    target = str(cwd or ROOT)
    if IS_WINDOWS:
        line = subprocess.list2cmdline([str(part) for part in cmd])
        return subprocess.run(line, cwd=target, env=env, shell=True, check=check)
    return subprocess.run([str(part) for part in cmd], cwd=target, env=env, check=check)


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
        sys.path.insert(0, str(BACKEND_DIR))
        from runtime_config import load_environment  # noqa: WPS433 (実行時 import)
        load_environment()
        env = os.environ.copy()
    except Exception:
        pass
    return env


def needs_frontend_build() -> bool:
    index = DIST_DIR / 'index.html'
    if not index.exists() or not (DIST_DIR / 'assets').is_dir():
        return True
    index_mtime = index.stat().st_mtime
    return any(
        (ROOT / rel).exists() and (ROOT / rel).stat().st_mtime > index_mtime
        for rel in FRONTEND_SOURCES
    )


def build_frontend_if_needed() -> bool:
    """戻り値: 起動してよければ True。"""
    if (FRONTEND_DIR / 'node_modules').is_dir():
        if not needs_frontend_build():
            return True
        npm = resolve_npm()
        if not npm:
            print('npm が見つからないため画面をビルドできません (frontend/ で npm install を実行してください)。', file=sys.stderr)
            return False
        print('画面をビルドしています (frontend/ で npm run build)...', flush=True)
        try:
            run_command([npm, 'run', 'build'], cwd=FRONTEND_DIR)
        except subprocess.CalledProcessError:
            return False
        return True
    # node_modules が無い場合は同梱のビルド成果物 (frontend/dist/) を使う。
    if not (DIST_DIR / 'index.html').exists():
        print('画面 (frontend/dist/index.html) がありません。frontend/ で npm install && npm run build を実行してください。', file=sys.stderr)
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
        run_command([python, '-m', 'pip', 'install', '-r', str(BACKEND_DIR / 'requirements.txt'), *args])
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
    if npm and (FRONTEND_DIR / 'package.json').exists():
        print('-- フロントエンド依存関係をインストール (frontend/ で npm install) --', flush=True)
        run_command([npm, 'install'], cwd=FRONTEND_DIR)
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
    # 2026-10-21 の未認証 RCE 2 件 (CVE-2026-109618 / CVE-2026-109619) の修正版か確認する。
    if not check_php_security(php):
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
    #
    # API は重い処理を Flask (app.py) へ同期プロキシする間もワーカーを1つ占有する。
    # 既定を8にしていたときは、解析や /radar/map が重なると閲覧リクエストが
    # 空きワーカー待ちになったため、16 へ増やす (TUNEDROP_PHP_WORKERS で変更可)。
    env['PHP_CLI_SERVER_WORKERS'] = env.get('TUNEDROP_PHP_WORKERS') or '16'
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
            auth_proc = popen_server([python, str(BACKEND_DIR / 'app.py')], env)
        try:
            (ROOT / '.web_port').write_text(f'{web_port}\n', encoding='utf-8')
        except OSError as exc:
            print(f'Notice: .web_port を書き込めませんでした: {exc}', file=sys.stderr)

        print(f'TuneDrop: http://localhost:{web_port} (Ctrl+C で停止)', flush=True)
        if (ROOT / 'admin' / 'admin.php').exists():
            print('管理者ページ: admin/admin.php (ローカル専用。admin.sh から開けます)', flush=True)
        print('開発時: 別ターミナルで npm run dev (Vite: http://localhost:5173/)', flush=True)

        php_proc = popen_server(
            [php, *PHP_HARDENING_FLAGS, '-S', f'127.0.0.1:{web_port}',
             '-t', str(ROOT), str(BACKEND_DIR / 'router.php')],
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
