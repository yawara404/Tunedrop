"""Exercise playlist cover responses against an isolated SQLite database."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'covers.sqlite'
    db = sqlite3.connect(database)
    db.executescript((ROOT / 'setup.sql').read_text())
    # 閲覧者 (ログインなしで使われる共通ゲストユーザー) の固定タブ
    db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','test-only')")
    db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,cover_id,is_favorite,sort_order,system_key) "
               "VALUES (50,99,'未整理','Other',0,NULL,0,0,'inbox')")
    db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,cover_id,is_favorite,sort_order,system_key) "
               "VALUES (51,99,'公開用お気に入り','J-POP',1,NULL,1,1,'public_favorites')")
    # 他ユーザーが作成した公開リスト (共有一覧に出る側)
    db.execute("INSERT INTO playlists (id,user_id,name,cover_id,is_public) VALUES (3,1,'Custom','custom-cover',1)")
    db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,added_at) VALUES (10,50,'latest','2000-01-02 00:00:00')")
    db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,added_at) VALUES (11,50,'older','2000-01-01 00:00:00')")
    db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,added_at) VALUES (12,51,'tie-a','2000-01-03 00:00:00')")
    db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,added_at) VALUES (13,51,'tie-b','2000-01-03 00:00:00')")
    db.commit()

    def playlists(action='get_playlists'):
        script = '$_SERVER["REQUEST_METHOD"]="GET"; $_GET["action"]=$argv[1]; require $argv[2];'
        output = subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', script, action, str(ROOT / 'api.php')],
            env={**os.environ, 'TUNEDROP_DB': str(database)}, text=True,
        )
        return {row['id']: row for row in json.loads(output)}

    rows = playlists()
    assert rows[50]['cover_id'] == 'latest'  # Timestamp wins over ID/order.
    assert rows[51]['cover_id'] == 'tie-b'   # Same timestamp: higher ID wins.
    for endpoint in ('get_public_playlists', 'get_recent_playlists'):
        public = playlists(endpoint)
        assert public[3]['cover_id'] == 'custom-cover'     # 手動設定が残る
        assert not any(row['system_key'] for row in public.values())  # 固定タブは共有しない

    # Use the API's actual move statement to verify playlist arrival ordering.
    source = (ROOT / 'api.php').read_text()
    move_sql = source.split('$db->prepare("UPDATE bookmarks SET added_at = ', 1)[1].split('");', 1)[0]
    db.execute('UPDATE bookmarks SET added_at = ' + move_sql, (50, 50, 12, 99))  # tie-a を未整理へ移動
    db.commit()
    assert playlists()[50]['cover_id'] == 'tie-a'
    db.execute('DELETE FROM bookmarks WHERE id=12')
    db.commit()
    assert playlists()[50]['cover_id'] == 'latest'
    db.execute('DELETE FROM bookmarks WHERE playlist_id=50')
    db.commit()
    assert playlists()[50]['cover_id'] is None
    assert playlists('get_public_playlists')[3]['cover_id'] == 'custom-cover'
    db.close()
print('PASS: latest additions, timestamp ties, moves, deletions, empty lists, public responses, custom covers.')
