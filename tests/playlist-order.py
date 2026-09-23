"""固定タブ (未整理 / 公開用お気に入り) が常に先頭2件に並ぶことを確認する。

ユーザー作成リストの sort_order (0,1,2...) と固定タブの sort_order (0,1) が
衝突すると、固定タブが1・2番目から外れて見える (並び替えがリセットされたように
見える) 不具合があった。get_playlists が固定タブを必ず先頭に固定し、
reorder_playlists が固定タブの枠ぶん番号をずらして保存することを検証する。
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'order.sqlite'
    api = Path(directory) / 'api.php'
    # CLI has no php://input; adapt only the HTTP request-body boundary.
    api.write_text((ROOT / 'api.php').read_text()
                   .replace("file_get_contents('php://input')", "getenv('TEST_BODY')"))
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','test-only')")
        # 固定タブ (先頭に固定されるべき2件)
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,system_key,sort_order)"
                   " VALUES (10,99,'未整理','Other',0,'inbox',0)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,system_key,sort_order)"
                   " VALUES (11,99,'公開用お気に入り','Other',0,'public_favorites',1)")
        # ユーザー作成リスト。sort_order が固定タブと衝突している状態 (旧データの再現)
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order)"
                   " VALUES (20,99,'Alpha','Other',0,0)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order)"
                   " VALUES (21,99,'Bravo','Other',0,1)")

    def request(action, body=None):
        script = '$_SERVER["REQUEST_METHOD"]=$argv[1]; $_GET=["action"=>$argv[2]]; require $argv[3];'
        return json.loads(subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', script,
             'POST' if body is not None else 'GET', action, str(api)],
            env={**os.environ, 'TUNEDROP_DB': str(database), 'TEST_BODY': json.dumps(body)}, text=True,
        ))

    def names():
        return [p['name'] for p in request('get_playlists')]

    # [1] 固定タブが必ず先頭2件 (sort_order の衝突に影響されない)
    assert names()[:2] == ['未整理', '公開用お気に入り'], names()

    # [2] 並び替えでユーザーリストの順序が保存され、リロード後も維持される
    assert request('reorder_playlists', {'ordered_ids': [21, 20]})['success'] is True
    assert names() == ['未整理', '公開用お気に入り', 'Bravo', 'Alpha'], names()
    with sqlite3.connect(database) as db:
        saved = dict(db.execute("SELECT id, sort_order FROM playlists WHERE user_id=99").fetchall())
    # 固定タブは 0/1 のまま、ユーザーリストはその続き (2,3) になる
    assert saved[10] == 0 and saved[11] == 1, saved
    assert saved[21] == 2 and saved[20] == 3, saved

    # [3] 新しいリストは末尾に追加される
    created = request('create_playlist', {'name': 'Charlie', 'category': 'Other', 'is_public': 0})
    assert created['success'] is True, created
    assert names() == ['未整理', '公開用お気に入り', 'Bravo', 'Alpha', 'Charlie'], names()

print('PASS: 固定タブは常に先頭2件で、ユーザーリストのカスタム順はリロード後も維持される。')
