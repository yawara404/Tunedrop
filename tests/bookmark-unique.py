"""同じリスト内の曲の重複登録を防ぎ、違うリストへの同じ曲の登録は許可する。

api.php の仕様:
  - 同じリスト内 (playlist_id, youtube_id) のユニーク索引で二重登録を防ぐ
  - 別のリストへ同じ曲を入れるのは許可する（ゲストも含む）
  - 旧仕様（ゲスト全リストで1曲1件）のトリガーは起動時に撤去される
  - 「すべてのブックマーク」表示は youtube_id ごとに1件へまとめる（最も古い MIN(id) の行）
  - 移動先のリストに同じ曲が既にある場合だけ move_bookmark を拒否する

実行: PHP_BIN=/Applications/MAMP/bin/php/php8.3.30/bin/php .venv/bin/python tests/bookmark-unique.py
"""
import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = tempfile.mkdtemp()
database = Path(TMP) / "unique.sqlite"
api = Path(TMP) / "api.php"
src = (ROOT / "api.php").read_text()
src = src.replace("file_get_contents('php://input')", "getenv('TEST_BODY')")
api.write_text(src)
con = sqlite3.connect(str(database))
con.executescript((ROOT / "setup.sql").read_text())
con.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','x')")
con.execute("INSERT INTO users (id,username,password_hash) VALUES (98,'regular','x')")
con.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (91,99,'GA',0)")
con.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (92,99,'GB',0)")
con.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (93,99,'GC',0)")
con.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (81,98,'RA',0)")
con.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (82,98,'RB',0)")
# 旧仕様の制約（ユニーク索引・ゲスト用トリガー）を外して、過去データの重複を作る
con.execute("DROP INDEX bookmarks_playlist_video_unique")
con.execute("DROP TRIGGER IF EXISTS bookmarks_guest_video_unique_insert")
con.execute("DROP TRIGGER IF EXISTS bookmarks_guest_video_unique_update")
con.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title) VALUES (50,91,'oldedupe0001','A')")
con.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title) VALUES (51,91,'oldedupe0001','B')")
con.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title) VALUES (52,91,'guestcross01','C')")
con.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title) VALUES (53,92,'guestcross01','D')")
con.commit()
con.close()


def req(action, body=None):
    code = '$_SERVER["REQUEST_METHOD"]=$argv[1]; $_GET=["action"=>$argv[2]]; require $argv[3];'
    args = [os.environ.get("PHP_BIN", "php"), "-r", code,
            "POST" if body is not None else "GET", action, str(api)]
    env = dict(os.environ)
    env["TUNEDROP_DB"] = str(database)
    env["TEST_BODY"] = json.dumps(body)
    out = subprocess.check_output(args, env=env, text=True)
    return json.loads(out)


def bookmark_ids(youtube_id):
    """その曲の行IDを返す（リスト横断の重複確認用）。"""
    with sqlite3.connect(str(database)) as db:
        return [r[0] for r in db.execute(
            "SELECT id FROM bookmarks WHERE youtube_id = ? ORDER BY id", (youtube_id,))]


# 閲覧時 (get_playlists) の移行処理で、同一リスト内の重複だけが整理される
req("get_playlists")
assert bookmark_ids("oldedupe0001") == [50], bookmark_ids("oldedupe0001")   # 最も古い行だけ残る
assert bookmark_ids("guestcross01") == [52, 53], bookmark_ids("guestcross01")  # 別リストは残す
with sqlite3.connect(str(database)) as db:
    trigs = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
    assert "bookmarks_guest_video_unique_insert" not in trigs, trigs
    assert "bookmarks_guest_video_unique_update" not in trigs, trigs
    indexes = {r[1] for r in db.execute("PRAGMA index_list(bookmarks)")}
    assert "bookmarks_playlist_video_unique" in indexes, indexes

