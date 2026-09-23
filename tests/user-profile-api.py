"""他ユーザーのプロフィール API (get_user_profile) が公開情報だけを返すことを確認する。

Shareの作成者名から開くプロフィールは、そのユーザーの「公開リスト」だけを
返す必要がある。非公開リスト・固定タブ (未整理 / 公開用お気に入り) は
件数にも一覧にも含めない。
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'userprofile.sqlite'
    api = Path(directory) / 'api.php'
    api.write_text((ROOT / 'api.php').read_text()
                   .replace("file_get_contents('php://input')", "getenv('TEST_BODY')"))
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (500,'guest','x')")
        db.execute("INSERT INTO users (id,username,password_hash,created_at)"
                   " VALUES (501,'wawa404','x','2026-01-02 03:04:05')")
        # 公開リスト (2件) と非公開リスト、固定タブ
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order)"
                   " VALUES (510,501,'Public A','J-POP',1,2)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order)"
                   " VALUES (511,501,'Public B','Other',1,3)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order)"
                   " VALUES (512,501,'Private','Other',0,4)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,system_key,sort_order)"
                   " VALUES (513,501,'未整理','Other',0,'inbox',0)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,system_key,sort_order)"
                   " VALUES (514,501,'公開用お気に入り','Other',0,'public_favorites',1)")
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,sort_order) VALUES (510,'aaaaaaaaaaa',0)")
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,sort_order) VALUES (510,'bbbbbbbbbbb',1)")
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,sort_order) VALUES (511,'ccccccccccc',0)")
        db.execute("INSERT INTO bookmarks (playlist_id,youtube_id,sort_order) VALUES (512,'ddddddddddd',0)")

    def request(action, body=None, qs=''):
        # CLI では $_GET が空なので、action と追加パラメータ (qs) を組み立てて渡す
        script = ('$_SERVER["REQUEST_METHOD"]=$argv[1]; $_GET=["action"=>$argv[2]];'
                  'parse_str(ltrim($argv[4] ?? "", "&"), $extra); $_GET += $extra; require $argv[3];')
        return json.loads(subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', script,
             'POST' if body is not None else 'GET', action, str(api), qs],
            env={**os.environ, 'TUNEDROP_DB': str(database), 'TEST_BODY': json.dumps(body)}, text=True,
        ))

    # 公開お気に入りを1件付けて favorite_count に含まれることを確認する
    request('get_public_playlists')
    with sqlite3.connect(database) as db:
        db.execute("INSERT INTO public_favorites (user_id,kind,target_id) VALUES (500,'playlist',510)")

    data = request('get_user_profile', qs='&user_id=501')
    assert data['user']['id'] == 501, data
    assert data['user']['name'] == 'wawa404', data
    assert data['user']['created_at'] == '2026-01-02 03:04:05', data
    names = [p['name'] for p in data['playlists']]
    assert names == ['Public B', 'Public A'], names          # 新しい順 (id 降順)
    assert 'Private' not in names and '未整理' not in names and '公開用お気に入り' not in names, names
    # 非公開リストや固定タブの曲は件数に入らない
    assert data['user']['stats']['public_playlists'] == 2, data['user']['stats']
    assert data['user']['stats']['public_tracks'] == 3, data['user']['stats']
    assert data['user']['stats']['favorites'] == 1, data['user']['stats']
    assert [p['favorite_count'] for p in data['playlists'] if p['id'] == 510] == [1], data['playlists']

    # 未指定 / 存在しないIDはエラー
    assert 'error' in request('get_user_profile'), 'user_id 無しはエラー'
    assert 'error' in request('get_user_profile', qs='&user_id=9999'), '存在しないユーザーはエラー'

print('PASS: 他ユーザーのプロフィールは公開リストだけを件数・一覧に含める。')
