<?php
// PHP development server equivalent of the Apache public-file allowlist.
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');
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
return false;
