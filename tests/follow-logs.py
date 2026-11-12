"""フォロー API とプロフィール簡易ログ (get_profile_activity) の検証。

実DBには触れず、一時 SQLite と CLI PHP で確認する:
  - フォロー / 解除で件数と is_following が変わる
  - フォロー中 / フォロワー一覧が正しい向きで返る
  - ゲスト・自分自身・存在しないユーザーはフォローできない
  - 保存曲 / プレイリスト / お気に入りの簡易ログが新しい順に返る
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

from php_auth_fixture import bearer, SECRET

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'follow.sqlite'
    api = Path(directory) / 'api.php'
    api.write_text((ROOT / 'backend' / 'api.php').read_text()
                   .replace("file_get_contents('php://input')", "getenv('TEST_BODY')"))
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'backend' / 'setup.sql').read_text())
        db.execute("CREATE TABLE IF NOT EXISTS public_favorites ("
                   " user_id INTEGER NOT NULL, kind TEXT NOT NULL, target_id INTEGER NOT NULL,"
                   " PRIMARY KEY(user_id, kind, target_id))")
        db.execute("INSERT INTO users (id,username,password_hash,created_at)"
                   " VALUES (500,'guest_abc','x','2026-01-01 00:00:00')")
        db.execute("INSERT INTO users (id,username,password_hash,created_at)"
                   " VALUES (501,'alice','x','2026-01-01 00:00:00')")
        db.execute("INSERT INTO users (id,username,password_hash,created_at)"
                   " VALUES (502,'bob','x','2026-01-01 00:00:00')")
        # alice: 公開リスト (古い) / 非公開リスト (新しい) / 固定タブ
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order,created_at)"
                   " VALUES (510,501,'Alice Public','J-POP',1,2,'2026-01-02 10:00:00')")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order,created_at)"
                   " VALUES (512,501,'Alice Private','Other',0,3,'2026-01-03 10:00:00')")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,system_key,sort_order,created_at)"
                   " VALUES (513,501,'未整理','Other',0,'inbox',0,'2026-01-04 10:00:00')")
        # bob: 公開リスト
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order,created_at)"
                   " VALUES (511,502,'Bob Public','Other',1,2,'2026-01-02 12:00:00')")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel,is_favorite,added_at)"
                   " VALUES (101,510,'aaaaaaaaaaa','Alice A','A',1,'2026-01-02 11:00:00')")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel,added_at)"
                   " VALUES (102,510,'bbbbbbbbbbb','Alice B','B','2026-01-03 11:00:00')")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel,is_favorite,added_at)"
                   " VALUES (103,512,'ccccccccccc','Alice Private C','C',1,'2026-01-04 11:00:00')")
        db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel,added_at)"
                   " VALUES (104,511,'ddddddddddd','Bob D','D','2026-01-05 11:00:00')")
        # alice が bob の公開曲と公開リストをお気に入りにしている
        db.execute("INSERT INTO public_favorites (user_id,kind,target_id) VALUES (501,'track',104)")
        db.execute("INSERT INTO public_favorites (user_id,kind,target_id) VALUES (501,'playlist',511)")

    def request(action, body=None, qs='', user_id=501):
        script = ('$_SERVER["REQUEST_METHOD"]=$argv[1]; $_SERVER["HTTP_AUTHORIZATION"]=$argv[5];'
                  '$_GET=["action"=>$argv[2]];'
                  'parse_str(ltrim($argv[4] ?? "", "&"), $extra); $_GET += $extra; require $argv[3];')
        output = subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', script,
             'POST' if body is not None else 'GET', action, str(api), qs, bearer(user_id)],
            env={**os.environ, 'TUNEDROP_DB': str(database),
                 'TEST_BODY': json.dumps(body), 'SECRET_KEY': SECRET},
            text=True,
        )
        return json.loads(output)

    # --- フォロー ---
    followed = request('follow_user', body={'user_id': 502})
    assert followed['success'] is True, followed
    assert followed['is_following'] == 1, followed
    assert followed['following'] == 1 and followed['followers'] == 1, followed
    # 二重フォローでも件数は増えない
    assert request('follow_user', body={'user_id': 502})['following'] == 1

    overview = request('get_follow_overview')
    assert overview['counts'] == {'following': 1, 'followers': 0}, overview['counts']
    assert [u['id'] for u in overview['following']] == [502], overview['following']
    assert overview['following'][0]['is_following'] == 1, overview['following']

    bob_overview = request('get_follow_overview', qs='&user_id=502')
    assert bob_overview['counts'] == {'following': 0, 'followers': 1}, bob_overview['counts']
    assert [u['id'] for u in bob_overview['followers']] == [501], bob_overview['followers']

    profile = request('get_user_profile', qs='&user_id=502')
    assert profile['user']['is_following'] == 1, profile['user']
    assert profile['user']['stats']['followers'] == 1, profile['user']['stats']
    assert profile['user']['stats']['following'] == 0, profile['user']['stats']

    # 自分自身 / ゲスト / 存在しないユーザーはフォローできない
    assert 'error' in request('follow_user', body={'user_id': 501}), '自分自身は不可'
    assert 'error' in request('follow_user', body={'user_id': 502}, user_id=500), 'ゲストは不可'
    assert 'error' in request('follow_user', body={'user_id': 500}), 'ゲストはフォロー対象にできない'
    assert 'error' in request('follow_user', body={'user_id': 9999}), '存在しないユーザーは不可'

    # ゲスト作成の公開リスト作者もプロフィールは閲覧できる (フォローボタンだけ出さない)
    guest_profile = request('get_user_profile', qs='&user_id=500')
    assert guest_profile['user']['is_guest'] is True, guest_profile['user']

    unfollowed = request('unfollow_user', body={'user_id': 502})
    assert unfollowed['is_following'] == 0 and unfollowed['following'] == 0, unfollowed
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT COUNT(*) FROM user_follows").fetchone()[0] == 0

    # --- 簡易ログ ---
    tracks = request('get_profile_activity', qs='&type=tracks&limit=10')['tracks']
    assert [t['youtube_id'] for t in tracks] == ['ccccccccccc', 'bbbbbbbbbbb', 'aaaaaaaaaaa'], tracks

    playlists = request('get_profile_activity', qs='&type=playlists&limit=10')['playlists']
    assert [p['name'] for p in playlists] == ['Alice Private', 'Alice Public'], playlists
    assert all(p['name'] != '未整理' for p in playlists), playlists

    favorites = request('get_profile_activity', qs='&type=favorites&limit=10')
    favorite_tracks = [t['youtube_id'] for t in favorites['tracks']]
    assert set(favorite_tracks) == {'aaaaaaaaaaa', 'ccccccccccc', 'ddddddddddd'}, favorite_tracks
    favorite_lists = [p['name'] for p in favorites['playlists']]
    assert 'Bob Public' in favorite_lists, favorite_lists

print('PASS: フォロー/解除・フォロー中/フォロワー一覧・3つの簡易ログが正しく動く。')
