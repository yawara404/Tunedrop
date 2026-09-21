# TuneDrop：GitHub管理・Cloudflare Tunnelで自作サーバー公開

対象は現在のmacOS + MAMP構成。GitHubにはコードを保存し、PHP・Python・SQLiteは自分のサーバーで動かします。GitHub Pagesではこのアプリ全体を実行できません。

```text
ブラウザ → https://music.example.com → Cloudflare Tunnel
                                         ↓
                         MAMP Apache + PHP (127.0.0.1:8888)
                              ├ SQLite（サーバーに保存）
                              └ Python / Waitress (127.0.0.1:5001)
GitHub → サーバーでコードを取得・更新
```

`music.example.com`・GitHubの所有者名などは自分の値に置き換えてください。固定URL用にはCloudflareでDNS管理するドメインが必要です。PCを停止・スリープすると公開も止まります。

## 1. 今回追加した公開対策

- `.htaccess` は公開するHTML・JS・CSSと `api.php`・`admin.php` だけを許可します。DB、秘密鍵、Pythonソース、SQL、Markdown、バックアップ、`.git` はHTTPで取得できません。新しい画像やJSファイルを追加するときは許可リストにも追加してください。
- `router.php` はPHP開発サーバー用の同じ制限です。`./start.sh` と `./admin.sh --serve` はこのルーターを使います。`php -S ...` をルーターなしで直接起動しないでください。
- JWT署名鍵はPython起動時に `.jwt_secret` にランダム生成され、PHPも同じファイルを読みます。既知の旧鍵は拒否します。既存ユーザーは更新後に再ログインが必要です。
- Googleログインは `google-auth` で署名・宛先・発行者・有効期限を検証し、検証失敗や通信失敗をログイン拒否にします。`GOOGLE_CLIENT_ID` 未設定ならGoogleログインは利用できません。
- Pythonは `127.0.0.1` のみで待ち受けます。外からはApache経由で利用します。
- `.gitignore` はDB、鍵、環境設定、バックアップなどを除外します。YouTube／Gemini APIキーはソースから除去し、環境変数で読み込みます。
- 初回起動では空のDBを作り、デモアカウントを自動投入しません。既存DBはそのまま使います。

## 2. 既存環境をバックアップ

まずngrokなどの公開トンネルを停止してから更新します。SQLiteは稼働中のファイルを単純コピーするのではなく、バックアップ機能を使います。

```bash
cd /Users/<username>/Tunedrop
mkdir -p backups
sqlite3 database.sqlite ".backup 'backups/before-publication.sqlite'"
```

`backups/` はGitとHTTP配信の対象外です。ディスク故障に備え、別媒体にも保管してください。このバックアップにはユーザー情報が含まれます。

## 3. Pythonの準備と起動

```bash
cd /Users/<username>/Tunedrop
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

音源解析も使う場合はREADME.local.md（ローカルマニュアル）の解析用依存関係を追加してください。`requirements.txt` は認証サーバーの基本依存関係です。

`.env.example` を参考に `.env` を作成し、`chmod 600 .env` で保護します。既存の `.env` は上書きしないでください。この環境ではソース内のYouTube／Gemini APIキーを `.env` に移動済みです。

Pythonは `python-dotenv` でプロジェクト直下の `.env` を自動読み込みします。`./start.sh`、`python app.py`、解析スクリプトの直接実行でも利用できます。起動時の作業ディレクトリには依存しません。**OSやコマンドで指定した環境変数を優先**し、`.env` は未設定の値を補います。値は文字列として読み、シェルコマンドや `${VAR}` の展開は実行しません。変更後はPythonを再起動してください。

別の設定ファイルを使う場合は `TUNEDROP_ENV_FILE=/absolute/path/server.env` を起動環境に設定します。指定したファイルがない場合は環境変数と既定値のみを使います。GoogleクライアントIDを `.env` に保存すれば毎回の指定は不要です。

```bash
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python app.py
# .env の PORT よりこちらの指定が優先されます
PORT=5001 .venv/bin/python app.py
```

仕様の参考：[python-dotenv公式](https://bbc2.github.io/python-dotenv/)。

- `YOUTUBE_API_KEY`：YouTube検索用。未設定でもURL/IDによる追加は使えます。
- `GEMINI_API_KEY`：Gemini解析用。未設定時は他の利用可能な解析方式を使います。
- 元のAPIキーがソースや共有済み履歴に含まれていた場合は、Google側で旧キーを失効・再発行し、API・利用元の制限を設定して `.env` を更新します。コードから消すだけでは旧キーは失効しません。

Google Cloud Consoleでウェブアプリ用OAuthクライアントを設定します。

- `config.js` の `googleClientId` にクライアントIDを設定。
- サーバー起動時の `GOOGLE_CLIENT_ID` に同じ値を指定。クライアントIDは秘密鍵ではありません。
- 承認済みJavaScript生成元に `http://localhost:8888` と `https://music.example.com` を追加。URLのパスや末尾の `/` は含めません。

