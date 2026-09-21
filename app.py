#!/usr/bin/env python3
"""
Tune drop - Flask Authentication Server
Token-based authentication with PyJWT and Werkzeug password hashing.
Runs on http://localhost:5000
"""

import os
import sqlite3
import datetime
import time
import json
import threading
import urllib.request
import urllib.parse
import secrets
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import jwt

from runtime_config import load_environment, load_secret

load_environment()

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# Config
DB_PATH = os.environ.get('TUNEDROP_DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'database.sqlite'))
SECRET_KEY = load_secret()
JWT_EXPIRATION_HOURS = 24

# Google OAuth 2.0 (Google Identity Services)
# Google Cloud Console で「OAuth 2.0 クライアントID (ウェブアプリケーション)」を作成し、
# 承認済みの JavaScript 生成元とリダイレクト URI を設定してください。
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '').strip()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db_if_needed():
    """Ensure database and tables exist."""
    conn = get_db()
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                google_sub TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                category TEXT DEFAULT 'Other',
                is_public BOOLEAN DEFAULT 0,
                cover_id TEXT,
                is_favorite INTEGER DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bookmarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                playlist_id INTEGER NOT NULL,
                youtube_id TEXT NOT NULL,
                title TEXT DEFAULT 'Unknown Title',
                channel TEXT DEFAULT 'Unknown Artist',
                is_favorite INTEGER DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
            );
        """)
        # 既存DBへの google_sub カラム追加 (Googleログイン対応)
        try:
            cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
            if 'google_sub' not in cols:
                conn.execute("ALTER TABLE users ADD COLUMN google_sub TEXT")
        except Exception:
            pass
        if 'display_name' not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_unique ON users(display_name)")
        # 全ユーザー共通の固定タブ (未整理 / 公開用お気に入り) を識別する system_key 列
        migrate_system_playlists(conn)
    conn.close()


# 固定タブの定義 (api.php の TUNEDROP_SYSTEM_PLAYLISTS と揃える)
SYSTEM_PLAYLISTS = [
    ('inbox', '未整理', 'Other', 0, 0),
    ('public_favorites', '公開用お気に入り', 'J-POP', 1, 1),
]


def migrate_system_playlists(conn):
    """既存DBへ system_key 列を追加し、名前から未整理/公開用お気に入りを自動で印付ける。"""
    columns = [row[1] for row in conn.execute("PRAGMA table_info(playlists)").fetchall()]
    if 'system_key' not in columns:
        conn.execute("ALTER TABLE playlists ADD COLUMN system_key TEXT")
    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS playlists_system_key_unique ON playlists(user_id, system_key)"
        )
    except sqlite3.IntegrityError:
        # 既に重複した system_key がある場合は索引作成をあきらめる (動作には影響しない)
        pass
    for system_key, name, _category, _is_public, _is_favorite in SYSTEM_PLAYLISTS:
        conn.execute(
            """
            UPDATE playlists SET system_key = ?
             WHERE system_key IS NULL AND name = ?
               AND id IN (SELECT MIN(id) FROM playlists WHERE system_key IS NULL AND name = ? GROUP BY user_id)
            """,
            (system_key, name, name),
        )
    # 固定タブは各ユーザー専用 (自分のものを1つだけ持つ) ため、過去に他ユーザーの固定タブへ
    # 登録したお気に入りは同名タブが二重に並ぶ原因になる。重複表示を避けるため取り除く。
    # (自分の固定タブは public_favorites ではなく playlists.is_favorite で管理する)
    try:
        conn.execute(
            """
            DELETE FROM public_favorites
             WHERE kind = 'playlist'
               AND target_id IN (SELECT id FROM playlists WHERE system_key IS NOT NULL)
            """
        )
    except sqlite3.OperationalError:
        # public_favorites が無いDB (api.php 未実行) では何もしない
        pass


def new_display_name(cursor):
    # Try every four-digit value at most once, starting at a random position.
    start = secrets.randbelow(10000)
    for offset in range(10000):
        candidate = f"user{(start + offset) % 10000:04d}"
        if not cursor.execute("SELECT 1 FROM users WHERE username=? OR display_name=?", (candidate, candidate)).fetchone():
            return candidate
    raise ValueError('利用可能な初期ユーザー名がありません。')


# サイト初期データのサンプル楽曲 (setup.sql の初期データと同じ2曲)
SAMPLE_BOOKMARKS = [
    ('uSijY6BEMRE', 'Yellow', 'kz (livetune)'),
    ('bPI0_YzOiEw', 'i wanna be your world', 'kz (livetune)'),
]


def insert_default_library(cursor, user_id):
    """新規ユーザー向けに、サイト初期データのサンプル楽曲を入れたデフォルトプレイリストを用意する。

    - 未整理 (非公開) … サンプル2曲
    - 公開用お気に入り (公開) … サンプル2曲
    どちらのリストを開いてもサンプルが見えるように、両方に配置する。
    cover_id は api.php 側で最新曲が自動設定されるため NULL で作成する。
    """
    cursor.execute(
        "INSERT INTO playlists (user_id, name, category, is_public, cover_id, is_favorite, system_key, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, '未整理', 'Other', 0, None, 0, 'inbox', 0)
    )
    unorganized_id = cursor.lastrowid
    cursor.execute(
        "INSERT INTO playlists (user_id, name, category, is_public, cover_id, is_favorite, system_key, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, '公開用お気に入り', 'J-POP', 1, None, 1, 'public_favorites', 1)
    )
    fav_playlist_id = cursor.lastrowid
    for sort_order, (youtube_id, title, channel) in enumerate(SAMPLE_BOOKMARKS):
        cursor.execute(
            "INSERT INTO bookmarks (playlist_id, youtube_id, title, channel, sort_order) VALUES (?, ?, ?, ?, ?)",
            (unorganized_id, youtube_id, title, channel, sort_order)
        )
        cursor.execute(
            "INSERT INTO bookmarks (playlist_id, youtube_id, title, channel, sort_order) VALUES (?, ?, ?, ?, ?)",
            (fav_playlist_id, youtube_id, title, channel, sort_order)
        )
    return fav_playlist_id


def generate_token(user_id, username):
    payload = {
        'user_id': user_id,
        'username': username,
        'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=JWT_EXPIRATION_HOURS),
        'iat': datetime.datetime.utcnow()
    }
    return jwt.encode(payload, SECRET_KEY, algorithm='HS256')


def decode_token(token):
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=['HS256'])
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None


@app.route('/auth/register', methods=['POST'])
def register():
    data = request.get_json() or {}
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()

    if not username or not password:
        return jsonify({'error': 'ユーザー名とパスワードを入力してください。'}), 400

    if len(username) < 3 or len(username) > 30:
        return jsonify({'error': 'ユーザー名は3文字以上30文字以内で指定してください。'}), 400

    if len(password) < 4:
        return jsonify({'error': 'パスワードは4文字以上で指定してください。'}), 400

    password_hash = generate_password_hash(password, method='pbkdf2:sha256')

    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.cursor()
        display_name = new_display_name(cursor)
        cursor.execute(
            "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)",
            (username, password_hash, display_name)
        )
        user_id = cursor.lastrowid

        # 新規ユーザーのデフォルト保護プレイリスト作成 (未整理 & 公開用お気に入り)
        # サイト初期データのサンプル楽曲も同時に用意する
        insert_default_library(cursor, user_id)

        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({'error': 'このユーザー名は既に使用されています。'}), 409
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': f'登録処理に失敗しました: {str(e)}'}), 500

    conn.close()
    token = generate_token(user_id, display_name)
    return jsonify({
        'success': True,
        'message': '登録が完了しました。',
        'token': token,
        'user': {
            'id': user_id,
            'username': display_name
        }
    }), 201


@app.route('/auth/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()

    if not username or not password:
        return jsonify({'error': 'ユーザー名とパスワードを入力してください。'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, COALESCE(display_name, username) AS username, password_hash FROM users WHERE username = ?", (username,))
    row = cursor.fetchone()
    conn.close()

    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify({'error': 'ユーザー名またはパスワードが正しくありません。'}), 401

    token = generate_token(row['id'], row['username'])
    return jsonify({
        'success': True,
        'message': 'ログインに成功しました。',
        'token': token,
        'user': {
            'id': row['id'],
            'username': row['username']
        }
    }), 200


@app.route('/auth/google', methods=['POST'])
def google_login():
    """Google ID トークンを検証し、ログイン/アカウント作成して JWT を返す。

    フロントは Google Identity Services (GIS) の `google.accounts.id`
    で取得した `credential` (JWT) を { "credential": "..." } として送る。
    """
    data = request.get_json() or {}
    credential = (data.get('credential') or data.get('id_token') or '').strip()
    if not credential:
        return jsonify({'error': 'Google 認証情報がありません。'}), 400

    if not GOOGLE_CLIENT_ID:
        return jsonify({'error': 'サーバーの GOOGLE_CLIENT_ID が未設定です。'}), 503
    try:
        # google-auth verifies Google's signature, audience, issuer and expiry.
        from google.oauth2 import id_token
        from google.auth.transport.requests import Request
        info = id_token.verify_oauth2_token(credential, Request(), GOOGLE_CLIENT_ID)
        if not info.get('sub'):
            raise ValueError('Missing subject')
    except Exception:
        # Network failures must never bypass signature verification.
        return jsonify({'error': 'Google トークンの検証に失敗しました。'}), 401

    sub = info['sub']
    email = (info.get('email') or '').strip()
    name = (info.get('name') or '').strip()

    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.cursor()
        row = cur.execute("SELECT * FROM users WHERE google_sub = ?", (sub,)).fetchone()
        if not row:
            username = new_display_name(cur)
            cur.execute("INSERT INTO users (username, password_hash, google_sub, display_name) VALUES (?, ?, ?, ?)",
                        (username, '!google-oauth', sub, username))
            user_id = cur.lastrowid
            insert_default_library(cur, user_id)
        else:
            user_id = row['id']
            username = row['display_name'] or row['username']
        conn.commit()
    except Exception:
        conn.rollback()
        return jsonify({'error': 'Googleログイン処理に失敗しました。'}), 500
    finally:
        conn.close()

    token = generate_token(user_id, username)
    return jsonify({
        'success': True,
        'message': 'Google ログインに成功しました。',
        'token': token,
        'user': {'id': user_id, 'username': username}
    }), 200


@app.route('/auth/profile', methods=['POST'])
def update_profile():
    authorization = request.headers.get('Authorization', '')
    decoded = decode_token(authorization[7:]) if authorization.startswith('Bearer ') else None
    if not decoded:
        return jsonify({'error': 'ログインし直してください。'}), 401
    data = request.get_json(silent=True) or {}
    name = data.get('username')
    if not isinstance(name, str):
        return jsonify({'error': 'ユーザー名を入力してください。'}), 400
    name = name.strip()
    if not 3 <= len(name) <= 30 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        return jsonify({'error': 'ユーザー名は改行なしの3〜30文字で入力してください。'}), 400
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute("SELECT 1 FROM users WHERE id=?", (decoded['user_id'],)).fetchone():
            return jsonify({'error': 'ユーザーが見つかりません。'}), 404
        if conn.execute("SELECT 1 FROM users WHERE id!=? AND (username=? OR display_name=?)", (decoded['user_id'], name, name)).fetchone():
            return jsonify({'error': 'このユーザー名は既に使用されています。'}), 409
        conn.execute("UPDATE users SET display_name=? WHERE id=?", (name, decoded['user_id']))
        conn.commit()
    except sqlite3.IntegrityError:
        return jsonify({'error': 'このユーザー名は既に使用されています。'}), 409
    finally:
        conn.close()
    return jsonify({'success': True, 'token': generate_token(decoded['user_id'], name),
                    'user': {'id': decoded['user_id'], 'username': name}})


@app.route('/auth/me', methods=['GET'])
def get_current_user():
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return jsonify({'error': '認証ヘッダーがありません。'}), 401

    token = auth_header.split(' ')[1]
    decoded = decode_token(token)
    if not decoded:
        return jsonify({'error': 'トークンが無効または期限切れです。'}), 401

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, COALESCE(display_name, username) AS username, created_at FROM users WHERE id = ?", (decoded['user_id'],))
    row = cursor.fetchone()

    # ユーザーの統計情報を合わせて返却
    cursor.execute("SELECT count(*) as count FROM playlists WHERE user_id = ?", (decoded['user_id'],))
    playlists_count = cursor.fetchone()['count']

    cursor.execute("""
        SELECT count(*) as count FROM bookmarks b
        JOIN playlists p ON b.playlist_id = p.id
        WHERE p.user_id = ?
    """, (decoded['user_id'],))
    bookmarks_count = cursor.fetchone()['count']

    # お気に入り = 「お気に入り曲」+「お気に入りリスト」
    # (api.php の一覧と同じ判定に揃える: 自分のお気に入り + 公開曲/公開リストに付けたお気に入り)
    try:
        cursor.execute("""
            SELECT count(*) as count FROM bookmarks b
            JOIN playlists p ON b.playlist_id = p.id
            WHERE (b.is_favorite = 1 AND p.user_id = ?)
               OR (p.is_public = 1 AND EXISTS(
                       SELECT 1 FROM public_favorites f
                       WHERE f.user_id = ? AND f.kind = 'track' AND f.target_id = b.id))
        """, (decoded['user_id'], decoded['user_id']))
        favorites_count = cursor.fetchone()['count']

        cursor.execute("""
            SELECT count(*) as count FROM playlists p
            WHERE (p.is_favorite = 1 AND p.user_id = ?)
               OR (p.is_public = 1 AND EXISTS(
                       SELECT 1 FROM public_favorites f
                       WHERE f.user_id = ? AND f.kind = 'playlist' AND f.target_id = p.id))
        """, (decoded['user_id'], decoded['user_id']))
        favorites_count += cursor.fetchone()['count']
    except sqlite3.OperationalError:
        # public_favorites が無いDB (api.php 未実行) では自分のお気に入り曲のみ数える
        cursor.execute("""
            SELECT count(*) as count FROM bookmarks b
            JOIN playlists p ON b.playlist_id = p.id
            WHERE p.user_id = ? AND b.is_favorite = 1
        """, (decoded['user_id'],))
        favorites_count = cursor.fetchone()['count']

    conn.close()

    if not row:
        return jsonify({'error': 'ユーザーが見つかりません。'}), 404

    return jsonify({
        'user': {
            'id': row['id'],
            'username': row['username'],
            'created_at': row['created_at'],
            'stats': {
                'playlists_count': playlists_count,
                'bookmarks_count': bookmarks_count,
                'favorites_count': favorites_count
            }
        }
    }), 200


@app.route('/health', methods=['GET'])
@app.route('/auth/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'service': 'Tune drop Auth Server'}), 200


def _analysis_cache_entry(video_id):
    """analysis_cache から解析結果 (dict or None) を返す。"""
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT data FROM analysis_cache WHERE youtube_id=?", (video_id,)).fetchone()
        conn.close()
        if row:
            import json
            return json.loads(row["data"])
    except Exception:
        pass
    return None


def _save_analysis_cache(video_id, result, merge=False):
    """AI/解析結果を analysis_cache に保存する。

    merge=True のときは既存エントリに result をマージする。
    その際 analysis_cache.protect_measured() を通すため、音源解析済みの行は
    AI 推定 (gemini / rules) のフィールドで実測 BPM や CLAP のムードを失わない。
    (AI 推定と実測値が同じ行に共存できる)
    """
    try:
        import analysis_cache
        conn = get_db()
        conn.execute(
            "CREATE TABLE IF NOT EXISTS analysis_cache ("
            "youtube_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)")
        import json
        data = dict(result)
        if merge:
            existing = _analysis_cache_entry(video_id) or {}
            data = analysis_cache.protect_measured(existing, data)
            existing.update(data)
            data = existing
        # 「保存されている tempo が実測値かどうか」を常に明確にする
        data["measured"] = (data.get("tempo_source")
                            in analysis_cache.MEASURED_SOURCES)
        conn.execute(
            "INSERT OR REPLACE INTO analysis_cache (youtube_id, data, updated_at) "
            "VALUES (?, ?, ?)",
            (video_id, json.dumps(data, ensure_ascii=False), int(time.time())))
        conn.commit()
        conn.close()
    except Exception:
        pass



def _num(v, default=0.0):
    """安全に float へ変換する (None/NaN/不正値は default)。"""
    try:
        f = float(v)
    except Exception:
        return default
    if f != f or f in (float("inf"), float("-inf")):
        return default
    return f


def align_tempo(measured, reference):
    """実測 BPM のオクターブ誤り (半速/倍速) を AI 推定値に寄せて補正する。

    ビートトラッカーは 82.9 BPM の曲をそのまま返すことがある (例: KING は実際 165.8)。
    measured の 1/2, 1, 2, 4 倍のうち reference (AI 推定 BPM) に最も近い値を選ぶ。
    reference が無効な場合は measured をそのまま返す。
    """
    m = _num(measured)
    ref = _num(reference)
    if m <= 0 or ref <= 0:
        return m
    best, best_diff = m, abs(m - ref)
    for factor in (0.5, 2.0, 4.0, 0.25):
        cand = m * factor
        if not (55.0 <= cand <= 210.0):
            continue
        diff = abs(cand - ref)
        if diff < best_diff:
            best, best_diff = cand, diff
    return best


def ai_analyze_bookmark(video_id, title, channel, category):
    """曲情報 → ai_analyzer.analyze → 保存。feature_vector を含む dict を返す。"""
    from ai_analyzer import analyze
    res = analyze(title, channel, category)
    res["status"] = "ready"
    res["source_video"] = video_id
    _save_analysis_cache(video_id, res, merge=True)
    return res


def _apply_audio_result(res, va, source="audio"):
    """音源解析 (librosa/CLAP) の実測値を AI 推定結果へ反映する。

    BPM と雰囲気特徴は「実測 > AI推定」の優先順位で上書きする。
    実測 BPM が得られなかった場合は何もせず False を返す。
    """
    from ai_analyzer import FEATURE_KEYS
    bpm = _num(va.get("tempo"))
    if bpm <= 0:
        return False
    res["tempo"] = round(bpm, 1)
    res["tempo_raw"] = va.get("tempo_raw") or round(bpm, 1)
    res["tempo_source"] = source
    res["tempo_confidence"] = va.get("tempo_confidence", 0)
    res["measured"] = True
    res["audio_engine"] = va.get("engine")
    res["duration"] = va.get("duration")
    res["audio_feature_vector"] = (va.get("audio_feature_vector")
                                   or va.get("feature_vector") or [])
    res["chorus"] = va.get("chorus") or []
    res["beats"] = va.get("beats") or []
    res["chords"] = va.get("chords") or []
    for key in ("energy", "danceability", "valence", "acousticness",
                "instrumentalness", "speechiness", "liveness", "mood"):
        if va.get(key) is not None:
            res[key] = va[key]
    if va.get("vibe_tags"):
        res["vibe_tags"] = va["vibe_tags"]
    if va.get("vibe_scores"):
        res["vibe_scores"] = va["vibe_scores"]
    if va.get("vibe_clap"):
        res["vibe_clap"] = va["vibe_clap"]
    fv = va.get("feature_vector")
    if isinstance(fv, list) and len(fv) == len(FEATURE_KEYS):
        # 音源から算出した 8次元ベクトル (UMAP用) をそのまま採用
        res["feature_vector"] = fv
    elif res.get("feature_vector"):
        # 次元数が違う場合 (旧音響ベクトル等) は tempo 要素だけ更新
        res["feature_vector"][0] = round(max(0.0, min(1.0, bpm / 200.0)), 4)
    return True


def audio_engine_name():
    """使用する音源解析エンジン名を返す (TUNEDROP_AUDIO_ENGINE で切替)。

    エンジンは librosa (+CLAP) のみ。"none" / "off" / "0" で音源解析を無効化。
    旧値 "essentia" は librosa として扱う。
    """
    val = (os.environ.get("TUNEDROP_AUDIO_ENGINE", "librosa") or "librosa").strip().lower()
    return "librosa" if val == "essentia" else val


def reanalyze_bookmark(video_id, title, channel, category, use_audio=True):
    """既存曲を再解析する: Gemini(AI) で推定 → 音源解析で雰囲気と BPM を実測上書き。

    - 音源解析 (librosa / CLAP があれば librosa+clap) で
      実測 BPM・energy・valence・mood などを取得し、AI 推定値より優先する。
    - 実測 BPM のオクターブ誤り (半速/倍速) は AI 推定 BPM を参照して補正する。
    - 音源取得に失敗した場合は AI 推定値のまま (measured=False, audio_error を記録)。

    use_audio=False で音源解析をスキップ (Gemini 推定のみ)。
    TUNEDROP_AUDIO_ENGINE=none でも音源解析をスキップする。
    """
    # 1) AI (Gemini or ルールベース) で特徴量・BPM を推定
    res = ai_analyze_bookmark(video_id, title, channel, category)
    if not use_audio or audio_engine_name() in ("none", "off", "0"):
        return res

    # 2) 音源解析 (librosa + 任意で CLAP) で実測値を取得。
    #    オクターブ補正は vibe_analyzer 内部で行う。
    try:
        from vibe_analyzer import analyze as analyze_vibe
        va = analyze_vibe(video_id, DB_PATH, force=True,
                          reference_tempo=res.get("tempo"))
        if not _apply_audio_result(res, va, "audio"):
            res["measured"] = False
            if va.get("error"):
                res["audio_error"] = str(va["error"])[:200]
        _save_analysis_cache(video_id, res, merge=True)
    except Exception as exc:
        res["measured"] = False
        res["audio_error"] = str(exc)[:200]

    return res




def _db_bookmarks(include_cache=True):
    """bookmarks を playlist/user 情報と結合して返す。

    各曲に analysis_cache の feature_vector / tempo / chorus / beats も付与。
    """
    from ai_analyzer import detect_vocaloid
    conn = get_db()
    rows = conn.execute("""
        SELECT b.youtube_id, b.title, b.channel,
               p.category, p.name AS playlist_name, p.is_public, p.user_id,
               COALESCE(u.display_name, u.username) AS author
        FROM bookmarks b
        JOIN playlists p ON p.id = b.playlist_id
        JOIN users u ON u.id = p.user_id
        ORDER BY b.added_at DESC, b.id DESC
    """).fetchall()
    conn.close()

    out = []
    for r in rows:
        item = {
            "youtube_id": r["youtube_id"],
            "title": r["title"],
            "channel": r["channel"],
            "category": r["category"] or "Other",
            "playlist_name": r["playlist_name"] or "",
            "author": r["author"] or "User",
            "is_public": r["is_public"],
            "user_id": r["user_id"],
            "feature_vector": [],
            "tempo": 0.0,
            "chorus_start": None,
            "beats": 0,
            "engine": None,
            "bpm_source": None,
            "vibe_tags": [],
            "audio_engine": None,
            "mood": None,
            "energy": None,
        }
        if include_cache:
            d = _analysis_cache_entry(r["youtube_id"])
            if d:
                item["feature_vector"] = d.get("feature_vector", []) or []
                item["tempo"] = d.get("tempo", 0.0)
                chorus = d.get("chorus") or []
                item["chorus_start"] = float(chorus[0]["start"]) if chorus else None
                item["beats"] = len(d.get("beats") or [])
                item["engine"] = d.get("engine")
                item["bpm_source"] = d.get("tempo_source") or ("audio" if d.get("measured") else None)
                item["vibe_tags"] = d.get("vibe_tags") or []
                item["audio_engine"] = d.get("audio_engine")
                item["mood"] = d.get("mood")
                item["energy"] = d.get("energy")
        # ボカロシンガー名を含む曲は表示カテゴリを Vocaloid に補正 (解析結果が無くても即時反映)
        if detect_vocaloid(item["title"], item["channel"]):
            item["category"] = "Vocaloid"
        out.append(item)
    return out


@app.route('/analysis/async/<video_id>', methods=['GET'])
def analysis_async(video_id):
    """ブックマーク登録時に AI 特徴量推定を実行する。"""
    from audio_download import VIDEO_ID_RE
    if not VIDEO_ID_RE.match(video_id or ""):
        return jsonify({'error': 'Invalid YouTube video ID'}), 400
    hit = _analysis_cache_entry(video_id)
    if hit and hit.get("feature_vector"):
        return jsonify({'status': 'cached'}), 200

    # 曲情報を取得
    bm = None
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT title, channel, category FROM bookmarks b "
            "JOIN playlists p ON p.id = b.playlist_id "
            "WHERE b.youtube_id=?", (video_id,)).fetchone()
        conn.close()
        if row:
            bm = dict(row)
    except Exception:
        pass
    if not bm:
        return jsonify({'status': 'queued', 'note': 'bookmark not found'}), 202

    ai_analyze_bookmark(video_id, bm.get("title"), bm.get("channel"), bm.get("category"))
    return jsonify({'status': 'done'}), 200


@app.route('/ai/analyze/<video_id>', methods=['GET'])
def ai_analyze(video_id):
    """曲情報から特徴量を推定して返す (保存もする)。"""
    from audio_download import VIDEO_ID_RE
    if not VIDEO_ID_RE.match(video_id or ""):
        return jsonify({'error': 'Invalid YouTube video ID'}), 400
    bm = None
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT title, channel, category FROM bookmarks b "
            "JOIN playlists p ON p.id = b.playlist_id "
            "WHERE b.youtube_id=?", (video_id,)).fetchone()
        conn.close()
        if row:
            bm = dict(row)
    except Exception:
        pass
    if not bm:
        return jsonify({'error': 'bookmark not found'}), 404
    res = ai_analyze_bookmark(video_id, bm.get("title"), bm.get("channel"), bm.get("category"))
    return jsonify(res), 200


@app.route('/radar/map', methods=['GET'])
def radar_map():
    """全ブックマークの特徴ベクトルを UMAP で 2次元へ射影する。

    query params:
      public=1   → 公開ブックマークのみ
      user_id=N  → 対象ユーザーを絞る (未指定は全ユーザー)
    """
    from audio_download import VIDEO_ID_RE
    from radar_map import embed

    public_only = request.args.get('public') == '1'
    user_id = _num(request.args.get('user_id'), 0)
    items = _db_bookmarks()
    if user_id:
        items = [i for i in items if i.get("user_id") == int(user_id)]
    if public_only:
        items = [i for i in items if i["is_public"] == 1]

    # 無効ID・重複を除外。同一曲が複数プレイリストに属する場合は
    # 「Other 以外」のカテゴリを優先する (未整理=Other に重複登録されていても本来のカテゴリを表示)。
    seen = {}   # youtube_id -> cleaned 内のインデックス
    cleaned = []
    for it in items:
        vid = it["youtube_id"] or ""
        if not VIDEO_ID_RE.match(vid):
            continue
        idx = seen.get(vid)
        if idx is None:
            seen[vid] = len(cleaned)
            cleaned.append(it)
        elif (cleaned[idx].get("category") or "Other") == "Other" \
                and (it.get("category") or "Other") != "Other":
            cleaned[idx] = it
    items = cleaned

    vectors = [it["feature_vector"] for it in items]
    coords, method = embed(vectors)

    points, pending = [], []
    coord_index = 0
    for i, it in enumerate(items):
        feats = it["feature_vector"] or []
        coords_for_item = coords[coord_index] if feats and coord_index < len(coords) else None
        entry = {
            "youtube_id": it["youtube_id"],
            "title": it["title"],
            "channel": it["channel"],
            "category": it["category"],
            "playlist_name": it["playlist_name"],
            "author": it["author"],
            "features": {
                "tempo": it["tempo"],
                "chorus_start": it["chorus_start"],
                "beats": it["beats"],
                "energy": it["energy"],
                "mood": it["mood"],
                "engine": it["engine"] or "unavailable",
                "bpm_source": it.get("bpm_source"),
                "vibe_tags": it.get("vibe_tags") or [],
                "audio_engine": it.get("audio_engine"),
                "x": round(coords_for_item[0], 4) if coords_for_item else None,
                "y": round(coords_for_item[1], 4) if coords_for_item else None,
            },
        }
        if feats:
            points.append(entry)
            coord_index += 1
        else:
            pending.append({"youtube_id": it["youtube_id"], "title": it["title"]})

    return jsonify({
        "success": True,
        "method": method,
        "count": len(points),
        "pending": pending,
        "points": points,
    }), 200


_ANALYZE_STATE = {
    'running': False,
    'total': 0,
    'done': 0,
    'current': None,
    'queued': [],
    'results': [],
    'errors': [],
    'force': False,
    'audio': True,
    'engine': 'librosa',
    'started_at': None,
    'finished_at': None,
}


def _run_reanalyze_batch(targets, use_audio, force):
    """再解析バッチを実行する (バックグラウンドスレッド用)。"""
    import analysis_cache
    st = _ANALYZE_STATE
    st.update({'running': True, 'total': len(targets), 'done': 0, 'results': [],
               'errors': [], 'audio': use_audio, 'force': force,
               'engine': audio_engine_name(),
               'started_at': time.time(), 'finished_at': None})
    for it in targets:
        vid = it['youtube_id']
        st['current'] = vid
        # 最適化: 全曲再解析 (force=1) でも、実測BPMが既にある曲は音源DLを省略し、
        # AI推定のみを再実行する (曲数が多い場合の処理時間を大幅に短縮)。
        audio_for_song = use_audio and not (
            force and (it.get('bpm_source') in analysis_cache.MEASURED_SOURCES))
        try:
            res = reanalyze_bookmark(vid, it['title'], it['channel'],
                                     it['category'], use_audio=audio_for_song)
            st['results'].append({
                'youtube_id': vid,
                'title': it.get('title'),
                'tempo': res.get('tempo'),
                'tempo_raw': res.get('tempo_raw'),
                'tempo_source': res.get('tempo_source'),
                'engine': res.get('engine'),
                'audio_engine': res.get('audio_engine'),
                'vibe_tags': res.get('vibe_tags'),
                'mood': res.get('mood'),
                'measured': bool(res.get('measured')),
                'error': res.get('audio_error'),
            })
        except Exception as exc:
            st['errors'].append({'youtube_id': vid, 'error': str(exc)[:200]})
        finally:
            st['done'] += 1
    st['current'] = None
    st['running'] = False
    st['finished_at'] = time.time()


@app.route('/radar/analyze_all', methods=['GET'])
def radar_analyze_all():
    """全ブックマークを再解析する (Gemini AI + 音源解析 librosa/CLAP)。

    query params:
      user_id=N  → 対象ユーザーを絞る (未指定は全ユーザー)
      force=1    → 既存キャッシュを無視して全曲再解析 (既定 0 = 未解析のみ)
      audio=0    → 音源解析をスキップしてAIのみ (既定 1 = 両方。旧名 essentia も受付)
      limit=N    → 先頭 N 曲だけを処理
      wait=1     → バックグラウンドではなく同期実行し、結果を返す
    既定は確認のため非同期で開始し、進捗は /radar/analyze_status で取得する。
    """
    from audio_download import VIDEO_ID_RE

    force = request.args.get('force') == '1'
    use_audio = (request.args.get('audio', '1') != '0'
                 and request.args.get('essentia', '1') != '0')
    wait = request.args.get('wait') == '1'
    limit = _num(request.args.get('limit'), 0)

    user_id = _num(request.args.get('user_id'), 0)
    items = _db_bookmarks()
    if user_id:
        items = [i for i in items if i.get("user_id") == int(user_id)]
    targets = []
    for it in items:
        vid = it["youtube_id"]
        if not (vid and VIDEO_ID_RE.match(vid)):
            continue
        if not force and (it["feature_vector"]):
            continue
        if not any(t["youtube_id"] == vid for t in targets):
            targets.append(it)
    if limit > 0:
        targets = targets[:int(limit)]

    if wait:
        _run_reanalyze_batch(targets, use_audio, force)
        return jsonify({'success': True, 'state': _ANALYZE_STATE}), 200

    if targets and not _ANALYZE_STATE['running']:
        threading.Thread(target=_run_reanalyze_batch,
                         args=(targets, use_audio, force), daemon=True).start()

    return jsonify({
        'success': True,
        'queued': [t["youtube_id"] for t in targets],
        'force': force,
        'audio': use_audio,
        'engine': audio_engine_name(),
        'running': _ANALYZE_STATE['running'],
    }), 200


@app.route('/radar/analyze_status', methods=['GET'])
def radar_analyze_status():
    """再解析バッチの進捗を返す (フロントのポーリング用)。"""
    st = dict(_ANALYZE_STATE)
    started = st.get('started_at')
    st['elapsed'] = round(time.time() - started, 1) if started else 0
    return jsonify({'success': True, 'state': st}), 200


@app.route('/youtube/meta', methods=['GET'])
def youtube_meta():
    from youtube_helper import get_video_meta
    video_id = (request.args.get('id') or request.args.get('youtube_id') or '').strip()
    try:
        return jsonify(get_video_meta(video_id))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/youtube/search', methods=['GET'])
def youtube_search():
    from youtube_helper import search_videos
    query = request.args.get('q', '')
    limit = request.args.get('limit', '10')
    try:
        return jsonify(search_videos(query, limit))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/analysis/engines', methods=['GET'])
def analysis_engines():
    """利用可能な解析エンジンを返す (フロントの表示用)。"""
    import shutil
    from ai_analyzer import GEMINI_API_KEY
    engines = {
        'librosa': False, 'clap': False,
        'ytdlp': bool(shutil.which('yt-dlp')), 'ffmpeg': bool(shutil.which('ffmpeg')),
        'youtube_api': False, 'ai': True, 'gemini': bool(GEMINI_API_KEY),
        'engine': audio_engine_name(),
    }
    try:
        from audio_download import find_ytdlp
        engines['ytdlp'] = bool(find_ytdlp() or shutil.which('yt-dlp'))
    except Exception:
        pass
    try:
        from vibe_analyzer import has_librosa, has_clap, clap_status
        engines['librosa'] = has_librosa()
        engines['clap'] = has_clap()
        engines['clap_status'] = clap_status()
    except Exception:
        pass
    try:
        import youtube_helper
        engines['youtube_api'] = bool(youtube_helper.YOUTUBE_API_KEY)
    except Exception:
        pass
    return jsonify(engines), 200


import socket

def get_free_port():
    env_port = os.environ.get('PORT')
    if env_port:
        try:
            return int(env_port)
        except ValueError:
            pass

    candidates = [5000, 5050, 5001, 5555, 8081, 8085]
    for p in candidates:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('127.0.0.1', p))
                return p
        except OSError:
            continue

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


if __name__ == '__main__':
    init_db_if_needed()
    port = get_free_port()

    # Save active port so frontend / PHP can auto-detect
    port_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.auth_port')
    try:
        with open(port_file, 'w') as f:
            f.write(str(port))
    except Exception as e:
        print(f"Notice: Could not write .auth_port file: {e}")

    print(f"==================================================")
    print(f"💧 Tune drop Auth (Production WSGI) running on http://localhost:{port}")
    print(f"==================================================")
    try:
        from waitress import serve
        serve(app, host='127.0.0.1', port=port, _quiet=True)
    except ImportError:
        app.run(host='127.0.0.1', port=port, debug=False)
