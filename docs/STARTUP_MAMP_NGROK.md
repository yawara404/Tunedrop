# 💧 Tune drop 起動ガイド（MAMP + ngrok）

> **外部公開する場合:** [GitHub・Cloudflare Tunnel公開ガイド](DEPLOY_GITHUB_CLOUDFLARE.md)の初期設定を先に行ってください。Apacheの `mod_rewrite` 有効化、Python依存関係の更新、GoogleクライアントIDのサーバー設定が必要です。旧鍵のログイン情報は再ログインが必要です。

このドキュメントは、Tune drop を **MAMP（Web配信 + PHP API）** と **ngrok（HTTPS公開トンネル）** で起動し、
ローカルと外部（スマホ・別PC）の両方から使えるようにする手順をまとめたものです。

- 対象OS: macOS（検証環境: macOS + MAMP + ngrok 3.39.11）
- プロジェクト: `/Users/<username>/Tunedrop`
- 公開URL: `https://gainfully-macaroni-swivel.ngrok-free.dev/`

---

## 0. 起動する構成（全体像）

```text
[ブラウザ / スマホ]
   │ ① http://localhost:8888/                      （ローカル）
   │ ② https://gainfully-macaroni-swivel.ngrok-free.dev/  （外部公開）
   ▼
MAMP Apache (:8888, DocumentRoot = /Users/<username>/Tunedrop)
   ├── index.html / app.js / style.css / config.js ... 静的配信
   ├── api.php  … SQLite(database.sqlite) を直接読み書きするデータAPI
   │      └── 認証だけは下の Python サーバーへ HTTP 転送（プロキシ）
   └── /api/*   … ProxyPass で Python サーバーへ転送（httpd.conf 設定済み）
   ▼
Python app.py (Flask + Waitress, :5000/5050/5001… 自動選択)
   └── ログイン / 新規登録 / Google ログイン / JWT発行 / 音源・AI解析
```

| 役割 | 実体 | ポート | 起動方法 |
|---|---|---|---|
| Web配信（HTML/CSS/JS） | MAMP の Apache | `8888` | MAMP アプリで Start Servers |
| データAPI（PHP + SQLite） | `api.php`（MAMP Apache が実行） | `8888` | MAMP に含まれる |
| 認証・解析サーバー | `app.py`（Flask/Waitress） | `5000`→`5050`→`5001`… の順で空きを自動選択（`.auth_port` に記録） | `./start.sh --mamp` |
| HTTPS公開トンネル | ngrok | ローカル4040が管理画面 | `ngrok http --url=… 8888` |

> **MySQL は使いません。** データはすべてプロジェクト直下の `database.sqlite` に保存されます。

---

## 1. 前提条件の確認

```bash
cd /Users/<username>/Tunedrop

# MAMP がインストールされているか（無料版のアプリ本体は /Applications/MAMP/MAMP.app）
ls -d /Applications/MAMP/MAMP.app

# プロジェクトが MAMP の公開フォルダ（DocumentRoot）になっているか
grep -E '^DocumentRoot|^Listen' /Applications/MAMP/conf/apache/httpd.conf
#  → DocumentRoot "/Users/<username>/Tunedrop" / Listen 8888 ならOK

# Python ライブラリ（Flask / flask-cors / PyJWT / Waitress）
python3 -c 'import flask, flask_cors, jwt, waitress; print("Python依存関係 OK")'

# ngrok がインストール済みで認証トークンが設定されているか
ngrok version
ngrok config check      # → Valid configuration file ... と表示されればOK
```

不足時の導入手順:

```bash
# Python ライブラリ（プロジェクト専用 venv を作る場合）
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# ngrok（Homebrew）
brew install ngrok/ngrok/ngrok
ngrok config add-authtoken <あなたのauthtoken>
```

音源解析まで使う場合は `yt-dlp` と `ffmpeg` も必要です（`brew install yt-dlp ffmpeg`）。
ブックマーク操作・閲覧だけなら不要です。

---

## 2. 起動手順（3ステップ）

### ステップ1: MAMP を起動する（Web配信 + PHP API）

