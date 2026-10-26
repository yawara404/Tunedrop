-- Run against an empty MySQL 8.0 database using utf8mb4.
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  password_hash VARCHAR(512) NOT NULL,
  google_sub VARCHAR(255) NULL,
  display_name VARCHAR(255) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY users_username_unique (username),
  UNIQUE KEY users_display_name_unique (display_name),
  UNIQUE KEY users_google_sub_unique (google_sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS playlists (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(255) DEFAULT 'Other',
  is_public TINYINT(1) DEFAULT 0,
  cover_id VARCHAR(255) NULL,
  is_favorite TINYINT(1) DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  system_key VARCHAR(64) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY playlists_system_key_unique (user_id, system_key),
  KEY playlists_user_id_idx (user_id),
  CONSTRAINT playlists_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bookmarks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  playlist_id BIGINT UNSIGNED NOT NULL,
  youtube_id VARCHAR(255) NOT NULL,
  title VARCHAR(2048) DEFAULT 'Unknown Title',
  channel VARCHAR(2048) DEFAULT 'Unknown Artist',
  is_favorite TINYINT(1) DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  added_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY bookmarks_playlist_video_unique (playlist_id, youtube_id),
  KEY bookmarks_video_idx (youtube_id),
  CONSTRAINT bookmarks_playlist_fk FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS public_favorites (
  user_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('playlist','track') NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, kind, target_id),
  CONSTRAINT favorites_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS analysis_cache (
  youtube_id VARCHAR(255) NOT NULL PRIMARY KEY,
  data LONGTEXT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS site_settings (
  `key` VARCHAR(255) NOT NULL PRIMARY KEY,
  value LONGTEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
