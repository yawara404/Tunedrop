#!/usr/bin/env bash
# ==========================================================
# backend/watchdog.sh: TuneDrop の死活監視と自動復旧
# ----------------------------------------------------------
# 使い方:
#   ./backend/watchdog.sh check       1回だけ確認 (再起動しない。異常なら終了コード1)
#   ./backend/watchdog.sh once        1回だけ確認し、異常なら復旧する
#   ./backend/watchdog.sh loop        30秒ごとに確認・復旧 (前面で動作)
#   ./backend/watchdog.sh start       loop をバックグラウンドで開始
#   ./backend/watchdog.sh stop        バックグラウンドの loop を停止
#   ./backend/watchdog.sh status      状態と直近のログを表示
#   ./backend/watchdog.sh install [--prevent-sleep]
#                                     macOS launchd へ登録 (ログイン時起動 + 常時監視)
#   ./backend/watchdog.sh uninstall   launchd から解除
#
# 監視対象:
#   1. ローカルWeb (PHP + router.php) … /api.php?action=health&deep=1 (DB接続も確認)
#   2. 認証・解析サーバー (app.py)   … /health
#   3. 公開URL (Cloudflare Tunnel)   … https://music.wawa-app.me/tunedrop/api.php
#   4. メモリ/スワップの逼迫        … 警告ログのみ (80%以上で30分に1回)
#
# 復旧:
#   Web/認証が落ちていれば start.sh を起動し直します。
#   ローカルは生きていて公開URLだけ落ちていれば tunnel.sh を再起動します
#   (インターネット自体が切れているときは無駄な再起動をしません)。
#   メンテナンスモード (maintenance.flag) 中は正常として扱い、再起動しません。
#
# 状態・ログはリポジトリ外 (既定 ~/.tunedrop) に置きます。
#
# 環境変数:
#   TUNEDROP_WATCHDOG_INTERVAL       loop の間隔秒 (既定 30)
#   TUNEDROP_WATCHDOG_COOLDOWN       同じ対象を再起動する最短間隔秒 (既定 120)
#   TUNEDROP_WATCHDOG_START_TIMEOUT  スタック再起動後に復旧を待つ秒数 (既定 180)
#   TUNEDROP_WATCHDOG_TUNNEL_TIMEOUT トンネル再起動後に復旧を待つ秒数 (既定 90)
#   TUNEDROP_WATCHDOG_DRY_RUN        1 で復旧動作をログ出力だけにする (テスト用)
#   TUNEDROP_WATCHDOG_SKIP_PUBLIC    1 で公開URLの確認をしない (テスト用)
#   TUNEDROP_WATCHDOG_LOCAL_URL      ローカルWebのhealth URL (既定 .web_port から生成)
#   TUNEDROP_WATCHDOG_AUTH_URL       認証サーバーのhealth URL (既定 .auth_port から生成)
#   TUNEDROP_WATCHDOG_PUBLIC_URL     公開health URL
#   TUNEDROP_WATCHDOG_ONLINE_URL     ネットワーク疎通の確認先 (既定 https://1.1.1.1/cdn-cgi/trace)
#   TUNEDROP_WATCHDOG_PREVENT_SLEEP  1 で caffeinate -s (AC電源時にスリープさせない)
#   TUNEDROP_WATCHDOG_STATE_DIR      状態・ログの保存先 (既定 ~/.tunedrop)
# ==========================================================
set -u

# launchd から起動すると PATH が最小構成のため、Homebrew 等を先に足す。
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

STATE_DIR="${TUNEDROP_WATCHDOG_STATE_DIR:-$HOME/.tunedrop}"
LOG_FILE="$STATE_DIR/watchdog.log"
OUT_FILE="$STATE_DIR/watchdog.out.log"
STACK_LOG="$STATE_DIR/stack.log"
LOCK_DIR="$STATE_DIR/lock"
PID_FILE="$STATE_DIR/watchdog.pid"