MAMP アプリを開き、**Start Servers** を押します（メニューから起動する場合）。

```bash
open -a MAMP      # MAMP が起動していない場合のみ
```

- 起動後、`http://localhost:8888/`（DocumentRoot = `Tunedrop/` 直下）で画面が開きます。
- MAMP の Apache ポートは `8888` を使用します（`/Applications/MAMP/conf/apache/httpd.conf` の `Listen 8888`）。
- Apache の MAMP 起動状態は次で確認できます。

```bash
pgrep -f 'MAMP/conf/apache/httpd.conf' && echo "Apache 起動中"
```

### ステップ2: Python 認証・解析サーバーを起動する

新しいターミナルで、`--mamp` モードで起動します（Web配信は MAMP が担当するため Python のみ起動）。

```bash
cd /Users/<username>/Tunedrop
./start.sh --mamp
```

- 表示例: `💧 Tune drop Auth (Production WSGI) running on http://localhost:5001`
- `5000` が AirPlay や他アプリで使用中でも、`5050 → 5001 …` と空きポートを自動で探して起動します。
- 使用中のポートは `.auth_port` に書き出され、`api.php` がそこへ認証リクエストを転送します。
- ログイン・新規登録・Google ログイン・全曲解析を使わない場合は省略しても閲覧はできます。
- 停止は `Ctrl + C` です。

特定ポートで固定したい場合:

```bash
PORT=5001 ./start.sh --mamp
```

### ステップ3: ngrok で HTTPS 公開する

**別のターミナル**で MAMP のポート `8888` をトンネルします。

```bash
# 予約済みの固定ドメインを使う（config.js に記載のURLと同じ）
ngrok http --url=gainfully-macaroni-swivel.ngrok-free.dev 8888

# 固定ドメインを使わず毎回ランダムURLでよい場合
ngrok http 8888
```

- 起動すると `Forwarding  https://gainfully-macaroni-swivel.ngrok-free.dev -> http://localhost:8888` と表示されます。
- 管理画面（リクエスト履歴・リプレイ）は **http://127.0.0.1:4040** です。
- ngrok 無料プランで同時に張れるトンネルは1本です。既に別のトンネルを起動している場合は停止してください。

バックグラウンドで起動してログを残す場合:

```bash
nohup ngrok http --url=gainfully-macaroni-swivel.ngrok-free.dev 8888 \
  --log=stdout > /tmp/tunedrop_ngrok.log 2>&1 &
tail -f /tmp/tunedrop_ngrok.log
```

### 起動後のアクセス先

| 用途 | URL |
|---|---|
| ローカル（MAMP直） | `http://localhost:8888/` |
| 外部公開（ngrok） | `https://gainfully-macaroni-swivel.ngrok-free.dev/` |
| 初回利用 | 新規登録（新規DBにデモアカウントは自動作成されません） |
| ngrok 管理画面 | `http://127.0.0.1:4040` |

---

## 3. 動作確認（curl で疎通チェック）

```bash
cd /Users/<username>/Tunedrop

# ① MAMP の PHP API
curl -s "http://localhost:8888/api.php?action=health"
#  → {"status":"ok","service":"TuneDrop PHP API"}

# ② Python 認証サーバー（ポートは .auth_port から自動取得）
curl -s "http://127.0.0.1:$(cat .auth_port)/health"
#  → {"service":"Tune drop Auth Server","status":"ok"}

# ③ ngrok トンネル（公開URL）
curl -s "https://gainfully-macaroni-swivel.ngrok-free.dev/api.php?action=health"

# ④ ngrok のトンネル一覧
curl -s http://127.0.0.1:4040/api/tunnels

# ⑤ 画面（index.html）が返るか
curl -s -o /dev/null -w "index:%{http_code}\n" "http://localhost:8888/"
```

ログイン → 自分のデータが見えるか（ユーザーごとのデータ分離）まで確認する場合（登録したテスト用アカウントに置換）:

```bash
TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}' \
  "http://localhost:8888/api.php?action=auth&endpoint=login" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8888/api.php?action=auth&endpoint=me"
#  → {"user":{"id":1,"username":"demo","stats":{...}}} のように demo の情報が返る
```

