# SQLite から MySQL への移行

MySQL 8.0 以降、PHP の `pdo_mysql`、Python の `PyMySQL` が必要です（このリポジトリの `.php/` と `.venv/` には両方入っています）。PHP と Python は同じ `TUNEDROP_MYSQL_*` 環境変数を使用します。`./backend/start.sh` は `.env` の値を両方のプロセスへ渡します。

## 1. MySQL を用意する（macOS / Homebrew）

```sh
brew install mysql
brew services start mysql          # ログイン時に自動起動する
mysql -u root -e 'SELECT VERSION();'
```

続けて、空のデータベースと専用ユーザーを作ります（文字セットは `utf8mb4`）。パスワードは `python3 -c 'import secrets;print(secrets.token_urlsafe(24))'` などで生成し、**リポジトリの外**（例 `~/.tunedrop/mysql.env`、`chmod 600`）に控えてください。

```sh
mysql -u root -e "
  CREATE DATABASE IF NOT EXISTS tunedrop CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
  CREATE USER IF NOT EXISTS 'tunedrop'@'localhost' IDENTIFIED BY 'ここに生成したパスワード';
  CREATE USER IF NOT EXISTS 'tunedrop'@'127.0.0.1' IDENTIFIED BY 'ここに生成したパスワード';
  GRANT ALL PRIVILEGES ON tunedrop.* TO 'tunedrop'@'localhost';
  GRANT ALL PRIVILEGES ON tunedrop.* TO 'tunedrop'@'127.0.0.1';
  FLUSH PRIVILEGES;"

# スキーマ（テーブル6つ）を適用する
mysql -u root tunedrop < backend/mysql_schema.sql
mysql -u root tunedrop -e 'SHOW TABLES;'
```

`tunedrop@localhost`（ソケット）と `tunedrop@127.0.0.1`（TCP）の両方を作るのは、接続方法によって照合されるアカウントが変わるためです。

## 2. データを移す

1. PHP、Python、公開トンネルを停止します。移行中の SQLite への書き込みを止めてください（`pkill -f 'Tunedrop/start.py'` など）。
2. 既存 DB をバックアップします。DB は配信フォルダの外（`.env` の `TUNEDROP_DB`）にあるため、そのパスを指定します。

   ```sh
   mkdir -p ~/.tunedrop/backups
   sqlite3 "$(grep '^TUNEDROP_DB=' .env | cut -d= -f2-)" \
     ".backup '$HOME/.tunedrop/backups/before-mysql.sqlite'"
   ```

3. まず件数を確認し（dry run）、問題なければ `--apply` でコピーします。コピーは MySQL が空のときだけ受け付けます。

   ```sh
   set -a; . ~/.tunedrop/mysql.env; set +a        # TUNEDROP_MYSQL_* を読み込む
   PYTHONPATH=backend .venv/bin/python backend/migrate_sqlite_to_mysql.py
   PYTHONPATH=backend .venv/bin/python backend/migrate_sqlite_to_mysql.py --apply
   ```

4. `.env` の `TUNEDROP_MYSQL_*` を設定し、`chmod 600 .env` にします（`.env.example` に項目があります）。`TUNEDROP_DB` は切り戻し用に残しておくと安全です。
5. `./backend/start.sh` で起動し、ログイン、プレイリスト、曲の追加、公開ページ、Radar を確認します。`users` などの件数が SQLite 側と一致することを MySQL 側でも確認してください。

   ```sh
   mysql -u root tunedrop -e "SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM playlists) playlists, (SELECT COUNT(*) FROM bookmarks) bookmarks;"
   ```

## 3. 運用メモ

- **バックアップ**: `mysqldump --single-transaction --databases tunedrop > tunedrop-$(date +%Y%m%d-%H%M%S).sql`。管理画面の SQLite ファイルバックアップは MySQL では利用できません。
- **テスト**: テストは一時 SQLite を前提に書かれています。`.env` に `TUNEDROP_MYSQL_*` がある状態で個別に実行すると**本番 MySQL へ接続してしまう**ため、同梱のランナーを使ってください（MySQL 設定を空にして実行します）。

  ```sh
  ./tests/run-all.sh                       # 全部
  ./tests/run-all.sh tests/genre-rules.py  # 個別
  ```

- **切り戻し**: プロセスを止め、`.env` の `TUNEDROP_MYSQL_HOST` を空にして `./backend/start.sh` を再起動します（SQLite バックアップを戻す場合は DB 本体と `-wal` / `-shm` をセットで扱ってください）。MySQL 切り替え後に作成されたデータは SQLite には自動反映されません。

