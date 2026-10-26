"""Radar のお気に入り: 解析済みで Radar に出る曲は自分の未整理へコピーし、未解析の非公開曲は拒否する。"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from php_auth_fixture import bearer, SECRET

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'radar-favorite.sqlite'
    api = Path(directory) / 'api.php'
    # CLI には php://input が無いため、HTTP の本文境界だけテスト用に差し替える。
    source = (ROOT / 'api.php').read_text().replace("file_get_contents('php://input')", "getenv('TEST_BODY')")
    api.write_text(source)
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','test-only')")
        # 他ユーザー (1) の非公開リスト曲。解析前は Radar に出ない = お気に入り不可。
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (40,1,'private',0)")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel) "
                   "VALUES (400,40,'unanalyzed-private','未解析','Artist')")
        # 解析済み = Radar に出る非公開曲。お気に入り時に閲覧者の未整理へコピーする。
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (41,1,'radar private',0)")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel) "
                   "VALUES (401,41,'radar-private','Radar Private','Radar Artist')")
        db.execute("INSERT INTO analysis_cache (youtube_id,data,updated_at) VALUES ('radar-private','{}',0)")
        # 公開曲と、閲覧者自身の非公開曲。
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (42,1,'public',1)")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel) "
                   "VALUES (402,42,'public-track','Public','Artist')")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (43,99,'mine',0)")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel) "
                   "VALUES (403,43,'own-private','Mine','Artist')")

    def request(action, body=None, playlist='null', video=''):
        script = ('$_SERVER["REQUEST_METHOD"]=$argv[1]; $_SERVER["HTTP_AUTHORIZATION"]=$argv[6]; '
                  '$_GET=["action"=>$argv[2],"playlist_id"=>$argv[3]]; if ($argv[5]) $_GET["youtube_id"]=$argv[5]; '
                  'require $argv[4];')
        return json.loads(subprocess.check_output(
            ['php', '-r', script, 'POST' if body is not None else 'GET', action, str(playlist), str(api), video, bearer()],
            env={**os.environ, 'TUNEDROP_DB': str(database), 'TEST_BODY': json.dumps(body), 'SECRET_KEY': SECRET},
            text=True,
        ))

    # 未解析の非公開曲は Radar に出ないため、従来どおり拒否する。
    assert request('get_track_favorite', video='unanalyzed-private')['success'] is False
    assert request('toggle_favorite_bookmark', {'youtube_id': 'unanalyzed-private'})['success'] is False

    # Radar に出る解析済みの非公開曲は、閲覧者の未整理へコピーしてお気に入りにできる。
    first = request('get_track_favorite', video='radar-private')
    assert first['success'] is True and first['is_favorite'] == 0, first
    toggled = request('toggle_favorite_bookmark', {'youtube_id': 'radar-private'})
    assert toggled['success'] is True and toggled['is_favorite'] == 1, toggled
    assert request('get_track_favorite', video='radar-private')['is_favorite'] == 1
    assert 'radar-private' in {track['youtube_id'] for track in request('get_my_bookmarks', playlist='fav_tracks')}

    with sqlite3.connect(database) as db:
        row = db.execute(
            "SELECT b.title, b.channel, b.is_favorite, p.system_key FROM bookmarks b "
            "JOIN playlists p ON p.id=b.playlist_id WHERE b.youtube_id='radar-private' AND p.user_id=99"
        ).fetchone()
        assert row == ('Radar Private', 'Radar Artist', 1, 'inbox'), row
        # 非公開リスト由来なので public_favorites には入れない。
        assert db.execute("SELECT COUNT(*) FROM public_favorites WHERE user_id=99").fetchone()[0] == 0

    # 数値 ID は他人の非公開行を推測できるためコピーしない。
    assert request('toggle_favorite_bookmark', {'id': 401})['success'] is False

    # 公開曲・自分の曲も従来どおりお気に入りにできる。
    assert request('toggle_favorite_bookmark', {'youtube_id': 'public-track'})['is_favorite'] == 1
    assert request('toggle_favorite_bookmark', {'youtube_id': 'own-private'})['is_favorite'] == 1
    assert {track['youtube_id'] for track in request('get_my_bookmarks', playlist='fav_tracks')} == {
        'radar-private', 'public-track', 'own-private'}

    assert request('toggle_favorite_bookmark', {'youtube_id': 'radar-private'})['is_favorite'] == 0
    assert request('toggle_favorite_bookmark', {'youtube_id': 'public-track'})['is_favorite'] == 0
    assert request('toggle_favorite_bookmark', {'youtube_id': 'own-private'})['is_favorite'] == 0
print('PASS: Radar の解析済み曲はお気に入りにでき (未整理へコピー)、未解析の非公開曲と数値IDは拒否する。')
