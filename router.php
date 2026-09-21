<?php
// PHP development server equivalent of the Apache public-file allowlist.
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');
$public = ['/', '/index.html', '/api.php', '/admin.php', '/app.js', '/api-client.js',
    '/config.js', '/text-marquee.js', '/admin.js', '/style.css', '/admin.css',
    '/frontend/manager-lists.js', '/vendor/vue.esm-browser.prod.js'];
if (!in_array($path, $public, true)) {
    http_response_code(403);
    exit('Forbidden');
}
return false;
