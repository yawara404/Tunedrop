#!/usr/bin/env zsh
# ./sync.sh : ローカル ⇄ GitHub をワンコマンドで同期する
#   ./sync.sh               … 変更をコミットしてpush (メッセージは自動生成)
#   ./sync.sh "メッセージ"   … コミットメッセージを指定してpush
# zsh用 (./sync.sh / zsh sync.sh。bashでも動作可)
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

MSG="${1:-クラウド同期 $(date '+%Y-%m-%d %H:%M')}"

echo "== fetch =="
git fetch origin

# 未コミット変更があり、かつリモートが進んでいる場合は先にコミットしてからrebaseする
if [[ -n "$(git status --porcelain)" ]]; then
    BEHIND=$(git rev-list --count main..origin/main)
    if [[ "$BEHIND" -gt 0 ]]; then
        echo "未コミット変更があり、リモートも進んでいます。先にコミットします。"
        git add -A
        git commit -m "$MSG"
    fi
fi

BEHIND=$(git rev-list --count main..origin/main)
if [[ "$BEHIND" -gt 0 ]]; then
    echo "== リモートの変更を取り込み (rebase) =="
    git pull --rebase origin main
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo "== ローカルの変更をコミット =="
    git add -A
    git commit -m "$MSG"
fi

echo "== push =="
git push origin main
echo "同期完了: $(git log --oneline -1)"
