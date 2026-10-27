<?php
// PHP ビルトインサーバー (backend/start.sh) 版の公開ファイル許可リスト。
// Apache の .htaccess と同じ規則で、配信するのは画面 (frontend/dist/ の
// index.html と assets/ = Vite のビルド成果物) と API / OGP / 管理画面 /
// 検索エンジン向けファイルだけ。
//
// このファイルは backend/ にあり、docroot (-t) はプロジェクト直下。
// 公開URLは整理前と同じで、実ファイルの置き場だけが backend/ と frontend/dist/ に
// 分かれている (下の $static_map / $entry_points が対応表)。
//
// 公開 (Cloudflare Tunnel) では https://<host>/tunedrop/ 配下で配信される。
// Apache は /tunedrop の Alias が処理するが、PHPビルトインサーバーは
// REQUEST_URI のままのパス (<docroot>/tunedrop/api.php) を探してしまうため、
// 先頭の /tunedrop を外して許可判定し、プレフィックス付きの要求は
// このルーターが実ファイルを返す / エントリポイントを実行する (Alias 相当)。
$requestPath = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');

// floppy.io は同じ公開 PHP サーバーから配信する別アプリ。実体は
// docroot/floppy.io のシンボリックリンクなので、ルーターの許可リストを
// 適用せず PHP ビルトインサーバーの通常処理へ渡す。
if (preg_match('#^/floppy\.io(?:/|$)#', $requestPath)) {
    return false;
}

$prefix = '';
if (preg_match('#^/[Tt]unedrop(?=/|$)#', $requestPath, $matched)) {
    $prefix = $matched[0];
    $path = substr($requestPath, strlen($prefix));
    if ($path === '') {
        // /tunedrop (末尾スラッシュなし) は Apache の mod_dir と同じく /tunedrop/ へ寄せる。
        // 寄せないと相対URL (assets/... など) が / 直下を指してしまう。
        $query = (string)parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY);
        header('Location: ' . $prefix . '/' . ($query !== '' ? '?' . $query : ''), true, 301);
        exit;
    }
} else {
    $path = $requestPath;
}
if ($path === '') {
    $path = '/';
}
// このルーターは backend/ にあり、docroot (-t) はプロジェクト直下 (その親)。
// ソースは backend/ と frontend/ に分かれているが、公開URLは変えない:
//   公開URL                     → 実ファイル
//   /                           → frontend/dist/index.html (Vite のビルド成果物)
//   /index.html                 → frontend/dist/index.html
//   /assets/<hash>.<ext>        → frontend/dist/assets/<hash>.<ext>
//   /api.php, /ogp.php          → backend/api.php, backend/ogp.php (実行)
//   /robots.txt, /sitemap.xml   → プロジェクト直下
//   /frontend/favicon-card.png  → frontend/favicon-card.png (OGPカード画像)
//   /admin/admin.{js,css}       → admin/ (ローカル専用)
$projectRoot = dirname(__DIR__);
$static_map = [
    '/' => $projectRoot . '/frontend/dist/index.html',
    '/index.html' => $projectRoot . '/frontend/dist/index.html',
    '/robots.txt' => $projectRoot . '/robots.txt',
    '/sitemap.xml' => $projectRoot . '/sitemap.xml',
    '/frontend/favicon-card.png' => $projectRoot . '/frontend/favicon-card.png',
    '/admin/admin.js' => $projectRoot . '/admin/admin.js',
    '/admin/admin.css' => $projectRoot . '/admin/admin.css',
];
// PHP のエントリポイントは実行する (読み込んで返すとソースが見えてしまう)。
$entry_points = [
    '/api.php' => __DIR__ . '/api.php',
    '/ogp.php' => __DIR__ . '/ogp.php',
    '/admin/admin.php' => $projectRoot . '/admin/admin.php',
];
// 画面の本体は Vite のビルド成果物 (frontend/dist/)。assets/ はファイル名に内容の
// ハッシュが入るため個別登録できない。代わりに「assets/ 直下 + 拡張子が既知の資産」
// だけを配信する (サブフォルダ・隠しファイル・想定外の拡張子は403のまま。
// ビルド元の frontend/app.js なども配信しない)。
// Google Search Console の「HTMLファイル」所有権確認は google<値>.html という名前で置くため、
// この形のファイル名だけは個別登録なしで配信する (存在しないパスは404のまま)。
// 管理画面のシェルスクリプト (admin/admin.sh) は配信しない。
$asset_pattern = '#^/assets/[A-Za-z0-9_-]+\.(?:js|css|svg|png|jpe?g|webp|gif|ico|woff2?|map)$#';
if (!preg_match($asset_pattern, $path)
    && !isset($static_map[$path])
    && !isset($entry_points[$path])
    && !preg_match('#^/google[a-z0-9]+\.html$#i', $path)) {
    http_response_code(403);
    exit('Forbidden');
}

