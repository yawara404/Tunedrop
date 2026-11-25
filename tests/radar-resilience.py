"""Radar: native worker failure/timeout, single-flight refresh, scoped stale cache."""
import concurrent.futures
from pathlib import Path
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT / 'backend'))
import app as server

cache_directory = tempfile.TemporaryDirectory()
server.EMBED_CACHE_PATH = str(Path(cache_directory.name) / "embedding.json")

vectors = [[1., 2., 3.], [2., 3., 1.], [3., 1., 2.], [4., 2., 1.]]
with tempfile.TemporaryDirectory() as directory:
    worker = Path(directory) / 'radar_embed_worker.py'
    with patch.object(server, 'BACKEND_DIR', directory), patch.object(server, 'UMAP_TIMEOUT', .3):
        for script in ('import os; os._exit(134)', 'import time; time.sleep(10)',
                       'print("[[0,0]]")', 'print("[[NaN,0],[0,0],[0,0],[0,0]]")'):
            Path(server.EMBED_CACHE_PATH).unlink(missing_ok=True)
            worker.write_text(script)
            started = time.monotonic()
            coords, method = server.embed(vectors)
            assert method == 'pca', method
            assert len(coords) == len(vectors)
            assert time.monotonic() - started < 3

# 新しいメモリキャッシュが無くても、保存した座標を再計算せず再利用する。
with patch.object(server.subprocess, 'run', side_effect=AssertionError('must reuse disk')):
    reused, method = server.embed(vectors)
    assert reused == coords and method == 'pca'
assert Path(server.EMBED_CACHE_PATH).stat().st_mode & 0o077 == 0
with patch.object(server.subprocess, 'run', side_effect=RuntimeError('recompute')) as worker:
    server.embed(vectors, n_neighbors=3)
    assert worker.call_count == 1, 'settings changes must invalidate saved coordinates'

item = dict(youtube_id='abcdefghijk', feature_vector=[1,2,3], user_id=1,
            is_public=0, title='Test', channel='Artist', category='Other',
            playlist_name='Private', author='Owner', tempo=120, mood='calm',
            engine='rules', energy=.5)
started = threading.Event()
release = threading.Event()
calls = []

def embedding(vectors):
    calls.append(vectors)
    started.set()
    assert release.wait(3)
    return [[.5,.5] for _ in vectors], 'pca'

def request(path='/radar/map'):
    with server.app.test_client() as client:
        result = client.get(path)
        assert result.status_code == 200, result.data
        return result.json

with patch.object(server, '_map_cache_key', lambda public, user: (public,user,1)), \
     patch.object(server, '_db_bookmarks', lambda: [dict(item)]), \
     patch.object(server, 'embed', embedding):
    server._MAP_CACHE.update(key=None, payload=None, at=0.)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = [pool.submit(request) for _ in range(8)]
        assert started.wait(2)
        release.set()
        assert all(job.result()['count'] == 1 for job in jobs)
    assert len(calls) == 1, len(calls)
    # 最低更新間隔の間でも別の公開範囲へキャッシュを流用しない。
    assert request('/radar/map?public=1')['count'] == 0
    assert len(calls) == 2
    assert request()['count'] == 1
    # 更新中でも直前の同じ範囲のマップはすぐ返る。
    with server._MAP_BUILD_LOCK:
        assert request()['count'] == 1

print('PASS: worker crash/timeout/invalid output -> PCA; concurrent cold loads compute once; scoped stale cache')
