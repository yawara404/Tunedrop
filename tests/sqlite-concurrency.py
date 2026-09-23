"""MAMP(PHP/api.php) と Python(app.py) が同じ SQLite を共有しても固まらないことを確認する。

旧実装は次の理由でサイトが「起動しない」状態になっていた。

1. リクエストごとにテーブル作成・重複整理 (書き込み) を実行していた
2. ロールバックジャーナルのままだったため、書き込み中は読み取りも待たされた
3. PDO のロック待ちが長く、Apache の FastCGI idle timeout (30秒) を超えて
   応答が返らなくなっていた

修正後は WAL + busy_timeout + スキーマ版 (user_version) により、
「読み取りは待たされない」「書き込みは待ち切れなければ短時間で 503 を返す」。

実行: PHP_BIN=/Applications/MAMP/bin/php/php8.3.30/bin/php .venv/bin/python tests/sqlite-concurrency.py
"""
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
# api.php の TUNEDROP_SCHEMA_VERSION と同期させる (ベタ書きだと更新時にずれる)
SCHEMA_VERSION = int(re.search(
    r'const TUNEDROP_SCHEMA_VERSION\s*=\s*(\d+)',
    (ROOT / 'api.php').read_text(encoding='utf-8')).group(1))
BUSY_TIMEOUT_WAIT = 5      # api.php の TUNEDROP_BUSY_TIMEOUT_MS と合わせる
MAX_ACCEPTABLE_SECONDS = 15  # FastCGI idle timeout (30秒) より十分短いこと


def php_request(api, action, database, body=None, timeout=30):
    """api.php を CLI で実行し、HTTPステータスと JSON ボディを返す。"""
    script = (
        '$_SERVER["REQUEST_METHOD"]=$argv[1]; $_GET=["action"=>$argv[2]];'
        'ob_start(); require $argv[3]; $out = ob_get_clean();'
        # CLI では未設定時の http_response_code() が false になるため 200 に読み替える
        '$code = http_response_code();'
        'echo json_encode(["code" => $code === false ? 200 : $code, "body" => json_decode($out, true)]);'
    )
    started = time.monotonic()
    completed = subprocess.run(
        [os.environ.get('PHP_BIN', 'php'), '-r', script,
         'POST' if body is not None else 'GET', action, str(api)],
        env={**os.environ, 'TUNEDROP_DB': str(database), 'TEST_BODY': json.dumps(body)},
        text=True, capture_output=True, timeout=timeout, check=True,
    )
    elapsed = time.monotonic() - started
    payload = json.loads(completed.stdout)
    return payload['code'], payload['body'], elapsed


with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'concurrency.sqlite'
    api = Path(directory) / 'api.php'
    # CLI には php://input が無いため、リクエストボディの境界だけ差し替える
    api.write_text((ROOT / 'api.php').read_text()
                   .replace("file_get_contents('php://input')", "getenv('TEST_BODY')"))

    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','test-only')")
        # 固定タブを用意しておき、閲覧だけのリクエストでは書き込みが発生しない状態にする
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,is_favorite,system_key,sort_order)"
                   " VALUES (91,99,'未整理','Other',0,0,'inbox',0)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,is_favorite,system_key,sort_order)"
                   " VALUES (92,99,'公開用お気に入り','J-POP',1,1,'public_favorites',1)")

    # [1] 初回リクエストでスキーマを最新化し、WAL になっていること
    code, body, _ = php_request(api, 'get_playlists', database)
    assert code == 200, (code, body)
    assert isinstance(body, list) and body, body
    with sqlite3.connect(database) as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0].lower() == 'wal', 'WALになっていない'
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION, 'スキーマ版が記録されていない'
        version_before = db.execute("PRAGMA data_version").fetchone()[0]

    # [2] 閲覧リクエストは書き込みを行わない (DBが更新されない)
    code, body, _ = php_request(api, 'get_playlists', database)
    assert code == 200 and isinstance(body, list), (code, body)
    with sqlite3.connect(database) as db:
        version_after = db.execute("PRAGMA data_version").fetchone()[0]
    assert version_after == version_before, '閲覧だけでDBが書き換わっている (リクエストごとの書き込みが残っている)'

    # [3] 他プロセスが書き込みロックを持っていても読み取りは待たされない (WAL)
    holder = sqlite3.connect(database)
    try:
        holder.execute("BEGIN IMMEDIATE")
        holder.execute("UPDATE playlists SET sort_order = sort_order WHERE id = 91")
        code, body, elapsed = php_request(api, 'get_playlists', database, timeout=20)
        assert code == 200 and isinstance(body, list), (code, body)
        assert elapsed < MAX_ACCEPTABLE_SECONDS, f'読み取りが待たされた: {elapsed:.1f}s'

        # [4] 書き込みはロック待ちで固まらず、短時間で 503 + retryable を返す
        code, body, elapsed = php_request(
            api, 'reorder_playlists', database, body={'ordered_ids': [91, 92]}, timeout=25)
        assert code == 503, (code, body)
        assert isinstance(body, dict) and body.get('retryable') is True, body
        assert elapsed < BUSY_TIMEOUT_WAIT + MAX_ACCEPTABLE_SECONDS, f'書き込みが固まった: {elapsed:.1f}s'
    finally:
        holder.rollback()
        holder.close()

    # [5] ロックが解放されれば即座に成功する (再試行で復帰できる)
    code, body, elapsed = php_request(
        api, 'reorder_playlists', database, body={'ordered_ids': [91, 92]}, timeout=20)
    assert code == 200 and body == {'success': True}, (code, body)
    assert elapsed < MAX_ACCEPTABLE_SECONDS, f'解放後の書き込みが遅い: {elapsed:.1f}s'

print('PASS: WAL + busy_timeout + スキーマ版で、閲覧は待たされず書き込みは短時間で復帰可能なエラーを返す。')