<?php
ini_set('display_errors', 0);
error_reporting(E_ALL);
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if (($_GET['action'] ?? '') === 'health') {
    echo json_encode(['status' => 'ok', 'service' => 'TuneDrop PHP API']);
    exit;
}

$db_path = getenv('TUNEDROP_DB') ?: __DIR__ . '/database.sqlite';

/**
 * Flask 認証/解析サーバー (app.py) の稼働ポートを動的検出する。
 * .auth_port ファイル → 既知ポート走査の順で探索する。
 */
function get_active_auth_port(): int {
    $port_file = __DIR__ . '/.auth_port';
    $saved = 0;
    if (is_file($port_file)) {
        $saved = (int)trim((string)@file_get_contents($port_file));
    }
    $candidates = array_values(array_unique(array_filter([
        $saved, 5000, 5050, 5001, 5555, 8081, 8085
    ])));
    foreach ($candidates as $p) {
        $context = stream_context_create(['http' => ['timeout' => 0.4]]);
        $raw = @file_get_contents("http://127.0.0.1:{$p}/health", false, $context);
        $health = is_string($raw) ? json_decode($raw, true) : null;
        if (is_array($health) && ($health['service'] ?? '') === 'Tune drop Auth Server') {
            return $p;
        }
    }
    return $saved ?: 5000;
}

/**
 * JWT (app.py が発行する HS256 トークン) を検証して user_id を取り出す。
 * app.py と同じ SECRET_KEY (環境変数または共有 .jwt_secret ファイル) を使用する。
 */
function jwt_b64url_decode(string $s): string {
    $r = str_replace(['-', '_'], ['+', '/'], $s);
    $pad = strlen($r) % 4;
    if ($pad) $r .= str_repeat('=', 4 - $pad);
    return (string)base64_decode($r);
}

function jwt_user_id_from_token(string $token): ?int {
    $secret = trim((string)getenv('SECRET_KEY'));
    if ($secret === '') {
        $file = getenv('TUNEDROP_SECRET_FILE') ?: __DIR__ . '/.jwt_secret';
        $secret = trim((string)@file_get_contents($file));
    }
    if (strlen($secret) < 32 || $secret === 'tunedrop-secret-jwt-key-2026-secure') return null;
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;
    [$h, $p, $s] = $parts;
    $expected = rtrim(strtr(base64_encode(hash_hmac('sha256', $h . '.' . $p, $secret, true)), '+/', '-_'), '=');
    if (!hash_equals($expected, $s)) return null;
    $header = json_decode(jwt_b64url_decode($h), true);
    if (!is_array($header) || ($header['alg'] ?? '') !== 'HS256') return null;
    $payload = json_decode(jwt_b64url_decode($p), true);
    if (!is_array($payload)) return null;
    if (!isset($payload['exp']) || !is_numeric($payload['exp']) || (int)$payload['exp'] <= time()) return null;
    if (isset($payload['nbf']) && (int)$payload['nbf'] > time()) return null;
    return isset($payload['user_id']) ? (int)$payload['user_id'] : null;
}

/**
 * Authorization ヘッダの生値を取得する。
 * MAMP (Apache + FastCGI PHP) では .htaccess の SetEnvIf により
 * REDIRECT_HTTP_AUTHORIZATION 側に入るため、両方を確認する。
 * Webサーバーがどちらも渡さない場合は apache_request_headers() を試す。
 */
function auth_header_value(): string {
    foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
        if (!empty($_SERVER[$key])) {
            return trim((string)$_SERVER[$key]);
        }
    }
    if (function_exists('apache_request_headers')) {
        foreach ((array)apache_request_headers() as $name => $value) {
            if (strcasecmp((string)$name, 'Authorization') === 0) {
                return trim((string)$value);
            }
        }
    }
    return '';
}

/** Authorization: Bearer ヘッダからログイン中ユーザーの user_id を取得する (未ログインは null)。 */
function current_user_id(): ?int {
    $auth = auth_header_value();
    if (preg_match('/Bearer\s+(\S+)/i', $auth, $m)) {
        return jwt_user_id_from_token($m[1]);
    }
    return null;
}

/** ユーザーごとのデータを返すアクション用。未ログインは 401 で応答して終了する。 */
function require_user_id(): int {
    $uid = current_user_id();
    if (!$uid) {
        http_response_code(401);
        echo json_encode(['error' => 'ログインが必要です。', 'auth_required' => true], JSON_UNESCAPED_UNICODE);
        exit;
    }
    return $uid;
}

/** 全ゲスト共通で使うユーザー名。 */
const TUNEDROP_GUEST_USERNAME = 'guest';

/**
 * 全ユーザー共通の固定タブ定義。配列の順序がサイドバーでの並び順になる。
 * inbox           … 「未整理」  (非公開・曲追加の既定の追加先)
 * public_favorites… 「公開用お気に入り」 (公開・お気に入り扱い)
 */
const TUNEDROP_SYSTEM_PLAYLISTS = [
    'inbox' => ['name' => '未整理', 'category' => 'Other', 'is_public' => 0, 'is_favorite' => 0],
    'public_favorites' => ['name' => '公開用お気に入り', 'category' => 'J-POP', 'is_public' => 1, 'is_favorite' => 1],
];

/** 固定タブ (未整理 / 公開用お気に入り) かどうか。全ユーザー共通で名称・削除・並び替えを固定する。 */
function is_system_playlist(array $playlist): bool {
    return !empty($playlist['system_key']);
}

/** 指定ユーザーに固定タブが無ければ作成する (どのユーザー・ゲストでも必ず2つのタブを表示するため)。 */
function ensure_system_playlists(PDO $db, int $user_id): void {
    if ($user_id <= 0) return;
    $select = $db->prepare("SELECT 1 FROM playlists WHERE user_id = ? AND system_key = ?");
    $insert = $db->prepare(
        "INSERT INTO playlists (user_id, name, category, is_public, cover_id, is_favorite, system_key, sort_order)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)"
    );
    $position = 0;
    foreach (TUNEDROP_SYSTEM_PLAYLISTS as $system_key => $definition) {
        $select->execute([$user_id, $system_key]);
        if (!$select->fetchColumn()) {
            try {
                $insert->execute([
                    $user_id, $definition['name'], $definition['category'],
                    $definition['is_public'], $definition['is_favorite'], $system_key, $position,
                ]);
            } catch (PDOException $error) {
                // 同時リクエストで既に作成されていた場合は何もしない
            }
        }
        $position++;
    }
}

