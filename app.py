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
import re
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

# SQLite のロック待ち上限 (秒)。MAMP(PHP) も同じ DB を書き換えるため、
# 待ち続けて FastCGI の idle timeout (30秒) を超えないよう短くしておく。
DB_BUSY_TIMEOUT_SECONDS = float(os.environ.get('TUNEDROP_DB_TIMEOUT', '5'))

# Google OAuth 2.0 (Google Identity Services)
# Google Cloud Console で「OAuth 2.0 クライアントID (ウェブアプリケーション)」を作成し、
# 承認済みの JavaScript 生成元とリダイレクト URI を設定してください。
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '').strip()


def get_db():
    """SQLite 接続。PHP (MAMP/api.php) と同時に書き込んでもハングしないよう
    busy_timeout を短く設定する (待ち切れないときは例外で即座に返す)。"""
    conn = sqlite3.connect(DB_PATH, timeout=DB_BUSY_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute(f"PRAGMA busy_timeout = {int(DB_BUSY_TIMEOUT_SECONDS * 1000)};")
    return conn


def enable_wal_mode(conn):
    """WAL ジャーナルに切り替える。

    ロールバックジャーナル方式だと、解析バッチの書き込み中に MAMP(PHP) の
    読み取りが待たされ、Apache の FastCGI idle timeout (30秒) に切られて
    サイト全体が「起動しない」状態になる。WAL は読み書きが互いをブロックしない。
    モードは DB ファイルに記憶されるため、以降の接続では実質 no-op。
    """
    try:
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
    except sqlite3.DatabaseError:
        # WAL にできないファイルシステム (ネットワーク越し等) でも動作は続ける
        pass


def init_db_if_needed():
    """Ensure database and tables exist."""
    conn = get_db()
    enable_wal_mode(conn)
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
        # 同じリスト内で同じ曲が二重登録されないようにする (掃除 + ユニーク索引)
        migrate_unique_bookmarks(conn)
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


def migrate_unique_bookmarks(conn):
    """同じリスト内で同じ曲 (youtube_id) が二重登録されないようにする。

    過去に作られた同一リスト内の重複行を掃除した上で、DBレベルで保証するユニーク索引を張る。
    違うリストへの同じ曲の登録は許可する（ゲストも含む）。
    「すべてのブックマーク」「お気に入り曲」など複数リストをまとめて表示する画面では、
    表示側で youtube_id ごとに1件にまとめる（API側の get_my_bookmarks を参照）。
    """
    # 各 (playlist_id, youtube_id) の組で最も古い行だけを残して重複を取り除く
    duplicated = conn.execute(
        "SELECT 1 FROM bookmarks GROUP BY playlist_id, youtube_id HAVING COUNT(*) > 1 LIMIT 1"
    ).fetchone()
    if duplicated:
        conn.execute(
            """
            DELETE FROM bookmarks
             WHERE id NOT IN (SELECT MIN(id) FROM bookmarks GROUP BY playlist_id, youtube_id)
            """
        )
    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_playlist_video_unique "
            "ON bookmarks(playlist_id, youtube_id)"
        )
    except sqlite3.IntegrityError:
        # 同時書き込みで掃除しきれない重複が残っていた場合は索引作成をあきらめる (動作には影響しない)
        pass
    # 旧仕様 (ゲスト全リストで1曲1件) のトリガーが残っていたら撤去する。
    # 現仕様は「違うリストなら同じ曲OK」のため、ゲスト用トリガーは使わない。
    conn.execute("DROP TRIGGER IF EXISTS bookmarks_guest_video_unique_insert")
    conn.execute("DROP TRIGGER IF EXISTS bookmarks_guest_video_unique_update")


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

    - 未整理 (非公開) … 空 (ゲストは全リストで同じ曲を1つだけ持てるため)
    - 公開用お気に入り (公開) … サンプル2曲
    cover_id は api.php 側で最新曲が自動設定されるため NULL で作成する。
    """
    cursor.execute(
        "INSERT INTO playlists (user_id, name, category, is_public, cover_id, is_favorite, system_key, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, '未整理', 'Other', 0, None, 0, 'inbox', 0)
    )
    cursor.execute(
        "INSERT INTO playlists (user_id, name, category, is_public, cover_id, is_favorite, system_key, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, '公開用お気に入り', 'J-POP', 1, None, 1, 'public_favorites', 1)
    )
    fav_playlist_id = cursor.lastrowid
    for sort_order, (youtube_id, title, channel) in enumerate(SAMPLE_BOOKMARKS):
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
    conn = None
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT data FROM analysis_cache WHERE youtube_id=?", (video_id,)).fetchone()
        if row:
            import json
            return json.loads(row["data"])
    except Exception:
        pass
    finally:
        if conn is not None:
            conn.close()
    return None


def _save_analysis_cache(video_id, result, merge=False):
    """AI/解析結果を analysis_cache に保存する。

    merge=True のときは既存エントリに result をマージする。
    その際 analysis_cache.protect_measured() を通すため、音源解析済みの行は
    AI 推定 (gemini / rules) のフィールドで実測 BPM や CLAP のムードを失わない。
    (AI 推定と実測値が同じ行に共存できる)

    接続は finally で必ず閉じる。例外で開いたままになると、コミットされていない
    書き込みトランザクションがロックを保持し続け、PHP (MAMP) 側が SQLite の
    ロック待ちで固まってしまう (サイト全体が応答しなくなる)。
    """
    conn = None
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
    except Exception:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
    finally:
        if conn is not None:
            conn.close()



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
    """実測 BPM のオクターブ補正 (実装は vibe_analyzer に一本化)。

    以前は同じロジックを app.py にも重複して持っていたため、片方だけ直すと
    解析結果と保存値で挙動が食い違う恐れがあった。ここは互換用の入口として
    vibe_analyzer 側を呼ぶだけにする。
    """
    from vibe_analyzer import align_tempo as _align_tempo
    return _align_tempo(measured, reference)


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
    import analysis_cache
    bpm = _num(va.get("tempo"))
    if bpm <= 0:
        return False
    res["tempo"] = round(bpm, 1)
    res["tempo_raw"] = va.get("tempo_raw") or round(bpm, 1)
    res["tempo_source"] = source
    res["tempo_confidence"] = va.get("tempo_confidence", 0)
    # どの証拠でテンポを決めたか (UI/デバッグ用) とアルゴリズム版を残す
    (res["tempo_method"], res["tempo_candidates"], res["tempo_algo"]) = (
        va.get("tempo_method"), va.get("tempo_candidates"),
        va.get("tempo_algo", analysis_cache.TEMPO_ALGO_VERSION))
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
    try:
        rows = conn.execute("""
            SELECT b.youtube_id, b.title, b.channel,
                   p.category, p.name AS playlist_name, p.is_public, p.user_id,
                   COALESCE(u.display_name, u.username) AS author
            FROM bookmarks b
            JOIN playlists p ON p.id = b.playlist_id
            JOIN users u ON u.id = p.user_id
            ORDER BY b.added_at DESC, b.id DESC
        """).fetchall()
    finally:
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
            "bpm_method": None,
            "bpm_algo": None,
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
                item["bpm_method"] = d.get("tempo_method")
                item["bpm_algo"] = d.get("tempo_algo")
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
    conn = None
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT title, channel, category FROM bookmarks b "
            "JOIN playlists p ON p.id = b.playlist_id "
            "WHERE b.youtube_id=?", (video_id,)).fetchone()
        if row:
            bm = dict(row)
    except Exception:
        pass
    finally:
        if conn is not None:
            conn.close()
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


def _normalize(emb):
    import numpy as np
    arr = np.asarray(emb, dtype="float64")
    if arr.ndim != 2 or arr.shape[0] == 0:
        return []
    mn = arr.min(axis=0)
    mx = arr.max(axis=0)
    rng = mx - mn
    rng[rng == 0] = 1.0
    norm = (arr - mn) / rng
    norm = norm * 0.9 + 0.05   # 5% 余白を付ける
    return np.clip(norm, 0.0, 1.0).tolist()


def _pca2d(X):
    import numpy as np
    X = X - X.mean(axis=0)
    try:
        _, _, vt = np.linalg.svd(X, full_matrices=False)
        return X @ vt[:2].T
    except Exception:
        return X[:, :2]


def embed(features, n_neighbors=15, min_dist=0.1, random_state=42):
    """(coords, method) を返す。coords は各曲の [x, y] ([0,1])。"""
    import numpy as np
    feats = []
    for f in features:
        f = list(f or [])
        if f:
            feats.append(f)
    n = len(feats)
    if n == 0:
        return [], "none"
    if n == 1:
        return [[0.5, 0.5]], "none"
    if n == 2:
        return [[0.0, 0.0], [1.0, 1.0]], "none"

    X = np.asarray(feats, dtype="float64")
    std = X.std(axis=0)
    keep = std > 1e-12
    if not keep.any():
        # 全次元が定数 → 均等円配置にフォールバック
        ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
        return np.column_stack([0.5 + 0.4 * np.cos(ang),
                                0.5 + 0.4 * np.sin(ang)]).tolist(), "circle"

    X = X[:, keep]
    std = X.std(axis=0)
    std[std == 0] = 1.0
    Z = (X - X.mean(axis=0)) / std

    nn = max(2, min(n_neighbors, n - 1))
    method = "umap"
    try:
        import umap  # noqa: F401
        reducer = umap.UMAP(
            n_components=2, n_neighbors=nn, min_dist=min_dist,
            metric="euclidean", random_state=random_state, n_epochs=200,
        )
        emb = reducer.fit_transform(Z)
        if np.asarray(emb).shape[0] != n:
            raise RuntimeError("bad embedding shape")
    except Exception:
        method = "pca"
        emb = _pca2d(Z)

    coords = _normalize(emb)
    if len(coords) != n:   # 最終保険
        coords = [[0.5, 0.5] for _ in range(n)]
        method = "none"
    return coords, method


@app.route('/radar/map', methods=['GET'])
def radar_map():
    """全ブックマークの特徴ベクトルを UMAP で 2次元へ射影する。

    query params:
      public=1   → 公開ブックマークのみ
      user_id=N  → 対象ユーザーを絞る (未指定は全ユーザー)
    """
    from audio_download import VIDEO_ID_RE

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
            # radar_map の応答は描画・検索に使う field のみに絞る。
            # chorus_start / beats / energy / audio_engine はフロントが参照しないため送らない。
            "features": {
                "tempo": it["tempo"],
                "mood": it["mood"],
                "engine": it["engine"] or "unavailable",
                "bpm_source": it.get("bpm_source"),
                "bpm_method": it.get("bpm_method"),
                "vibe_tags": it.get("vibe_tags") or [],
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
        # ただしテンポ推定アルゴリズムが更新された行 (bpm_algo が古い) は、
        # 精度向上を反映させるため音源を取得し直して測り直す。
        already_measured = (
            it.get('bpm_source') in analysis_cache.MEASURED_SOURCES
            and it.get('bpm_algo') == analysis_cache.TEMPO_ALGO_VERSION)
        audio_for_song = use_audio and not (force and already_measured)
        try:
            res = reanalyze_bookmark(vid, it['title'], it['channel'],
                                     it['category'], use_audio=audio_for_song)
            st['results'].append({
                'youtube_id': vid,
                'title': it.get('title'),
                'tempo': res.get('tempo'),
                'tempo_raw': res.get('tempo_raw'),
                'tempo_source': res.get('tempo_source'),
                'tempo_method': res.get('tempo_method'),
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
    import analysis_cache
    targets = []
    for it in items:
        vid = it["youtube_id"]
        if not (vid and VIDEO_ID_RE.match(vid)):
            continue
        if not force and it["feature_vector"]:
            # force=0 (未解析のみ) は「AI推定済みかつ音源実測済み(現行アルゴリズム版)」だけ除外する。
            # 登録時 (/analysis/async) はAI推定のみで feature_vector が付くため、
            # 旧条件 (feature_vector の有無だけ) では音源未実測の曲が対象外になり、
            # 雰囲気検索ボタンで未解析曲が解析されない。
            # audio=0 (AIのみ) の場合は feature_vector あり=解析済みとして除外する。
            measured_current = (
                it.get("bpm_source") in analysis_cache.MEASURED_SOURCES
                and it.get("bpm_algo") == analysis_cache.TEMPO_ALGO_VERSION)
            if not use_audio or measured_current:
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


# APIキーは環境変数から取得。Python起動時に非公開の .env を読み込みます。
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def is_video_id(value: str) -> bool:
    return bool(YOUTUBE_ID_RE.match(value or ""))


def _http_get_json(url: str, timeout: int = 8):
    req = urllib.request.Request(url, headers={"User-Agent": "TuneDrop/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def oembed_meta(video_id: str) -> dict:
    """Fallback metadata without API key (oEmbed + noembed)."""
    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    for endpoint in [
        "https://www.youtube.com/oembed?url=" + urllib.parse.quote(watch_url, safe=""),
        "https://noembed.com/embed?url=" + urllib.parse.quote(watch_url, safe=""),
    ]:
        try:
            data = _http_get_json(endpoint)
            if data and data.get("title"):
                return {
                    "youtube_id": video_id,
                    "title": data.get("title", ""),
                    "channel": data.get("author_name", "Unknown Artist"),
                    "thumbnail": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
                    "source": "oembed",
                }
        except Exception:
            continue
    return {
        "youtube_id": video_id,
        "title": video_id,
        "channel": "Unknown Artist",
        "thumbnail": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
        "source": "fallback",
    }


def get_video_meta(video_id: str) -> dict:
    if not is_video_id(video_id):
        raise ValueError("Invalid YouTube video ID")
    if YOUTUBE_API_KEY:
        try:
            url = (
                "https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id="
                + video_id + "&key=" + YOUTUBE_API_KEY
            )
            data = _http_get_json(url)
            items = data.get("items", [])
            if items:
                sn = items[0].get("snippet", {})
                stats = items[0].get("statistics", {})
                thumbs = (sn.get("thumbnails") or {})
                thumb = (thumbs.get("medium") or thumbs.get("high") or thumbs.get("default") or {}).get("url")
                return {
                    "youtube_id": video_id,
                    "title": sn.get("title", ""),
                    "channel": sn.get("channelTitle", ""),
                    "description": sn.get("publishedAt", ""),
                    "thumbnail": thumb or f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
                    "view_count": stats.get("viewCount"),
                    "source": "youtube-data-api",
                }
        except Exception:
            pass
    return oembed_meta(video_id)


def search_videos(query: str, max_results: int = 10) -> dict:
    query = (query or "").strip()
    if not query:
        raise ValueError("query is required")
    max_results = max(1, min(25, int(max_results or 10)))
    if YOUTUBE_API_KEY:
        try:
            url = (
                "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults="
                + str(max_results) + "&q=" + urllib.parse.quote(query) + "&key=" + YOUTUBE_API_KEY
            )
            data = _http_get_json(url)
            items = []
            for it in data.get("items", []):
                vid = ((it.get("id") or {}).get("videoId")) or ""
                sn = it.get("snippet", {})
                if is_video_id(vid):
                    items.append({
                        "youtube_id": vid,
                        "title": sn.get("title", ""),
                        "channel": sn.get("channelTitle", ""),
                        "thumbnail": f"https://img.youtube.com/vi/{vid}/hqdefault.jpg",
                    })
            return {"source": "youtube-data-api", "items": items}
        except Exception:
            pass
    return {"source": "disabled", "items": [], "hint": "YOUTUBE_API_KEY が未設定のため検索は無効です。URL/IDでの追加をご利用ください。"}


@app.route('/youtube/meta', methods=['GET'])
def youtube_meta():
    video_id = (request.args.get('id') or request.args.get('youtube_id') or '').strip()
    try:
        return jsonify(get_video_meta(video_id))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/youtube/search', methods=['GET'])
def youtube_search():
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
    engines['youtube_api'] = bool(YOUTUBE_API_KEY)
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
    print(f"💧 Tune drop Auth (Production WSGI) running on http://localhost:{port}", flush=True)
    print(f"==================================================", flush=True)
    try:
        from waitress import serve
        serve(app, host='127.0.0.1', port=port, _quiet=True)
    except ImportError:
        app.run(host='127.0.0.1', port=port, debug=False)
