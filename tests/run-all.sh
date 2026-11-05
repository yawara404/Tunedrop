#!/usr/bin/env bash
# tests/run-all.sh: 全テストを一時 SQLite で実行する (実DBに触れない)。
#
# なぜ必要か:
#   .env に TUNEDROP_MYSQL_* があると、テストが本番 MySQL へ接続してしまう
#   (テストは一時 SQLite を前提に書かれている)。ここで MySQL 設定を空にして実行する。
#   シェルに TUNEDROP_MYSQL_* が残っている場合 (env で export した等) も同じく無効化する。
#
# 使い方:
#   ./tests/run-all.sh                    # tests/*.py を全部
#   ./tests/run-all.sh tests/genre-rules.py   # 指定したテストだけ
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
cd "$ROOT"

# テストは一時 SQLite を使う (本番 MySQL を汚さない)
export TUNEDROP_MYSQL_HOST=''
export TUNEDROP_MYSQL_PORT=''
export TUNEDROP_MYSQL_DATABASE=''
export TUNEDROP_MYSQL_USER=''
export TUNEDROP_MYSQL_PASSWORD=''

PHP_BIN="${PHP_BIN:-$ROOT/.php/bin/php}"
[ -x "$PHP_BIN" ] || PHP_BIN="$(command -v php)"
export PHP_BIN

PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
[ -x "$PYTHON" ] || PYTHON="$(command -v python3)"

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
    targets=("$DIR"/*.py)
fi

failed=0
ran=0
for test in "${targets[@]}"; do
    case "$(basename "$test")" in
        php_auth_fixture.py) continue ;;   # 共有ヘルパー (テスト本体ではない)
    esac
    ran=$((ran + 1))
    printf '== %s\n' "$(basename "$test")"
    if ! "$PYTHON" "$test"; then
        printf '!! FAILED: %s\n' "$test" >&2
        failed=$((failed + 1))
    fi
done

printf '\n結果: %d 件中 %d 件失敗\n' "$ran" "$failed"
[ "$failed" -eq 0 ]
