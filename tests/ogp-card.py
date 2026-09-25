"""公開リストの共有URL (ogp.php) が画像付きOGPカードを返し、非公開は漏らさない。"""
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PHP = os.environ.get('PHP_BIN', 'php')

with tempfile.TemporaryDirectory() as directory:
    database = Path(directory) / 'ogp.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'setup.sql').read_text())
        # カバー未設定の公開リスト (最後に追加した曲のサムネイルを使う)
        db.execute("INSERT INTO playlists (id,user_id,name,is_public,category,cover_id) VALUES (30,1,'夜のドライブ',1,'Other',NULL)")
        for i in range(3):
            db.execute('INSERT INTO bookmarks (playlist_id,youtube_id,title) VALUES (30,?,?)', (f'drive-{i}', f'曲{i}'))
        # 非公開リスト (共有しても中身を出してはいけない)
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (31,1,'秘密のリスト',0)")
        # メタ属性への注入を防ぐ (エスケープ確認)
        db.execute("INSERT INTO playlists (id,user_id,name,is_public) VALUES (32,1,'<script>alert(1)</script>\"',1)")

    def render(playlist):
        query = '$_GET=[];' if playlist is None else f'$_GET=["playlist"=>{playlist!r}];'
        code = (query +
                '$_SERVER["HTTP_HOST"]="example.test";$_SERVER["SCRIPT_NAME"]="/tunedrop/ogp.php";'
                '$_SERVER["HTTPS"]="on";require $argv[1];')
        return subprocess.check_output(
            [PHP, '-r', code, str(ROOT / 'ogp.php')],
            env={**os.environ, 'TUNEDROP_DB': str(database)}, text=True,
        )

    card = render(30)
    assert '<meta property="og:title" content="夜のドライブ - Tune drop">' in card, card
    assert '<meta property="og:type" content="website">' in card
    assert 'test_user さんの公開プレイリスト / 全3曲' in card
    assert '<meta property="og:image" content="https://i.ytimg.com/vi/drive-2/hqdefault.jpg">' in card, card
    assert '<meta name="twitter:card" content="summary_large_image">' in card
    assert 'https://example.test/tunedrop/ogp.php?playlist=30' in card
    assert 'location.replace("index.html#/playlist/30")' in card

    generic = render(31)
    assert '秘密のリスト' not in generic
    assert '<meta name="twitter:card" content="summary">' in generic
    assert 'location.replace("index.html")' in generic

    escaped = render(32)
    assert '<script>alert(1)</script>' not in escaped
    assert '&lt;script&gt;alert(1)&lt;/script&gt;' in escaped

    # IDなし (トップページ共有) もサイト共通カードを返す
    top = render(None)
    assert '<meta property="og:title" content="Tune drop - Music Bookmark &amp; Radar">' in top

print('PASS: 公開リストは画像付きカード、非公開・不正名はエスケープ/フォールバックされた。')
