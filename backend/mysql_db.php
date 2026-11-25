<?php
/** Shared PHP connection configuration for TuneDrop MySQL. */
function tunedrop_mysql_load_environment(): void {
    static $loaded = false;
    if ($loaded) return;
    $loaded = true;
    $path = getenv('TUNEDROP_ENV_FILE');
    if (!$path) {
        // .env はプロジェクト直下 (docroot) に置く。このファイルは backend/ にあるため、
        // 直下を優先し、無ければこのファイルの隣 (テストの複製など) を見る。
        $path = is_readable(dirname(__DIR__) . '/.env') ? dirname(__DIR__) . '/.env' : __DIR__ . '/.env';
    }
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
    // MySQL の再起動・瞬断で1回失敗しただけで API を 500 にしないよう、短い間隔で
    // 接続をやり直す。待ち時間は 1回目 150ms、2回目 300ms ... (既定 3回試行)。
    //   TUNEDROP_MYSQL_CONNECT_RETRIES     試行回数 (既定 3)
    //   TUNEDROP_MYSQL_CONNECT_RETRY_DELAY_MS  初回の待ち時間ミリ秒 (既定 150)
    $attempts = (int)(getenv('TUNEDROP_MYSQL_CONNECT_RETRIES') ?: 3);
    if ($attempts < 1) $attempts = 1;
    $delay_ms = max(0, (int)(getenv('TUNEDROP_MYSQL_CONNECT_RETRY_DELAY_MS') ?: 150));
    $last = null;
    for ($attempt = 1; $attempt <= $attempts; $attempt++) {
        try {
            return new PDO($dsn, $user, getenv('TUNEDROP_MYSQL_PASSWORD') ?: '', [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => true,
                PDO::ATTR_TIMEOUT => 5,
            ]);
        } catch (PDOException $error) {
            $last = $error;
            if ($attempt >= $attempts) break;
            if ($delay_ms > 0) usleep($delay_ms * 1000 * $attempt);
        }
    }
    throw $last ?: new RuntimeException('MySQL connection failed.');
}
