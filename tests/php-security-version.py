"""Verify the PHP version gate for the 2026-10-21 RCE advisories and server hardening flags."""
from contextlib import redirect_stderr
import importlib.util
import io
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('tunedrop_start', ROOT / 'backend' / 'start.py')
start = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(start)

# バージョン文字列の解釈 (PHP 8.5.10 (cli) / PHP_VERSION のどちらでも動く)
assert start.parse_php_version('8.5.11') == (8, 5, 11)
assert start.parse_php_version('PHP 8.4.27 (cli)') == (8, 4, 27)
assert start.parse_php_version('') is None
assert start.parse_php_version('unknown') is None

# 2026-10-21 の修正版 (CVE-2026-109618 / CVE-2026-109619) 未満は拒否する
VULNERABLE = [(8, 5, 11), (8, 5, 0), (8, 4, 26), (8, 3, 35), (8, 2, 34), (8, 1, 99), (7, 4, 33)]
FIXED = [(8, 5, 12), (8, 5, 20), (8, 4, 27), (8, 3, 36), (8, 2, 35), (8, 6, 0)]
for version in VULNERABLE:
    assert start.php_security_issue(version), version
for version in FIXED:
    assert start.php_security_issue(version) is None, version
assert start.php_security_issue(None)

# 未修正なら起動拒否。ローカル検証用の明示指定だけ許可する。
original_detect = start.detect_php_version
original_override = os.environ.pop('TUNEDROP_ALLOW_VULNERABLE_PHP', None)
start.detect_php_version = lambda php: '8.5.10 (cli)'
try:
    with redirect_stderr(io.StringIO()) as stderr:
        assert start.check_php_security('php') is False
    assert 'CVE-2026-109618' in stderr.getvalue()
    assert 'CVE-2026-109619' in stderr.getvalue()
    os.environ['TUNEDROP_ALLOW_VULNERABLE_PHP'] = '1'
    with redirect_stderr(io.StringIO()):
        assert start.check_php_security('php') is True
finally:
    start.detect_php_version = original_detect
    os.environ.pop('TUNEDROP_ALLOW_VULNERABLE_PHP', None)
    if original_override is not None:
        os.environ['TUNEDROP_ALLOW_VULNERABLE_PHP'] = original_override

# 修正版はそのまま許可する
start.detect_php_version = lambda php: '8.5.12'
try:
    assert start.check_php_security('php') is True
finally:
    start.detect_php_version = original_detect

# プロジェクト内 .php/ があれば優先し、PHP_BIN の明示指定が最優先であること
original_php_bin = os.environ.get('PHP_BIN')
project_php = ROOT / '.php' / 'bin' / 'php'
if project_php.is_file() and original_php_bin is None:
    assert Path(start.resolve_php()).resolve() == project_php.resolve()
os.environ['PHP_BIN'] = '/custom/php'
try:
    assert start.resolve_php() == '/custom/php'
finally:
    os.environ.pop('PHP_BIN', None)
    if original_php_bin is not None:
        os.environ['PHP_BIN'] = original_php_bin

# 実 PHP で緩和フラグが効く (CLI の memory_limit は既定 -1 のため有限にする)
php = os.environ.get('PHP_BIN', 'php')
result = subprocess.run(
    [php, *start.PHP_HARDENING_FLAGS, '-r',
     'echo ini_get("memory_limit"), "|", ini_get("display_errors"), "|", '
     'ini_get("log_errors"), "|", ini_get("expose_php");'],
    capture_output=True, text=True, check=True,
)
assert result.stdout.strip() == '256M|0|1|0', result.stdout
print('PASS: PHP 8.5.12 / 8.4.27 / 8.3.36 / 8.2.35 gate, local override, and hardened server flags.')
