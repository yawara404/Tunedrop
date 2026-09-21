CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    google_sub TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'Other', -- カテゴリ用のカラム
    is_public BOOLEAN DEFAULT 0,
    cover_id TEXT,                 -- サムネイル画像用のYouTube IDカラム
    is_favorite INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    system_key TEXT,               -- 固定タブ識別用 ('inbox'=未整理 / 'public_favorites'=公開用お気に入り)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    youtube_id TEXT NOT NULL,
    title TEXT DEFAULT 'Unknown Title',
    channel TEXT DEFAULT 'Unknown Artist',
    is_favorite INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

-- 同じリスト内に同じ曲を二重登録できないようにする (別リストへの登録は許可)
CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_playlist_video_unique
    ON bookmarks(playlist_id, youtube_id);

-- 解析結果のキャッシュ (AI推定 Gemini + 音源実測 librosa/CLAP)
CREATE TABLE IF NOT EXISTS analysis_cache (
    youtube_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- ==========================================
-- 初期データの挿入
-- ==========================================

INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (1, 'test_user', 'dummy_hash_string');

-- プレイリストデータの挿入
-- ※「未整理」リストは曲が空になるため、cover_idをNULLに設定
INSERT OR IGNORE INTO playlists (id, user_id, name, category, is_public, cover_id, system_key)
VALUES (1, 1, '未整理', 'Other', 0, NULL, 'inbox');

INSERT OR IGNORE INTO playlists (id, user_id, name, category, is_public, cover_id, system_key)
VALUES (2, 1, '公開用お気に入り', 'Vocaloid', 1, 'uSijY6BEMRE', 'public_favorites');

-- ブックマークデータの挿入（kz (livetune) の2曲のみ残しています）
INSERT OR IGNORE INTO bookmarks (id, playlist_id, youtube_id, title, channel)
VALUES (1, 2, 'uSijY6BEMRE', 'Yellow', 'kz (livetune)');

INSERT OR IGNORE INTO bookmarks (id, playlist_id, youtube_id, title, channel)
VALUES (2, 2, 'bPI0_YzOiEw', 'i wanna be your world', 'kz (livetune)');
