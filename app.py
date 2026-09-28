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
import hashlib
import hmac
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

# ---- 負荷対策 (重い解析でマシンを占有しない) ----
# 音源解析 (librosa/CLAP・torch) は全コアを使い切ると操作が重くなるため、
# 使うスレッド数を制限できる。既定は「コア数の半分 (最低2)」。
#   TUNEDROP_CPU_THREADS=4  → 4スレッドに制限 / 0 や unset で自動 (半分) / "all" で制限なし
_cpu_threads_env = os.environ.get('TUNEDROP_CPU_THREADS', '').strip().lower()
if _cpu_threads_env == 'all':
    CPU_THREADS = 0
elif _cpu_threads_env.isdigit() and int(_cpu_threads_env) > 0:
    CPU_THREADS = int(_cpu_threads_env)
else:
    CPU_THREADS = max(2, (os.cpu_count() or 4) // 2)
# numpy/BLAS は import 時にスレッド数を読むため、numpy を読み込む前に設定する
# (app.py は numpy を関数内で遅延 import しているので、ここで間に合う)。
if CPU_THREADS:
    for _thread_env in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
                        'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
        os.environ.setdefault(_thread_env, str(CPU_THREADS))
# 解析バッチの1曲ごとの待ち時間 (秒)。連続で回し続けても操作が重くならないように少し空ける。
ANALYZE_THROTTLE_SECONDS = float(os.environ.get('TUNEDROP_ANALYZE_THROTTLE', '0.5'))

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


@app.route('/auth/guest', methods=['POST'])
def guest_session():
    """Restore a browser's local guest or create one in the shared local SQLite DB."""
    data = request.get_json(silent=True) or {}
    credential = data.get('credential', '')
    if credential is not None and not isinstance(credential, str):
        return jsonify({'error': 'ゲスト認証情報が無効です。'}), 400
    conn = get_db()
    try:
        if credential:
            match = re.fullmatch(r'(\d+)\.([0-9a-f]{64})', credential)
            if not match:
                return jsonify({'error': 'ゲスト認証情報が無効です。'}), 401
            user_id = int(match.group(1))
            row = conn.execute('SELECT username, password_hash FROM users WHERE id=?', (user_id,)).fetchone()
            digest = hashlib.sha256(match.group(2).encode('ascii')).hexdigest()
            if not row or not row['username'].startswith('guest_') or not hmac.compare_digest(row['password_hash'], '!guest:' + digest):
                return jsonify({'error': 'ゲスト認証情報が無効です。'}), 401
        else:
            secret = secrets.token_hex(32)
            digest = hashlib.sha256(secret.encode('ascii')).hexdigest()
            with conn:
                cursor = conn.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)',
                                      ('guest_' + secrets.token_hex(16), '!guest:' + digest))
                user_id = cursor.lastrowid
                insert_default_library(conn.cursor(), user_id)
            credential = f'{user_id}.{secret}'
        return jsonify({'success': True, 'credential': credential,
                        'token': generate_token(user_id, 'guest'), 'user': {'id': user_id, 'guest': True}})
    finally:
        conn.close()


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
            'username': display_name,
            'login_id': username
        }
    }), 201


