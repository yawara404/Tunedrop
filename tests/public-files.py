"""HTTP checks for the PHP router and an isolated MAMP Apache allowlist."""
import os
from pathlib import Path
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

def check(command, cwd, port):
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
        for path in ['/', '/frontend/app.js', '/frontend/style.css',
                     '/frontend/config.js', '/frontend/favicon.svg',
                     '/frontend/manager-lists.js', '/frontend/api-client.js', '/frontend/text-marquee.js',
                     '/vendor/vue.esm-browser.prod.js',
                     '/database.sqlite', '/database.sqlite-wal', '/.jwt_secret', '/.admin_token',
                     '/.git/config', '/app.py', '/setup.sql', '/README.md', '/tests/test.js',
                     '/_backup_pre_radar/api.php', '/%2ejwt_secret', '/router.php', '/missing.css',
                     '/app.js', '/style.css', '/config.js']:
            try:
                with urllib.request.urlopen(base+path) as response:
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
            expected = 200 if path in ['/', '/frontend/app.js', '/frontend/style.css', '/frontend/config.js', '/frontend/favicon.svg'] else 403
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
    for name in ['index.html','frontend/app.js','frontend/style.css','frontend/config.js',
                 'frontend/favicon.svg',
                 'database.sqlite','.jwt_secret','.admin_token','app.py','setup.sql','README.md',
                 'tests/test.js','_backup_pre_radar/api.php','.git/config','database.sqlite-wal']:
        path=web/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('test fixture')
    php_port=port()
    check([PHP,'-S',f'127.0.0.1:{php_port}','-t',str(web),str(web/'router.php')],work,php_port)
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
DocumentRoot "{web}"
<Directory "{web}">
    AllowOverride All
    Require all granted
</Directory>
''')
        check([APACHE,'-f',str(config),'-D','FOREGROUND'],work,apache_port)
    else:
        raise RuntimeError('Set APACHE_BIN to run the Apache verification')
print('PASS: Apache and PHP router serve public assets and reject DB, secrets, source, backups and encoded hidden paths.')
