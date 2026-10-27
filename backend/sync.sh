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
# このスクリプトは backend/ にあり、リポジトリのルートは1つ上。
# git と sitemap.xml、frontend/ はルートからの相対で扱う。
if [[ -n "${ZSH_VERSION:-}" ]]; then
    ROOT="${DIR:h}"
else
    ROOT="$(cd "$DIR/.." && pwd)"
fi
cd "$ROOT"

MSG="${1:-クラウド同期 $(date '+%Y-%m-%d %H:%M')}"

echo "== 画面をビルド (frontend/ -> frontend/dist/、Vite) =="
if [[ -d frontend/node_modules ]]; then
    ( cd frontend && npm run build )
else
    echo "frontend/node_modules が無いためビルドをスキップします (cd frontend && npm install を実行してください)" >&2
fi

# ビルド成果物 (frontend/dist/) に差分があれば sitemap.xml の lastmod を今日に更新する。
# (検索エンジンに「サイトが更新された」ことを伝える。手で書き換えてもよい)
# OGPカード画像の ?v= はビルド時に frontend/vite.config.mjs が中身のハッシュへ更新する。
if [[ -f sitemap.xml && -n "$(git status --porcelain frontend/dist 2>/dev/null)" ]]; then
    today="$(date +%Y-%m-%d)"
    current="$(sed -n 's#.*<lastmod>\([^<]*\)</lastmod>.*#\1#p' sitemap.xml | head -1)"
    if [[ "$current" != "$today" ]]; then
        if sed --version >/dev/null 2>&1; then SED_I=(-i); else SED_I=(-i ''); fi
        sed "${SED_I[@]}" "s#<lastmod>[^<]*</lastmod>#<lastmod>${today}</lastmod>#" sitemap.xml
        echo "更新: sitemap.xml の lastmod を ${today} に更新"
    fi
fi

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