/** 指定プレイリストが固定タブなら system_key を返す (それ以外は null)。 */
function system_key_of_playlist(PDO $db, int $user_id, int $playlist_id): ?string {
    $stmt = $db->prepare("SELECT system_key FROM playlists WHERE id = ? AND user_id = ?");
    $stmt->execute([$playlist_id, $user_id]);
    $key = $stmt->fetchColumn();
    return ($key === false || $key === null || $key === '') ? null : (string)$key;
}

/** 既存DBへ system_key 列を追加し、名前から未整理/公開用お気に入りを自動で印付ける。 */
function migrate_system_playlists(PDO $db): void {
    $columns = $db->query("PRAGMA table_info(playlists)")->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('system_key', $columns, true)) {
        $db->exec("ALTER TABLE playlists ADD COLUMN system_key TEXT");
    }
    try {
        $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS playlists_system_key_unique ON playlists(user_id, system_key)");
    } catch (PDOException $error) {
        // 既に重複した system_key がある場合は索引作成をあきらめる (動作には影響しない)
    }
    foreach (['inbox' => '未整理', 'public_favorites' => '公開用お気に入り'] as $system_key => $name) {
        $stmt = $db->prepare(
            "UPDATE playlists SET system_key = :key
             WHERE system_key IS NULL AND name = :name
               AND id IN (SELECT MIN(id) FROM playlists WHERE system_key IS NULL AND name = :name GROUP BY user_id)"
        );
        $stmt->execute([':key' => $system_key, ':name' => $name]);
    }
    // 固定タブは各ユーザー専用 (自分のものを1つだけ持つ) ため、過去に他ユーザーの固定タブへ
    // 登録したお気に入りは同名タブが二重に並ぶ原因になる。重複表示を避けるため取り除く。
    // (自分の固定タブは public_favorites ではなく playlists.is_favorite で管理する)
    $db->exec(
        "DELETE FROM public_favorites
          WHERE kind = 'playlist'
            AND target_id IN (SELECT id FROM playlists WHERE system_key IS NOT NULL)"
    );
}

/** 同じリスト内で同じ曲 (youtube_id) が二重登録されないようにする。
 *  過去に作られた同一リスト内の重複行を掃除した上で、DBレベルで保証するユニーク索引を張る。
 *  違うリストへの同じ曲の登録は許可する (ゲストも含む)。
 *  「すべてのブックマーク」「お気に入り曲」など複数リストをまとめて表示する画面では、
 *  表示側で youtube_id ごとに1件にまとめる (下の get_my_bookmarks を参照)。 */
function migrate_unique_bookmarks(PDO $db): void {
    // 各 (playlist_id, youtube_id) の組で最も古い行だけを残して重複を取り除く
    $db->exec(
        "DELETE FROM bookmarks
          WHERE id NOT IN (SELECT MIN(id) FROM bookmarks GROUP BY playlist_id, youtube_id)"
    );
    try {
        $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_playlist_video_unique ON bookmarks(playlist_id, youtube_id)");
    } catch (PDOException $error) {
        // 同時リクエストで掃除しきれない重複が残っていた場合は索引作成をあきらめる (動作には影響しない)
    }
    // 旧仕様 (ゲスト全リストで1曲1件) のトリガーが残っていたら撤去する。
    // 現仕様は「違うリストなら同じ曲OK」のため、ゲスト用トリガーは使わない。
    $db->exec("DROP TRIGGER IF EXISTS bookmarks_guest_video_unique_insert");
    $db->exec("DROP TRIGGER IF EXISTS bookmarks_guest_video_unique_update");
}

/** サイト初期データのサンプル楽曲入りデフォルトライブラリを作成する (app.py の insert_default_library と同一内容)。
    「未整理」「公開用お気に入り」のどちらを開いてもサンプル2曲が見えるように、両方に配置する。
    違うリストへの同じ曲の登録は許可するため、初期サンプルも両方に入れてよい。
    「すべてのブックマーク」「お気に入り曲」などのまとめ表示では youtube_id ごとに1件にまとめる。 */
function insert_default_library_php(PDO $db, int $user_id): int {
    $samples = [
        ['uSijY6BEMRE', 'Yellow', 'kz (livetune)'],
        ['bPI0_YzOiEw', 'i wanna be your world', 'kz (livetune)'],
    ];
    $ins = $db->prepare("INSERT INTO playlists (user_id, name, category, is_public, cover_id, is_favorite, system_key, sort_order) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)");
    $unorganized = TUNEDROP_SYSTEM_PLAYLISTS['inbox'];
    $ins->execute([$user_id, $unorganized['name'], $unorganized['category'], $unorganized['is_public'], $unorganized['is_favorite'], 'inbox', 0]);
    $unorganized_id = (int)$db->lastInsertId();
    $public_favorites = TUNEDROP_SYSTEM_PLAYLISTS['public_favorites'];
    $ins->execute([$user_id, $public_favorites['name'], $public_favorites['category'], $public_favorites['is_public'], $public_favorites['is_favorite'], 'public_favorites', 1]);
    $fav_playlist_id = (int)$db->lastInsertId();
    $bm = $db->prepare("INSERT INTO bookmarks (playlist_id, youtube_id, title, channel, sort_order) VALUES (?, ?, ?, ?, ?)");
    foreach ($samples as $sort_order => $s) {
        $bm->execute([$unorganized_id, $s[0], $s[1], $s[2], $sort_order]);
        $bm->execute([$fav_playlist_id, $s[0], $s[1], $s[2], $sort_order]);
    }
    return $fav_playlist_id;
}