> ブラウザで開いたときは、ヘッダー右上のユーザー表示からログインし、リロードしてもログイン状態が維持されることを確認してください。

---

## 4. Google ログインを使う場合（OAuth 生成元の登録）

Google ログインは Google Identity Services を使うため、**ブラウザに表示されている origin を
Google Cloud Console に登録しておく必要があります**（未登録だと「no registered origin」エラーになります）。

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →「APIとサービス」→「認証情報」
2. 使用している「OAuth クライアント ID（ウェブ アプリケーション）」を開く
3. 「**承認済みの JavaScript 生成元**」に、以下のような origin を追加する（パスやスラッシュは不要）

```text
http://localhost:8888
http://127.0.0.1:8888
https://gainfully-macaroni-swivel.ngrok-free.dev
```

- `http://localhost:8888` と `http://127.0.0.1:8888`、および `https://…ngrok-free.dev` は
  それぞれ **別の origin** として扱われるため、使う環境の分だけ個別に登録してください。
- クライアントIDは `config.js` の `googleClientId` に設定済みです。
  （`AQ.` / `AIza` で始まる値は APIキーでクライアントIDではないため、そのままでは使えません）
- ログインモーダルには現在の origin が表示されるので、登録漏れの確認に使えます。

---

## 5. 停止手順

| 停止したいもの | 操作 |
|---|---|
| Python 認証・解析サーバー | 起動したターミナルで `Ctrl + C` |
| ngrok トンネル | 起動したターミナルで `Ctrl + C`（バックグラウンド起動時は下記コマンド） |
| MAMP（Apache） | MAMP アプリの **Stop Servers** |

```bash
# バックグラウンド起動した ngrok を停止
pkill -f 'ngrok http' && echo "ngrok 停止"

# 停止確認（何も表示されなければ停止済み）
pgrep -f 'ngrok http'; pgrep -f 'app.py'
```

---

## 6. トラブルシューティング

### ブラウザで公開URLを開くと「You are about to visit…」と表示される（ERR_NGROK_6024）
ngrok 無料プランの初回アクセス警告ページです。**「Visit Site」をクリック**すれば先へ進めます
（以降はクッキーでスキップされます）。アプリのAPI通信は `fetch` 経由のため、この警告の影響を受けません。

### 画面は出るが「APIに接続できません」と表示される
`api-client.js` は次の順で API を自動検出します。上から順に確認してください。

1. 現在のページと同じ場所の `api.php`
2. `config.js` の `mampApiUrl`（既定: `http://localhost:8888/api.php`）
3. `http://localhost:8888/api.php`

```bash
curl -s "http://localhost:8888/api.php?action=health"   # JSON が返るか
grep -E '^DocumentRoot|^Listen' /Applications/MAMP/conf/apache/httpd.conf
```

別ポート・別パスで MAMP を動かしている場合は `config.js` の `mampApiUrl` を合わせてください。

### 「認証サーバーに接続できません。app.py が起動しているか確認してください。」
`./start.sh --mamp` が起動していないか、`.auth_port` の記録が古い状態です。

```bash
pgrep -f 'app.py' || ./start.sh --mamp
cat .auth_port
curl -s "http://127.0.0.1:$(cat .auth_port)/health"
```

### ログインしてもゲスト扱いになる／他のユーザーのデータが見える
MAMP の Apache は PHP を FastCGI で実行するため、**本来 `Authorization` ヘッダが PHP に渡りません**。
本プロジェクトでは `.htaccess` で環境変数へコピーして解決しています（`api.php` の `auth_header_value()` が参照）。

```bash
# .htaccess の設定が効いているか（REDIRECT_HTTP_AUTHORIZATION に Bearer トークンが入る）
grep -n 'SetEnvIf' .htaccess
grep -n 'setenvif_module' /Applications/MAMP/conf/apache/httpd.conf   # LoadModule されているか
```

- `setenvif_module` がコメントアウトされている／`AllowOverride` が `None` の場合は、
  MAMP の `httpd.conf` を見直して Apache を再起動してください。
- 設定変更後は `curl` で `/api.php?action=auth&endpoint=me` が `{"user":…}` を返すことを確認します。