# 同じリストへの二重登録は拒否する
first = req("add_bookmark", {"youtube_id": "newvideo0001", "playlist_id": 91, "title": "T", "channel": "C"})
assert first["success"] is True, first
second = req("add_bookmark", {"youtube_id": "newvideo0001", "playlist_id": 91, "title": "T", "channel": "C"})
assert second["success"] is False, second
assert "このリストに登録されています" in second["error"], second

# 別のリストへ同じ曲を入れるのは許可する
other = req("add_bookmark", {"youtube_id": "newvideo0001", "playlist_id": 92, "title": "T", "channel": "C"})
assert other["success"] is True, other
assert len(bookmark_ids("newvideo0001")) == 2, bookmark_ids("newvideo0001")
third = req("add_bookmark", {"youtube_id": "newvideo0001", "playlist_id": 92, "title": "T", "channel": "C"})
assert third["success"] is False, third

# DBレベルでも別リストなら作れる（旧トリガーは撤去済み）。同一リストの重複は作れない。
with sqlite3.connect(str(database)) as db:
    try:
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (93,'newvideo0001','X')")
    except sqlite3.IntegrityError as error:
        raise SystemExit("別リストへの同じ曲の登録は許可されるべき: %s" % error)
    try:
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (91,'newvideo0001','X')")
        raise SystemExit("同一リスト内の重複 INSERT は拒否されるべき")
    except sqlite3.IntegrityError:
        pass
assert len(bookmark_ids("newvideo0001")) == 3, bookmark_ids("newvideo0001")

# 同一リストへ重複させる UPDATE も拒否される
with sqlite3.connect(str(database)) as db:
    db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (81,'updatetest01','U1')")
    db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (82,'updatetest02','U2')")
    db.commit()
    uid = db.execute("SELECT id FROM bookmarks WHERE youtube_id='updatetest02'").fetchone()[0]
    try:
        db.execute("UPDATE bookmarks SET playlist_id=81, youtube_id='updatetest01' WHERE id=?", (uid,))
        raise SystemExit("同一リストへ重複させる UPDATE は拒否されるべき")
    except sqlite3.IntegrityError:
        pass

# 移動: 移動先に同じ曲が無ければ成功する
with sqlite3.connect(str(database)) as db:
    db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title) VALUES (60,91,'movecan0001','M')")
    db.commit()
moved = req("move_bookmark", {"id": 60, "target_playlist_id": 93})
assert moved["success"] is True, moved
with sqlite3.connect(str(database)) as db:
    assert db.execute("SELECT playlist_id FROM bookmarks WHERE id=60").fetchone()[0] == 93

# 移動先に同じ曲が既にある場合だけ拒否する
with sqlite3.connect(str(database)) as db:
    db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title) VALUES (61,92,'movecan0001','M2')")
    db.commit()
blocked = req("move_bookmark", {"id": 60, "target_playlist_id": 92})
assert blocked["success"] is False, blocked
assert "同じ曲が既にあります" in blocked["error"], blocked
with sqlite3.connect(str(database)) as db:
    assert db.execute("SELECT playlist_id FROM bookmarks WHERE id=60").fetchone()[0] == 93

# 同じリストへの移動（実質キャンセル）は許可する
same = req("move_bookmark", {"id": 60, "target_playlist_id": 93})
assert same["success"] is True, same

# 「すべてのブックマーク」表示は youtube_id ごとに1件へまとめる
tracks = req("get_my_bookmarks")
ids = [t["youtube_id"] for t in tracks]
assert ids.count("newvideo0001") == 1, ids
assert ids.count("movecan0001") == 1, ids
assert ids.count("guestcross01") == 1, ids

# 一般ユーザーも別リストへ同じ曲を入れてよい（同一リスト内のみ禁止）
with sqlite3.connect(str(database)) as db:
    db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (81,'regular001','R1')")
    db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (82,'regular001','R2')")
    db.commit()
    count = db.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='regular001'").fetchone()[0]
assert count == 2, count
print("PASS 同じリスト内の重複だけを防ぎ、別リストへの同じ曲の登録は許可される。")
