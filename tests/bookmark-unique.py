"""同じリスト内で同じ曲 (youtube_id) が重複しないことを確認する。

- add_bookmark: 同じリストへの2回目の追加は拒否され、別リストへの追加は許可される
- 修正前のDBに同一リスト内の重複が残っていてもマイグレーションで掃除される
- move_bookmark: 移動先に同じ曲がある場合は移動できず、無ければ移動できる
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'unique.sqlite'
    api = Path(directory) / 'api.php'
    # CLI has no php://input; adapt only the HTTP request-body boundary.
    source = (ROOT / 'api.php').read_text().replace("file_get_contents('php://input')", "getenv('TEST_BODY')")
    api.write_text(source)
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        # ブックマーク操作は require_user_or_guest 経由で guest ユーザーとして走る
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','test-only')")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (91,99,'Guest list A',0)")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (92,99,'Guest list B',0)")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (93,99,'Guest list C',0)")
        # 索引が無い時代のDBに残っていた「同一リスト内の重複」を再現する
        db.execute("DROP INDEX bookmarks_playlist_video_unique")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title) VALUES (50,91,'oldedupe0001','Old dup A')")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title) VALUES (51,91,'oldedupe0001','Old dup B')")
        db.commit()

    def request(action, body=None):
        script = '$_SERVER["REQUEST_METHOD"]=$argv[1]; $_GET=["action"=>$argv[2]]; require $argv[3];'
        return json.loads(subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', script, 'POST' if body is not None else 'GET', action, str(api)],
            env={**os.environ, 'TUNEDROP_DB': str(database), 'TEST_BODY': json.dumps(body)}, text=True,
        ))

    # どのリクエストでも最初にマイグレーションが走り、同一リスト内の重複は最も古い行だけ残る
    request('get_playlists')
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='oldedupe0001'").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM bookmarks WHERE id=50").fetchone()[0] == 1
        assert db.execute(
            "SELECT COUNT(*) FROM bookmarks GROUP BY playlist_id, youtube_id HAVING COUNT(*) > 1"
        ).fetchall() == []
        assert db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='bookmarks_playlist_video_unique'"
        ).fetchone()[0] == 1

    # 新しい曲を Guest list A に追加 → 成功
    first = request('add_bookmark', {'youtube_id': 'newvideo0001', 'playlist_id': 91, 'title': 'New Video', 'channel': 'Test Channel'})
    assert first['success'] is True, first

    # 同じリストへもう一度追加 → 拒否され、重複行は増えない
    second = request('add_bookmark', {'youtube_id': 'newvideo0001', 'playlist_id': 91, 'title': 'New Video', 'channel': 'Test Channel'})
    assert second['success'] is False and '既に' in second['error'], second
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT COUNT(*) FROM bookmarks WHERE playlist_id=91 AND youtube_id='newvideo0001'").fetchone()[0] == 1

    # 別リスト (Guest list B) への同じ曲の追加は許可される
    other = request('add_bookmark', {'youtube_id': 'newvideo0001', 'playlist_id': 92, 'title': 'New Video', 'channel': 'Test Channel'})
    assert other['success'] is True, other
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='newvideo0001'").fetchone()[0] == 2

    with sqlite3.connect(database) as db:
        row = db.execute("SELECT id FROM bookmarks WHERE playlist_id=91 AND youtube_id='newvideo0001'").fetchone()
        bookmark_in_a = row[0]

    # 移動先 (Guest list B) に同じ曲がある場合は移動できない
    blocked_move = request('move_bookmark', {'id': bookmark_in_a, 'target_playlist_id': 92})
    assert blocked_move['success'] is False and '移動先' in blocked_move['error'], blocked_move
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT playlist_id FROM bookmarks WHERE id=?", (bookmark_in_a,)).fetchone()[0] == 91

    # 移動先 (Guest list C) に同じ曲がなければ移動できる
    moved = request('move_bookmark', {'id': bookmark_in_a, 'target_playlist_id': 93})
    assert moved['success'] is True, moved
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT playlist_id FROM bookmarks WHERE id=?", (bookmark_in_a,)).fetchone()[0] == 93
        assert db.execute(
            "SELECT COUNT(*) FROM bookmarks GROUP BY playlist_id, youtube_id HAVING COUNT(*) > 1"
        ).fetchall() == []

    # 同じ曲でも他ユーザー (setup.sql の user 1) のリストには影響しない
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT COUNT(*) FROM bookmarks WHERE playlist_id=2 AND youtube_id='uSijY6BEMRE'").fetchone()[0] == 1

print('PASS: 同じリスト内で曲が重複せず、別リストへの登録は引き続き許可される。')