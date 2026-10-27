"""HTTP checks for the PHP router (./start.sh) public-file allowlist."""
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
PHP = os.environ.get('PHP_BIN', 'php')

def check(command, cwd, port, extra_allowed=(), prefix_expectations=None):
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(60):
            if process.poll() is not None:
                raise RuntimeError(process.stderr.read().decode())
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.1):
                    break
            except OSError:
                time.sleep(.05)
        base = f'http://127.0.0.1:{port}'
        allowed = ['/', '/index.html', '/assets/index-Ab12Cd.js', '/assets/index-Ab12Cd.css',
                   '/assets/favicon-Ab12Cd.svg',
                   '/frontend/favicon-card.png',
                   '/robots.txt', '/sitemap.xml', '/google9f8e7d6c5b4a.html',
                   '/admin/admin.php', '/admin/admin.js', '/admin/admin.css'] + list(extra_allowed)
        for path in allowed + [
                     '/frontend/manager-lists.js', '/frontend/api-client.js', '/frontend/text-marquee.js',
                     '/vendor/vue.esm-browser.prod.js',
                     # Vite のビルド元 (配信するのは assets/ のビルド成果物だけ)
                     '/frontend/app.js', '/frontend/config.js', '/frontend/style.css',
                     '/frontend/favicon.svg', '/frontend/index.html', '/frontend/main.js',
                     '/main.js', '/src/main.js', '/package.json', '/vite.config.mjs', '/package-lock.json',
                     '/node_modules/vite/package.json',
                     # assets/ はサブフォルダ・隠しファイル・想定外の拡張子を許可しない
                     '/assets/sub/index.js', '/assets/index.js.map', '/assets/.env', '/assets/',
                     '/database.sqlite', '/database.sqlite-wal', '/.jwt_secret', '/.admin_token',
                     '/.git/config', '/app.py', '/setup.sql', '/README.md', '/tests/test.js',
                     '/_backup_pre_radar/api.php', '/%2ejwt_secret', '/router.php', '/missing.css',
                     '/app.js', '/style.css', '/config.js',
                     '/google.html', '/google9f8e7d6c5b4a.html.bak', '/.env',
                     '/admin/admin.sh', '/admin/README.md', '/admin.php', '/admin.js', '/admin.css',
                     '/admin', '/admin/',
                     # 整理後: ソースの置き場 (backend/ と frontend/dist) は直接配信しない。
                     # 公開URL (/api.php, /assets/... など) のまま router.php が対応付ける。
                     '/backend/api.php', '/backend/router.php', '/backend/start.py',
                     '/backend/mysql_db.php', '/backend/setup.sql',
                     '/frontend/dist/index.html', '/frontend/dist/assets/index-Ab12Cd.js']:
            try:
                with urllib.request.urlopen(base+path) as response:
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
            expected = 200 if path in allowed else 403
            assert status == expected, (command[0], path, status, expected)
        # 公開URL (https://<host>/tunedrop/...) のプレフィックス付きでも同じ許可判定か。
        # 配信は PHPビルトインサーバー (router.php) が Alias 相当を行うため、
        # 配信と同じ経路 (router.php) だけで検証する。
        for path, expected in (prefix_expectations or {}).items():
            try:
                with urllib.request.urlopen(base+path) as response:
                    status = response.status
                    headers = response.headers
                    if path in ('/tunedrop/', '/tunedrop/index.html'):
                        # ブラウザには毎回 ETag で再検証させ、CF のエッジには短時間だけ持たせる
                        assert headers.get('Cache-Control') == (
                            'public, max-age=0, s-maxage=60, must-revalidate, '
                            'stale-while-revalidate=60'), headers
                        etag = headers.get('ETag')
                        assert etag, headers
                        # 再検証 (If-None-Match) は 304 になり、本文を送り直さない
                        revalidate = urllib.request.Request(base+path, headers={'If-None-Match': etag})
                        try:
                            with urllib.request.urlopen(revalidate) as not_modified:
                                revalidate_status = not_modified.status
                        except urllib.error.HTTPError as error:
                            revalidate_status = error.code
                        assert revalidate_status == 304, revalidate_status
            except urllib.error.HTTPError as error:
                status = error.code
            assert status == expected, (command[0], path, status, expected)
    finally:
        process.terminate()
        process.wait(timeout=10)
        process.stderr.close()