INTERVAL="${TUNEDROP_WATCHDOG_INTERVAL:-30}"
COOLDOWN="${TUNEDROP_WATCHDOG_COOLDOWN:-120}"
CURL_TIMEOUT="${TUNEDROP_WATCHDOG_CURL_TIMEOUT:-8}"
START_TIMEOUT="${TUNEDROP_WATCHDOG_START_TIMEOUT:-180}"
TUNNEL_TIMEOUT="${TUNEDROP_WATCHDOG_TUNNEL_TIMEOUT:-90}"
DRY_RUN="${TUNEDROP_WATCHDOG_DRY_RUN:-0}"
SKIP_PUBLIC="${TUNEDROP_WATCHDOG_SKIP_PUBLIC:-0}"
PREVENT_SLEEP="${TUNEDROP_WATCHDOG_PREVENT_SLEEP:-0}"
ONLINE_URL="${TUNEDROP_WATCHDOG_ONLINE_URL:-https://1.1.1.1/cdn-cgi/trace}"

LABEL="me.wawa.tunedrop.watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

CHECK_DETAIL=""
RESTART_WAIT=0
CAFFEINATE_PID=""

mkdir -p "$STATE_DIR" 2>/dev/null || true

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

# ログが無制限に育たないように、5MB を超えたら .1 へ退避する。
rotate_log() {
    local file="$1" limit="${2:-5242880}" size
    [ -f "$file" ] || return 0
    size="$(wc -c < "$file" 2>/dev/null | tr -d ' ')"
    case "$size" in ''|*[!0-9]*) return 0 ;; esac
    if [ "$size" -gt "$limit" ]; then
        mv -f "$file" "$file.1" 2>/dev/null || true
    fi
}

# ポート記録ファイル (.web_port / .auth_port) を読み、無効なら既定値を使う。
read_port() {
    local file="$1" default="$2" port=""
    if [ -f "$file" ]; then
        port="$(tr -dc '0-9' < "$file" 2>/dev/null)"
    fi
    [ -n "$port" ] || port="$default"
    printf '%s' "$port"
}

local_health_url() {
    if [ -n "${TUNEDROP_WATCHDOG_LOCAL_URL:-}" ]; then
        printf '%s' "$TUNEDROP_WATCHDOG_LOCAL_URL"
    else
        printf 'http://127.0.0.1:%s/api.php?action=health&deep=1' "$(read_port "$ROOT/.web_port" 8888)"
    fi
}

auth_health_url() {
    if [ -n "${TUNEDROP_WATCHDOG_AUTH_URL:-}" ]; then
        printf '%s' "$TUNEDROP_WATCHDOG_AUTH_URL"
    else
        printf 'http://127.0.0.1:%s/health' "$(read_port "$ROOT/.auth_port" 5050)"
    fi
}

public_health_url() {
    if [ -n "${TUNEDROP_WATCHDOG_PUBLIC_URL:-}" ]; then
        printf '%s' "$TUNEDROP_WATCHDOG_PUBLIC_URL"
    else
        printf 'https://music.wawa-app.me/tunedrop/api.php?action=health&deep=1'
    fi
}

# curl の結果を FETCH_BODY / FETCH_CODE に入れる (失敗時は戻り値1)。
fetch_url() {
    local out
    FETCH_BODY=""
    FETCH_CODE=0
    if ! out="$(curl -sS -m "$CURL_TIMEOUT" -w '\n%{http_code}' "$1" 2>/dev/null)"; then
        return 1
    fi
    FETCH_CODE="${out##*$'\n'}"
    FETCH_BODY="${out%$'\n'*}"
    return 0
}

# 小さな JSON から文字列値を1つ取り出す (jq 非依存)。
json_value() {
    printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

mark_state() { # $1=name $2=up|down
    local flag="$STATE_DIR/$1-down"
    if [ "$2" = "down" ]; then
        [ -f "$flag" ] || log "$1: NG ($CHECK_DETAIL)"
        : > "$flag" 2>/dev/null || true
    elif [ -f "$flag" ]; then
        rm -f "$flag" 2>/dev/null || true
        log "$1: 復旧しました"
    fi
}

# ----------------------------------------------------------
# ヘルスチェック (CHECK_DETAIL に理由を入れて 0=OK / 1=NG)
# ----------------------------------------------------------
check_web() {
    local url status db code
    url="$(local_health_url)"
    if ! fetch_url "$url"; then
        CHECK_DETAIL="接続できません ($url)"
        return 1
    fi
    code="$FETCH_CODE"
    status="$(json_value "$FETCH_BODY" status)"
    case "$status" in
        maintenance)
            CHECK_DETAIL="メンテナンス中 (HTTP $code)"
            return 0
            ;;
        ok)
            db="$(json_value "$FETCH_BODY" database)"
            if [ "$db" = "error" ]; then
                CHECK_DETAIL="DBに接続できません (HTTP $code)"
                return 1
            fi
            if [ "$code" != "200" ]; then
                CHECK_DETAIL="HTTP $code"
                return 1
            fi
            if [ -n "$db" ]; then
                CHECK_DETAIL="HTTP $code / DB $db"
            else
                CHECK_DETAIL="HTTP $code"
            fi
            return 0
            ;;
        *)
            CHECK_DETAIL="HTTP $code status=${status:-unknown}"
            return 1
            ;;
    esac
}