既存Pythonプロセスは元のターミナルでCtrl+Cで止め、次で起動します。

```bash
GOOGLE_CLIENT_ID='あなたのクライアントID.apps.googleusercontent.com' PORT=5001 ./start.sh --mamp
```

Googleログインを使わない場合は `PORT=5001 ./start.sh --mamp` で起動し、`config.js` の `googleClientId` を空文字にします。通常の新規登録・パスワードログインは使えます。

`.jwt_secret` は一度生成したものを再利用します。中身をGitHub、チャット、ログへ貼らないでください。MAMPのPHP実行ユーザーがこのファイルを読める必要があります。既定の権限は600です。PHPを別ユーザーで動かす構成では専用グループと640などで読取権限を付け、全員が読める権限にはしないでください。

高度な設定：`SECRET_KEY` を使う場合は32文字以上のランダム値をPHPとPythonの**両方**に設定します。ターミナルの環境変数はMAMPのPHPに自動継承されないため、通常は共有ファイル方式を使ってください。`TUNEDROP_SECRET_FILE` を使う場合も両プロセスで同じファイルパスに設定します。Pythonと `./start.sh` のPHP開発サーバーは `.env` を読み込みます。ただし `SECRET_KEY` を `.env` に設定してもMAMPには渡らないため、共有ファイル方式を推奨します。

## 4. MAMP / Apacheの設定（必須）

`/Applications/MAMP/conf/apache/httpd.conf` をバックアップして編集します。今回このマシンのMAMP設定ファイル自体は変更していません。

1. DocumentRootを `/Users/<username>/Tunedrop`、ポートを8888にする。
2. 次のモジュール行の先頭に `#` があれば外す。

```apache
LoadModule rewrite_module modules/mod_rewrite.so
```

3. プロジェクトに対応するDirectory設定を次のようにする。既存設定があればそこを編集します。

```apache
<Directory "/Users/<username>/Tunedrop">
    AllowOverride All
    Require all granted
</Directory>
```

4. `/api/` のPython転送がある場合は、固定ポート5001と揃えます。`mod_proxy`・`mod_proxy_http` も有効にします。既存の同じProxyPass設定を重複追加しないでください。

```apache
ProxyPass /api/ http://127.0.0.1:5001/
ProxyPassReverse /api/ http://127.0.0.1:5001/
```

5. Apache設定を検証し、MAMPでStop Servers → Start Servers。

```bash
/Applications/MAMP/Library/bin/httpd -t -f /Applications/MAMP/conf/apache/httpd.conf
```

`.htaccess` を無視するサーバーでは今回のアクセス制限は働きません。Nginxへ移す場合も、同等の許可リストとPHP実行設定を別途作成してください。Live Serverを外部公開してはいけません。

## 5. 公開前の確認

```bash
curl -i 'http://localhost:8888/api.php?action=health'
curl -o /dev/null -s -w '%{http_code}\n' http://localhost:8888/database.sqlite
curl -o /dev/null -s -w '%{http_code}\n' http://localhost:8888/.jwt_secret
curl -o /dev/null -s -w '%{http_code}\n' http://localhost:8888/_backup_pre_radar/api.php
curl -o /dev/null -s -w '%{http_code}\n' http://localhost:8888/app.py
```

healthは200とJSON、後の4件は403になることを確認します。**200で取得できる状態では公開しないでください。** 500ならApacheのログを確認し、特に `mod_rewrite` と `AllowOverride All` を見直します。

ブラウザでは画面表示、新規登録、通常ログイン、楽曲の保存、再読み込み後の保持、Googleログインを確認します。以前のログイン状態は旧鍵で署名されているため、ログアウトしてログインし直します。

既存DBにデモアカウントが残っている場合は、必要なデータを退避してから `./admin.sh` の管理画面で削除してください。今回の変更は既存アカウントを削除しません。管理者トークン付きURLは共有しないでください。