/** 全ゲスト共通の 'guest' ユーザーを確保し、デフォルトライブラリがなければ作成して user_id を返す。 */
function ensure_guest_user(PDO $db): int {
    $select = $db->prepare("SELECT id FROM users WHERE username = ?");
    $select->execute([TUNEDROP_GUEST_USERNAME]);
    $id = (int)($select->fetchColumn() ?: 0);
    if (!$id) {
        try {
            // ゲストにはログインできないランダムなパスワードハッシュを入れておく
            $ins = $db->prepare("INSERT INTO users (username, password_hash, google_sub) VALUES (?, ?, NULL)");
            $ins->execute([TUNEDROP_GUEST_USERNAME, '!guest-' . bin2hex(random_bytes(16))]);
            $id = (int)$db->lastInsertId();
        } catch (PDOException $e) {
            // 同時起動で競合した場合は既存の guest を拾い直す
            $select->execute([TUNEDROP_GUEST_USERNAME]);
            $id = (int)($select->fetchColumn() ?: 0);
        }
    }
    if (!$id) return 0;
    // ゲストのデフォルトライブラリがまだ無い場合のみ作成する
    $check = $db->prepare("SELECT COUNT(*) FROM playlists WHERE user_id = ?");
    $check->execute([$id]);
    if ((int)$check->fetchColumn() === 0) {
        insert_default_library_php($db, $id);
    }
    return $id;
}

