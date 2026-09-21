#!/bin/bash
# ./start.sh: PHP + Python / ./start.sh --mamp: Pythonのみ（Web配信はMAMP）
# bash / zsh のどちらでも実行可能 (./start.sh / zsh start.sh)
set -e
# zshではglobが一致しないと「no matches found」で止まるためnull_globにする (bashではスキップされる)
setopt null_glob 2>/dev/null || true
DIR="$(cd "$(dirname "${BASH_SOURCE:-$0}")" && pwd)"
cd "$DIR"
MODE="${1:-standalone}"
if [[ "$MODE" != standalone && "$MODE" != --mamp ]]; then
    echo "Usage: ./start.sh [--mamp]" >&2
    exit 1
fi
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

if auth_server_running; then
    echo "認証・解析サーバーは既に起動しています (ポート $(tr -dc '0-9' <"$DIR/.auth_port"))。" >&2
    echo "二重起動を防ぐため、このまま終了します。再起動はそのプロセスを Ctrl+C で止めてから実行してください。" >&2
    exit 0
fi

cleanup() {
    [[ -n "$PYTHON_PID" ]] && kill "$PYTHON_PID" 2>/dev/null || true
    [[ -n "$PHP_PID" ]] && kill "$PHP_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM
"$PYTHON_BIN" app.py &
PYTHON_PID=$!
if [[ "$MODE" == --mamp ]]; then
    echo "MAMPを起動してください: http://localhost:8888/Tunedrop/"
    echo "Live Server: index.htmlをOpen with Live Serverで開いてください。"
    echo "管理者ページ: ./admin.sh （トークン付きURLを開きます）"
    echo "Ctrl+CでPythonサーバーを停止します。"
    wait "$PYTHON_PID"
else
    echo "TuneDrop: http://localhost:8000 （Ctrl+Cで停止）"
    echo "管理者ページ: ./admin.sh （トークン付きURLを開きます）"
    "$PYTHON_BIN" "$DIR/runtime_config.py" "$PHP_BIN" -S 127.0.0.1:8000 -t "$DIR" "$DIR/router.php" &
    PHP_PID=$!
    wait "$PHP_PID"
fi