check_auth() {
    local url status service code
    url="$(auth_health_url)"
    if ! fetch_url "$url"; then
        CHECK_DETAIL="接続できません ($url)"
        return 1
    fi
    code="$FETCH_CODE"
    status="$(json_value "$FETCH_BODY" status)"
    service="$(json_value "$FETCH_BODY" service)"
    if [ "$service" != "Tune drop Auth Server" ]; then
        CHECK_DETAIL="想定外の応答 service=${service:-none} (HTTP $code)"
        return 1
    fi
    if [ "$status" != "ok" ]; then
        CHECK_DETAIL="status=${status:-none} (HTTP $code)"
        return 1
    fi
    CHECK_DETAIL="HTTP $code"
    return 0
}

check_public() {
    local url status db code
    url="$(public_health_url)"
    if ! fetch_url "$url"; then
        CHECK_DETAIL="接続できません ($url)"
        return 1
    fi
    code="$FETCH_CODE"
    status="$(json_value "$FETCH_BODY" status)"
    case "$status" in
        maintenance)
            CHECK_DETAIL="メンテナンス中 (HTTP $code)"
            return 0
            ;;
        ok)
            db="$(json_value "$FETCH_BODY" database)"
            if [ "$db" = "error" ]; then
                CHECK_DETAIL="DBに接続できません (HTTP $code)"
                return 1
            fi
            if [ "$code" != "200" ]; then
                CHECK_DETAIL="HTTP $code"
                return 1
            fi
            CHECK_DETAIL="HTTP $code"
            return 0
            ;;
        *)
            CHECK_DETAIL="HTTP $code status=${status:-unknown}"
            return 1
            ;;
    esac
}

report() { # $1=name $2=0/1(OK) $3=detail
    if [ "$2" = "1" ]; then
        printf '%-8s : OK  %s\n' "$1" "$3"
    else
        printf '%-8s : NG  %s\n' "$1" "$3"
    fi
}

check_all() {
    local rc=0
    if check_web; then report local 1 "$CHECK_DETAIL"; else report local 0 "$CHECK_DETAIL"; rc=1; fi
    if check_auth; then report auth 1 "$CHECK_DETAIL"; else report auth 0 "$CHECK_DETAIL"; rc=1; fi
    if [ "$SKIP_PUBLIC" = "1" ]; then
        report public 1 "skip (TUNEDROP_WATCHDOG_SKIP_PUBLIC=1)"
    elif check_public; then
        report public 1 "$CHECK_DETAIL"
    else
        report public 0 "$CHECK_DETAIL"
        rc=1
    fi
    return $rc
}

# ----------------------------------------------------------
# 復旧処理
# ----------------------------------------------------------
network_online() {
    curl -sS -m 5 -o /dev/null "$ONLINE_URL" 2>/dev/null
}

can_restart() { # $1=target
    local file="$STATE_DIR/last-$1" now last
    now="$(date +%s)"
    last="$(cat "$file" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ $((now - last)) -lt "$COOLDOWN" ]; then
        RESTART_WAIT=$((COOLDOWN - (now - last)))
        return 1
    fi
    return 0
}

mark_restart() { # $1=target
    date +%s > "$STATE_DIR/last-$1" 2>/dev/null || true
}