@app.route('/auth/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()

    if not username or not password:
        return jsonify({'error': 'ログインIDとパスワードを入力してください。'}), 400

    conn = get_db()
    cursor = conn.cursor()
    # ログインIDは登録時に指定した users.username (メールアドレスなど)。
    # 画面に表示されるのは display_name (表示名) なので、両方を返して混同を防ぐ。
    cursor.execute(
        "SELECT id, username AS login_id, COALESCE(display_name, username) AS username, password_hash"
        " FROM users WHERE username = ?", (username,))
    row = cursor.fetchone()
    conn.close()

    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify({
            'error': 'ログインIDまたはパスワードが正しくありません。'
                     'ログインIDは登録時のメールアドレスなどで、表示名とは別です。'
        }), 401

    token = generate_token(row['id'], row['username'])
    return jsonify({
        'success': True,
        'message': 'ログインに成功しました。',
        'token': token,
        'user': {
            'id': row['id'],
            'username': row['username'],
            'login_id': row['login_id']
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
    cursor.execute("SELECT id, username AS login_id, COALESCE(display_name, username) AS username, created_at FROM users WHERE id = ?", (decoded['user_id'],))
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
            'login_id': row['login_id'],
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
    if va.get("tempo_raw_full") is not None:
        res["tempo_raw_full"] = va["tempo_raw_full"]
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
                "instrumentalness", "speechiness", "liveness", "mood",
                "mood_source", "mood_confidence"):
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
    #    負荷対策: torch は自前のスレッド数を持つため、OMP と同じ上限へ合わせる。
    if CPU_THREADS:
        try:
            import torch
            torch.set_num_threads(CPU_THREADS)
        except Exception:
            pass
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


def reanalyze_audio_only(video_id, title, channel):
    """既存のAI推定を保持したまま、音源由来の特徴量だけを再測定する。"""
    res = _analysis_cache_entry(video_id) or {}
    if audio_engine_name() in ("none", "off", "0"):
        return res
    if CPU_THREADS:
        try:
            import torch
            torch.set_num_threads(CPU_THREADS)
        except Exception:
            pass
    try:
        from vibe_analyzer import analyze as analyze_vibe
        va = analyze_vibe(video_id, DB_PATH, force=True,
                          reference_tempo=res.get("tempo"))
        if _apply_audio_result(res, va, "audio"):
            _save_analysis_cache(video_id, res, merge=True)
        elif va.get("error"):
            res["audio_error"] = str(va["error"])[:200]
    except Exception as exc:
        res["audio_error"] = str(exc)[:200]
    return res




def _db_bookmarks(include_cache=True):
    """bookmarks を playlist/user 情報と結合して返す。

    各曲に analysis_cache の feature_vector / tempo / chorus / beats も付与。
    """
    from ai_analyzer import explicit_metadata_category
    conn = get_db()
    try:
        rows = conn.execute("""
            SELECT b.youtube_id, b.title, b.channel, b.added_at,
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
            "added_at": r["added_at"],   # Radar の「新着順」に使う (YYYY-MM-DD HH:MM:SS)
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
        ai_category = None
        vocal_type = None
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
                ai_category = d.get("ai_category")
                vocal_type = d.get("vocal_type")
        # 表示カテゴリの優先順位: 明示された合成音声/タイアップ情報 → LLMの曲別判定。
        # 人声/合成音声の判定も保存値で補正し、プレイリストカテゴリには依存しない。
        item["category"] = ai_category or "Other"
        metadata_category = explicit_metadata_category(item["title"], item["channel"])
        if metadata_category:
            item["category"] = metadata_category
        elif vocal_type == "human" and item["category"] == "Vocaloid":
            item["category"] = "J-POP"
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


# UMAP (numba) はスレッドセーフではない。embed() を同時に走らせると
# 「Numba workqueue threading layer is terminating: Concurrent access has been detected」
# でプロセスごと落ちる (実際に運用で発生した) ため、埋め込み計算はロックで直列化する。
_EMBED_LOCK = threading.Lock()

# /radar/map の応答キャッシュ。UIは画面を開くたび・解析中に何度も呼ぶため、
# 毎回UMAPを回すと重い (負荷対策)。ブックマークや解析キャッシュが変わったら作り直す。
_MAP_CACHE = {'key': None, 'payload': None, 'at': 0.0}
MAP_CACHE_TTL = float(os.environ.get('TUNEDROP_MAP_CACHE_TTL', '60') or '60')
# 解析バッチ中は内容が数秒ごとに変わるため、変更直後でも最低この秒数は作り直さない
# (古いキャッシュを返してでもUMAPの連続再計算を防ぐ = 負荷対策)。
MAP_MIN_INTERVAL = float(os.environ.get('TUNEDROP_MAP_MIN_INTERVAL', '10') or '10')


def _map_cache_key(public_only, user_id):
    """マップの見た目が変わる条件を表すキー (ブックマーク/プレイリスト/解析キャッシュの版)。"""
    conn = get_db()
    try:
        bookmarks = conn.execute(
            "SELECT COUNT(*), COALESCE(MAX(id), 0) FROM bookmarks").fetchone()
        playlists = conn.execute(
            "SELECT COUNT(*), COALESCE(MAX(id), 0) FROM playlists").fetchone()
        cache = conn.execute(
            "SELECT COUNT(*), COALESCE(MAX(updated_at), 0) FROM analysis_cache").fetchone()
    finally:
        conn.close()
    return (bool(public_only), int(user_id), tuple(bookmarks), tuple(playlists), tuple(cache))


def _dedup_bookmarks(items):
    """bookmarks の重複 (同一曲が複数プレイリストに属する) を除外する。

    同一曲が複数プレイリストに属する場合は「Other 以外」のカテゴリを優先する
    (未整理=Other に重複登録されていても本来のカテゴリを表示)。無効な video_id も除く。
    """
    from audio_download import VIDEO_ID_RE
    seen = {}   # youtube_id -> cleaned 内のインデックス
    cleaned = []
    for it in items:
        vid = it.get("youtube_id") or ""
        if not VIDEO_ID_RE.match(vid):
            continue
        idx = seen.get(vid)
        if idx is None:
            seen[vid] = len(cleaned)
            cleaned.append(it)
        elif (cleaned[idx].get("category") or "Other") == "Other" \
                and (it.get("category") or "Other") != "Other":
            cleaned[idx] = it
    return cleaned


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
        # 同時実行でプロセスが落ちるため、埋め込み計算は直列化する
        with _EMBED_LOCK:
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
    public_only = request.args.get('public') == '1'
    user_id = _num(request.args.get('user_id'), 0)

    # 同じ内容ならキャッシュを返す (UIは解析中に何度も呼ぶため、毎回UMAPを回さない)。
    # 内容が変わっていても MAP_MIN_INTERVAL 秒は古いキャッシュを返し、
    # 解析バッチ中の連続再計算を防ぐ (次に呼ばれたときに作り直す)。
    cache_key = _map_cache_key(public_only, user_id)
    if _MAP_CACHE['payload'] is not None:
        age = time.time() - _MAP_CACHE['at']
        if (_MAP_CACHE['key'] == cache_key and age < MAP_CACHE_TTL) or age < MAP_MIN_INTERVAL:
            return jsonify(_MAP_CACHE['payload']), 200

    items = _db_bookmarks()
    if user_id:
        items = [i for i in items if i.get("user_id") == int(user_id)]
    if public_only:
        items = [i for i in items if i["is_public"] == 1]

    # 無効ID・重複を除外。同一曲が複数プレイリストに属する場合は
    # 「Other 以外」のカテゴリを優先する。
    items = _dedup_bookmarks(items)

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
            # 新着順の並べ替えに使う追加日時 (同一曲が複数リストにある場合は最新の1件)
            "added_at": it.get("added_at"),
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

    payload = {
        "success": True,
        "method": method,
        "count": len(points),
        "pending": pending,
        "points": points,
    }
    _MAP_CACHE.update({'key': cache_key, 'payload': payload, 'at': time.time()})
    return jsonify(payload), 200


# ---- おすすめ順 (Ollama による自動推薦) ----

# 推薦レシピのキャッシュ。12時間ごとに再計算し、それまでは保存済みの結果を即返す
# (Ollama 呼び出しを挟まないため、Radar 画面の切り替えが速くなる)。
# ブックマーク/解析キャッシュが変わった場合は 12時間待たずに再計算する。
_RECOMMEND_CACHE = {'key': None, 'order': [], 'recipe': {}, 'fallback': False, 'at': 0.0}
RECOMMEND_CACHE_TTL = float(os.environ.get('TUNEDROP_RECOMMEND_CACHE_TTL', '43200') or '43200')


def _recommend_cache_file():
    """おすすめ結果を保存する JSON ファイル (DB と別ファイルにして書込競合を避ける)。"""
    return os.environ.get(
        'TUNEDROP_RECOMMEND_CACHE',
        os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), 'analysis_recommend.json'))


def _load_recommend_cache():
    """保存済みのおすすめキャッシュを読む (無ければ None)。"""
    try:
        with open(_recommend_cache_file(), 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _persist_recommend_cache():
    """おすすめキャッシュをディスクへ保存する (12時間の再計算間隔をまたいで再利用)。"""
    try:
        tmp = _recommend_cache_file() + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(_RECOMMEND_CACHE, f, ensure_ascii=False)
        os.replace(tmp, _recommend_cache_file())
    except Exception:
        pass


def _restore_recommend_cache():
    """起動時に保存済みのおすすめキャッシュを復元する。"""
    saved = _load_recommend_cache()
    if saved and saved.get('key') is not None:
        _RECOMMEND_CACHE.update(saved)


# 起動時に保存済みのおすすめを復元する (再起動後も 12時間内は再計算しない)。
_restore_recommend_cache()

# テンポ/エネルギー/明るさの3区分 (指標ごとに異なる値域)
_BAND_RANGES = {
    'tempo':   {'slow': (0, 100), 'mid': (100, 140), 'fast': (140, 1e9)},
    'energy':  {'low': (0, 0.4), 'mid': (0.4, 0.65), 'high': (0.65, 1e9)},
    'valence': {'low': (0, 0.4), 'mid': (0.4, 0.6), 'high': (0.6, 1e9)},
}


def _band_match(metric, value, band):
    """value が band (slow/mid/fast や low/mid/high, 'any'/None) に該当すれば 1.0。"""
    if band in (None, '', 'any'):
        return 0.5
    lo, hi = _BAND_RANGES.get(metric, {}).get(band, (None, None))
    if lo is None or value is None:
        return 0.0
    try:
        return 1.0 if lo <= float(value) < hi else 0.0
    except (TypeError, ValueError):
        return 0.0


def _rank_weight(value, ranked):
    """ranked リスト内の順位ほど高い重み (0..1)。含まれなければ 0。空なら 0.5。"""
    if not ranked:
        return 0.5
    try:
        idx = ranked.index(value)
    except ValueError:
        return 0.0
    return (len(ranked) - idx) / max(1, len(ranked))


@app.route('/radar/recommend', methods=['GET'])
def radar_recommend():
    """Ollama による自動おすすめ順を返す。

    - 好みプロファイル (ジャンル/ムード分布・テンポ・エネルギー概況) を作り、
      Ollama に「どのジャンル/ムード/テンポを優先するか」のレシピを出させる。
    - レシピへの一致度 + お気に入り + 新着を決定的スコア化して曲を並べる。

    query params:
      user_id=N  → 対象ユーザーを絞る (未指定は全ユーザー)
      public=1   → 公開ブックマークのみ
      refresh=1  → キャッシュを無視して再計算
    """
    from collections import Counter
    from ai_analyzer import recommend_recipe, CATEGORIES

    user_id = _num(request.args.get('user_id'), 0)
    public_only = request.args.get('public') == '1'
    refresh = request.args.get('refresh') == '1'

    # キャッシュキー (ブックマーク/プレイリスト/解析キャッシュの版)。
    # 永続化で tuple→list 化して比較が壊れないよう、JSON 文字列で持つ。
    cache_key = json.dumps(_map_cache_key(public_only, user_id), sort_keys=True)
    if not refresh and _RECOMMEND_CACHE['key'] == cache_key \
            and time.time() - _RECOMMEND_CACHE['at'] < RECOMMEND_CACHE_TTL:
        return jsonify(_RECOMMEND_CACHE['payload']), 200

    items = _db_bookmarks()
    if user_id:
        items = [i for i in items if i.get("user_id") == int(user_id)]
    if public_only:
        items = [i for i in items if i["is_public"] == 1]
    # 同一曲が複数プレイリストに属する重複を除外する (radar_map と同様)
    items = _dedup_bookmarks(items)

    # 好みプロファイルの要約
    genres = Counter(i.get('category') or 'Other' for i in items)
    moods = Counter(i.get('mood') for i in items if i.get('mood'))
    tempos = [i.get('tempo') for i in items if i.get('tempo') and i.get('tempo') > 0]
    energies = [i.get('energy') for i in items if i.get('energy') is not None]

    lines = []
    if genres:
        lines.append('Genres: ' + ', '.join(f'{g} {c}曲' for g, c in genres.most_common(5)))
    if moods:
        lines.append('Moods: ' + ', '.join(f'{m} {c}曲' for m, c in moods.most_common(5)))
    if tempos:
        lines.append('Tempo: 平均 %.0f BPM (%.0f〜%.0f)' % (sum(tempos) / len(tempos), min(tempos), max(tempos)))
    if energies:
        lines.append('Energy: 平均 %.2f (0〜1)' % (sum(energies) / len(energies)))
    profile_text = '\n'.join(lines) or 'No analyzed tracks yet.'

    recipe = recommend_recipe(profile_text) or {}
    fallback = not recipe

    # Ollama 失敗時は分布上位を既定の好みにする
    prefer_genres = [g for g in (recipe.get('prefer_genres') or []) if g in CATEGORIES]
    if not prefer_genres:
        prefer_genres = [g for g, _c in genres.most_common(3)]
    prefer_moods = list(recipe.get('prefer_moods') or [])
    if not prefer_moods:
        prefer_moods = [m for m, _c in moods.most_common(3)]
    tempo_pref = recipe.get('tempo') or 'any'
    energy_pref = recipe.get('energy') or 'any'
    valence_pref = recipe.get('valence') or 'any'

    # 曲ごとのおすすめスコア
    # お気に入りプレイリストに属する曲は加点 (公開用お気に入り etc.)
    fav_ids = _favorite_video_ids()
    # 新着の基準 (最新 added_at を 1.0 に正規化)
    added_times = []
    for i in items:
        try:
            added_times.append((i['youtube_id'], datetime.datetime.strptime(
                str(i.get('added_at') or ''), '%Y-%m-%d %H:%M:%S').timestamp()))
        except (ValueError, TypeError):
            pass
    newest = max((t for _vid, t in added_times), default=time.time())
    oldest = min((t for _vid, t in added_times), default=newest)
    span = max(1e-6, newest - oldest)

    # 発掘ボーナス用: ジャンル/ムードの占有率 (均質なコレクションでは
    # 好み一致だけでは全曲が同点になり新着順と区別が付かないため、
    # 少数派のジャンル/ムードの曲を「忘れずに聴ける」よう加点する)
    total = max(1, len(items))
    genre_share = {g: c / total for g, c in genres.items()}
    mood_share = {m: c / total for m, c in moods.items()}

    scored = []
    for it in items:
        vid = it['youtube_id']
        cat = it.get('category') or 'Other'
        mood = it.get('mood')
        tempo = it.get('tempo') or 0
        energy = it.get('energy')
        valence = it.get('valence')
        recency = 0.0
        for v, t in added_times:
            if v == vid:
                recency = (t - oldest) / span
                break
        fav = 1.0 if vid in fav_ids else 0.0
        # 少数派ほど高い発掘点 (0..2)
        variety = ((1.0 - genre_share.get(cat, 0.0))
                   + (1.0 - mood_share.get(mood, 0.0) if mood else 1.0))
        score = (fav * 10.0
                 + _rank_weight(cat, prefer_genres) * 3.0
                 + _rank_weight(mood, prefer_moods) * 2.0
                 + variety * 3.0
                 + _band_match('tempo', tempo, tempo_pref) * 1.0
                 + _band_match('energy', energy, energy_pref) * 1.0
                 + _band_match('valence', valence, valence_pref) * 1.0
                 + recency * 0.15)
        scored.append((vid, score))
    scored.sort(key=lambda x: (-x[1], x[0]))

    payload = {
        'success': True,
        'taste': recipe.get('taste') or '',
        'order': [vid for vid, _s in scored],
        'prefer_genres': prefer_genres,
        'prefer_moods': prefer_moods,
        'tempo': tempo_pref,
        'energy': energy_pref,
        'valence': valence_pref,
        'fallback': fallback,
    }
    _RECOMMEND_CACHE.update({'key': cache_key, 'payload': payload, 'at': time.time(),
                             'order': payload['order'], 'recipe': recipe, 'fallback': fallback})
    _persist_recommend_cache()
    return jsonify(payload), 200


def _favorite_video_ids():
    """お気に入り (is_favorite=1) のプレイリストに属する曲の youtube_id 集合を返す。"""
    out = set()
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT DISTINCT b.youtube_id FROM bookmarks b "
            "JOIN playlists p ON p.id = b.playlist_id WHERE p.is_favorite = 1").fetchall()
        for r in rows:
            out.add(r["youtube_id"])
    except Exception:
        pass
    finally:
        conn.close()
    return out


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
    'interrupted': False,
}

# _ANALYZE_STATE はワーカースレッドとリクエストスレッドの両方から触るためロックで保護する。
_ANALYZE_LOCK = threading.Lock()


def _batch_state_file():
    """再解析バッチの進捗を保存する JSON ファイル (DB と別ファイルにして書込競合を避ける)。"""
    return os.environ.get(
        'TUNEDROP_BATCH_STATE',
        os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), 'analysis_batch_state.json'))


def _persist_batch_state():
    """現在のバッチ状態をディスクへ保存する (途中保存・再開用)。原子置換で壊れにくくする。"""
    try:
        with _ANALYZE_LOCK:
            snapshot = json.dumps(_ANALYZE_STATE, ensure_ascii=False)
        tmp = _batch_state_file() + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(snapshot)
        os.replace(tmp, _batch_state_file())
    except Exception:
        pass


def _load_batch_state():
    """保存済みのバッチ状態を読む (無ければ None)。"""
    try:
        with open(_batch_state_file(), 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _restore_batch_state():
    """起動時に中断したバッチ状態を復元する (running=True のまま落ちた分は中断扱い)。

    各曲の解析結果自体は analysis_cache に逐次保存されているため、ここで復元するのは
    進捗・結果・エラーの表示用の状態。running は必ず False に戻す (スレッドは死んでいる)。
    """
    saved = _load_batch_state()
    if not saved:
        return
    with _ANALYZE_LOCK:
        for key in ('total', 'done', 'queued', 'results', 'errors',
                    'force', 'audio', 'engine', 'started_at', 'finished_at'):
            if key in saved:
                _ANALYZE_STATE[key] = saved[key]
        _ANALYZE_STATE['interrupted'] = bool(saved.get('running'))
        _ANALYZE_STATE['running'] = False
        _ANALYZE_STATE['current'] = None


# 起動時に中断したバッチ状態を復元する (再起動後も進捗表示・再開ができる)。
_restore_batch_state()


def _run_reanalyze_batch(targets, use_audio, force):
    """再解析バッチを実行する (バックグラウンドスレッド用)。

    - 1曲ごとに進捗を _ANALYZE_STATE へ反映し、_persist_batch_state() で途中保存する。
    - 各曲の解析結果は reanalyze_bookmark / reanalyze_audio_only が analysis_cache に逐次保存する。
    - 中断しても analysis_cache と state ファイルの両方から再開できる。
    """
    import analysis_cache
    st = _ANALYZE_STATE
    with _ANALYZE_LOCK:
        st.update({'running': True, 'total': len(targets), 'done': 0, 'results': [],
                   'errors': [], 'audio': use_audio, 'force': force,
                   'engine': audio_engine_name(), 'interrupted': False,
                   'queued': [t['youtube_id'] for t in targets],
                   'started_at': time.time(), 'finished_at': None})
    _persist_batch_state()
    for it in targets:
        vid = it['youtube_id']
        with _ANALYZE_LOCK:
            st['current'] = vid
        _persist_batch_state()
        # 最適化: 全曲再解析 (force=1) でも、実測BPMが既にある曲は音源DLを省略し、
        # AI推定のみを再実行する (曲数が多い場合の処理時間を大幅に短縮)。
        # ただしテンポ推定アルゴリズムが更新された行 (bpm_algo が古い) は、
        # 精度向上を反映させるため音源を取得し直して測り直す。
        already_measured = (
            it.get('bpm_source') in analysis_cache.MEASURED_SOURCES
            and it.get('bpm_algo') == analysis_cache.TEMPO_ALGO_VERSION)
        audio_for_song = use_audio and not (force and already_measured)
        try:
            if it.get('_audio_only'):
                res = reanalyze_audio_only(vid, it['title'], it['channel'])
            else:
                res = reanalyze_bookmark(vid, it['title'], it['channel'],
                                         it['category'], use_audio=audio_for_song)
            with _ANALYZE_LOCK:
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
            with _ANALYZE_LOCK:
                st['errors'].append({'youtube_id': vid, 'error': str(exc)[:200]})
        finally:
            with _ANALYZE_LOCK:
                st['done'] += 1
                if vid in st['queued']:
                    st['queued'].remove(vid)
            _persist_batch_state()
            # 負荷対策: 連続実行でマシンを占有し続けないよう、曲間に少し待ちを入れる
            if ANALYZE_THROTTLE_SECONDS > 0:
                time.sleep(ANALYZE_THROTTLE_SECONDS)
    with _ANALYZE_LOCK:
        st['current'] = None
        st['running'] = False
        st['finished_at'] = time.time()
    _persist_batch_state()


@app.route('/radar/analyze_all', methods=['GET'])
def radar_analyze_all():
    """全ブックマークを再解析する (Gemini AI + 音源解析 librosa/CLAP)。

    query params:
      user_id=N  → 対象ユーザーを絞る (未指定は全ユーザー)
      force=1    → 既存キャッシュを無視して全曲再解析 (既定 0 = 未解析のみ)
      audio=0    → 音源解析をスキップしてAIのみ (既定 1 = 両方。旧名 essentia も受付)
      limit=N    → 先頭 N 曲だけを処理
      wait=1     → バックグラウンドではなく同期実行し、結果を返す
      reset=1    → 中断状態 (途中保存) を破棄して最初からやり直す
      resume=1   → 前回中断した残りの曲を優先して再開する (未指定でも未解析曲は自動で対象)
      include_gemini=1 → Gemini解析済みの曲も対象に含める (管理者用。既定は保護)
    既定は確認のため非同期で開始し、進捗は /radar/analyze_status で取得する。

    Gemini (engine=gemini) のAI推定値は既定で保護する。音源が未解析または旧版なら
    AI推定を保持したまま音源特徴のみ再測定し、AI自体をやり直す場合は
    include_gemini=1 または管理者ページ (解析キャッシュ → 該当曲を削除) を使う。
    """
    from audio_download import VIDEO_ID_RE

    force = request.args.get('force') == '1'
    use_audio = (request.args.get('audio', '1') != '0'
                 and request.args.get('essentia', '1') != '0')
    wait = request.args.get('wait') == '1'
    reset = request.args.get('reset') == '1'
    resume = request.args.get('resume') == '1'
    limit = _num(request.args.get('limit'), 0)
    # Gemini解析済みの曲を対象に含めるか (既定 0 = 保護)。UI は常に 0 を送る。
    include_gemini = request.args.get('include_gemini') == '1'

    # 中断状態の破棄 (最初からやり直す)
    if reset:
        with _ANALYZE_LOCK:
            _ANALYZE_STATE.update({'running': False, 'total': 0, 'done': 0,
                                   'current': None, 'queued': [], 'results': [],
                                   'errors': [], 'interrupted': False,
                                   'started_at': None, 'finished_at': None})
        try:
            os.remove(_batch_state_file())
        except OSError:
            pass

    # 前回の中断から再開: 保存済みの残キューを先頭に寄せる
    resume_ids = []
    if resume:
        with _ANALYZE_LOCK:
            resume_ids = list(_ANALYZE_STATE.get('queued') or [])

    user_id = _num(request.args.get('user_id'), 0)
    items = _db_bookmarks()
    if user_id:
        items = [i for i in items if i.get("user_id") == int(user_id)]
    import analysis_cache
    targets = []
    skipped_gemini = []
    audio_refresh_enabled = (use_audio and audio_engine_name() not in ("none", "off", "0"))
    for it in items:
        vid = it["youtube_id"]
        if not (vid and VIDEO_ID_RE.match(vid)):
            continue
        # Gemini のAI推定値は保護するが、未測定/旧版の音源特徴は音源だけ再解析する。
        # AI出力まで再実行してGemini結果をローカル推定で上書きしない。
        is_gemini = (it.get("engine") == "gemini" or it.get("bpm_source") == "gemini")
        if not include_gemini and is_gemini:
            measured_current = (
                it.get("bpm_source") in analysis_cache.MEASURED_SOURCES
                and it.get("bpm_algo") == analysis_cache.TEMPO_ALGO_VERSION)
            if audio_refresh_enabled and not measured_current:
                it = dict(it)
                it["_audio_only"] = True
            else:
                skipped_gemini.append(vid)
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

    # 再開指定時は、前回中断した残キューを先頭に並べ替える (未解析曲は後ろに続く)
    if resume_ids:
        resume_set = set(resume_ids)
        targets.sort(key=lambda t: 0 if t["youtube_id"] in resume_set else 1)

    if wait:
        _run_reanalyze_batch(targets, use_audio, force)
        return jsonify({'success': True, 'state': _ANALYZE_STATE}), 200

    if targets and not _ANALYZE_STATE['running']:
        threading.Thread(target=_run_reanalyze_batch,
                         args=(targets, use_audio, force), daemon=True).start()

    return jsonify({
        'success': True,
        'queued': [t["youtube_id"] for t in targets],
        # Gemini解析済みで対象外にした曲 (UIのメッセージ用)
        'skipped_gemini': skipped_gemini,
        'force': force,
        'audio': use_audio,
        'engine': audio_engine_name(),
        'running': _ANALYZE_STATE['running'],
    }), 200


@app.route('/radar/analyze_status', methods=['GET'])
def radar_analyze_status():
    """再解析バッチの進捗を返す (フロントのポーリング用)。

    - running=True なら解析中、False で interrupted=True なら前回中断した状態 (再開可能)。
    - resumable は「残りの曲が途中保存されている」ことを示す。
    """
    with _ANALYZE_LOCK:
        st = dict(_ANALYZE_STATE)
    started = st.get('started_at')
    st['elapsed'] = round(time.time() - started, 1) if started else 0
    st['resumable'] = bool(st.get('interrupted') and st.get('queued'))
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
