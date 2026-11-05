#!/usr/bin/env bash
# ==========================================================
# メンテナンスモードの切り替え
# ----------------------------------------------------------
#   ./backend/maintenance.sh on "データベース移行のため停止します"
#   ./backend/maintenance.sh off
#   ./backend/maintenance.sh status
#
# プロジェクト直下に maintenance.flag を置きます。backend/router.php と
# backend/api.php がこれを検出し、画面は 503 + maintenance.html、
# API は 503 + JSON (maintenance: true) を返します。
# 管理画面 (/admin) は解除作業のため止まりません。
# ==========================================================
set -eu
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
FLAG="$ROOT/maintenance.flag"

usage() {
    cat <<'EOF'
使い方:
  ./backend/maintenance.sh on [メッセージ]   メンテナンスモードを有効にする
  ./backend/maintenance.sh off               メンテナンスモードを解除する
  ./backend/maintenance.sh status            現在の状態を表示する
EOF
}

case "${1:-status}" in
    on)
        shift || true
        message="${*:-ただいまメンテナンス中です。時間をおいて再試行してください。}"
        printf '%s\n' "$message" > "$FLAG"
        echo "メンテナンスモードを有効にしました。"
        echo "  フラグ: $FLAG"
        echo "  メッセージ: $message"
        ;;
    off)
        if [ -f "$FLAG" ]; then
            rm -f "$FLAG"
            echo "メンテナンスモードを解除しました。"
        else
            echo "メンテナンスモードは有効になっていません。"
        fi
        ;;
    status)
        if [ -f "$FLAG" ]; then
            echo "メンテナンス中です。"
            echo "  メッセージ: $(cat "$FLAG")"
        else
            echo "通常運転中です。"
        fi
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        usage >&2
        exit 1
        ;;
esac