### Google ログインで「no registered origin」エラーになる
→ [4. Google ログインを使う場合](#4-google-ログインを使う場合oauth-生成元の登録) の origin 登録を行ってください。

### ngrok 起動時に「ERR_NGROK_108 / tunnel session limit」が出る
無料プランは同時1トンネルまでです。既存のトンネルを停止してから起動します。

```bash
pkill -f 'ngrok http'
```

### 固定ドメインのURLを変更したい
ngrok ダッシュボードで新しいドメインを予約し、`--url=` の値を差し替えます。
あわせて `config.js` のコメント、Google Cloud Console の承認済み生成元、このドキュメントの記載も更新してください。

### ポート `5000` が使えないと言われる
macOS の AirPlay などが使用中です。`app.py` は `5050 → 5001 → 5555 → 8081 → 8085` の順に自動で
空きポートを探すため通常はそのまま起動できます。固定したい場合は `PORT=5001 ./start.sh --mamp` を指定します。

### データベースを初期状態に戻したい

以下はローカル開発専用です。`setup.sql` はデモデータを含みます。公開環境ではこの手順を使わず、[公開ガイドのバックアップ・復元](DEPLOY_GITHUB_CLOUDFLARE.md#8-更新バックアップ常時運用)に従ってください。

```bash
cd /Users/<username>/Tunedrop
rm database.sqlite
sqlite3 database.sqlite < setup.sql
```

MAMP の実行ユーザーが `Tunedrop/` フォルダと `database.sqlite` に書き込める必要があります。

---

## 7. 設定ファイル早見表

| ファイル | 役割 | 変更する場面 |
|---|---|---|
| `/Applications/MAMP/conf/apache/httpd.conf` | `DocumentRoot`、`Listen 8888`、`ProxyPass /api → 127.0.0.1:5001`、`AllowOverride All` | 公開フォルダやポートを変えるとき |
| `config.js` | `mampApiUrl`（APIの場所）、`googleClientId` | APIのポート/パスを変えるとき、Google クライアントID変更時 |
| `.auth_port` | `app.py` が自動書き出しする認証サーバーの待受ポート | 手で編集しない（自動更新） |
| `.htaccess` | MAMP/FastCGI 用に `Authorization` ヘッダを PHP へ引き渡す | 通常は編集不要 |
| `start.sh` | `./start.sh`（PHPビルトイン + Python）／`./start.sh --mamp`（Pythonのみ） | 起動方法を変えるとき |
| `api.php` / `app.py` | データAPI（PHP）／認証・解析API（Python） | アプリの機能改修時 |

### 補足: この構成で行った修正（2026-09-20）

MAMP + ngrok で **ログイン状態が保持されず、常にゲストとして扱われる**問題を修正しました。

- **`.htaccess`（新規）**: `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`
  MAMP の FastCGI PHP（`php_sapi_name() = cgi-fcgi`）には `Authorization` ヘッダが届かないため、
  Apache 側で環境変数（`REDIRECT_HTTP_AUTHORIZATION`）へコピーして PHP から読めるようにしました。
- **`api.php`**: `Authorization` ヘッダ取得を `auth_header_value()` に共通化し、
  `HTTP_AUTHORIZATION` / `REDIRECT_HTTP_AUTHORIZATION` / `apache_request_headers()` の順に参照します。
  これにより、データAPI（JWT検証）と認証プロキシ（`action=auth`）の両方でユーザーが正しく識別されます。
  PHP ビルトインサーバー（`./start.sh`）・Live Server 経由の動作には影響しません。

---

## 8. ワンショット起動（コピー用）

```bash
# ① MAMP（GUI）
open -a MAMP    # 起動後「Start Servers」を押す

# ② Python 認証・解析サーバー
cd /Users/<username>/Tunedrop && ./start.sh --mamp

# ③ 別ターミナルで ngrok 公開
ngrok http --url=gainfully-macaroni-swivel.ngrok-free.dev 8888
```

ローカル: `http://localhost:8888/` ／ 公開: `https://gainfully-macaroni-swivel.ngrok-free.dev/`

