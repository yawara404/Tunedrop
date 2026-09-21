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