# pgrep -f の一致プロセスを止める (自分自身は除外)。SIGTERM で終わらなければ SIGKILL。
terminate_pattern() {
    local pattern="$1" pids pid i alive
    pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
    [ -n "$pids" ] || return 0
    for pid in $pids; do
        [ "$pid" = "$$" ] && continue
        kill "$pid" 2>/dev/null || true
    done
    i=0
    while [ "$i" -lt 10 ]; do
        alive=0
        for pid in $pids; do
            if kill -0 "$pid" 2>/dev/null; then alive=1; fi
        done
        [ "$alive" = "0" ] && return 0
        sleep 0.5
        i=$((i + 1))
    done
    for pid in $pids; do
        [ "$pid" = "$$" ] && continue
        kill -9 "$pid" 2>/dev/null || true
    done
    return 0
}

# 指定ポートを掴んでいるプロセスを解放する (SIGTERM → SIGKILL)。
free_port() {
    local port="$1" pids pid i alive
    command -v lsof >/dev/null 2>&1 || return 0
    pids="$(lsof -ti ":$port" 2>/dev/null || true)"
    [ -n "$pids" ] || return 0
    for pid in $pids; do
        [ "$pid" = "$$" ] && continue
        kill "$pid" 2>/dev/null || true
    done
    i=0
    while [ "$i" -lt 6 ]; do
        alive=0
        for pid in $pids; do
            if kill -0 "$pid" 2>/dev/null; then alive=1; fi
        done
        [ "$alive" = "0" ] && return 0
        sleep 0.5
        i=$((i + 1))
    done
    for pid in $pids; do
        [ "$pid" = "$$" ] && continue
        kill -9 "$pid" 2>/dev/null || true
    done
}

stop_stack() {
    terminate_pattern "$ROOT/backend/start.py"
    terminate_pattern "$ROOT/backend/app.py"
    # start.py が落ちた後に残った PHP ワーカーも、このdocrootのものだけ止める。
    terminate_pattern "php.*$ROOT/backend/router.php"
    free_port 8888
    free_port 5050
    rm -f "$ROOT/.web_port" "$ROOT/.auth_port" 2>/dev/null || true
}

wait_for() { # $1=check関数名 $2=待つ秒数
    local fn="$1" limit="$2" elapsed=0
    while [ "$elapsed" -lt "$limit" ]; do
        if "$fn"; then return 0; fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    "$fn"
    return $?
}

restart_stack() {
    if ! can_restart stack; then
        log "stack: 再起動の間隔制限中 (あと ${RESTART_WAIT}秒)"
        return 1
    fi
    log "stack: Web/認証サーバーを再起動します"
    if [ "$DRY_RUN" = "1" ]; then
        log "stack: DRY_RUN のため実行しません"
        return 1
    fi
    mark_restart stack
    stop_stack
    rotate_log "$STACK_LOG"
    ( cd "$ROOT" && nohup /bin/bash "$DIR/start.sh" >> "$STACK_LOG" 2>&1 & echo $! > "$STATE_DIR/stack.pid" )
    if wait_for check_web "$START_TIMEOUT"; then
        local port
        port="$(read_port "$ROOT/.web_port" 8888)"
        log "stack: 復旧しました (port $port)"
        if [ "$port" != "8888" ]; then
            log "stack: 注意: 8888 が使用中のため port $port で起動しました。公開トンネルは 8888 固定のため、公開URLは復旧しません。8888 を空けて再起動してください"
        fi
        return 0
    fi
    log "stack: 起動後もローカルWebが応答しません ($STACK_LOG を確認してください)"
    return 1
}

restart_tunnel() {
    if ! network_online; then
        log "tunnel: ネットワークがオフラインのため再起動しません"
        return 1
    fi
    if ! can_restart tunnel; then
        log "tunnel: 再起動の間隔制限中 (あと ${RESTART_WAIT}秒)"
        return 1
    fi
    log "tunnel: 公開トンネルを再起動します"
    if [ "$DRY_RUN" = "1" ]; then
        log "tunnel: DRY_RUN のため実行しません"
        return 1
    fi
    mark_restart tunnel
    rotate_log "$LOG_FILE"
    "$DIR/tunnel.sh" restart >> "$LOG_FILE" 2>&1
    if wait_for check_public "$TUNNEL_TIMEOUT"; then
        log "tunnel: 復旧しました"
        return 0
    fi
    log "tunnel: 再起動後も公開URLが応答しません (~/.cloudflared/tunedrop-tunnel.log を確認)"
    return 1
}

