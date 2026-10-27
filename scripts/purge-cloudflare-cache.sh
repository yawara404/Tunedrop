#!/usr/bin/env bash
# ./scripts/purge-cloudflare-cache.sh: Cloudflare のエッジキャッシュから TuneDrop の
# 公開URLを削除する (画面を再ビルドして公開した直後に実行する)。
#
# なぜ必要か:
#   router.php は index.html に `s-maxage=60, stale-while-revalidate=60` を付け、
#   Cloudflare のエッジに短時間だけ HTML を持たせる。ビルドでは assets/ を作り直す
#   (package.json の build が `rm -rf assets` する) ため、古い HTML を配ると
#   存在しない assets を参照して画面が真っ白になる。公開直後にこれを実行して消す。
#
# 前提:
#   HTML は Cloudflare の既定ではキャッシュされない (cf-cache-status: DYNAMIC)。
#   このスクリプトが意味を持つのは、HTML をキャッシュする Cache Rule を
#   追加している場合 (例: `music.wawa-app.me/tunedrop/` の HTML を 60 秒キャッシュ)。
#   `assets/` は内容ハッシュ付きのファイル名なので、削除は不要 (削除しても害はない)。
#
# 使い方:
#   CF_API_TOKEN=... CF_ZONE_ID=... ./scripts/purge-cloudflare-cache.sh
#   ./scripts/purge-cloudflare-cache.sh --everything        # ゾーン全体を削除
#   ./scripts/purge-cloudflare-cache.sh URL [URL ...]       # 指定URLだけ削除
#
# トークン:
#   権限は Zone → Cache Purge (Zone.Cache Purge) だけでよい。リポジトリには置かず、
#   環境変数か次のファイル (chmod 600) から読む:
#     ~/.cloudflare/tunedrop-purge.env   (CF_API_TOKEN=... / CF_ZONE_ID=... の2行)
#
# 参考: https://developers.cloudflare.com/api/resources/cache/methods/purge/

set -u

# 公開ベースURL (末尾スラッシュなし)。別ホストへ移した場合は TUNEDROP_PUBLIC_URL で指定。
PUBLIC_BASE="${TUNEDROP_PUBLIC_URL:-https://music.wawa-app.me/tunedrop}"
ENV_FILE="${TUNEDROP_CF_ENV_FILE:-$HOME/.cloudflare/tunedrop-purge.env}"
API="https://api.cloudflare.com/client/v4/zones"

usage() {
    cat <<'EOF'
使い方: CF_API_TOKEN=... CF_ZONE_ID=... ./scripts/purge-cloudflare-cache.sh [--everything | URL ...]

  (引数なし)     画面 (HTML) と公開データAPIの既定URLを削除する
  --everything   ゾーン全体のキャッシュを削除する
  URL ...        指定したURLだけ削除する

  CF_API_TOKEN   権限: Zone → Cache Purge
  CF_ZONE_ID     対象ゾーンのID (Cloudflare ダッシュボードの概要で確認)
  どちらも未指定なら $HOME/.cloudflare/tunedrop-purge.env から読む
EOF
}

# 環境変数が無ければ 600 の設定ファイルから読む (値はそのまま使い、実行はしない)。
load_env_file() {
    [ -f "$ENV_FILE" ] || return 0
    local line
    while IFS= read -r line; do
        case "$line" in
            CF_API_TOKEN=*) [ -n "${CF_API_TOKEN:-}" ] || CF_API_TOKEN="${line#CF_API_TOKEN=}" ;;
            CF_ZONE_ID=*)   [ -n "${CF_ZONE_ID:-}" ]   || CF_ZONE_ID="${line#CF_ZONE_ID=}" ;;
        esac
    done < "$ENV_FILE"
}

# 削除するURL (HTML と、ETag でキャッシュさせる公開データAPI)
default_urls() {
    printf '%s\n' \
        "${PUBLIC_BASE}/" \
        "${PUBLIC_BASE}/index.html" \
        "${PUBLIC_BASE}/api.php?action=get_public_playlists" \
        "${PUBLIC_BASE}/api.php?action=radar_map"
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac

load_env_file
if [ -z "${CF_API_TOKEN:-}" ] || [ -z "${CF_ZONE_ID:-}" ]; then
    echo "CF_API_TOKEN と CF_ZONE_ID が必要です。" >&2
    echo "  例: CF_API_TOKEN=... CF_ZONE_ID=... $0" >&2
    echo "  または $ENV_FILE に書いて chmod 600 してください。" >&2
    exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
    echo "curl が見つかりません。" >&2
    exit 1
fi

if [ "${1:-}" = "--everything" ]; then
    PAYLOAD='{"purge_everything":true}'
    echo "ゾーン全体のキャッシュを削除します (zone: ${CF_ZONE_ID})"
elif [ -n "${1:-}" ]; then
    PAYLOAD="{\"files\":["
    separator=''
    for url in "$@"; do
        PAYLOAD="${PAYLOAD}${separator}\"${url}\""
        separator=','
    done
    PAYLOAD="${PAYLOAD}]}"
    echo "指定URLのキャッシュを削除します:"
    for url in "$@"; do echo "  $url"; done
else
    PAYLOAD="{\"files\":["
    separator=''
    while IFS= read -r url; do
        PAYLOAD="${PAYLOAD}${separator}\"${url}\""
        separator=','
        echo "削除: $url"
    done < <(default_urls)
    PAYLOAD="${PAYLOAD}]}"
fi

response="$(curl -sS -X POST "${API}/${CF_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$PAYLOAD" 2>&1)" || {
    echo "Cloudflare API への接続に失敗しました。" >&2
    echo "$response" >&2
    exit 1
}

case "$response" in
    *'"success":true'*)
        echo "キャッシュを削除しました。"
        exit 0
        ;;
esac

echo "削除に失敗しました。応答:" >&2
echo "$response" >&2
echo "トークンの権限 (Zone → Cache Purge) と CF_ZONE_ID を確認してください。" >&2
exit 1
