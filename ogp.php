<?php
/**
 * Tune drop: SNS共有用の OGP / Twitterカードを返すエンドポイント
 * ==========================================================
 * SPA (index.html) はハッシュルーティング (#/playlist/12) で動くため、
 * SNSのクローラーには公開リストの中身が見えず、共有してもカードが出ない。
 * このエンドポイントは公開リストの OGP メタタグだけを返し、人間のブラウザは
 * そのまま SPA の該当画面へ転送する (クローラーは meta refresh / JS を実行しない)。
 *
 *   共有URL: ogp.php?playlist=<id>
 *
 * - 公開リスト (is_public = 1) のみ情報を出す。非公開・存在しない・IDなしは
 *   サイト共通のカードにフォールバックする (情報漏洩しない)。
 * - 画像は YouTube のサムネイル (hqdefault.jpg) を絶対URLで返す。
 * - OGPクローラーは 3xx を追わず内容を読めないことがあるため、HTTP 200 の
 *   HTML 内で meta refresh / JS により転送する (HTTPリダイレクトは使わない)。
 * - 公開ファイル許可リスト (.htaccess / router.php) への追加が必要。
 */

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: public, max-age=300');

/** HTML本文・属性へ埋め込む文字列をエスケープする。 */
function ogp_escape(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/**
 * リクエストから公開ベースURL (例: https://host/tunedrop) を組み立てる。
 * Cloudflare Tunnel / ngrok 越しでも正しい URL になるよう
 * X-Forwarded-Proto を優先し、テストや特殊環境向けに環境変数で上書きできる。
 */
function ogp_base_url(): string
{
    $override = trim((string)getenv('TUNEDROP_OGP_BASE_URL'));
    if ($override !== '') {
        return rtrim($override, '/');
    }
    $scheme = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') ? 'https' : 'http';
    $forwarded = trim((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
    if ($forwarded !== '') {
        $candidate = strtolower(trim(explode(',', $forwarded)[0]));
        if ($candidate === 'https' || $candidate === 'http') {
            $scheme = $candidate;
        }
    }
    $host = (string)($_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? 'localhost'));
    $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? ''));
    $dir = '';
    if ($script !== '' && $script[0] === '/') {
        $dir = rtrim(dirname($script), '/');
        if ($dir === '/') {
            $dir = '';
        }
    }
    return $scheme . '://' . $host . $dir;
}

/** 公開リストを1件読む。見つからなければ null (非公開・存在しない)。 */
function ogp_load_playlist(string $db_path, int $playlist_id): ?array
{
    if ($playlist_id <= 0 || !is_file($db_path)) {
        return null;
    }
    try {
        $db = new PDO('sqlite:' . $db_path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 5,
        ]);
        $db->exec('PRAGMA busy_timeout = 5000;');
        // display_name は api.php の ensure_schema が後から足す列。
        // まだ無い DB (セットアップ直後) でも動くように有無を確認する。
        $user_columns = $db->query('PRAGMA table_info(users)')->fetchAll(PDO::FETCH_COLUMN, 1);
        $author_expr = in_array('display_name', $user_columns, true)
            ? 'COALESCE(u.display_name, u.username)'
            : 'u.username';
        $stmt = $db->prepare(
            "SELECT p.id, p.name, p.category, p.cover_id,
                    {$author_expr} AS author,
                    (SELECT COUNT(*) FROM bookmarks b WHERE b.playlist_id = p.id) AS track_count
             FROM playlists p
             JOIN users u ON u.id = p.user_id
             WHERE p.id = ? AND p.is_public = 1"
        );
        $stmt->execute([$playlist_id]);
        $playlist = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$playlist) {
            return null;
        }
        // カバー未設定なら「最後に追加した曲」を使う (画面表示と同じ解決順)
        if (empty($playlist['cover_id'])) {
            $latest = $db->prepare(
                "SELECT youtube_id FROM bookmarks WHERE playlist_id = ?
                 ORDER BY added_at DESC, id DESC LIMIT 1"
            );
            $latest->execute([$playlist_id]);
            $cover = $latest->fetchColumn();
            $playlist['cover_id'] = $cover === false ? '' : (string)$cover;
        }
        return $playlist;
    } catch (Throwable $error) {
        return null;
    }
}