# スワップ逼迫はサーバー自身では解消できないため、警告だけ残す (30分に1回)。
memory_warning() {
    local stats pct now last
    stats="$(sysctl -n vm.swapusage 2>/dev/null || true)"
    [ -n "$stats" ] || return 0
    pct="$(printf '%s' "$stats" | awk '{u=""; t=""; for(i=1;i<=NF;i++){if($i=="used")u=$(i+2); if($i=="total")t=$(i+2)} if(t+0>0){sub(/M$/,"",u); sub(/M$/,"",t); printf "%d", (u/t)*100}}')"
    case "$pct" in ''|*[!0-9]*) return 0 ;; esac
    [ "$pct" -ge 80 ] || return 0
    now="$(date +%s)"
    last="$(cat "$STATE_DIR/last-mem-warn" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ $((now - last)) -ge 1800 ]; then
        date +%s > "$STATE_DIR/last-mem-warn" 2>/dev/null || true
        log "memory: スワップ使用率 ${pct}% ($stats)。重いアプリを閉じてください"
    fi
}

# 同時実行 (launchd と手動) を防ぐ。持ち主が死んでいるロックは奪い直す。
acquire_lock() {
    local holder
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        printf '%s' "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
        return 0
    fi
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
        rm -rf "$LOCK_DIR" 2>/dev/null || true
        if mkdir "$LOCK_DIR" 2>/dev/null; then
            printf '%s' "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
            return 0
        fi
    fi
    return 1
}

release_lock() {
    if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" = "$$" ]; then
        rm -rf "$LOCK_DIR" 2>/dev/null || true
    fi
    return 0
}

cycle() {
    local rc=0 web_ok=0 auth_ok=0
    if ! acquire_lock; then
        log "cycle: 前回の処理が実行中のためスキップします"
        return 0
    fi
    rotate_log "$LOG_FILE"

    if check_web; then
        web_ok=1
        mark_state web up
    else
        mark_state web down
    fi
    if check_auth; then
        auth_ok=1
        mark_state auth up
    else
        mark_state auth down
    fi

    # Web と認証は同じ start.py が管理するため、どちらか落ちていれば1回だけ再起動する。
    if [ "$web_ok" = "0" ] || [ "$auth_ok" = "0" ]; then
        if restart_stack; then
            mark_state web up
            mark_state auth up
        else
            rc=1
        fi
    fi

    if [ "$SKIP_PUBLIC" != "1" ]; then
        if check_public; then
            mark_state public up
        else
            mark_state public down
            if check_web; then
                # 公開URLは 8888 へのトンネルを前提としている。ローカルWebが 8888 以外で
                # 起動しているときはトンネル側から 502 になるため、8888 を解放してスタックを再起動する。
                local web_p
                web_p="$(read_port "$ROOT/.web_port" 8888)"
                if [ -z "${TUNEDROP_WATCHDOG_LOCAL_URL:-}" ] && [ "$web_p" != "8888" ]; then
                    log "public: 公開トンネルは 8888 を要求しますが、Web は port $web_p で起動しています。8888 を解放してスタックを再起動します"
                    free_port 8888
                    if restart_stack; then
                        mark_state web up
                        mark_state auth up
                    else
                        rc=1
                    fi
                elif restart_tunnel; then
                    mark_state public up
                else
                    rc=1
                fi
            else
                log "tunnel: ローカルWebも落ちているためトンネル再起動は行いません"
                rc=1
            fi
        fi
    fi

    memory_warning
    release_lock
    return $rc
}

# ----------------------------------------------------------
# 常駐・確認
# ----------------------------------------------------------
start_sleep_guard() {
    [ "$PREVENT_SLEEP" = "1" ] || return 0
    command -v caffeinate >/dev/null 2>&1 || return 0
    caffeinate -s -w $$ >/dev/null 2>&1 &
    CAFFEINATE_PID=$!
    log "watchdog: caffeinate -s を有効化しました (PID $CAFFEINATE_PID)"
    # -s は「AC電源接続中」だけスリープを抑止する。バッテリー駆動では
    # アイドルスリープ（既定1分のことが多い）で公開が止まるため、警告を残す。
    if on_battery; then
        log "watchdog: バッテリー駆動です。スリープすると公開URLが停止します。電源に接続してください"
    fi
}

