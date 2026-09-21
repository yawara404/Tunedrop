"""固定タブ (未整理 / 公開用お気に入り) が重複表示されないことを確認する。

各ユーザーは自分の固定タブを1つだけ持ち、他ユーザーの固定タブは
サイドバー一覧にも Share (共有一覧) にも現れない。
修正前に作られた「他人の固定タブへのお気に入り」行が残っていても重複しない。
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'dedupe.sqlite'
    api = Path(directory) / 'api.php'
    # CLI has no php://input; adapt only the HTTP request-body boundary.
    source = (ROOT / 'api.php').read_text().replace("file_get_contents('php://input')", "getenv('TEST_BODY')")
    api.write_text(source)
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        # 閲覧者 (ログインなしで使われる共通ゲストユーザー)
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (99,'guest','test-only')")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (99,99,'Guest private',0)")
        # 他ユーザーが作成した公開リスト (固定タブではないので共有一覧に出る)
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (30,1,'Shared public',1)")

    def request(action, body=None):
        script = '$_SERVER["REQUEST_METHOD"]=$argv[1]; $_GET=["action"=>$argv[2]]; require $argv[3];'
        return json.loads(subprocess.check_output(
            [os.environ.get('PHP_BIN', 'php'), '-r', script, 'POST' if body is not None else 'GET', action, str(api)],
            env={**os.environ, 'TUNEDROP_DB': str(database), 'TEST_BODY': json.dumps(body)}, text=True,
        ))

    # api.php が public_favorites テーブルを用意する
    request('get_public_playlists')
    with sqlite3.connect(database) as db:
        # 修正前のDBに残っていた「他ユーザーの固定タブ (id 2) へのお気に入り」を再現する
        db.execute("INSERT INTO public_favorites (user_id,kind,target_id) VALUES (99,'playlist',2)")

    own = request('get_playlists')
    names = [p['name'] for p in own]
    assert names.count('公開用お気に入り') == 1, names
    assert names.count('未整理') == 1, names
    # 固定タブはすべて自分のもの (他ユーザーの固定タブは含まれない)
    assert all(p['user_id'] == 99 for p in own if p['system_key']), own
    assert 2 not in [p['id'] for p in own]
    assert [p for p in own if p['name'] == '公開用お気に入り'][0]['system_key'] == 'public_favorites'
    # まだお気に入りにしていない他ユーザーの公開リストは一覧に入らない
    assert 30 not in [p['id'] for p in own]

    for action in ('get_public_playlists', 'get_recent_playlists'):
        public = request(action)
        assert [p['id'] for p in public] == [30], (action, public)
        assert not any(p['system_key'] for p in public), (action, public)

    # 他ユーザーの固定タブはお気に入りに追加できない
    blocked = request('toggle_favorite_playlist', {'id': 2})
    assert blocked['success'] is False and '固定タブ' in blocked['error'], blocked
    # ユーザー作成の公開リストは今までどおりお気に入りに追加でき、一覧に1件だけ入る
    assert request('toggle_favorite_playlist', {'id': 30})['is_favorite'] == 1
    assert [p['id'] for p in request('get_playlists') if p['id'] == 30] == [30]

    with sqlite3.connect(database) as db:
        # 重複の原因になっていた古いお気に入り行は取り除かれる
        assert db.execute("SELECT COUNT(*) FROM public_favorites WHERE kind='playlist' AND target_id=2").fetchone()[0] == 0

    # 再度同じ行が入っても (旧データの再投入) 重複しない
    with sqlite3.connect(database) as db:
        db.execute("INSERT INTO public_favorites (user_id,kind,target_id) VALUES (99,'playlist',2)")
        db.commit()
    assert [p['name'] for p in request('get_playlists')].count('公開用お気に入り') == 1
print('PASS: 固定タブは各ユーザー1つだけ表示され、他ユーザーの固定タブは一覧・共有リスト・お気に入りから除外される。')
