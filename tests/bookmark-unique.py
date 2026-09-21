"""Guest holds each song at most once across all lists."""
import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path

ROOT = Path("/Users/<username>/Tunedrop")
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
    args = ["php", "-r", code, "POST" if body is not None else "GET", action, str(api)]
    env = dict(os.environ)
    env["TUNEDROP_DB"] = str(database)
    env["TEST_BODY"] = json.dumps(body)
    out = subprocess.check_output(args, env=env, text=True)
    return json.loads(out)


req("get_playlists")
con = sqlite3.connect(str(database))
assert con.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='oldedupe0001'").fetchone()[0] == 1
assert con.execute("SELECT COUNT(*) FROM bookmarks WHERE id=50").fetchone()[0] == 1
assert con.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='guestcross01'").fetchone()[0] == 1
assert con.execute("SELECT COUNT(*) FROM bookmarks WHERE id=52").fetchone()[0] == 1
trigs = set(r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall())
assert "bookmarks_guest_video_unique_insert" in trigs, trigs
assert "bookmarks_guest_video_unique_update" in trigs, trigs
con.close()
first = req("add_bookmark", {"youtube_id": "newvideo0001", "playlist_id": 91, "title": "T", "channel": "C"})
assert first["success"] is True, first
second = req("add_bookmark", {"youtube_id": "newvideo0001", "playlist_id": 91, "title": "T", "channel": "C"})
assert second["success"] is False, second
other = req("add_bookmark", {"youtube_id": "newvideo0001", "playlist_id": 92, "title": "T", "channel": "C"})
assert other["success"] is False, other
assert "別のリスト" in other["error"], other
con = sqlite3.connect(str(database))
assert con.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='newvideo0001'").fetchone()[0] == 1
bid = con.execute("SELECT id FROM bookmarks WHERE playlist_id=91 AND youtube_id='newvideo0001'").fetchone()[0]
con.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (91,'movecan0001','M')")
con.commit()
movable = con.execute("SELECT id FROM bookmarks WHERE playlist_id=91 AND youtube_id='movecan0001'").fetchone()[0]
con.close()
moved = req("move_bookmark", {"id": movable, "target_playlist_id": 93})
assert moved["success"] is True, moved
con = sqlite3.connect(str(database))
assert con.execute("SELECT playlist_id FROM bookmarks WHERE id=?", (movable,)).fetchone()[0] == 93
con.close()
blocked = req("move_bookmark", {"id": movable, "target_playlist_id": 92})
assert blocked["success"] is True, blocked
# ゲストは全リストで1曲1件のため、移動は常に安全 (移動先に同じ曲がある状態自体が重複であり、
# マイグレーションで整理される)。移動後も重複が無いことを確認する。
con = sqlite3.connect(str(database))
assert con.execute("SELECT playlist_id FROM bookmarks WHERE id=?", (movable,)).fetchone()[0] == 92
assert con.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='movecan0001'").fetchone()[0] == 1
con.close()
blocked2 = req("move_bookmark", {"id": movable, "target_playlist_id": 93})
assert blocked2["success"] is True, blocked2
con = sqlite3.connect(str(database))
assert con.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='movecan0001'").fetchone()[0] == 1
con.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (91,'updatetest01','U1')")
con.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (92,'updatetest02','U2')")
con.commit()
uid = con.execute("SELECT id FROM bookmarks WHERE youtube_id='updatetest02'").fetchone()[0]
try:
    con.execute("UPDATE bookmarks SET youtube_id='updatetest01' WHERE id=?", (uid,))
    con.commit()
    raise SystemExit("direct cross-list update should fail")
except sqlite3.IntegrityError as e:
    assert "guest_duplicate_video" in str(e), e
    con.rollback()
con = sqlite3.connect(str(database))
try:
    con.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (92,'newvideo0001','X')")
    con.commit()
    raise SystemExit("direct duplicate insert should fail")
except sqlite3.IntegrityError as e:
    assert "guest_duplicate_video" in str(e), e
con.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (81,'regular001','R1')")
con.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (82,'regular001','R2')")
con.commit()
assert con.execute("SELECT COUNT(*) FROM bookmarks WHERE youtube_id='regular001'").fetchone()[0] == 2
con.close()
print("PASS guest-all-lists unique")
