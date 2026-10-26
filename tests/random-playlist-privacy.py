"""「ランダム」名のリストを開いても、他人の非公開リストの曲が漏れないことを確認する。

get_my_bookmarks のランダム分岐は、以前は全ユーザーの bookmarks から抽選していたため、
名前が「ランダム」のリストを 1 つ作れば、他人の非公開リストの曲名・チャンネルを取得できた。
修正後は「自分が所有するリスト + 公開リスト」だけから抽選する。

実データは触らず、一時フォルダの DB と api.php だけで検証する。

実行: PHP_BIN="$(command -v php)" .venv/bin/python tests/random-playlist-privacy.py
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from php_auth_fixture import bearer, SECRET

ROOT = Path(__file__).resolve().parents[1]

MINE = 'MINEVID0001'
OTHER_PRIVATE = 'SECRETVID01'
OTHER_PUBLIC = 'PUBLICVID01'


def get_my_bookmarks(api, database, playlist_id, user_id=99):
    """api.php を CLI で実行し、get_my_bookmarks の JSON を返す。"""
    script = (
        '$_SERVER["REQUEST_METHOD"]="GET"; $_SERVER["HTTP_AUTHORIZATION"]=$argv[4];'
        '$_GET=json_decode($argv[2], true);'
        'ob_start(); require $argv[3]; $out = ob_get_clean();'
        'echo json_encode(json_decode($out, true));'
    )
    completed = subprocess.run(
        [os.environ.get('PHP_BIN', 'php'), '-r', script, 'GET',
         json.dumps({'action': 'get_my_bookmarks', 'playlist_id': str(playlist_id)}),
         str(api), bearer(user_id)],
        env={**os.environ, 'TUNEDROP_DB': str(database), 'SECRET_KEY': SECRET},
        text=True, capture_output=True, check=True,
    )
    return json.loads(completed.stdout)


def youtube_ids(tracks):
    return {track['youtube_id'] for track in tracks}


with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'privacy.sqlite'
    api = Path(directory) / 'api.php'
    # CLI には php://input が無いため、リクエストボディの境界だけ差し替える
    api.write_text((ROOT / 'api.php').read_text()
                   .replace("file_get_contents('php://input')", "getenv('TEST_BODY')"))

    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'me','test-only')")
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (98,'other','test-only')")
        playlists = [
            # (id, user_id, name, is_public, system_key)
            (91, 99, '未整理', 0, 'inbox'),
            (92, 99, '公開用お気に入り', 1, 'public_favorites'),
            (95, 99, 'ランダム5曲', 0, None),          # 自分が開く「ランダム」リスト
            (93, 98, '他人の非公開リスト', 0, None),
            (94, 98, '他人の公開リスト', 1, None),
            (96, 98, 'ランダム3曲', 1, None),          # 他人が公開している「ランダム」リスト
        ]
        for playlist_id, user_id, name, is_public, system_key in playlists:
            db.execute(
                "INSERT INTO playlists (id,user_id,name,category,is_public,is_favorite,system_key,sort_order)"
                " VALUES (?,?,?,'Other',?,0,?,0)",
                (playlist_id, user_id, name, is_public, system_key))
        bookmarks = [
            (91, MINE, '自分の曲'),
            (93, OTHER_PRIVATE, '他人の非公開の曲'),
            (94, OTHER_PUBLIC, '他人の公開の曲'),
        ]
        for playlist_id, youtube_id, title in bookmarks:
            db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,title,channel) VALUES (?,?,?,'ch')",
                       (playlist_id, youtube_id, title))

    # [1] 自分の「ランダム5曲」を開く: 自分の曲と公開曲だけが抽選対象になる
    tracks = get_my_bookmarks(api, database, 95)
    assert isinstance(tracks, list) and tracks, tracks
    ids = youtube_ids(tracks)
    assert OTHER_PRIVATE not in ids, ('他人の非公開リストの曲が漏れている', ids)
    assert MINE in ids, ('自分の曲が返っていない', ids)
    assert OTHER_PUBLIC in ids, ('公開リストの曲が返っていない', ids)

    # [2] 他人が公開している「ランダム3曲」を開く: 同じく非公開曲は混ざらない
    tracks = get_my_bookmarks(api, database, 96)
    assert isinstance(tracks, list) and tracks, tracks
    ids = youtube_ids(tracks)
    assert OTHER_PRIVATE not in ids, ('他人の非公開リストの曲が漏れている', ids)

    # [3] 通常の公開リストは従来どおり中身だけを返す (ランダム分岐に入らない)
    tracks = get_my_bookmarks(api, database, 94)
    assert youtube_ids(tracks) == {OTHER_PUBLIC}, tracks

print('PASS: random-named playlists never expose other users\' private bookmarks.')