def public_prefix_expectations(referenced):
    """公開URL (/tunedrop/...) のプレフィックス付きでの期待ステータス。"""
    expectations = {
        # 末尾スラッシュ無しは /tunedrop/ へリダイレクトされる (urllib は追従する)
        '/tunedrop': 200,
        '/tunedrop/': 200,
        '/tunedrop/index.html': 200,
        '/tunedrop/api.php': 200,
        '/tunedrop/ogp.php': 200,
        '/tunedrop/admin/admin.php': 200,
        '/tunedrop/admin/admin.js': 200,
        '/tunedrop/admin/admin.css': 200,
        '/tunedrop/robots.txt': 200,
        '/tunedrop/sitemap.xml': 200,
        '/tunedrop/frontend/favicon-card.png': 200,
        '/tunedrop/assets/index-Ab12Cd.js': 200,
        # 配信してはいけないものはプレフィックス付きでも403のまま
        '/tunedrop/database.sqlite': 403,
        '/tunedrop/frontend/app.js': 403,
        '/tunedrop/.jwt_secret': 403,
        '/tunedrop/admin/admin.sh': 403,
        '/tunedrop/router.php': 403,
        '/tunedrop/nope.css': 403,
    }
    for url in referenced:
        expectations['/tunedrop' + url] = 200
    return expectations

def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

with tempfile.TemporaryDirectory() as temporary:
    work = Path(temporary)
    web = work/'public'
    (web/'backend').mkdir(parents=True)
    (web/'frontend'/'dist'/'assets').mkdir(parents=True)
    # ルーターとエントリポイントは実物をコピーする (配信と同じ経路で検証するため)。
    # mysql_db.php はコピーしない (api.php は is_file のときだけ読むため、
    # テキストのダミーを置くと構文エラーになる)。
    for name in ['router.php', 'api.php', 'ogp.php']:
        shutil.copy(ROOT/'backend'/name, web/'backend'/name)
    # ソースは backend/ と frontend/dist/ に分かれているが、公開URLは整理前と同じ:
    #   /                    → frontend/dist/index.html
    #   /assets/<hash>.<ext> → frontend/dist/assets/<hash>.<ext>
    #   /api.php, /ogp.php   → backend/*.php (実行)
    for name in ['frontend/dist/index.html','frontend/favicon-card.png',
                 'frontend/dist/assets/index-Ab12Cd.js','frontend/dist/assets/index-Ab12Cd.css',
                 'frontend/dist/assets/favicon-Ab12Cd.svg',
                 # 配信してはいけないもの (存在していても403になること)
                 'frontend/app.js','frontend/config.js','frontend/style.css','frontend/favicon.svg',
                 'frontend/index.html','frontend/main.js',
                 'frontend/dist/assets/sub/index.js','frontend/dist/assets/index.js.map',
                 'frontend/dist/assets/.env',
                 'robots.txt','sitemap.xml','google9f8e7d6c5b4a.html',
                 'admin/admin.php','admin/admin.js','admin/admin.css','admin/admin.sh',
                 'database.sqlite','.jwt_secret','.admin_token','setup.sql','README.md',
                 'backend/app.py','backend/setup.sql',
                 'tests/test.js','_backup_pre_radar/api.php','.git/config','database.sqlite-wal']:
        path=web/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('test fixture')
    # ビルド済み index.html が参照している資産 (assets/index-<hash>.js など) を
    # そのまま配信できるかも確認する。許可リストのパターンが Vite の出力名とずれると、
    # ビルドは通るのに画面が真っ白 (403) になる事故になるため。
    built = ROOT/'frontend'/'dist'/'index.html'
    referenced = []
    if built.exists():
        for url in sorted(set(re.findall(r'\./assets/[A-Za-z0-9_.-]+', built.read_text(encoding='utf-8')))):
            name = url[len('./'):]
            path = web/'frontend'/'dist'/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('test fixture')
            referenced.append('/' + name)
    php_port=port()
    check([PHP,'-S',f'127.0.0.1:{php_port}','-t',str(web),str(web/'backend'/'router.php')],work,php_port,referenced,
          public_prefix_expectations(referenced))
print('PASS: PHP router (backend/start.sh) serves public assets and rejects DB, secrets, source, backups and encoded hidden paths.')
