#!/usr/bin/env zsh
# ./start.sh: Web配信 (PHPビルトインサーバー + router.php) と 認証・解析サーバー (Python) を起動する
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
    *)
        echo "Usage: ./start.sh   (Web配信 + 認証・解析サーバーを起動)" >&2
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
PHP_BIN="${PHP_BIN:-$(command -v php || true)}"
if [[ -z "$PHP_BIN" ]]; then
    echo "PHPが見つかりません。PHPをインストールするか、PHP_BIN=/path/to/php を指定してください。" >&2
    exit 1
fi
PYTHON_PID=''
PHP_PID=''

# 画面 (プロジェクト直下の index.html と assets/) は Vite のビルド成果物。
# ビルド元 (frontend/) の方が新しければ自動でビルドし直す。
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
# 二重起動するとポートと SQLite のロックを取り合い、応答が止まるため先に弾く。
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
# 8888 を第一候補にしているのは、公開トンネル (cloudflared) の接続先が 8888 のため。
# 同じポートで受ければトンネル側の設定を変えずに配信を切り替えられる。
pick_web_port() {
    local candidate
    for candidate in "${TUNEDROP_PORT:-8888}" 8888 8000 8001 8002 8003 8010 8080; do
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
WEB_PORT="$(pick_web_port)" || {
    echo "空きポートが見つかりませんでした。TUNEDROP_PORT=8001 のように指定してください。" >&2
    exit 1
}
if [[ "$WEB_PORT" != 8888 ]]; then
    echo "注意: ポート8888は使用中です (別のサーバーが使っている場合があります)。" >&2
    echo "公開トンネル (cloudflared) は 8888 を見ているため、そのサーバーを止めてから" >&2
    echo "このスクリプトを起動すると、公開URLもこのサーバーへ切り替わります。" >&2
    echo "Webサーバーはポート $WEB_PORT で起動します。" >&2
fi
echo "TuneDrop: http://localhost:$WEB_PORT （Ctrl+Cで停止）"
echo "管理者ページ: ./admin/admin.sh （トークン付きURLを開きます）"
# PHPビルトインサーバーは既定で1リクエストずつ処理する。公開トンネル越しでは
# 画面(HTML/JS/CSS)とAPIが並行して飛ぶため、ワーカーを増やして詰まりを防ぐ
# (PHP 7.4+ の機能。TUNEDROP_PHP_WORKERS で変更可)。
export PHP_CLI_SERVER_WORKERS="${TUNEDROP_PHP_WORKERS:-8}"
# 実際に使ったポートを記録 (Vite開発サーバーのプロキシ先 / admin.sh が参照)
printf '%s\n' "$WEB_PORT" > "$DIR/.web_port"
# 開発中は Vite 開発サーバー (HMR付き) を使う。API は vite.config.mjs が
# このポート (.web_port) へプロキシするため、画面側の設定変更は不要。
echo "開発時: 別ターミナルで npm run dev (Vite: http://localhost:5173/ → API は $WEB_PORT へ自動プロキシ)"
"$PYTHON_BIN" "$DIR/runtime_config.py" "$PHP_BIN" -S "127.0.0.1:$WEB_PORT" -t "$DIR" "$DIR/router.php" &
PHP_PID=$!
wait "$PHP_PID"
