#!/usr/bin/env zsh
# ./start.sh: PHP + Python / ./start.sh --mamp: Pythonのみ（Web配信はMAMP）
# zsh用 (./start.sh / zsh start.sh。bashでも動作可)
set -e
# glob不一致を空展開にする (zsh: nullglob / bash: nullglob)
if [[ -n "${ZSH_VERSION:-}" ]]; then
    setopt nullglob
else
    shopt -s nullglob 2>/dev/null || true
fi
if [[ -n "${ZSH_VERSION:-}" ]]; then
    DIR="${0:A:h}"
else
    DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
fi
cd "$DIR"
MODE="${1:-standalone}"
case "$MODE" in
    # `./start.sh start` のように start/serve を付けて呼ばれる場合も受け付ける
    # (他のプロジェクトの起動スクリプトに合わせた呼び方で「Usage」で止まる事故を防ぐ)。
    standalone|start|serve) MODE=standalone ;;
    --mamp) ;;
    *)
        echo "Usage: ./start.sh [--mamp]   (引数なし = PHP + Python をこのMac内で起動)" >&2
        exit 1
        ;;
esac
PYTHON_BIN="${PYTHON_BIN:-python3}"
if [[ -x "$DIR/.venv/bin/python" ]]; then
    PYTHON_BIN="$DIR/.venv/bin/python"
fi
"$PYTHON_BIN" -c 'import flask, flask_cors, jwt, dotenv' || {
    echo "Python依存関係が必要です。README.local.md（ローカルマニュアル）の起動方法を確認してください。" >&2
    exit 1
}
if [[ "$MODE" != --mamp ]]; then
    PHP_BIN="${PHP_BIN:-$(command -v php || true)}"
    if [[ -z "$PHP_BIN" ]]; then
        for candidate in /Applications/MAMP/bin/php/php*/bin/php; do
            if [[ -x "$candidate" ]]; then
                PHP_BIN="$candidate"
                break
            fi
        done
    fi
    if [[ -z "$PHP_BIN" ]]; then
        echo "PHPが見つかりません。MAMPをインストールしてください。" >&2
        exit 1
    fi
fi
PYTHON_PID=''
PHP_PID=''

# 画面 (プロジェクト直下の index.html と assets/) は Vite のビルド成果物。
# ビルド元 (frontend/) の方が新しければ自動でビルドし直す。MAMP 配信 (--mamp) でも
# 同じフォルダを配信するため、モードに関わらずここで整える。
# node_modules が無い (npm install 未実行) 場合はビルドできないので、
# 既にある成果物をそのまま使う (無ければ理由を出して止まる)。
if [[ -d node_modules ]]; then
    needs_build=0
    if [[ ! -f index.html || ! -d assets ]]; then
        needs_build=1
    else
        for src in frontend/index.html frontend/main.js frontend/app.js frontend/config.js frontend/style.css; do
            if [[ "$src" -nt index.html ]]; then
                needs_build=1
            fi
        done
    fi
    if [[ "$needs_build" == 1 ]]; then
        echo "画面をビルドしています (npm run build)..."
        npm run build
    fi
elif [[ ! -f index.html ]]; then
    echo "画面 (index.html) がありません。npm install && npm run build を実行してください。" >&2
    exit 1
fi

# 既に認証・解析サーバーが動いているか (.auth_port のポートに /health を投げて確認)。
# 二重起動するとポートと SQLite のロックを取り合い、MAMP 側の応答が止まるため先に弾く。
auth_server_running() {
    local recorded
    [[ -f "$DIR/.auth_port" ]] || return 1
    recorded="$(tr -dc '0-9' <"$DIR/.auth_port")"
    [[ -n "$recorded" ]] || return 1
    "$PYTHON_BIN" - "$recorded" <<'PY'
import json
import sys
import urllib.request

try:
    with urllib.request.urlopen("http://127.0.0.1:%s/health" % sys.argv[1], timeout=2) as response:
        payload = json.load(response)
except Exception:
    sys.exit(1)
sys.exit(0 if payload.get("service") == "Tune drop Auth Server" else 1)
PY
}

# 安全に bind できるポートを探す (8000 が他プロジェクトに使われている場合がある)。
# TUNEDROP_PORT を指定するとその値を最優先で使う。
pick_web_port() {
    local candidate
    for candidate in "${TUNEDROP_PORT:-8000}" 8000 8001 8002 8003 8010 8080; do
        if "$PYTHON_BIN" - "$candidate" <<'PY'
import socket
import sys

try:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
PY
        then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

# 認証・解析サーバー (app.py) が既に動いている場合でも、Webサーバーは起動する。
# 以前はここで終了していたため「サーバーを起動できない/接続できない」状態になった。
START_AUTH=1
if auth_server_running; then
    echo "認証・解析サーバーは既に起動しています (ポート $(tr -dc '0-9' <"$DIR/.auth_port"))。" >&2
    echo "二重起動はせず、既存のプロセスをそのまま使ってWebサーバーだけを起動します。" >&2
    START_AUTH=0
fi

cleanup() {
    [[ -n "$PYTHON_PID" ]] && kill "$PYTHON_PID" 2>/dev/null || true
    [[ -n "$PHP_PID" ]] && kill "$PHP_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM
if [[ "$START_AUTH" == 1 ]]; then
    "$PYTHON_BIN" app.py &
    PYTHON_PID=$!
fi
if [[ "$MODE" == --mamp ]]; then
    # MAMPのDocumentRootはプロジェクト直下とは限らない。公開エイリアスは小文字の /tunedrop/。
    echo "MAMPを起動してください: http://localhost:8888/tunedrop/"
    echo "Live Server: index.htmlをOpen with Live Serverで開いてください。"
    echo "管理者ページ: ./admin/admin.sh （トークン付きURLを開きます）"
    if [[ "$START_AUTH" == 1 ]]; then
        echo "Ctrl+CでPythonサーバーを停止します。"
        wait "$PYTHON_PID"
    else
        echo "WebサーバーはMAMPをそのまま使えます (このスクリプトは終了します)。"
    fi
else
    WEB_PORT="$(pick_web_port)" || {
        echo "空きポートが見つかりませんでした。TUNEDROP_PORT=8001 のように指定してください。" >&2
        exit 1
    }
    if [[ "$WEB_PORT" != 8000 ]]; then
        echo "注意: ポート8000は別のアプリが使用中です (このMacでは Midair.io の uvicorn が常駐)。" >&2
        echo "Webサーバーはポート $WEB_PORT で起動します。" >&2
    fi
    echo "TuneDrop: http://localhost:$WEB_PORT （Ctrl+Cで停止）"
    echo "管理者ページ: ./admin/admin.sh （トークン付きURLを開きます）"
    "$PYTHON_BIN" "$DIR/runtime_config.py" "$PHP_BIN" -S "127.0.0.1:$WEB_PORT" -t "$DIR" "$DIR/router.php" &
    PHP_PID=$!
    wait "$PHP_PID"
fi
