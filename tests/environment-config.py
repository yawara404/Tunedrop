"""Exercise direct Python imports and the PHP launcher using isolated .env files."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temporary:
    work = Path(temporary)
    project = work / 'project'
    project.mkdir()
    for name in ['runtime_config.py', 'app.py', 'youtube_helper.py', 'ai_analyzer.py', 'audio_download.py']:
        shutil.copy(ROOT / name, project / name)
    sentinel = work / 'must-not-exist'
    (project / '.env').write_text(
        '# isolated settings\nGOOGLE_CLIENT_ID="fixture-client"\n'
        'YOUTUBE_API_KEY=fixture-youtube\nGEMINI_API_KEY=fixture-gemini\n'
        'PORT=5055\nYTDLP_PO_TOKEN=fixture-token\n'
        f'TUNEDROP_DB={work}/fixture.sqlite\n'
        f'LITERAL="$(touch {sentinel}) ${{PORT}}"\n'
    )
    env = {key: value for key, value in os.environ.items() if key not in [
        'GOOGLE_CLIENT_ID', 'YOUTUBE_API_KEY', 'GEMINI_API_KEY', 'PORT', 'TUNEDROP_DB',
        'TUNEDROP_ENV_FILE', 'SECRET_KEY', 'TUNEDROP_SECRET_FILE', 'PYTHON_DOTENV_DISABLED',
        'YTDLP_PO_TOKEN', 'LITERAL']}
    env['PYTHONPATH'] = str(project)
    def run(code, extra=None):
        subprocess.run([sys.executable, '-c', code], cwd=work,
                       env={**env, **(extra or {})}, check=True)
    # Import each helper first so it cannot rely on app.py having loaded .env.
    for module, key, value in [('youtube_helper','YOUTUBE_API_KEY','fixture-youtube'),
                               ('ai_analyzer','GEMINI_API_KEY','fixture-gemini')]:
        run(f'import {module}; assert {module}.{key} == {value!r}')
    run('import audio_download, os; assert os.environ["YTDLP_PO_TOKEN"] == "fixture-token"')
    run('import app; assert app.GOOGLE_CLIENT_ID == "fixture-client"; '
        'assert app.get_free_port() == 5055; assert app.DB_PATH.endswith("fixture.sqlite")')
    run('import app; assert app.GOOGLE_CLIENT_ID == "process-client"; assert app.get_free_port() == 6001',
        {'GOOGLE_CLIENT_ID': 'process-client', 'PORT': '6001'})
    custom = work / 'custom.env'
    custom.write_text('GOOGLE_CLIENT_ID=custom-client\n')
    run('import app; assert app.GOOGLE_CLIENT_ID == "custom-client"', {'TUNEDROP_ENV_FILE': str(custom)})
    run('import youtube_helper; assert youtube_helper.YOUTUBE_API_KEY == ""',
        {'TUNEDROP_ENV_FILE': str(work/'absent.env')})
    # The standalone PHP launcher's exec inherits dotenv without shell expansion.
    subprocess.run([sys.executable, str(project/'runtime_config.py'), sys.executable, '-c',
                    'import os; assert os.environ["PORT"] == "5055"; '
                    'assert "$(touch " in os.environ["LITERAL"]; '
                    'assert "${PORT}" in os.environ["LITERAL"]'], cwd=work, env=env, check=True)
    assert not sentinel.exists()
print('PASS: direct imports, cwd independence, environment precedence, custom/missing files, child process inheritance and literal values.')
