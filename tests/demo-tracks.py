#!/usr/bin/env python3
"""未ログインのデモ API (/radar/demo) が公開曲だけを5曲返すことを検証する。

実行: TUNEDROP_MYSQL_HOST= TUNEDROP_MYSQL_USER= TUNEDROP_MYSQL_PASSWORD= \
        TUNEDROP_MYSQL_DATABASE= .venv/bin/python tests/demo-tracks.py
"""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory() as directory:
    directory = Path(directory)
    database = directory / 'demo.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript((ROOT / 'backend' / 'setup.sql').read_text(encoding='utf-8'))
        db.execute("INSERT INTO users (id,username,password_hash) VALUES (9,'demo','x')")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public,category) VALUES (90,9,'公開',1,'J-POP')")
        db.execute("INSERT INTO playlists (id,user_id,name,is_public,category) VALUES (91,9,'非公開',0,'J-POP')")
        for i in range(6):
            video_id = f'pub{i:08d}'
            db.execute(
                "INSERT INTO bookmarks (playlist_id,youtube_id,title,channel) VALUES (90,?,?,?)",
                (video_id, f'Public {i}', 'Artist'),
            )
            db.execute(
                "INSERT INTO analysis_cache (youtube_id,data,updated_at) VALUES (?,?,?)",
                (video_id, json.dumps({
                    'feature_vector': [0.1, 0.2, 0.3],
                    'tempo': 120 + i,
                    'mood': 'calm',
                    'energy': 0.2 + i * 0.1,
                    'valence': 0.3 + i * 0.1,
                    'engine': 'ollama',
                    'ai_category': 'J-POP',
                }), 1),
            )
        db.execute(
            "INSERT INTO bookmarks (playlist_id,youtube_id,title,channel) VALUES (91,'prv00000001','Private','Artist')"
        )
        db.execute(
            "INSERT INTO analysis_cache (youtube_id,data,updated_at) VALUES ('prv00000001',?,1)",
            (json.dumps({'feature_vector': [1, 2, 3], 'energy': 0.9, 'valence': 0.9}),),
        )

    os.environ['TUNEDROP_DB'] = str(database)
    os.environ['TUNEDROP_RECOMMEND_CACHE'] = str(directory / 'recommend.json')
    os.environ['TUNEDROP_MYSQL_HOST'] = ''
    sys.path.insert(0, str(ROOT / 'backend'))
    import app as app_module

    response = app_module.app.test_client().get('/radar/demo')
    assert response.status_code == 200, response.status_code
    data = response.get_json()
    assert data['success'] is True
    assert data['count'] == 6, data['count']
    assert len(data['picks']) == 5, data['picks']
    ids = {point['youtube_id'] for point in data['picks']}
    assert 'prv00000001' not in ids, ids
    assert all(video_id.startswith('pub') for video_id in ids), ids
    assert all(point['features']['x'] is not None for point in data['picks'])

print('PASS: /radar/demo は公開曲だけからランダム5曲を返す。')
