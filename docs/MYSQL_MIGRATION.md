# SQLite から MySQL への移行

MySQL 8.0、PHP の `pdo_mysql`、Python の `PyMySQL` が必要です。PHP と Python は同じ `TUNEDROP_MYSQL_*` 環境変数を使用します。`./start.sh` は `.env` の値を両方のプロセスへ渡します。

1. PHP、Python、公開トンネルを停止します。移行中の SQLite への書き込みを止めてください。
2. 既存 DB をバックアップします。

   ```sh
   sqlite3 database.sqlite ".backup 'backups/before-mysql.sqlite'"
   ```

3. 空の MySQL データベースと専用ユーザーを作成します。文字セットは `utf8mb4` にします。`mysql_schema.sql` をその DB に適用します。

   ```sh
   mysql --host=HOST --user=USER --password DATABASE < mysql_schema.sql
   ```

4. `python -m pip install 'PyMySQL>=1.1,<2'` を実行します。`.env.example` の `TUNEDROP_MYSQL_*` を `.env` に追加し、パスワードを含む `.env` の権限を `600` にします。
5. まず件数を確認し、空の MySQL DB へのコピーを実行します。

   ```sh
   .venv/bin/python migrate_sqlite_to_mysql.py
   .venv/bin/python migrate_sqlite_to_mysql.py --apply
   ```

6. MySQL 側で `users`、`playlists`、`bookmarks`、`public_favorites`、`analysis_cache`、`site_settings` の件数を確認します。コピーは MySQL が空の場合だけ受け付けます。失敗時は MySQL DB を作り直してからやり直してください。
7. `./start.sh` で起動し、ログイン、プレイリスト、曲の追加、公開ページ、Radar を確認します。

MySQL 運用中の完全バックアップには `mysqldump --single-transaction` を使用してください。管理画面の SQLite ファイルバックアップは MySQL では利用できません。

切り戻す場合はプロセスを止め、`.env` の `TUNEDROP_MYSQL_HOST` を空にして SQLite バックアップを復元します。MySQL 切り替え後に作成されたデータは SQLite には自動反映されません。