/** 認証済みユーザーがいればその user_id、未ログインなら全ゲスト共通の guest ユーザーの user_id を返す。 */
function require_user_or_guest(PDO $db): int {
    $uid = current_user_id();
    if ($uid) return $uid;
    $guest_id = ensure_guest_user($db);
    if (!$guest_id) {
        http_response_code(500);
        echo json_encode(['error' => 'ゲストユーザーの初期化に失敗しました。'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    return $guest_id;
}

/** プレイリストのサムネイル (cover_id) を決める。
 *  - 固定タブ (未整理 / 公開用お気に入り) … 常に「最後に保存した曲」を使う
 *  - それ以外 … 手動設定が無い場合のみ「最後に保存した曲」を使う
 */
function with_default_playlist_covers(PDO $db, array $playlists): array {
    $latest = $db->prepare(
        "SELECT youtube_id FROM bookmarks WHERE playlist_id = ?
         ORDER BY added_at DESC, id DESC LIMIT 1"
    );
    $viewer = require_user_or_guest($db);
    foreach ($playlists as &$playlist) {
        if ((int)$playlist['user_id'] !== $viewer) {
            $playlist['is_favorite'] = public_favorite_state($db, $viewer, 'playlist', (int)$playlist['id']);
        }
        if (empty($playlist['cover_id']) || is_system_playlist($playlist)) {
            $latest->execute([$playlist['id']]);
            $cover = $latest->fetchColumn();
            $playlist['cover_id'] = $cover === false ? null : $cover;
        }
    }
    unset($playlist);
    return $playlists;
}

/** Favorites on another user's public content belong to the viewer. */
/** 同じ動画の複数登録をまとめた、ユーザーごとのお気に入り状態。 */
function track_favorite_state(PDO $db, int $user_id, string $youtube_id): int {
    $stmt = $db->prepare("SELECT EXISTS(
        SELECT 1 FROM bookmarks b JOIN playlists p ON p.id=b.playlist_id
        WHERE b.youtube_id=? AND (
            (p.user_id=? AND b.is_favorite=1) OR
            (p.is_public=1 AND EXISTS(SELECT 1 FROM public_favorites f
                WHERE f.user_id=? AND f.kind='track' AND f.target_id=b.id))
        ))");
    $stmt->execute([$youtube_id, $user_id, $user_id]);
    return (int)$stmt->fetchColumn();
}

function public_favorite_state(PDO $db, int $user_id, string $kind, int $id): int {
    $stmt = $db->prepare("SELECT 1 FROM public_favorites WHERE user_id=? AND kind=? AND target_id=?");
    $stmt->execute([$user_id, $kind, $id]);
    return $stmt->fetchColumn() ? 1 : 0;
}

function toggle_public_favorite(PDO $db, int $user_id, string $kind, int $id): int {
    $db->beginTransaction();
    try {
        $state = 1 - public_favorite_state($db, $user_id, $kind, $id);
        if ($state) {
            $stmt = $db->prepare("INSERT INTO public_favorites (user_id,kind,target_id) VALUES (?,?,?)");
        } else {
            $stmt = $db->prepare("DELETE FROM public_favorites WHERE user_id=? AND kind=? AND target_id=?");
        }
        $stmt->execute([$user_id, $kind, $id]);
        $db->commit();
        return $state;
    } catch (Throwable $error) {
        $db->rollBack();
        throw $error;
    }
}

try {
    $db = new PDO("sqlite:" . $db_path);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec("PRAGMA foreign_keys = ON;");
    $user_columns = $db->query("PRAGMA table_info(users)")->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('display_name', $user_columns, true)) {
        $db->exec("ALTER TABLE users ADD COLUMN display_name TEXT");
    }
    $db->exec("CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_unique ON users(display_name)");
    $db->exec("CREATE TABLE IF NOT EXISTS public_favorites (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('playlist','track')),
        target_id INTEGER NOT NULL,
        PRIMARY KEY(user_id,kind,target_id)
    )");

    // 解析結果キャッシュ用テーブル（AI推定 + 音源実測。存在しなければ作成）
    $db->exec("CREATE TABLE IF NOT EXISTS analysis_cache (
        youtube_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )");

    $columns_pl = $db->query("PRAGMA table_info(playlists)")->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('is_favorite', $columns_pl)) {
        $db->exec("ALTER TABLE playlists ADD COLUMN is_favorite INTEGER DEFAULT 0");
    }
    if (!in_array('sort_order', $columns_pl)) {
        $db->exec("ALTER TABLE playlists ADD COLUMN sort_order INTEGER DEFAULT 0");
    }
    
    $columns_bm = $db->query("PRAGMA table_info(bookmarks)")->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('is_favorite', $columns_bm)) {
        $db->exec("ALTER TABLE bookmarks ADD COLUMN is_favorite INTEGER DEFAULT 0");
    }
    if (!in_array('sort_order', $columns_bm)) {
        $db->exec("ALTER TABLE bookmarks ADD COLUMN sort_order INTEGER DEFAULT 0");
    }

    // 全ユーザー共通の固定タブ (未整理 / 公開用お気に入り) の識別列を用意する
    migrate_system_playlists($db);
    // 同じリスト内で同じ曲が二重登録されないようにする (掃除 + ユニーク索引)
    migrate_unique_bookmarks($db);

    $action = $_GET['action'] ?? '';
    $method = $_SERVER['REQUEST_METHOD'];
    $input = json_decode(file_get_contents('php://input'), true);

    switch ($action) {
        case 'get_playlists':
            // Own playlists plus public playlists explicitly saved by this viewer.
            // 他ユーザーの固定タブ (未整理 / 公開用お気に入り) は自分のタブと名前が重複するため含めない。
            $user_id = require_user_or_guest($db);
            // 全ユーザー共通の固定タブ (未整理 / 公開用お気に入り) を必ず用意する
            ensure_system_playlists($db, $user_id);
            $stmt = $db->prepare("SELECT p.* FROM playlists p WHERE p.user_id = ? OR (p.system_key IS NULL AND p.is_public=1 AND EXISTS(SELECT 1 FROM public_favorites f WHERE f.user_id=? AND f.kind='playlist' AND f.target_id=p.id)) ORDER BY p.sort_order ASC, p.id ASC");
            $stmt->execute([$user_id, $user_id]);
            $playlists = with_default_playlist_covers($db, $stmt->fetchAll(PDO::FETCH_ASSOC));
            // 固定タブ (未整理 / 公開用お気に入り) にはフロント制御用のフラグを付ける
            foreach ($playlists as &$playlist) {
                $playlist['is_default'] = is_system_playlist($playlist) ? 1 : 0;
            }
            unset($playlist);
            echo json_encode($playlists, JSON_UNESCAPED_UNICODE);
            break;

        case 'create_playlist':
            if ($method === 'POST' && !empty($input['name'])) {
                $user_id = require_user_or_guest($db);
                $name = $input['name'];
                $category = !empty($input['category']) ? $input['category'] : 'Other';
                $is_public = isset($input['is_public']) ? (int)$input['is_public'] : 0;
                $stmt = $db->prepare("INSERT INTO playlists (user_id, name, category, is_public) VALUES (?, ?, ?, ?)");
                $stmt->execute([$user_id, $name, $category, $is_public]);
                echo json_encode(['success' => true, 'id' => (int)$db->lastInsertId()]);
            } else {
                echo json_encode(['success' => false, 'error' => 'プレイリスト名を入力してください']);
            }
            break;

        case 'edit_playlist':
            if ($method === 'POST' && !empty($input['id']) && !empty($input['name'])) {
                $user_id = require_user_or_guest($db);
                $id = $input['id'];
                if (system_key_of_playlist($db, $user_id, (int)$id)) {
                    echo json_encode(['success' => false, 'error' => '固定タブ（未整理 / 公開用お気に入り）は変更できません'], JSON_UNESCAPED_UNICODE);
                    break;
                }
                $name = $input['name'];
                $category = $input['category'] ?? 'Other';
                $is_public = isset($input['is_public']) ? (int)$input['is_public'] : 0;
                
                if (isset($input['cover_id']) && $input['cover_id'] !== '') {
                    $stmt = $db->prepare("UPDATE playlists SET name = ?, category = ?, is_public = ?, cover_id = ? WHERE id = ? AND user_id = ?");
                    $stmt->execute([$name, $category, $is_public, $input['cover_id'], $id, $user_id]);
                } else {
                    $stmt = $db->prepare("UPDATE playlists SET name = ?, category = ?, is_public = ? WHERE id = ? AND user_id = ?");
                    $stmt->execute([$name, $category, $is_public, $id, $user_id]);
                }
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['success' => false, 'error' => 'Invalid input']);
            }
            break;

        case 'delete_playlist':
            if ($method === 'POST' && !empty($input['id'])) {
                $user_id = require_user_or_guest($db);
                $id = $input['id'];
                // 全ユーザー共通の固定タブ (未整理 / 公開用お気に入り) は削除できない
                if (system_key_of_playlist($db, $user_id, (int)$id)) {
                    echo json_encode(['success' => false, 'error' => '固定タブ（未整理 / 公開用お気に入り）は削除できません'], JSON_UNESCAPED_UNICODE);
                    break;
                }
                // 各ユーザーの最古のプレイリスト (未整理) は曲追加のフォールバック先のため保護する
                $oldest = $db->prepare("SELECT MIN(id) FROM playlists WHERE user_id = ?");
                $oldest->execute([$user_id]);
                $protected_id = (int)$oldest->fetchColumn();
                if ($protected_id && (int)$id === $protected_id) {
                    echo json_encode(['success' => false, 'error' => '未整理リストは削除できません']);
                    break;
                }
                $stmt = $db->prepare("DELETE FROM playlists WHERE id = ? AND user_id = ?");
                $stmt->execute([$id, $user_id]);
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['success' => false]);
            }
            break;

        case 'toggle_favorite_playlist':
            if ($method === 'POST' && !empty($input['id'])) {
                $user_id = require_user_or_guest($db);
                $stmt = $db->prepare("SELECT * FROM playlists WHERE id=? AND (user_id=? OR is_public=1)");
                $stmt->execute([$input['id'], $user_id]);
                $list = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$list) {
                    echo json_encode(['success'=>false, 'error'=>'Playlist not found']);
                    break;
                }
                if ((int)$list['user_id'] === $user_id) {
                    $state = 1 - (int)$list['is_favorite'];
                    $stmt = $db->prepare("UPDATE playlists SET is_favorite=? WHERE id=? AND user_id=?");
                    $stmt->execute([$state, $list['id'], $user_id]);
                } elseif (is_system_playlist($list)) {
                    // 固定タブは各ユーザーが自分のものを1つだけ持つため、他人の固定タブは
                    // お気に入りに追加できない (同名タブが並ぶ重複の原因になる)
                    echo json_encode(['success'=>false, 'error'=>'固定タブ（未整理 / 公開用お気に入り）はお気に入りに追加できません'], JSON_UNESCAPED_UNICODE);
                    break;
                } else {
                    $state = toggle_public_favorite($db, $user_id, 'playlist', (int)$list['id']);
                }
                echo json_encode(['success'=>true, 'is_favorite'=>$state]);
            } else {
                echo json_encode(['success'=>false]);
            }
            break;

        case 'add_bookmark':
            if ($method === 'POST' && !empty($input['youtube_id'])) {
                $user_id = require_user_or_guest($db);
                $youtube_id = $input['youtube_id'];
                $playlist_id = !empty($input['playlist_id']) ? (int)$input['playlist_id'] : 0;
                $title = isset($input['title']) ? trim((string)$input['title']) : '';
                $channel = isset($input['channel']) ? trim((string)$input['channel']) : '';

                // 追加先プレイリストはログインユーザー自身のもののみ許可。
                // 他人のID / 未指定 (home・お気に入り表示時) は自分の固定タブ「未整理」に追加する。
                ensure_system_playlists($db, $user_id);
                $ownerCheck = $db->prepare("SELECT id FROM playlists WHERE id = ? AND user_id = ?");
                $ownerCheck->execute([$playlist_id, $user_id]);
                if (!$ownerCheck->fetchColumn()) {
                    $fallback = $db->prepare("SELECT id FROM playlists WHERE user_id = ? AND system_key = 'inbox' LIMIT 1");
                    $fallback->execute([$user_id]);
                    $playlist_id = (int)$fallback->fetchColumn();
                    if (!$playlist_id) {
                        // 移行前のDBなどで未整理に印が無い場合の保険
                        $fallback = $db->prepare("SELECT id FROM playlists WHERE user_id = ? ORDER BY id ASC LIMIT 1");
                        $fallback->execute([$user_id]);
                        $playlist_id = (int)$fallback->fetchColumn();
                    }
                    if (!$playlist_id) {
                        echo json_encode(['success' => false, 'error' => 'プレイリストがありません。先に作成してください。'], JSON_UNESCAPED_UNICODE);
                        break;
                    }
                }

                // 同じリスト内に同じ曲が既にある場合は追加しない (曲の二重登録を防ぐ)。
                // 違うリストへの同じ曲の登録は許可する (ゲストも含む)。
                $dupeCheck = $db->prepare("SELECT 1 FROM bookmarks WHERE playlist_id = ? AND youtube_id = ?");
                $dupeCheck->execute([$playlist_id, $youtube_id]);
                if ($dupeCheck->fetchColumn()) {
                    echo json_encode(['success' => false, 'error' => 'この曲は既にこのリストに登録されています。'], JSON_UNESCAPED_UNICODE);
                    break;
                }

                // 同じ動画の保存済み情報を再利用する。仮の値は再取得できるよう除外する。
                $missingTitle = static function ($value) use ($youtube_id): bool {
                    return in_array(trim((string)$value), ['', 'Unknown Title', 'YouTube Track (' . $youtube_id . ')'], true);
                };
                $missingChannel = static function ($value): bool {
                    return in_array(trim((string)$value), ['', 'Unknown Artist'], true);
                };
                $savedMeta = $db->prepare("SELECT title, channel FROM bookmarks WHERE youtube_id = ? ORDER BY id ASC");
                $savedMeta->execute([$youtube_id]);
                $savedTitle = null;
                $savedChannel = null;
                while ($saved = $savedMeta->fetch(PDO::FETCH_ASSOC)) {
                    if ($savedTitle === null && !$missingTitle($saved['title'])) $savedTitle = trim($saved['title']);
                    if ($savedChannel === null && !$missingChannel($saved['channel'])) $savedChannel = trim($saved['channel']);
                    if ($savedTitle !== null && $savedChannel !== null) break;
                }
                $savedMeta->closeCursor();
                $title = $savedTitle ?? $title;
                $channel = $savedChannel ?? $channel;

                // 保存済み情報でも不足する項目だけ oEmbed → noembed の順で自動解決
                if ($missingTitle($title) || $missingChannel($channel)) {
                    $watch = 'https://www.youtube.com/watch?v=' . $youtube_id;
                    foreach ([
                        'https://www.youtube.com/oembed?url=' . urlencode($watch) . '&format=json',
                        'https://noembed.com/embed?url=' . urlencode($watch),
                    ] as $endpoint) {
                        $ctx = stream_context_create(['http' => [
                            'timeout' => 6, 'ignore_errors' => true,
                            'header' => "User-Agent: TuneDrop/1.0\r\n",
                        ]]);
                        $resp = @file_get_contents($endpoint, false, $ctx);
                        $meta = is_string($resp) ? @json_decode($resp, true) : null;
                        if (is_array($meta) && !empty($meta['title'])) {
                            if ($missingTitle($title)) $title = $meta['title'];
                            if ($missingChannel($channel)) $channel = $meta['author_name'] ?? 'Unknown Artist';
                            if (!$missingTitle($title) && !$missingChannel($channel)) break;
                        }
                    }
                }
                if ($missingTitle($title)) $title = 'YouTube Track (' . $youtube_id . ')';
                if ($missingChannel($channel)) $channel = 'Unknown Artist';

                try {
                    $stmt = $db->prepare("INSERT INTO bookmarks (playlist_id, youtube_id, title, channel, added_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))");
                    $stmt->execute([$playlist_id, $youtube_id, $title, $channel]);
                } catch (PDOException $error) {
                    // 同時リクエストで先に同一リストへ追加されていた場合 (ユニーク索引違反) も重複を作らず通知する
                    echo json_encode(['success' => false, 'error' => 'この曲は既にこのリストに登録されています。'], JSON_UNESCAPED_UNICODE);
                    break;
                }
                $updateCoverStmt = $db->prepare("UPDATE playlists SET cover_id = ? WHERE id = ? AND cover_id IS NULL AND user_id = ?");
                $updateCoverStmt->execute([$youtube_id, $playlist_id, $user_id]);

                // 曲ごとの解析結果があれば共有し、解析サーバーへの問い合わせも省く。
                $cacheStmt = $db->prepare("SELECT data FROM analysis_cache WHERE youtube_id = ?");
                $cacheStmt->execute([$youtube_id]);
                $cachedAnalysis = json_decode((string)$cacheStmt->fetchColumn(), true);
                if (!is_array($cachedAnalysis) || empty($cachedAnalysis['feature_vector'])) {
                    @file_get_contents('http://127.0.0.1:' . get_active_auth_port() . '/analysis/async/' . rawurlencode($youtube_id));
                }

                echo json_encode(['success' => true, 'title' => $title]);
            } else {
                echo json_encode(['success' => false]);
            }
            break;

        case 'delete_bookmark':
            if ($method === 'POST' && !empty($input['id'])) {
                $user_id = require_user_or_guest($db);
                $stmt = $db->prepare("DELETE FROM bookmarks WHERE id = ? AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)");
                $stmt->execute([$input['id'], $user_id]);
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['success' => false]);
            }
            break;

        case 'move_bookmark':
            if ($method === 'POST' && !empty($input['id']) && isset($input['target_playlist_id'])) {
                $user_id = require_user_or_guest($db);
                // 移動先プレイリストがログインユーザー自身のものか確認
                $targetCheck = $db->prepare("SELECT 1 FROM playlists WHERE id = ? AND user_id = ?");
                $targetCheck->execute([$input['target_playlist_id'], $user_id]);
                if (!$targetCheck->fetchColumn()) {
                    echo json_encode(['success' => false, 'error' => '移動先プレイリストが見つかりません'], JSON_UNESCAPED_UNICODE);
                    break;
                }
                // 移動先のリストに同じ曲が既にある場合は移動できない (同じリスト内の重複を防ぐ)。
                // 違うリストへの同じ曲の登録は許可するため、移動先以外のリストは対象外。
                // 自分自身が今あるリストへの移動 (実質キャンセル) はこれまでどおり許可する。
                $dupeCheck = $db->prepare(
                    "SELECT 1 FROM bookmarks
                      WHERE playlist_id = ?
                        AND youtube_id = (SELECT youtube_id FROM bookmarks WHERE id = ?)
                        AND playlist_id != (SELECT playlist_id FROM bookmarks WHERE id = ?)"
                );
                $dupeCheck->execute([$input['target_playlist_id'], $input['id'], $input['id']]);
                if ($dupeCheck->fetchColumn()) {
                    echo json_encode(['success' => false, 'error' => '移動先のリストに同じ曲が既にあります'], JSON_UNESCAPED_UNICODE);
                    break;
                }
                try {
                    $stmt = $db->prepare("UPDATE bookmarks SET added_at = CASE WHEN playlist_id != ? THEN strftime('%Y-%m-%d %H:%M:%f', 'now') ELSE added_at END, playlist_id = ? WHERE id = ? AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)");
                    $stmt->execute([$input['target_playlist_id'], $input['target_playlist_id'], $input['id'], $user_id]);
                } catch (PDOException $error) {
                    // 同時リクエストで移動先に同一曲が入った場合も重複を作らない
                    echo json_encode(['success' => false, 'error' => '移動先のリストに同じ曲が既にあります'], JSON_UNESCAPED_UNICODE);
                    break;
                }
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['success' => false, 'error' => 'Invalid input']);
            }
            break;

        case 'get_track_favorite':
        case 'toggle_favorite_bookmark':
            $user_id = require_user_or_guest($db);
            $params = $action === 'get_track_favorite' ? $_GET : ($input ?? []);
            if ($action === 'toggle_favorite_bookmark' && $method !== 'POST') {
                echo json_encode(['success'=>false]);
                break;
            }
            $by_video = !empty($params['youtube_id']);
            $key = $by_video ? 'b.youtube_id' : 'b.id';
            $value = $by_video ? $params['youtube_id'] : ($params['id'] ?? 0);
            $stmt = $db->prepare("SELECT b.*, p.user_id FROM bookmarks b JOIN playlists p ON p.id=b.playlist_id
                WHERE {$key}=? AND (p.user_id=? OR p.is_public=1)
                ORDER BY (p.user_id=?) DESC,
                    EXISTS(SELECT 1 FROM public_favorites f WHERE f.user_id=? AND f.kind='track' AND f.target_id=b.id) DESC,
                    b.id DESC LIMIT 1");
            $stmt->execute([$value, $user_id, $user_id, $user_id]);
            $track = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$track) {
                echo json_encode(['success'=>false, 'error'=>'お気に入りにできる曲が見つかりません。'], JSON_UNESCAPED_UNICODE);
                break;
            }
            if ($action === 'toggle_favorite_bookmark') $db->beginTransaction();
            $state = track_favorite_state($db, $user_id, $track['youtube_id']);
            if ($action === 'toggle_favorite_bookmark') {
                $state = 1 - $state;
                // 自分の各リストにある同じ曲を同期。他ユーザーの登録は変更しない。
                $stmt = $db->prepare("UPDATE bookmarks SET is_favorite=? WHERE youtube_id=?
                    AND playlist_id IN (SELECT id FROM playlists WHERE user_id=?)");
                $stmt->execute([$state, $track['youtube_id'], $user_id]);
                if ($state === 0) {
                    $stmt = $db->prepare("DELETE FROM public_favorites WHERE user_id=? AND kind='track'
                        AND target_id IN (SELECT id FROM bookmarks WHERE youtube_id=?)");
                    $stmt->execute([$user_id, $track['youtube_id']]);
                } elseif ((int)$track['user_id'] !== $user_id) {
                    $stmt = $db->prepare("INSERT OR IGNORE INTO public_favorites (user_id, kind, target_id) VALUES (?, 'track', ?)");
                    $stmt->execute([$user_id, $track['id']]);
                }
                $db->commit();
            }
            echo json_encode(['success'=>true, 'is_favorite'=>$state, 'youtube_id'=>$track['youtube_id']]);
            break;

        case 'get_my_bookmarks':
            $user_id = require_user_or_guest($db);
            $playlist_id = $_GET['playlist_id'] ?? 'null';
            $randomizeOrder = false;   // 「ランダム」リストは抽出順のまま並べる
            
            if ($playlist_id === 'fav_tracks') {
                // お気に入りに登録された行の中から、動画IDごとに代表を1件だけ返す。
                $stmt = $db->prepare("SELECT b.* FROM bookmarks b WHERE b.id IN (
                    SELECT MIN(x.id) FROM bookmarks x JOIN playlists p ON p.id=x.playlist_id
                    WHERE (x.is_favorite=1 AND p.user_id=?) OR
                        (p.is_public=1 AND EXISTS(SELECT 1 FROM public_favorites f
                            WHERE f.user_id=? AND f.kind='track' AND f.target_id=x.id))
                    GROUP BY x.youtube_id
                ) ORDER BY b.sort_order ASC, b.id ASC");
                $stmt->execute([$user_id, $user_id]);
            } elseif ($playlist_id !== 'null' && is_numeric($playlist_id)) {
                // 名前が「ランダム」系のリストは、開くたびにDBから重複なしでランダムに選んだ曲を返す。
                // 例: 「Radar ランダム5曲」→ 5曲ランダム (曲数は名前の「N曲」から読み取る)。
                $metaStmt = $db->prepare("SELECT name, user_id, is_public FROM playlists WHERE id = ?");
                $metaStmt->execute([$playlist_id]);
                $plMeta = $metaStmt->fetch(PDO::FETCH_ASSOC);
                $plName = $plMeta ? (string)$plMeta['name'] : '';
                $canAccess = $plMeta && ((int)$plMeta['user_id'] === $user_id || (int)$plMeta['is_public'] === 1);
                if ($canAccess && $plName !== '' && (strpos($plName, 'ランダム') !== false || stripos($plName, 'random') !== false)) {
                    $limit = 5;
                    if (preg_match('/(\d+)\s*曲/u', $plName, $m)) {
                        $limit = max(1, min(50, (int)$m[1]));
                    }
                    $stmt = $db->prepare("SELECT b.* FROM bookmarks b JOIN playlists p ON p.id = b.playlist_id GROUP BY b.youtube_id ORDER BY RANDOM() LIMIT ?");
                    $stmt->bindValue(1, $limit, PDO::PARAM_INT);
                    $stmt->execute();
                    $randomizeOrder = true;
                } else {
                    $stmt = $db->prepare("SELECT b.* FROM bookmarks b JOIN playlists p ON p.id = b.playlist_id WHERE b.playlist_id = ? AND (p.user_id = ? OR p.is_public = 1) ORDER BY b.sort_order ASC, b.id ASC");
                    $stmt->execute([$playlist_id, $user_id]);
                }
            } else {
                // ユーザーの全ブックマークを、youtube_id ごとに1件だけ返す。
                // 同じ曲が複数のリストにまたがって登録されていても、「すべてのブックマーク」では
                // 重複して見えないようにする（違うリストへの同じ曲の登録自体は引き続き許可される）。
                // 代表行はその曲の最も古い登録（MIN(id)）を使う。
                $stmt = $db->prepare(
                    "SELECT b.* FROM bookmarks b\n"
                    . " WHERE b.id IN (\n"
                    . "   SELECT MIN(x.id) FROM bookmarks x\n"
                    . "   JOIN playlists px ON px.id = x.playlist_id\n"
                    . "   WHERE px.user_id = ?\n"
                    . "   GROUP BY x.youtube_id\n"
                    . " )\n"
                    . " ORDER BY b.sort_order ASC, b.id ASC"
                );
                $stmt->execute([$user_id]);
            }
            $tracks = $stmt->fetchAll(PDO::FETCH_ASSOC);
            if ($randomizeOrder) {
                // クライアントはカスタム順(sort_order)で並べるため、抽出したランダム順を保つ
                foreach ($tracks as $i => $t) { $tracks[$i]['sort_order'] = $i; }
            }
            // 代表行や表示リストによらず、曲単位の状態を返す。
            foreach ($tracks as &$track) {
                $track['is_favorite'] = track_favorite_state($db, $user_id, $track['youtube_id']);
            }
            unset($track);
            echo json_encode($tracks, JSON_UNESCAPED_UNICODE);
            break;

        case 'get_public_playlists':
            // 固定タブ (未整理 / 公開用お気に入り) は各ユーザー専用のタブなので、
            // ユーザーが作成した公開リストだけを共有一覧に出す (同名タブの重複表示を防ぐ)。
            $stmt = $db->query(
                "SELECT p.*, COALESCE(u.display_name, u.username) AS author, COALESCE(u.display_name, u.username) AS author_name,
                        (SELECT COUNT(*) FROM bookmarks b WHERE b.playlist_id = p.id) AS track_count
                 FROM playlists p
                 JOIN users u ON u.id = p.user_id
                 WHERE p.is_public = 1 AND p.system_key IS NULL
                 ORDER BY p.created_at DESC, p.id DESC"
            );
            $playlists = with_default_playlist_covers($db, $stmt->fetchAll(PDO::FETCH_ASSOC));
            echo json_encode($playlists, JSON_UNESCAPED_UNICODE);
            break;

        case 'get_recent_playlists':
            // 共有一覧と同じく固定タブ (未整理 / 公開用お気に入り) は除外する
            $stmt = $db->query(
                "SELECT p.*, COALESCE(u.display_name, u.username) AS author,
                        (SELECT COUNT(*) FROM bookmarks b WHERE b.playlist_id = p.id) AS track_count
                 FROM playlists p
                 JOIN users u ON u.id = p.user_id
                 WHERE p.is_public = 1 AND p.system_key IS NULL
                 ORDER BY p.created_at DESC LIMIT 10"
            );
            $playlists = with_default_playlist_covers($db, $stmt->fetchAll(PDO::FETCH_ASSOC));
            echo json_encode($playlists, JSON_UNESCAPED_UNICODE);
            break;

        case 'radar_tunelot':
            // 抽選対象も固定タブを除いたユーザー作成の公開リストに限定する
            $stmt = $db->query("SELECT * FROM playlists WHERE is_public = 1 AND system_key IS NULL ORDER BY RANDOM() LIMIT 3");
            $playlists = with_default_playlist_covers($db, $stmt->fetchAll(PDO::FETCH_ASSOC));
            if (count($playlists) > 0) {
                echo json_encode(['success' => true, 'playlists' => $playlists], JSON_UNESCAPED_UNICODE);
            } else {
                echo json_encode(['success' => false, 'message' => '公開されているプレイリストがありません']);
            }
            break;

        // ==========================================
        // カテゴリ更新 (フロントの updatePlaylistCategory 用)
        // ==========================================
        case 'update_category':
            if ($method === 'POST' && !empty($input['id']) && isset($input['category'])) {
                $user_id = require_user_or_guest($db);
                if (system_key_of_playlist($db, $user_id, (int)$input['id'])) {
                    echo json_encode(['success' => false, 'error' => '固定タブ（未整理 / 公開用お気に入り）のタグは変更できません'], JSON_UNESCAPED_UNICODE);
                    break;
                }
                $stmt = $db->prepare("UPDATE playlists SET category = ? WHERE id = ? AND user_id = ?");
                $stmt->execute([$input['category'], $input['id'], $user_id]);
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['success' => false, 'error' => 'Invalid input']);
            }
            break;

        // ==========================================
        // プレイリスト並び替え (サイドバー)
        // ==========================================
        case 'reorder_playlists':
            if ($method === 'POST' && isset($input['ordered_ids']) && is_array($input['ordered_ids'])) {
                $user_id = require_user_or_guest($db);
                $ids = array_values(array_filter(array_map('intval', $input['ordered_ids'])));
                // 固定タブ (未整理 / 公開用お気に入り) は並び替え対象外 (サイドバーで常に先頭固定)
                $stmt = $db->prepare("UPDATE playlists SET sort_order = ? WHERE id = ? AND user_id = ? AND system_key IS NULL");
                foreach ($ids as $pos => $pid) {
                    $stmt->execute([$pos, $pid, $user_id]);
                }
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['success' => false, 'error' => 'Invalid input']);
            }
            break;

        // ==========================================
        // ブックマーク並び替え (楽曲カード)
        // ==========================================
        case 'reorder_bookmarks':
            if ($method === 'POST' && isset($input['ordered_ids']) && is_array($input['ordered_ids'])) {
                $user_id = require_user_or_guest($db);
                $ids = array_values(array_filter(array_map('intval', $input['ordered_ids'])));
                $stmt = $db->prepare("UPDATE bookmarks SET sort_order = ? WHERE id = ? AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)");
                foreach ($ids as $pos => $bid) {
                    $stmt->execute([$pos, $bid, $user_id]);
                }
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['success' => false, 'error' => 'Invalid input']);
            }
            break;

        // ==========================================
        // UMAP 楽曲マップ (Flask /radar/map をプロキシ)
        // ==========================================
        case 'radar_map': {
            $public = isset($_GET['public']) ? (int)$_GET['public'] : 0;
            $port = get_active_auth_port();
            $ctx = stream_context_create(['http' => ['timeout' => 30]]);
            $raw = @file_get_contents("http://127.0.0.1:{$port}/radar/map?public={$public}", false, $ctx);
            if ($raw === false) {
                http_response_code(503);
                echo json_encode(['success' => false, 'error' => 'UMAPマップサーバーに接続できません。(app.py を起動してください)'], JSON_UNESCAPED_UNICODE);
                break;
            }
            echo $raw;
            break;
        }

        case 'radar_analyze_all': {
            $port = get_active_auth_port();
            // force / audio / limit / wait を Flask へ転送する
            // (旧パラメータ名 essentia も audio として受付)
            $qs = http_build_query([
                'force' => isset($_GET['force']) ? (int)$_GET['force'] : 0,
                'audio' => isset($_GET['audio']) ? (int)$_GET['audio']
                    : (isset($_GET['essentia']) ? (int)$_GET['essentia'] : 1),
                'limit' => isset($_GET['limit']) ? (int)$_GET['limit'] : 0,
                'wait' => isset($_GET['wait']) ? (int)$_GET['wait'] : 0,
            ]);
            $timeout = (isset($_GET['wait']) && (int)$_GET['wait'] === 1) ? 3600 : 60;
            $ctx = stream_context_create(['http' => ['timeout' => $timeout]]);
            $raw = @file_get_contents("http://127.0.0.1:{$port}/radar/analyze_all?{$qs}", false, $ctx);
            if ($raw === false) {
                http_response_code(503);
                echo json_encode([
                    'success' => false,
                    'error' => '再解析サーバー(app.py)に接続できません。./start.sh で起動してください。',
                ], JSON_UNESCAPED_UNICODE);
                break;
            }
            echo $raw;
            break;
        }

        case 'radar_analyze_status': {
            $port = get_active_auth_port();
            $ctx = stream_context_create(['http' => ['timeout' => 20]]);
            $raw = @file_get_contents("http://127.0.0.1:{$port}/radar/analyze_status", false, $ctx);
            if ($raw === false) {
                http_response_code(503);
                echo json_encode([
                    'success' => false,
                    'error' => '再解析サーバー(app.py)に接続できません。',
                ], JSON_UNESCAPED_UNICODE);
                break;
            }
            echo $raw;
            break;
        }

        // ==========================================
        // 認証プロキシ (Flask app.py へ転送: MAMP/Live Server対応)
        // フロントは api.php?action=auth&endpoint=login|register を呼ぶ。
        // こうすることで Flask のポート不一致・CORS の問題を回避できる。
        // ==========================================
        case 'auth':
            $endpoint = $_GET['endpoint'] ?? 'login';
            if (!in_array($endpoint, ['login', 'register', 'google', 'me', 'profile'], true)) {
                http_response_code(400);
                echo json_encode(['error' => '無効な認証エンドポイントです。']);
                break;
            }
            $auth_port = get_active_auth_port();
            $auth_url = "http://127.0.0.1:{$auth_port}/auth/{$endpoint}";
            $auth_body = file_get_contents('php://input');
            $auth_header = auth_header_value();
            $auth_ctx = stream_context_create(['http' => [
                'method' => $endpoint === 'me' ? 'GET' : 'POST',
                'header' => "Content-Type: application/json\r\n" . ($auth_header !== '' ? "Authorization: {$auth_header}\r\n" : ''),
                'content' => $auth_body,
                'ignore_errors' => true,
                'timeout' => 15,
            ]]);
            $auth_resp = @file_get_contents($auth_url, false, $auth_ctx);
            if ($auth_resp === false) {
                http_response_code(503);
                echo json_encode(['error' => '認証サーバーに接続できません。app.py が起動しているか確認してください。']);
                break;
            }
            foreach ($http_response_header ?? [] as $response_header) {
                if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $response_header, $matches)) {
                    http_response_code((int)$matches[1]);
                }
            }
            echo $auth_resp;
            break;

        default:
            echo json_encode(['error' => 'Invalid action']);
            break;
    }

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Database error: ' . $e->getMessage()]);
}
?>