// ここから Apache の Alias + FastCGI 相当を自前で行う (プレフィックスの有無で
// 扱いを変えない。ビルド成果物が frontend/dist/ へ移ったため、ローカルの / も
// 自前で配信しないと配信元を解決できない)。
// ogp.php は SCRIPT_NAME から公開ベースURL (例: https://host/tunedrop) を作るため、
// プレフィックス付きのパスをそのまま渡す。
$_SERVER['SCRIPT_NAME'] = $requestPath;
$_SERVER['PHP_SELF'] = $requestPath;
$_SERVER['SCRIPT_FILENAME'] = $entry_points[$path]
    ?? ($static_map[$path] ?? $projectRoot . $path);

// PHP のエントリポイントは実行する (読み込んで返すとソースが見えてしまう)。
if (isset($entry_points[$path])) {
    require $entry_points[$path];
    return true;
}

if (isset($static_map[$path])) {
    $file = $static_map[$path];
} elseif (preg_match($asset_pattern, $path)) {
    $file = $projectRoot . '/frontend/dist' . $path;   // /assets/x → frontend/dist/assets/x
} else {
    $file = $projectRoot . $path;   // google<hash>.html
}
if (!is_file($file)) {
    http_response_code(404);
    exit('Not Found');
}
header('Content-Type: ' . tunedrop_asset_mime($file));
// .htaccess と同じキャッシュ方針 (assets/ はファイル名が内容に紐づくので長く持たせる)。
if (str_starts_with($path, '/assets/')) {
    header('Cache-Control: public, max-age=31536000, immutable');
} elseif ($path === '/' || str_ends_with($path, '.html')) {
    // HTML は URL が固定で、ビルドのたびに中身と参照する assets が変わる。
    // ブラウザには毎回 ETag で再検証させ (変わっていなければ 304 で本文ゼロ)、
    // Cloudflare のエッジには s-maxage の範囲だけ持たせる。デプロイ直後に
    // 削除済みの assets を参照する古い HTML を配り続けないよう stale 期間は短くし、
    // 公開後は scripts/purge-cloudflare-cache.sh で明示的に消す。
    header('Cache-Control: public, max-age=0, s-maxage=60, must-revalidate, stale-while-revalidate=60');
} elseif ($path === '/robots.txt' || $path === '/sitemap.xml') {
    header('Cache-Control: public, max-age=3600');   // クローラーが定期取得する
} elseif (preg_match('#\.(?:png|jpe?g|webp|gif|svg|ico)$#i', $path)) {
    header('Cache-Control: public, max-age=604800');
} else {
    header('Cache-Control: public, max-age=3600');
}
// 条件付きリクエスト (If-None-Match / If-Modified-Since) を自分で判定する。
// PHPビルトインサーバーは router.php が true を返した時点で自前配信になるため、
// ここで 304 を返さないと index.html (58KB) を再訪のたびに送り直してしまう。
$size = (int)filesize($file);
$modified = (int)filemtime($file);
$etag = '"' . dechex($modified) . '-' . dechex($size) . '"';
header('ETag: ' . $etag);
header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $modified) . ' GMT');
$if_none_match = trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
$if_modified_since = trim((string)($_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? ''));
$not_modified = false;
if ($if_none_match !== '') {
    $not_modified = ($if_none_match === $etag || $if_none_match === '*');
} elseif ($if_modified_since !== '') {
    $since = strtotime($if_modified_since);
    $not_modified = ($since !== false && $since >= $modified);
}
if ($not_modified) {
    http_response_code(304);
    return true;   // 本文は送らない
}
header('Content-Length: ' . (string)$size);
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
    readfile($file);
}
return true;

/** 配信するファイルの Content-Type (Cloudflare Tunnel 越しに返すため自前で決める)。 */
function tunedrop_asset_mime(string $file): string
{
    static $types = [
        'html' => 'text/html; charset=utf-8',
        'js' => 'text/javascript; charset=utf-8',
        'css' => 'text/css; charset=utf-8',
        'svg' => 'image/svg+xml',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'webp' => 'image/webp',
        'gif' => 'image/gif',
        'ico' => 'image/x-icon',
        'woff' => 'font/woff',
        'woff2' => 'font/woff2',
        'ttf' => 'font/ttf',
        'otf' => 'font/otf',
        'map' => 'application/json; charset=utf-8',
        'txt' => 'text/plain; charset=utf-8',
        'xml' => 'application/xml; charset=utf-8',
    ];
    return $types[strtolower(pathinfo($file, PATHINFO_EXTENSION))] ?? 'application/octet-stream';
}
