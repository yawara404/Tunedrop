"""HTTP checks for the PHP router and an isolated MAMP Apache allowlist."""
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
APACHE = os.environ.get('APACHE_BIN', '/Applications/MAMP/Library/bin/httpd')

def check(command, cwd, port, extra_allowed=()):
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
        allowed = ['/', '/assets/index-Ab12Cd.js', '/assets/index-Ab12Cd.css',
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
                     '/admin', '/admin/']:
            try:
                with urllib.request.urlopen(base+path) as response:
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
            expected = 200 if path in allowed else 403
            assert status == expected, (command[0], path, status, expected)
    finally:
        process.terminate()
        process.wait(timeout=10)
        process.stderr.close()

def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

with tempfile.TemporaryDirectory() as temporary:
    work = Path(temporary)
    web = work/'public'
    web.mkdir()
    for name in ['.htaccess', 'router.php']:
        shutil.copy(ROOT/name, web/name)
    for name in ['index.html','frontend/favicon-card.png',
                 'assets/index-Ab12Cd.js','assets/index-Ab12Cd.css','assets/favicon-Ab12Cd.svg',
                 # 配信してはいけないもの (存在していても403になること)
                 'frontend/app.js','frontend/config.js','frontend/style.css','frontend/favicon.svg',
                 'frontend/index.html','frontend/main.js',
                 'assets/sub/index.js','assets/index.js.map','assets/.env',
                 'robots.txt','sitemap.xml','google9f8e7d6c5b4a.html',
                 'admin/admin.php','admin/admin.js','admin/admin.css','admin/admin.sh',
                 'database.sqlite','.jwt_secret','.admin_token','app.py','setup.sql','README.md',
                 'tests/test.js','_backup_pre_radar/api.php','.git/config','database.sqlite-wal']:
        path=web/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('test fixture')
    # ビルド済み index.html が参照している資産 (assets/index-<hash>.js など) を
    # そのまま配信できるかも確認する。許可リストのパターンが Vite の出力名とずれると、
    # ビルドは通るのに画面が真っ白 (403) になる事故になるため。
    built = ROOT/'index.html'
    referenced = []
    if built.exists():
        for url in sorted(set(re.findall(r'\./assets/[A-Za-z0-9_.-]+', built.read_text(encoding='utf-8')))):
            name = url[len('./'):]
            path = web/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('test fixture')
            referenced.append('/' + name)
    php_port=port()
    check([PHP,'-S',f'127.0.0.1:{php_port}','-t',str(web),str(web/'router.php')],work,php_port,referenced)
    if Path(APACHE).exists():
        apache_port=port()
        server_root=Path(APACHE).resolve().parent.parent
        config=work/'httpd.conf'
        config.write_text(f'''ServerRoot "{server_root}"
Listen 127.0.0.1:{apache_port}
ServerName localhost
PidFile "{work}/httpd.pid"
ErrorLog "{work}/error.log"
LoadModule authz_core_module modules/mod_authz_core.so
LoadModule unixd_module modules/mod_unixd.so
LoadModule dir_module modules/mod_dir.so
LoadModule rewrite_module modules/mod_rewrite.so
DocumentRoot "{web}"
<Directory "{web}">
    AllowOverride All
    Require all granted
</Directory>
''')
        check([APACHE,'-f',str(config),'-D','FOREGROUND'],work,apache_port,referenced)
    else:
        raise RuntimeError('Set APACHE_BIN to run the Apache verification')
print('PASS: Apache and PHP router serve public assets and reject DB, secrets, source, backups and encoded hidden paths.')
