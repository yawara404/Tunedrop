<?php
// PHP development server equivalent of the Apache public-file allowlist.
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');
$public = ['/', '/index.html', '/api.php', '/admin.php', '/admin.js', '/admin.css',
    '/frontend/app.js', '/frontend/api-client.js', '/frontend/config.js',
    '/frontend/text-marquee.js', '/frontend/manager-lists.js', '/frontend/style.css',
    '/vendor/vue.esm-browser.prod.js'];
if (!in_array($path, $public, true)) {
    http_response_code(403);
    exit('Forbidden');
}
return false;
