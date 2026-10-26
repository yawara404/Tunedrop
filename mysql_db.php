<?php
/** Shared PHP connection configuration for TuneDrop MySQL. */
function tunedrop_mysql_load_environment(): void {
    static $loaded = false;
    if ($loaded) return;
    $loaded = true;
    $path = getenv('TUNEDROP_ENV_FILE') ?: __DIR__ . '/.env';
    if (!is_readable($path)) return;
    foreach (file($path, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) continue;
        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        if (!str_starts_with($key, 'TUNEDROP_MYSQL_') || getenv($key) !== false) continue;
        putenv($key . '=' . $value);
    }
}

function tunedrop_mysql_enabled(): bool {
    tunedrop_mysql_load_environment();
    return (getenv('TUNEDROP_MYSQL_HOST') ?: '') !== '';
}

function tunedrop_mysql_db(): PDO {
    $host = getenv('TUNEDROP_MYSQL_HOST');
    $port = (int)(getenv('TUNEDROP_MYSQL_PORT') ?: 3306);
    $name = getenv('TUNEDROP_MYSQL_DATABASE');
    $user = getenv('TUNEDROP_MYSQL_USER');
    if (!$host || !$name || !$user) {
        throw new RuntimeException('MySQL host, database and user must be configured.');
    }
    $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
    return new PDO($dsn, $user, getenv('TUNEDROP_MYSQL_PASSWORD') ?: '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => true,
        PDO::ATTR_TIMEOUT => 5,
    ]);
}
