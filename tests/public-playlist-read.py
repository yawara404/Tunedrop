"""Public playlist details are readable; another user's private tracks are not."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'public-read.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','test-only')")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (99,99,'Guest private',0)")
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id) VALUES (99,'guest-track')")
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id) VALUES (1,'private-track')")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (20,1,'Public five',1)")
        for i in range(5):
            db.execute('INSERT INTO bookmarks (playlist_id,youtube_id,sort_order) VALUES (20,?,?)', (f'public-{i}', i))

    def read(playlist):
        code = '$_SERVER["REQUEST_METHOD"]="GET"; $_GET=["action"=>"get_my_bookmarks","playlist_id"=>$argv[1]]; require $argv[2];'
        return json.loads(subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', code, str(playlist), str(ROOT / 'api.php')],
            env={**os.environ, 'TUNEDROP_DB': str(database)}, text=True,
        ))

    assert [t['youtube_id'] for t in read(20)] == [f'public-{i}' for i in range(5)]
    assert read(1) == []
    assert [t['youtube_id'] for t in read(99)] == ['guest-track']
    assert [t['youtube_id'] for t in read('null')] == ['guest-track']
    assert read(9999) == []
print('PASS: public playlist returns all five tracks; private and all-library reads stay scoped to the viewer.')
