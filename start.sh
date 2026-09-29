#!/usr/bin/env zsh
# ./start.sh: Web配信 (PHPビルトインサーバー + router.php) と 認証・解析サーバー (Python) を起動する。
# 実処理はクロスプラットフォーム版の start.py に集約している (Windows は start.cmd / start.ps1 / python start.py)。
# zsh用 (./start.sh / zsh start.sh。bash / Git Bash でも動作可)
set -e
if [[ -n "${ZSH_VERSION:-}" ]]; then
    DIR="${0:A:h}"
else
    DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
fi
cd "$DIR"

# 使用する Python を決める (優先: .venv → PYTHON_BIN → python3 → python)。
# Windows の venv は .venv/Scripts/python.exe なので、Git Bash からも拾えるようにする。
if [[ -x "$DIR/.venv/bin/python" ]]; then
    PYTHON_BIN="$DIR/.venv/bin/python"
elif [[ -x "$DIR/.venv/Scripts/python.exe" ]]; then
    PYTHON_BIN="$DIR/.venv/Scripts/python.exe"
elif [[ -n "${PYTHON_BIN:-}" ]]; then
    :
elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
else
    echo "Python 3 が見つかりません。インストールするか PYTHON_BIN=... を指定してください。" >&2
    exit 1
fi

exec "$PYTHON_BIN" "$DIR/start.py" "$@"