$db_path = getenv('TUNEDROP_DB') ?: __DIR__ . '/database.sqlite';
$base = ogp_base_url();
$playlist_id = (int)($_GET['playlist'] ?? 0);
$playlist = ogp_load_playlist($db_path, $playlist_id);

// 既定はサイト共通カード。公開リストが見つかったときだけ上書きする。
$title = 'Tune drop - Music Bookmark & Radar';
$description = 'YouTubeの音楽を自分好みにコレクション・整理し、みんなの公開プレイリストを発掘・共有できる音楽アプリ。';
$image = '';
$canonical = $base . '/index.html';
$redirect = 'index.html';

if ($playlist !== null) {
    $name = trim((string)$playlist['name']);
    $author = trim((string)($playlist['author'] ?? ''));
    $category = trim((string)($playlist['category'] ?? ''));
    $count = (int)($playlist['track_count'] ?? 0);
    $cover = trim((string)($playlist['cover_id'] ?? ''));

    $title = ($name !== '' ? $name : '公開プレイリスト') . ' - Tune drop';
    $parts = [];
    if ($author !== '') {
        $parts[] = $author . ' さんの公開プレイリスト';
    }
    if ($count > 0) {
        $parts[] = '全' . $count . '曲';
    }
    if ($category !== '' && $category !== 'Other') {
        $parts[] = 'カテゴリ: ' . $category;
    }
    $description = ($parts ? implode(' / ', $parts) . '。' : '')
        . 'Tune drop - YouTubeの音楽をコレクション＆発掘できる音楽アプリ。';
    if ($cover !== '') {
        $image = 'https://i.ytimg.com/vi/' . rawurlencode($cover) . '/hqdefault.jpg';
    }
    $canonical = $base . '/ogp.php?playlist=' . $playlist_id;
    $redirect = 'index.html#/playlist/' . $playlist_id;
}

$title_esc = ogp_escape($title);
$description_esc = ogp_escape($description);
$image_esc = ogp_escape($image);
$canonical_esc = ogp_escape($canonical);
$redirect_esc = ogp_escape($redirect);
$card = $image !== '' ? 'summary_large_image' : 'summary';
?><!DOCTYPE html>
<html lang="ja">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= $title_esc ?></title>
    <meta name="description" content="<?= $description_esc ?>">
    <meta name="robots" content="noindex, nofollow">
    <link rel="canonical" href="<?= $canonical_esc ?>">
    <meta property="og:site_name" content="Tune drop">
    <meta property="og:type" content="website">
    <meta property="og:title" content="<?= $title_esc ?>">
    <meta property="og:description" content="<?= $description_esc ?>">
    <meta property="og:url" content="<?= $canonical_esc ?>">
    <?php if ($image !== ''): ?>
    <meta property="og:image" content="<?= $image_esc ?>">
    <meta property="og:image:width" content="480">
    <meta property="og:image:height" content="360">
    <meta property="og:image:alt" content="<?= $title_esc ?>">
    <?php endif; ?>
    <meta name="twitter:card" content="<?= $card ?>">
    <meta name="twitter:title" content="<?= $title_esc ?>">
    <meta name="twitter:description" content="<?= $description_esc ?>">
    <?php if ($image !== ''): ?>
    <meta name="twitter:image" content="<?= $image_esc ?>">
    <?php endif; ?>
    <meta http-equiv="refresh" content="0; url=<?= $redirect_esc ?>">
    <script>location.replace(<?= json_encode($redirect, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>);</script>
</head>

<body>
    <p>移動しています… 自動で切り替わらない場合は <a href="<?= $redirect_esc ?>">こちら</a>。</p>
</body>

</html>