# バッテリー駆動なら 0 (true)
on_battery() {
    pmset -g batt 2>/dev/null | head -n 1 | grep -q 'Battery Power'
}

cleanup() {
    if [ -n "$CAFFEINATE_PID" ]; then
        kill "$CAFFEINATE_PID" 2>/dev/null || true
    fi
    release_lock
}

run_loop() {
    log "watchdog: 監視を開始します (interval ${INTERVAL}s / cooldown ${COOLDOWN}s / prevent_sleep=${PREVENT_SLEEP})"
    start_sleep_guard
    trap 'cleanup; exit 0' INT TERM
    while :; do
        cycle || true
        sleep "$INTERVAL" &
        wait $! 2>/dev/null || true
    done
}

pid_of_watchdog() {
    local pid cmd
    [ -f "$PID_FILE" ] || return 1
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null || return 1
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$cmd" in *watchdog.sh*) printf '%s' "$pid"; return 0 ;; esac
    return 1
}

start_watchdog() {
    local pid
    if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        echo "watchdog は launchd 管理下で動作しています（二重起動しません）"
        echo "状態: ./backend/watchdog.sh status"
        return 0
    fi
    if pid="$(pid_of_watchdog)"; then
        echo "watchdog は既に起動しています (PID $pid)"
        return 0
    fi
    mkdir -p "$STATE_DIR"
    nohup /bin/bash "$DIR/watchdog.sh" loop >> "$OUT_FILE" 2>&1 &
    pid=$!
    printf '%s' "$pid" > "$PID_FILE"
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
        echo "watchdog を開始しました (PID $pid)"
        echo "ログ: $LOG_FILE"
        return 0
    fi
    echo "watchdog の起動に失敗しました ($OUT_FILE を確認してください)" >&2
    return 1
}

stop_watchdog() {
    local pid
    if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        echo "watchdog は launchd 管理下です。停止するには ./backend/watchdog.sh uninstall を実行してください。"
        return 0
    fi
    if pid="$(pid_of_watchdog)"; then
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
        echo "watchdog を停止しました (PID $pid)"
    else
        echo "watchdog は起動していません"
    fi
    rm -f "$PID_FILE" 2>/dev/null || true
    rm -rf "$LOCK_DIR" 2>/dev/null || true
}

# 再起動時刻 (epoch) を人が読める形式にする。無ければ '-'.
last_restart_label() {
    local value
    value="$(cat "$STATE_DIR/last-$1" 2>/dev/null || true)"
    case "$value" in ''|*[!0-9]*) printf '%s' '-'; return 0 ;; esac
    date -r "$value" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || printf '%s' "$value"
}

show_status() {
    local pid swap rc
    printf 'watchdog : '
    pid="$(pgrep -f "$DIR/watchdog.sh loop" 2>/dev/null | head -n 1 || true)"
    if [ -z "$pid" ]; then pid="$(pid_of_watchdog || true)"; fi
    if [ -n "$pid" ]; then
        printf 'running (PID %s)\n' "$pid"
    elif command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        printf 'launchd 登録済み (loop 停止中)\n'
    else
        printf '停止中\n'
    fi
    pid="$(pgrep -f 'cloudflared tunnel run --token-file' 2>/dev/null | head -n 1 || true)"
    if [ -n "$pid" ]; then
        printf 'tunnel   : running (PID %s)\n' "$pid"
    else
        printf 'tunnel   : 停止中\n'
    fi
    pid="$(pgrep -f "$ROOT/backend/start.py" 2>/dev/null | head -n 1 || true)"
    if [ -n "$pid" ]; then
        printf 'stack    : running (PID %s, port %s)\n' "$pid" "$(read_port "$ROOT/.web_port" 8888)"
    else
        printf 'stack    : 停止中\n'
    fi
    swap="$(sysctl -n vm.swapusage 2>/dev/null || true)"
    printf 'swap     : %s\n' "${swap:-unknown}"
    printf 'power    : %s\n' "$(pmset -g batt 2>/dev/null | head -n 1 | sed "s/Now drawing from //; s/'//g" || echo unknown)"
    printf 'last     : stack=%s tunnel=%s\n' "$(last_restart_label stack)" "$(last_restart_label tunnel)"
    echo '--- health ---'
    check_all
    rc=$?
    if [ -f "$LOG_FILE" ]; then
        echo '--- log (tail 15) ---'
        tail -n 15 "$LOG_FILE"
    fi
    return $rc
}

