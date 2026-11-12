#!/usr/bin/env bash
# ./tunnel.sh: TuneDrop 公開トンネル（Cloudflare Tunnel: music.wawa-app.me/tunedrop/）の管理
#   使い方: ./tunnel.sh start | stop | restart | status
#
# 構成:
#   https://music.wawa-app.me/tunedrop/  →（Cloudflare）→ このトンネル
#                                        → http://127.0.0.1:8888（PHPビルトイン + router.php）
#
# 前提:
#   ・別途 ./start.sh で Web 配信（8888）を起動しておくこと。
#   ・このトンネルは Cloudflare ダッシュボード管理（ingress はダッシュボード側）で、
#     ローカルには設定ファイルが無い。そのためトークンで起動する。
#       トークンの保存先: ~/.cloudflared/tunedrop.token（600。Git には絶対に入れない）
#   ・midair / quadtecho など他プロジェクトのトンネルとは独立している。
#
# 二重起動を防ぐため、PIDファイルで稼働中プロセスを判定する。
# PID・ログ・トークンはリポジトリ外（既定 ~/.cloudflared）に置く。

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$DIR"

STATE_DIR="${TUNEDROP_TUNNEL_DIR:-$HOME/.cloudflared}"
TOKEN_FILE="${TUNEDROP_TUNNEL_TOKEN_FILE:-$STATE_DIR/tunedrop.token}"
LOG_FILE="${TUNEDROP_TUNNEL_LOG:-$STATE_DIR/tunedrop-tunnel.log}"
PID_FILE="${TUNEDROP_TUNNEL_PID:-$STATE_DIR/tunedrop-tunnel.pid}"
PUBLIC_URL="${TUNEDROP_PUBLIC_URL:-https://music.wawa-app.me/tunedrop/}"
HEALTH_URL="${PUBLIC_URL%/}/api.php?action=health"
# 不安定な Wi-Fi / NAT では QUIC が idle timeout で切れることがある。
# TUNEDROP_TUNNEL_PROTOCOL=http2 にすると TCP (7844) で接続する。既定は cloudflared 任せ (auto)。
TUNNEL_PROTOCOL="${TUNEDROP_TUNNEL_PROTOCOL:-}"

# ログが無制限に育たないように、5MB を超えたら .1 へ退避する。
rotate_log() {
    [ -f "$LOG_FILE" ] || return 0
    local size
    size="$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')"
    case "$size" in ''|*[!0-9]*) return 0 ;; esac
    if [ "$size" -gt 5242880 ]; then
        mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
    fi
}

# 稼働中のトンネル PID を返す（無ければ終了コード1）。
# PID は再起動後に別プロセスへ再利用されることがあるため、コマンドラインも確認する。
pid_of() {
    if [ -f "$PID_FILE" ]; then
        local pid cmd
        pid="$(cat "$PID_FILE" 2>/dev/null)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
            case "$cmd" in
                *cloudflared*"$TOKEN_FILE"*)
                    echo "$pid"
                    return 0
                    ;;
            esac
        fi
    fi
    return 1
}

start_tunnel() {
    if pid="$(pid_of)"; then
        echo "公開トンネルは既に起動しています (PID $pid) → $PUBLIC_URL"
        return 0
    fi
    if ! command -v cloudflared >/dev/null 2>&1; then
        echo "cloudflared が見つかりません（brew install cloudflared）" >&2
        return 1
    fi
    if [ ! -f "$TOKEN_FILE" ]; then
        echo "トークンが見つかりません: $TOKEN_FILE" >&2
        echo "Cloudflare ダッシュボード（Networking → Tunnels → tunedrop）のトークンを" >&2
        echo "このパスへ保存し、chmod 600 してください。" >&2
        return 1
    fi

    rotate_log
    if [ -n "$TUNNEL_PROTOCOL" ]; then
        nohup cloudflared tunnel run --token-file "$TOKEN_FILE" --protocol "$TUNNEL_PROTOCOL" >> "$LOG_FILE" 2>&1 &
    else
        nohup cloudflared tunnel run --token-file "$TOKEN_FILE" >> "$LOG_FILE" 2>&1 &
    fi
    echo $! > "$PID_FILE"
    sleep 3

    if pid="$(pid_of)"; then
        echo "公開トンネルを起動しました (PID $pid)"
        echo "公開URL: $PUBLIC_URL"
        if [ -n "$TUNNEL_PROTOCOL" ]; then
            echo "プロトコル: $TUNNEL_PROTOCOL"
        fi
        echo "ログ   : $LOG_FILE"
        return 0
    fi
    echo "公開トンネルの起動に失敗しました。$LOG_FILE を確認してください。" >&2
    return 1
}

stop_tunnel() {
    if pid="$(pid_of)"; then
        kill "$pid" 2>/dev/null
        # 終了を待ってから PID ファイルを片付ける（残ると次回の起動判定が誤る）
        for _ in 1 2 3 4 5; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 1
        done
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
        echo "公開トンネルを停止しました (PID $pid)"
    else
        echo "公開トンネルは起動していません"
    fi
    rm -f "$PID_FILE"
    return 0
}

show_status() {
    local local_port
    if pid="$(pid_of)"; then
        echo "公開トンネル: 稼働中 (PID $pid)"
    else
        echo "公開トンネル: 停止中"
    fi
    local_port="$(tr -dc '0-9' < "$DIR/../.web_port" 2>/dev/null)"
    [ -n "$local_port" ] || local_port=8888
    echo -n "ローカル: "
    curl -s -m 3 "http://127.0.0.1:${local_port}/api.php?action=health" || echo -n "PHP(${local_port}) に接続できません（./start.sh で起動してください）"
    echo
    echo -n "公開URL : "
    curl -s -m 8 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo -n "（未接続）"
    echo " $HEALTH_URL"
}

# 公開URLが 200 なら終了コード0。watchdog や cron から使える。
check_tunnel() {
    local code
    if ! pid="$(pid_of)"; then
        echo "tunnel: 停止中"
        return 1
    fi
    code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
        echo "tunnel: OK (PID $pid / HTTP 200)"
        return 0
    fi
    echo "tunnel: NG (PID $pid / HTTP ${code:-000}) $HEALTH_URL"
    return 1
}

case "${1:-status}" in
    start)   start_tunnel ;;
    stop)    stop_tunnel ;;
    restart) stop_tunnel && start_tunnel ;;
    status)  show_status ;;
    check)   check_tunnel ;;
    *)
        echo "使い方: ./tunnel.sh start | stop | restart | status | check" >&2
        exit 1
        ;;
esac