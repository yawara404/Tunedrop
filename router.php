<?php
// PHP development server equivalent of the Apache public-file allowlist.
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');
$public = ['/', '/index.html', '/api.php', '/admin.php', '/admin.js', '/admin.css',
    '/frontend/app.js', '/frontend/config.js', '/frontend/style.css', '/frontend/favicon.svg'];
if (!in_array($path, $public, true)) {
    http_response_code(403);
    exit('Forbidden');
}
return false;