## 6. Cloudflare Tunnelで公開

HomebrewがあるMacでは次で導入します。

```bash
brew install cloudflared
```

1. Cloudflareへドメインを追加し、ドメイン管理会社でネームサーバーをCloudflare指定値へ変更。既存DNSレコードを確認してから切り替えます。
2. Cloudflare管理画面の **Networking → Tunnels** でトンネルを作成。
3. サーバーのOS・CPUを選び、表示されたインストール／サービス起動コマンドをそのサーバーで実行。発行されたトンネルトークンはGitHubに保存しません。
4. 接続がHealthyになったら **Routes → Add route → Published application** を追加。

| 項目 | 設定例 |
|---|---|
| 公開ホスト名 | `music.example.com` |
| Service URL | `http://localhost:8888` |

`cloudflared` とMAMPを同じマシンで動かす設定です。ブラウザ側はHTTPSになり、ローカルApacheへの接続はHTTPです。ルーターで受信ポートを開放する必要はありません。

`https://music.example.com` を開き、前節のHTTP確認も同じ公開ホスト名で繰り返します。携帯回線からログイン・保存を試します。APIや管理画面を「Cache Everything」などのルールでキャッシュしないでください。

固定ドメインを用意する前の短時間の確認には以下も使えます。ランダムなURLが表示されます。これは開発用で、常設公開には名前付きトンネルを使います。

```bash
cloudflared tunnel --url http://localhost:8888
```

一時URLでGoogleログインも試すなら、そのURLの生成元登録が別途必要です。停止はCtrl+C。ngrokから切り替えた後は不要なngrokトンネルを止めます。

## 7. GitHubでコードを管理

**初期設定は完了済みです。** Privateリポジトリ `yawora404/Tunedrop` を作成し、push済みです。
履歴は最新スナップショットの1コミットに整理済みです（変更履歴は残していません）。
コミット author は GitHubアカウント（`yawora404` + noreplyメールアドレス）で設定済みです。

- リポジトリURL: https://github.com/yawora404/Tunedrop （Private）
- DB・`.jwt_secret`・`.admin_token`・`.env`・バックアップは `.gitignore` により除外済み。
  ソース内にAPI鍵等の秘密情報が混入していないことも初回push前に確認済みです。

### 初回公開の手順（実施記録・再現用）

新規マシンや別リポジトリでやり直すとき、または公開手順を確認するときは以下の通り。
トークンは macOS キーチェーンに保存済みのもの（scope: `repo` 等）を使用しており、
`git push` は認証入力なしで通ります。トークン自体をドキュメントやログに貼らないこと。

```bash
cd /Users/<username>/Tunedrop

# 1) 秘密情報がステージングに含まれないか確認 (.env / DB / 鍵 / バックアップ)
git diff --cached --name-only | grep -iE '\.env$|sqlite|jwt_secret|admin_token|\.key$|\.pem$|\.db$|backups/' \
  || echo 'OK: 秘密ファイルなし'
git diff --cached -U0 | grep -inE 'AIza[0-9A-Za-z_-]{30,}|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{30,}' \
  || echo 'OK: 鍵パターンなし'

# 2) コミット author を GitHub アカウント + noreply メールに設定 (このリポジトリ限定)
git config user.name "yawora404"
git config user.email "283852575+yawora404@users.noreply.github.com"
git commit -m "Prepare TuneDrop for self-hosting"

# 3) GitHub に空のリポジトリを作成 (Private)
#    - ブラウザ: https://github.com/new （「Add a README」等は作成しない）
#    - 今回は GitHub API で作成: POST /user/repos {"name":"Tunedrop","private":true}

# 4) リモート登録して push
git branch -M main
git remote add origin https://github.com/yawora404/Tunedrop.git
git push -u origin main
```

- push 後は `git status --short --branch` で `## main...origin/main` となり、
  GitHub 側の branch sha とローカルの `git log --oneline -1` が一致することを確認する。
- 公開設定は後からリポジトリの Settings → Danger Zone で Private ⇄ Public を変更可能。

### 日常の更新手順（コードを変更したとき）

```bash
cd /Users/<username>/Tunedrop
git status --short            # 変更内容を確認
git add .
git commit -m "変更内容の説明"
git push                      # origin/main へ反映
```

push前に `git diff --cached --stat` でステージング内容を確認し、
`.env`・DB・鍵ファイルなどが誤って含まれていないか目視チェックしてください。