# ----------------------------------------------------------
# macOS launchd (ログイン時起動 + 常時監視)
# ----------------------------------------------------------
install_agent() {
    local pid xml_root xml_state prevent_env i attempt
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "launchd は macOS 専用です。Linux では systemd のユニットで" >&2
        echo "  $DIR/watchdog.sh loop" >&2
        echo "を起動してください。" >&2
        return 1
    fi
    mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"
    if pid="$(pid_of_watchdog)"; then
        stop_watchdog >/dev/null
    fi
    xml_root="$(printf '%s' "$ROOT" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
    xml_state="$(printf '%s' "$STATE_DIR" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
    prevent_env=""
    if [ "$PREVENT_SLEEP" = "1" ]; then
        prevent_env="		<key>TUNEDROP_WATCHDOG_PREVENT_SLEEP</key>
		<string>1</string>"
    fi
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$xml_root/backend/watchdog.sh</string>
		<string>loop</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$xml_root</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
$prevent_env
	</dict>
	<key>StandardOutPath</key>
	<string>$xml_state/watchdog.out.log</string>
	<key>StandardErrorPath</key>
	<string>$xml_state/watchdog.out.log</string>
</dict>
</plist>
EOF
    chmod 644 "$PLIST" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    # bootout は非同期に完了する。直後に bootstrap すると
    # "Bootstrap failed: 5: Input/output error" になることがあるため、消えるまで待つ。
    i=0
    while launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do
        sleep 0.5
        i=$((i + 1))
    done
    attempt=0
    while [ "$attempt" -lt 3 ]; do
        launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 && break
        attempt=$((attempt + 1))
        sleep 1
    done
    if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        echo "launchd への登録に失敗しました: $PLIST" >&2
        echo "  launchctl bootstrap gui/$(id -u) \"$PLIST\" を手動で実行して原因を確認してください。" >&2
        return 1
    fi
    launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    echo "launchd に登録しました: $PLIST"
    echo "  ログイン時に watchdog が起動し、30秒ごとに監視・自動復旧します。"
    if [ "$PREVENT_SLEEP" = "1" ]; then
        echo "  AC電源接続中はスリープしません (caffeinate -s)。"
    fi
    echo "  状態: ./backend/watchdog.sh status"
    echo "  解除: ./backend/watchdog.sh uninstall"
    return 0
}

uninstall_agent() {
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST" 2>/dev/null || true
    echo "launchd から解除しました（ログは $STATE_DIR に残しています）"
    return 0
}

usage() {
    cat <<'EOF'
使い方:
  ./backend/watchdog.sh check       1回だけ確認 (再起動しない)
  ./backend/watchdog.sh once        1回だけ確認し、異常なら復旧する
  ./backend/watchdog.sh loop        30秒ごとに監視・復旧 (前面)
  ./backend/watchdog.sh start       loop をバックグラウンドで開始
  ./backend/watchdog.sh stop        loop を停止
  ./backend/watchdog.sh status      状態と直近のログ
  ./backend/watchdog.sh install [--prevent-sleep]
                                    macOS launchd へ登録 (ログイン時起動)
  ./backend/watchdog.sh uninstall   launchd から解除
EOF
}

once_cmd() {
    local rc rc2
    cycle
    rc=$?
    echo
    check_all
    rc2=$?
    if [ "$rc" -ne 0 ]; then return "$rc"; fi
    return "$rc2"
}

case "${1:-check}" in
    check)     check_all ;;
    once)      once_cmd ;;
    loop)      run_loop ;;
    start)     start_watchdog ;;
    stop)      stop_watchdog ;;
    status)    show_status ;;
    install)
        shift || true
        if [ "${1:-}" = "--prevent-sleep" ]; then PREVENT_SLEEP=1; fi
        install_agent
        ;;
    uninstall) uninstall_agent ;;
    -h|--help|help) usage ;;
    *)
        usage >&2
        exit 2
        ;;
esac



