"""Exercise favorite persistence without changing the live database."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'favorites.sqlite'
    api = Path(directory) / 'api.php'
    # CLI has no php://input; adapt only the HTTP request-body boundary.
    source = (ROOT / 'api.php').read_text().replace("file_get_contents('php://input')", "getenv('TEST_BODY')")
    api.write_text(source)
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','test-only')")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (99,99,'Guest private',0)")
        # 他ユーザー (user 1) が作成した公開リスト。固定タブではないので共有一覧に出る。
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (30,1,'Shared public',1)")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id) VALUES (30,30,'shared-track')")
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id) VALUES (1,'private-track')")

    def request(action, body=None, playlist='null', video=''):
        script = '$_SERVER["REQUEST_METHOD"]=$argv[1]; $_GET=["action"=>$argv[2],"playlist_id"=>$argv[3]]; if ($argv[5]) $_GET["youtube_id"]=$argv[5]; require $argv[4];'
        return json.loads(subprocess.check_output(
            ['php', '-r', script, 'POST' if body is not None else 'GET', action, str(playlist), str(api), video],
            env={**os.environ, 'TUNEDROP_DB': str(database), 'TEST_BODY': json.dumps(body)}, text=True,
        ))

    # 固定タブは各ユーザー専用のため、他人の固定タブ (id 2) はお気に入りに追加できない
    assert request('toggle_favorite_playlist', {'id':2})['success'] is False

    for kind, action, target in [('playlist','toggle_favorite_playlist',30), ('track','toggle_favorite_bookmark',1)]:
        result = request(action, {'id':target})
        assert result['success'] and result['is_favorite'] == 1
        if kind == 'playlist':
            saved = next(p for p in request('get_public_playlists') if p['id'] == 30)
            assert saved['is_favorite'] == 1
            assert [p['id'] for p in request('get_playlists') if p['id'] == 30] == [30]
        else:
            assert next(t for t in request('get_my_bookmarks', playlist=2) if t['id']==1)['is_favorite'] == 1
            assert [t['id'] for t in request('get_my_bookmarks', playlist='fav_tracks')] == [1]
        assert request(action, {'id':target})['is_favorite'] == 0
    # The Radar/mobile player passes a video ID, and reloads its saved state.
    video = 'uSijY6BEMRE'
    assert request('get_track_favorite', video=video)['is_favorite'] == 0
    assert request('toggle_favorite_bookmark', {'youtube_id':video})['is_favorite'] == 1
    assert request('get_track_favorite', video=video)['is_favorite'] == 1
    assert request('toggle_favorite_bookmark', {'youtube_id':video})['is_favorite'] == 0
    assert request('get_track_favorite', video=video)['is_favorite'] == 0
    assert request('toggle_favorite_bookmark', {'youtube_id':'private-track'})['success'] is False
    assert request('toggle_favorite_playlist', {'id':1})['success'] is False
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT is_favorite FROM playlists WHERE id=2').fetchone()[0] == 0
        assert db.execute('SELECT is_favorite FROM bookmarks WHERE id=1').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM public_favorites').fetchone()[0] == 0
print('PASS: playlist/track favorites persist per viewer, appear in favorites, toggle off, stay out of other users\' fixed tabs, and leave owner data unchanged.')
