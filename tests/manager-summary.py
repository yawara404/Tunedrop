"""Manager ホームのダッシュボード集計 (get_manager_summary) の検証。

- 固定タブ (未整理 / 公開用お気に入り) を除いたリスト数・公開中リスト数
- youtube_id の重複を除いた保存曲数 / お気に入り曲数
- カテゴリ別の分布 (リストのカテゴリ単位)
- 最近追加した曲 (added_at の新しい順・同じ曲は最新の保存1件)
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
    database = Path(directory) / 'summary.sqlite'
    api = Path(directory) / 'api.php'
    api.write_text((ROOT / 'backend' / 'api.php').read_text())

    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'backend' / 'setup.sql').read_text())
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'summary_user','test-only')")
        # 固定タブ (集計から除外される)
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,is_favorite,system_key,sort_order)"
                   " VALUES (110,99,'未整理','Other',0,0,'inbox',0)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,is_favorite,system_key,sort_order)"
                   " VALUES (111,99,'公開用お気に入り','J-POP',1,1,'public_favorites',1)")
        # ユーザー作成リスト
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order)"
                   " VALUES (120,99,'J-POP集','J-POP',0,0)")
        db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order)"
                   " VALUES (121,99,'アニメ集','Anime',1,1)")
        db.executemany(
            "INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel,is_favorite,added_at)"
            " VALUES (?,?,?,?,?,?,?)",
            [
                (101, 120, 'videoA', 'A', 'Artist A', 1, '2026-01-01 10:00:00'),
                (102, 121, 'videoB', 'B', 'Artist B', 0, '2026-01-02 10:00:00'),
                (103, 121, 'videoC', 'C', 'Artist C', 0, '2026-01-03 10:00:00'),
                # 同じ曲 (videoA) を別リストにも保存。曲数は重複せず、最近追加では新しい行を使う
                (104, 110, 'videoA', 'A', 'Artist A', 0, '2026-01-04 10:00:00'),
            ],
        )

    def request(action, user_id=99):
        script = ('$_SERVER["REQUEST_METHOD"]="GET"; $_SERVER["HTTP_AUTHORIZATION"]=$argv[2];'
                  ' $_GET=["action"=>$argv[1]]; require $argv[3];')
        return json.loads(subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', script, action, bearer(user_id), str(api)],
            env={**os.environ, 'TUNEDROP_DB': str(database), 'SECRET_KEY': SECRET}, text=True,
        ))

    summary = request('get_manager_summary')
    stats = summary['stats']

    # 固定タブは数えない / 曲は youtube_id 単位で重複を除く
    assert stats['playlists'] == 2, stats
    assert stats['public_playlists'] == 1, stats
    assert stats['tracks'] == 3, stats
    assert stats['favorite_tracks'] == 1, stats

    # カテゴリ別 (リストのカテゴリ単位で曲数を合計する)
    categories = {category['category']: category for category in summary['categories']}
    assert categories['J-POP']['playlists'] == 1 and categories['J-POP']['tracks'] == 1, categories
    assert categories['Anime']['playlists'] == 1 and categories['Anime']['tracks'] == 2, categories
    # 曲数の多いカテゴリが先頭に並ぶ
    assert summary['categories'][0]['category'] == 'Anime', summary['categories']

    # 最近追加した曲: added_at 降順・同じ曲は最新の保存1件
    recent = summary['recent_tracks']
    assert [track['youtube_id'] for track in recent] == ['videoA', 'videoC', 'videoB'], recent
    assert recent[0]['is_favorite'] == 1, recent[0]

    # 別ユーザーのデータは混ざらない
    db.execute("INSERT INTO users (id,username,password_hash) VALUES (100,'other','test-only')")
    db.execute("INSERT INTO playlists (id,user_id,name,category,is_public,sort_order)"
               " VALUES (130,100,'他人のリスト','Other',0,0)")
    db.execute("INSERT INTO bookmarks (id,playlist_id,youtube_id,title,channel,is_favorite,added_at)"
               " VALUES (105,130,'videoD','D','Artist D',0,'2026-01-05 10:00:00')")
    db.commit()   # with ブロックの外なので明示的に確定する (PHP は別接続で読む)
    other = request('get_manager_summary', 100)
    # ユーザー99のリスト・曲 (videoA/B/C) は混ざらず、自分 (100) の1曲だけが見える
    assert other['stats']['playlists'] == 1 and other['stats']['tracks'] == 1, other
    assert [track['youtube_id'] for track in other['recent_tracks']] == ['videoD'], other
    assert [category['category'] for category in other['categories']] == ['Other'], other

print('PASS: Managerダッシュボードの集計 (リスト/曲/公開/お気に入り/カテゴリ/最近追加) が正しい。')

