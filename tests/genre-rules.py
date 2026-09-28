"""ジャンル(カテゴリ)判定と、Gemini解析済み曲の保護の回帰テスト。

- ボイスバンク名・LLM の歌唱主体判定とジャンル表記の正規化
- 表示カテゴリの優先順位 (未解析=Other / ai_category / 明示されたボカロ・タイアップ情報)
- /radar/analyze_all が Gemini 解析済みの曲を対象外にすること

使い方:
    .venv/bin/python tests/genre-rules.py
"""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import types

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

with tempfile.TemporaryDirectory() as directory:
    db_path = Path(directory) / 'genre.sqlite'
    os.environ['TUNEDROP_DB'] = str(db_path)
    os.environ['SECRET_KEY'] = 'genre-rules-test-secret-at-least-32-bytes'
    os.environ['TUNEDROP_ENV_FILE'] = str(Path(directory) / 'none')
    os.environ['TUNEDROP_AI_ENGINE'] = 'rules'        # LLM は呼ばない
    os.environ['TUNEDROP_AUDIO_ENGINE'] = 'none'      # 音源解析もしない
    os.environ['TUNEDROP_ANALYZE_THROTTLE'] = '0'     # バッチを即終わらせる
    import ai_analyzer
    import app

    app.init_db_if_needed()

    # analysis_cache は app.py ではなく api.php / setup.sql 側が作るため、ここで用意する
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE IF NOT EXISTS analysis_cache ("
                   "youtube_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)")
        db.commit()

    cache = {
        # ai_category を持つ曲 (Anime)
        'aaaaaaaaaaa': {'feature_vector': [0.1] * 8, 'engine': 'ollama', 'ai_category': 'Anime'},
        # 歌唱主体をLLMが人声と判定。表示側でもアーティスト名なしでJ-POPへ補正
        'ddddddddddd': {'feature_vector': [0.1] * 8, 'engine': 'ollama',
                        'ai_category': 'Vocaloid', 'vocal_type': 'human'},
        # Gemini 解析済み → 「全曲解析」の対象外
        'eeeeeeeeeee': {'feature_vector': [0.1] * 8, 'engine': 'gemini'},
        'ggggggggggg': {'feature_vector': [0.1] * 8, 'engine': 'ollama',
                        'ai_category': 'Vocaloid', 'vocal_type': 'human'},
    }
    with sqlite3.connect(db_path) as db:
        # _db_bookmarks() は users を JOIN するため、所有者を先に用意する
        db.execute("INSERT OR IGNORE INTO users (id, username, password_hash) "
                   "VALUES (1, 'test_user', 'x')")
        db.execute("INSERT INTO playlists (id, user_id, name, category, is_public) "
                   "VALUES (10, 1, '混在リスト', 'Vocaloid', 0)")
        for vid, title, channel in [
            ('aaaaaaaaaaa', '紅蓮華', 'LiSA'),
            ('bbbbbbbbbbb', 'まだ解析していない曲', 'Artist'),        # 未解析 → Other
            ('ccccccccccc', 'テスト曲 feat.初音ミク', 'Prod'),          # ボカロ名 → Vocaloid
            ('ddddddddddd', '笹川真生 - サニーサイドへようこそ', '笹川真生 - Mao Sasagawa'),
            ('eeeeeeeeeee', 'Geminiで解析済みの曲', 'Artist'),
            ('zzzzzzzzzzz', '作品名 TV size OP', 'Artist'),               # 明示的なタイアップ → Anime
            ('ggggggggggg', '無名曲', '無名アーティスト'),                   # 名前によらず人声 → J-POP
        ]:
            db.execute("INSERT INTO bookmarks (playlist_id, youtube_id, title, channel) "
                       "VALUES (10, ?, ?, ?)", (vid, title, channel))
        # updated_at は現在時刻にする (キャッシュTTL切れのエントリは無効扱いになるため)
        now = int(time.time())
        for vid, data in cache.items():
            db.execute("INSERT INTO analysis_cache (youtube_id, data, updated_at) VALUES (?, ?, ?)",
                       (vid, json.dumps(data), now))
        db.commit()

    # --- 合成音声の明示名とジャンル/歌唱主体の正規化 ---
    assert ai_analyzer.detect_vocaloid('曲 feat.初音ミク') is True
    assert ai_analyzer.detect_vocaloid('笹川真生 - サニーサイドへようこそ') is False
    assert ai_analyzer.detect_vocaloid('Platform 5', 'Hanakuma Chifuyu') is True
    assert ai_analyzer.detect_vocaloid_producer('いよわ/iyowa') is True
    assert ai_analyzer.detect_vocaloid_producer('DECO*27') is True
    assert ai_analyzer.detect_vocaloid_producer('米津玄師') is False
    assert ai_analyzer.explicit_metadata_category('上書き', 'いよわ') == 'Vocaloid'
    assert ai_analyzer.normalize_category('jpop') == 'J-POP'
    assert ai_analyzer.normalize_vocal_type('human voice') == 'human'
    assert ai_analyzer.normalize_vocal_type('voicebank') == 'synthetic'
    assert ai_analyzer.normalize_vocal_type('not sure') == 'unknown'
    assert ai_analyzer.normalize_category('Lo-Fi') == 'Lo-Fi'
    assert ai_analyzer.normalize_category('ボカロ') == 'Vocaloid'
    assert ai_analyzer.normalize_category('謎ジャンル') is None
    assert ai_analyzer.explicit_metadata_category('作品名 TV size OP', 'Artist') == 'Anime'
    assert ai_analyzer.explicit_metadata_category('映画主題歌 - 曲名', 'Artist') == 'Anime'
    assert ai_analyzer.explicit_metadata_category('Lo-Fi beats 01', 'Producer') == 'Lo-Fi'
    assert ai_analyzer.explicit_metadata_category('Anime-inspired pop song', 'Artist') is None
    assert ai_analyzer.explicit_metadata_category('ドラマ主題歌 - 曲名', 'Artist') is None

    # 明示的なリリース情報は、曖昧なLLMジャンル回答より優先する。
    # 歌唱主体による補正はアーティスト名リストではなく、曲ごとの一般判定を使う。
    previous_engine = ai_analyzer.AI_ENGINE
    original_ollama = ai_analyzer._call_ollama
    original_genre = ai_analyzer._call_llm_genre
    original_bpm = ai_analyzer._call_llm_bpm
    ai_analyzer.AI_ENGINE = 'ollama'
    ai_analyzer._call_ollama = lambda *_: {'tempo': 155, 'genre': 'J-POP'}
    ai_analyzer._call_llm_bpm = lambda *_: {'tempo': 140}
    ai_analyzer._call_llm_genre = lambda *_: {
        'genre': 'Vocaloid', 'vocal_type': 'human'}
    try:
        result = ai_analyzer.analyze('作品名 TV size OP', 'Artist', 'Other')
        assert result['ai_category'] == 'Anime', result
        assert result['tempo'] == 140.0, result        # 専用BPM呼び出しの値が採用される
        result = ai_analyzer.analyze('サニーサイドへようこそ', '笹川真生', 'Other')
        assert result['ai_category'] == 'J-POP', result
        result = ai_analyzer.analyze('無名の曲', '無名の人間アーティスト', 'Other')
        assert result['ai_category'] == 'J-POP', result
        # BPM 不明 (0) ならルールベースへフォールバックする
        ai_analyzer._call_llm_bpm = lambda *_: {'tempo': 0}
        result = ai_analyzer.analyze('無名の曲', '無名の人間アーティスト', 'Other')
        assert result['tempo_source'] == 'rules', result
        ai_analyzer._call_llm_genre = lambda *_: {
            'genre': 'J-POP', 'vocal_type': 'synthetic'}
        result = ai_analyzer.analyze('合成音声の曲', 'Producer', 'Other')
        assert result['ai_category'] == 'Vocaloid', result
    finally:
        ai_analyzer.AI_ENGINE = previous_engine
        ai_analyzer._call_ollama = original_ollama
        ai_analyzer._call_llm_genre = original_genre
        ai_analyzer._call_llm_bpm = original_bpm

    # --- 表示カテゴリの優先順位 ---
    items = {item['youtube_id']: item for item in app._db_bookmarks()}
    assert items['aaaaaaaaaaa']['category'] == 'Anime', items['aaaaaaaaaaa']
    assert items['bbbbbbbbbbb']['category'] == 'Other', items['bbbbbbbbbbb']       # 未解析は Other
    assert items['ccccccccccc']['category'] == 'Vocaloid', items['ccccccccccc']    # ボカロ名は名前だけで確定
    assert items['ddddddddddd']['category'] == 'J-POP', items['ddddddddddd']
    assert items['ggggggggggg']['category'] == 'J-POP', items['ggggggggggg']
    assert items['zzzzzzzzzzz']['category'] == 'Anime', items['zzzzzzzzzzz']      # 明示情報はキャッシュ無しでも反映

    # Gemini のAI結果を保持し、音源特徴だけを更新する経路
    fake_vibe = types.ModuleType('vibe_analyzer')
    fake_vibe.analyze = lambda *_args, **_kwargs: {
        'tempo': 128.0, 'tempo_raw': 64.0, 'tempo_raw_full': 128.0,
        'tempo_confidence': 0.8, 'tempo_method': 'octave', 'tempo_candidates': [],
        'tempo_algo': 5, 'engine': 'librosa+clap', 'duration': 180.0,
        'feature_vector': [0.64] * 8, 'mood': 'energetic',
        'mood_source': 'clap', 'mood_confidence': 0.75, 'vibe_tags': ['高速'],
    }
    previous_audio_engine = app.audio_engine_name
    previous_threads = app.CPU_THREADS
    app.audio_engine_name = lambda: 'librosa'
    app.CPU_THREADS = 0
    sys.modules['vibe_analyzer'] = fake_vibe
    try:
        refreshed = app.reanalyze_audio_only('eeeeeeeeeee', 'Geminiで解析済みの曲', 'Artist')
        assert refreshed['engine'] == 'gemini', refreshed
        assert refreshed['tempo_source'] == 'audio' and refreshed['tempo'] == 128.0, refreshed
        assert refreshed.get('ai_category') is None, refreshed
        saved = app._analysis_cache_entry('eeeeeeeeeee')
        assert saved['engine'] == 'gemini' and saved['tempo_source'] == 'audio', saved
    finally:
        app.audio_engine_name = previous_audio_engine
        app.CPU_THREADS = previous_threads
        sys.modules.pop('vibe_analyzer', None)

    # --- Gemini 解析済みの曲は「全曲解析」の対象外 ---
    client = app.app.test_client()
    with client:
        payload = client.get('/radar/analyze_all?audio=0&force=1&limit=10').get_json()
    assert payload['success'] is True, payload
    assert 'eeeeeeeeeee' in payload['skipped_gemini'], payload['skipped_gemini']
    assert 'eeeeeeeeeee' not in payload['queued'], payload['queued']
    assert 'aaaaaaaaaaa' in payload['queued'], payload['queued']          # 保護対象以外は対象になる
    time.sleep(0.5)                                              # バックグラウンドのバッチ完了待ち

    # --- 途中保存 (進捗の永続化) と再開 ---
    # 中断状態を保存 → 復元 → 再開可能フラグが立つことを確認する
    with app._ANALYZE_LOCK:
        app._ANALYZE_STATE.update({
            'running': True, 'total': 10, 'done': 3, 'queued': ['aaaaaaaaaaa', 'bbbbbbbbbbb'],
            'results': [], 'errors': [], 'interrupted': False,
        })
    app._persist_batch_state()
    loaded = app._load_batch_state()
    assert loaded and loaded['done'] == 3 and loaded['queued'] == ['aaaaaaaaaaa', 'bbbbbbbbbbb'], loaded

    # 再起動を模して復元する (running=True のまま落ちた → interrupted=True, running=False)
    app._restore_batch_state()
    with app._ANALYZE_LOCK:
        st = dict(app._ANALYZE_STATE)
    assert st['interrupted'] is True and st['running'] is False and st['done'] == 3, st

    # analyze_status が再開可能を報告する
    with client:
        status = client.get('/radar/analyze_status').get_json()['state']
    assert status['resumable'] is True and status['interrupted'] is True, status

    # reset=1 で中断状態を破棄する
    with client:
        client.get('/radar/analyze_all?audio=0&reset=1').get_json()
    assert app._load_batch_state() is None
    with app._ANALYZE_LOCK:
        assert app._ANALYZE_STATE['interrupted'] is False and app._ANALYZE_STATE['done'] == 0, app._ANALYZE_STATE

    # --- Ollama による自動おすすめ順 (レシピはモックで固定) ---
    original_recommend = ai_analyzer.recommend_recipe
    ai_analyzer.recommend_recipe = lambda _profile: {
        'taste': '明るいボカロが好き',
        'prefer_genres': ['Vocaloid', 'J-POP'],
        'prefer_moods': ['happy', 'energetic'],
        'tempo': 'mid', 'energy': 'any', 'valence': 'high',
    }
    try:
        with client:
            rec = client.get('/radar/recommend').get_json()
        assert rec['success'] is True, rec
        assert rec['fallback'] is False, rec
        assert rec['prefer_genres'] == ['Vocaloid', 'J-POP'], rec
        # 全ブックマークが順序に含まれる
        assert set(rec['order']) == {r['youtube_id'] for r in app._db_bookmarks()}, rec['order']
    finally:
        ai_analyzer.recommend_recipe = original_recommend

    # --- ブックマーク登録時に音源解析 (librosa/CLAP) をキューへ積む ---
    calls = []
    original_reanalyze_audio_only = app.reanalyze_audio_only
    app.reanalyze_audio_only = lambda vid, title, channel: calls.append(vid) or {}
    previous_audio = app.audio_engine_name
    app.audio_engine_name = lambda: 'librosa'
    try:
        app._queue_audio_measure('ccccccccccc', 'テスト曲 feat.初音ミク', 'Prod')
        # ワーカーがキューを処理して reanalyze_audio_only を呼ぶまで待つ
        deadline = time.time() + 3
        while time.time() < deadline and 'ccccccccccc' not in calls:
            time.sleep(0.05)
        assert 'ccccccccccc' in calls, calls
    finally:
        app.reanalyze_audio_only = original_reanalyze_audio_only
        app.audio_engine_name = previous_audio

print('PASS: ジャンル判定・Gemini保護・途中保存・おすすめ順・音源解析キュー。')
