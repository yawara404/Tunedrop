<?php
// PHP ビルトインサーバー (./start.sh) 版の公開ファイル許可リスト。
// Apache の .htaccess と同じ規則で、配信するのは画面 (index.html と assets/ の
// ビルド成果物) と API / OGP / 管理画面 / 検索エンジン向けファイルだけ。
//
// 公開 (Cloudflare Tunnel) では https://<host>/tunedrop/ 配下で配信される。
// Apache は /tunedrop の Alias が処理するが、PHPビルトインサーバーは
// REQUEST_URI のままのパス (<docroot>/tunedrop/api.php) を探してしまうため、
// 先頭の /tunedrop を外して許可判定し、プレフィックス付きの要求は
// このルーターが実ファイルを返す / エントリポイントを実行する (Alias 相当)。
$requestPath = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');
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
$public = ['/', '/index.html', '/api.php', '/ogp.php',
    '/robots.txt', '/sitemap.xml',
    '/admin/admin.php', '/admin/admin.js', '/admin/admin.css',
    '/frontend/favicon-card.png'];
// 画面の本体は Vite のビルド成果物 (プロジェクト直下の index.html と assets/)。
// assets/ はファイル名に内容のハッシュが入るため個別登録できない。代わりに
// 「assets/ 直下 + 拡張子が既知の資産」だけを配信する (サブフォルダ・隠しファイル・
// 想定外の拡張子は403のまま。ビルド元の frontend/app.js なども配信しない)。
// Google Search Console の「HTMLファイル」所有権確認は google<値>.html という名前で置くため、
// この形のファイル名だけは個別登録なしで配信する (存在しないパスは404のまま)。
// 管理画面のシェルスクリプト (admin/admin.sh) は配信しない。
$asset_pattern = '#^/assets/[A-Za-z0-9_-]+\.(?:js|css|svg|png|jpe?g|webp|gif|ico|woff2?|map)$#';
if (!preg_match($asset_pattern, $path)
    && !in_array($path, $public, true)
    && !preg_match('#^/google[a-z0-9]+\.html$#i', $path)) {
    http_response_code(403);
    exit('Forbidden');
}
// プレフィックスなし (ローカル: http://127.0.0.1:8888/) は PHPビルトインサーバーの
// 通常処理へ任せる (DirectoryIndex / HEAD / Range がそのまま効く)。
if ($prefix === '') {
    return false;
}

// ここから公開URL (/tunedrop/...) 用: Apache の Alias + FastCGI 相当を自前で行う。
// ogp.php は SCRIPT_NAME から公開ベースURL (例: https://host/tunedrop) を作るため、
// プレフィックス付きのパスをそのまま渡す。
$_SERVER['SCRIPT_NAME'] = $requestPath;
$_SERVER['PHP_SELF'] = $requestPath;
$_SERVER['SCRIPT_FILENAME'] = __DIR__ . $path;

// PHP のエントリポイントは実行する (読み込んで返すとソースが見えてしまう)。
if (in_array($path, ['/api.php', '/ogp.php', '/admin/admin.php'], true)) {
    require __DIR__ . $path;
    return true;
}

$file = $path === '/' ? __DIR__ . '/index.html' : __DIR__ . $path;
if (!is_file($file)) {
    http_response_code(404);
    exit('Not Found');
}
header('Content-Type: ' . tunedrop_asset_mime($file));
// .htaccess と同じキャッシュ方針 (assets/ はファイル名が内容に紐づくので長く持たせる)。
if (str_starts_with($path, '/assets/')) {
    header('Cache-Control: public, max-age=31536000, immutable');
} elseif (str_ends_with($path, '.html')) {
    header('Cache-Control: no-cache, must-revalidate');
} elseif ($path === '/robots.txt' || $path === '/sitemap.xml') {
    header('Cache-Control: public, max-age=3600');   // クローラーが定期取得する
} elseif (preg_match('#\.(?:png|jpe?g|webp|gif|svg|ico)$#i', $path)) {
    header('Cache-Control: public, max-age=604800');
} else {
    header('Cache-Control: public, max-age=3600');
}
header('Content-Length: ' . (string)filesize($file));
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