ワンコマンドで済ませる場合は `./sync.sh` を使えます
（fetch → リモート変更のrebase → コミット → push を一括実行。
コミットメッセージは `./sync.sh "変更内容の説明"` のように指定できます）。

### リポジトリの公開設定を変えたいとき

GitHubのリポジトリページ → **Settings → General → 一番下の Danger Zone →
Change repository visibility** で Private ⇄ Public を切り替えられます。
現状のコミット内容には秘密情報が含まれていないため、Public化しても安全です。

### 補足

- `git config user.name` / `user.email` はこのリポジトリ限定（`--local`）で設定済みです。
  別リポジトリで使う場合は適宜設定してください。
- push時の認証はmacOSキーチェーンに保存済みのGitHubトークン（credential helper）で自動処理されます。
- 管理画面 (`admin.php` / `admin.js` / `admin.css` / `admin.sh` / `tests/admin-*`) は
  意図的にGit管理外 (`.gitignore`) です。ローカルでのみ保持され、GitHubには公開されません。
- `.gitignore` は既に追跡済みのファイルや過去の履歴を消しません。以前秘密情報をコミットした場合は、その鍵を交換し、履歴からの削除を別途行ってください。

### 別サーバーへの展開

別サーバーでは `git clone https://github.com/yawora404/Tunedrop.git` で取得し、Python・PHP（PDO SQLite含む）・Apache・cloudflaredを用意してこの手順を繰り返します。データを移す場合はSQLiteバックアップをサーバーへ安全に転送して復元します。GitHubだけではユーザーデータは移りません。

## 8. 更新・バックアップ・常時運用

更新時はDBをバックアップし、Pythonを止めてから次を実行します。

```bash
git pull --ff-only
.venv/bin/python -m pip install -r requirements.txt
GOOGLE_CLIENT_ID='あなたのクライアントID.apps.googleusercontent.com' PORT=5001 ./start.sh --mamp
```

ローカル変更がある場合は内容を確認してコミット等で整理し、強制リセットで消さないでください。Apache設定を変更した場合はMAMPも再起動します。

定期バックアップ例：同名を上書きしないよう日時を付けます。

```bash
mkdir -p backups
sqlite3 database.sqlite ".backup 'backups/tunedrop-$(date +%Y%m%d-%H%M%S).sqlite'"
```

復元時は公開とPython・Apacheを停止し、現行DBも退避してからバックアップを `database.sqlite` として戻します。古い `-wal` / `-shm` が残る場合はDB本体とセットで退避し、古いWALを復元DBへ混在させないでください。所有者・書込権限を確認して再起動します。

常時運用には、Macのスリープを無効にし、Apache・Python・cloudflaredの3つを再起動後も起動するよう設定します。`./start.sh --mamp` はターミナルを閉じると停止するため、常駐化する場合はmacOSのlaunchd、Linuxならsystemdで管理します。Pythonは `.venv/bin/python app.py` を起動し、`.env` またはサービスの環境変数に `PORT=5001` と `GOOGLE_CLIENT_ID` を設定します。Linuxへ移す場合はMAMP用パスをその環境に置き換えてください。今回サービス登録・DNS変更・GitHub送信は自動実行していません。

## 9. 回帰テスト

実データを変更しない一時DBで実行します。PHPの場所は環境に合わせて変更します。

```bash
.venv/bin/python tests/environment-config.py
PHP_BIN=/Applications/MAMP/bin/php/php8.3.30/bin/php .venv/bin/python tests/publication-security.py
PHP_BIN=/Applications/MAMP/bin/php/php8.3.30/bin/php .venv/bin/python tests/public-files.py
```

`environment-config.py` は直接起動時の `.env` 読込・優先順位・別ファイル指定・シェル文字列を実行しないことを検証します。`publication-security.py` は共有鍵とPHP/PythonのJWT互換性・Google認証失敗時の拒否を検証します。Googleの外部検証部分はモックであり、実アカウントのログイン確認は別途必要です。`public-files.py` はローカルポートでPHPと一時Apacheを起動し、HTTP配信制限を検証します。Apacheの既定パスはMAMPです。別環境では `APACHE_BIN` とテスト内のモジュール設定を調整してください。

## 参考資料

- [Cloudflare Tunnel公式セットアップ](https://developers.cloudflare.com/tunnel/get-started/)
- [Cloudflare Tunnelの仕組み](https://developers.cloudflare.com/tunnel/)
- [Google IDトークンのサーバー検証](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [GitHub Pagesで実行できるサイト](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
