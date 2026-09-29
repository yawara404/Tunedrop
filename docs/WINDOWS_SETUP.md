# Windows 本サーバーへの移行手順（git clone）

Tune drop を **ネイティブ Windows**（WSL 不使用）で動かす手順です。起動処理は
Windows / macOS / Linux 共通の `start.py` にまとめてあり、Windows では `start.cmd` /
`start.ps1` が入口になります。

```
起動:   start.cmd            （cmd / ダブルクリック）
        .\start.ps1          （PowerShell）
        python start.py      （どのシェルでも）
初回:   start.cmd --setup    （.venv 作成 + pip install + .env 作成 + npm install）
```

---

## 1. 必要なソフト

| ソフト | 必須 | 用途 / 備考 |
|---|---|---|
| Git for Windows | 必須 | `git clone` |
| Python 3.10+（3.11 推奨） | 必須 | 認証・解析サーバー。インストール時に「Add python.exe to PATH」を有効化（`py` ランチャーは無くても可） |
| PHP 8.x（CLI） | 必須 | 画面と API の配信（PHP ビルトインサーバー） |
| Node.js + npm | 任意 | 画面（`frontend/`）を変更したときだけ。実行だけなら不要（ビルド成果物を同梱） |
| ffmpeg / yt-dlp | 任意 | Radar の音源解析（実測 BPM・雰囲気） |
| Ollama | 任意 | Gemini が使えないときのローカル AI フォールバック |

> 画面のビルド成果物（プロジェクト直下の `index.html` と `assets/`）はリポジトリに
> 含まれているため、**トランクを clone して起動するだけなら Node.js は不要**です。

> Python が無い場合は、winget でも入ります（PATH 追加済みで入ります）。
> ```bat
> winget install --id Python.Python.3.12 -e
> ```
> Microsoft Store 版は `python` が WindowsApps のエイリアスになり `pip` が無いことがあるため、
> 公式版（python.org / winget）を使ってください。

> **`py` コマンドが無い場合**: `py` は python.org 版の「ランチャー」で、Store 版や
> インストーラで追加しなかった場合は入りません。**無くても `python` があれば起動できます**
> （`start.cmd` / `start.ps1` は `py` → `python` の順で自動検出します）。
> `python` も無い場合は次のどちらかで入れてください:
> ```powershell
> winget install --id Python.Python.3.12 -e
> ```
> winget が使えない環境（一部の Windows Server）では
> [python.org](https://www.python.org/downloads/windows/) のインストーラを使い、
> 「Add python.exe to PATH」と（Server の場合）「Install launcher for all users」にチェックします。
> インストール後は **新しいターミナルを開いて** `python --version` / `py --version` を確認してください。

### PHP のインストール

winget を使う場合:

```powershell
winget install --id PHP.PHP.8.3 -e
php --version
```

winget が無い（一部の Windows Server など）場合は ZIP 版を使います:

1. https://windows.php.net/download/ から「VS16 x64 Thread Safe」の ZIP を取得
2. `C:\php` に展開
3. `C:\php` をシステムの PATH に追加（設定 → システム → 詳細情報 → 環境変数）
4. `C:\php\php.ini-development` を `C:\php\php.ini` にコピーして編集（下の「PHP の拡張」を参照）
5. 新しいターミナルで `php --version` / `php -m`

> 配信は PHP ビルトインサーバー（`start.py` が起動）を使うため、**Apache / IIS は不要**です。

### 音源解析ツール（任意・Radar 用）

Radar の「実測BPM・雰囲気・mood」を使う場合だけ必要です。未導入でもマップは
AI推定／ルールベースで動作します。

| ツール | インストール | 確認 |
|---|---|---|
| ffmpeg | `winget install --id Gyan.FFmpeg -e`（または `choco install ffmpeg`） | `ffmpeg -version` |
| yt-dlp | `winget install --id yt-dlp.yt-dlp -e` または `python -m pip install yt-dlp` | `yt-dlp --version` |
| librosa | `.\.venv\Scripts\python.exe -m pip install librosa soundfile` | `python -c "import librosa"` |

- `ffmpeg` / `yt-dlp` は **PATH に通して**ください（アプリは `shutil.which` で探します）。
- 高精度な mood 判定（CLAP）を使う場合は追加で（重い・任意）:

  ```powershell
  .\.venv\Scripts\python.exe -m pip install torch torchvision
  .\.venv\Scripts\python.exe -m pip install --no-deps laion-clap
  .\.venv\Scripts\python.exe -m pip install torchlibrosa transformers ftfy regex pyyaml wcwidth progressbar2 webdataset wget h5py pandas
  ```

- CLAP の重み（数百MB〜1.8GB）は初回実行時にダウンロードされます。
  `TUNEDROP_VIBE_ENGINE=librosa` にすると CLAP を使わず軽く動きます。

### PHP の拡張（`php.ini`）

`php -m` で以下が有効か確認してください。有効化は `php.ini` の
`;extension=...` のコメントを外します。

- `pdo_sqlite` / `sqlite3` … SQLite データベース（必須）
- `openssl` / `mbstring` / `curl` / `fileinfo` … 文字列・通信・OGP（推奨）

`php.ini` の場所は `php --ini` で確認できます。

---

## 2. clone して初回セットアップ

```bat
git clone <リポジトリURL> Tunedrop
cd Tunedrop
start.cmd --setup
```

PowerShell（Windows の既定ターミナル）からは、カレントのファイルには `.\` を付けます:

```powershell
git clone <リポジトリURL> Tunedrop
cd Tunedrop
.\start.cmd --setup        # または  python .\start.py --setup
```

`--setup` で行われること:

1. `.venv` を作成（なければ）
2. pip が無ければ **ensurepip で自動復旧** し、`requirements.txt` をインストール（Flask / PyJWT / numpy など）
3. `.env` が無ければ `.env.example` から作成
4. `package.json` があり npm がある場合は `npm install`

> `requirements.txt` は**コア依存のみ**です。音源解析（librosa / CLAP / torch）を使う場合は
> 追加でインストールしてください（`README.md` の「楽曲解析エンジン」を参照）。
> 実行に必須の音源取得には `ffmpeg` と `yt-dlp` を PATH に通してください。

初回のみ `.env` を開き、必要ならキーを設定します（空でも起動します）。

```dotenv
YOUTUBE_API_KEY=...      # 任意（無い場合は oEmbed/noembed にフォールバック）
GEMINI_API_KEY=...       # 任意（AI 推定。無い場合は Ollama → ルールベース）
GOOGLE_CLIENT_ID=...     # 任意（Google ログイン。frontend/config.js と一致させる）
```

---

## 3. 起動

Windows の既定ターミナルは PowerShell です。**`start.cmd` は PowerShell からもそのまま動きます**
（PowerShell ではカレントの実行ファイルに `.\` を付けます）。まずはこれが一番簡単です。

```powershell
.\start.cmd
# もしくは
python .\start.py
```

`.ps1` を使う場合（既定では実行ポリシーで止まるので注意）:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
# 毎回 Bypass を付けたくない場合はユーザー単位で緩める:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#   .\start.ps1
```

cmd（コマンドプロンプト）の場合:

```bat
start.cmd
```

- 表示された `http://localhost:8888` をブラウザで開きます。
- ポート 8888 が使用中なら 8000 / 8001 … の順に空きポートへ切り替わり、起動時に表示されます。
  固定したい場合は `TUNEDROP_PORT` を設定してください（下記「環境変数」）。
- 停止はターミナルで `Ctrl+C`。

Git Bash の場合（同梱のラッパー経由）:

```bash
./start.sh
```

### 環境変数（PowerShell / cmd）

PowerShell では `$env:名前 = '値'`、cmd では `set 名前=値` です。**そのウィンドウ限り**で有効です。

```powershell
$env:PHP_BIN = 'C:\php\php.exe'
$env:TUNEDROP_PORT = '8888'
$env:TUNEDROP_PIP_PROXY = 'http://user:pass@proxy:8080'
.\start.cmd
```

```bat
set PHP_BIN=C:\php\php.exe
set TUNEDROP_PORT=8888
start.cmd
```

環境変数を**永続化**したい場合は `setx`（cmd）または `[Environment]::SetEnvironmentVariable`（PowerShell）を使います。

```powershell
setx PHP_BIN 'C:\php\php.exe'
# または
[Environment]::SetEnvironmentVariable('PHP_BIN', 'C:\php\php.exe', 'User')
```

---

## 4. 初回起動時に自動で作られるもの

`git clone` には含まれないランタイムデータは、初回起動時に自動生成されます。
バックアップや別マシンへの引き継ぎが必要な場合だけ手動でコピーしてください。

| ファイル | 内容 | 生成タイミング |
|---|---|---|
| `database.sqlite` | ユーザー・プレイリスト・ブックマーク | 初回起動（スキーマは自動作成） |
| `.jwt_secret` | JWT 署名鍵 | 初回起動（無ければ自動生成） |
| `.env` | API キー等 | `--setup` または初回起動 |
| `.web_port` / `.auth_port` | 使用中ポートの記録 | 起動時 |
| `analysis_batch_state.json` / `analysis_recommend.json` | 解析進捗・おすすめキャッシュ | 解析実行時 |

### 手動でコピーするもの（Git 管理外）

既存環境のデータを Windows サーバーへ引き継ぐ場合、次のファイルは clone に含まれないため
**手でコピー**します（新規構築なら不要。初回起動で自動生成されます）。

| ファイル / フォルダ | 内容 | 補足 |
|---|---|---|
| `database.sqlite` | ユーザー・プレイリスト・ブックマーク・解析キャッシュ | 引き継ぐなら必須。**サーバー停止中にコピー**（`-wal` / `-shm` があれば一緒に） |
| `.env` | API キー・設定 | 引き継ぐと再設定が不要 |
| `.jwt_secret` | JWT 署名鍵 | コピーすると既存のログインセッションが維持される |
| `admin/` | 管理者ページ | 使う場合のみ（`admin.sh` / `admin.php` / `admin.js` / `admin.css`） |
| `.admin_token` | 管理者トークン | `admin/` とセットでコピー |
| `README.local.md` | 詳細マニュアル | 参照用 |
| `analysis_batch_state.json` | 全曲解析の進捗 | 途中再開したいとき |
| `analysis_recommend.json` | おすすめキャッシュ | コピーしなくても再計算される |
| `wheelhouse/` | オフライン用の pip wheel | オフライン導入する場合のみ |
| `get-pip.py` | pip 復旧用スクリプト | 置いてある場合のみ |

コピー不要（再生成される）: `.venv/`（マシン固有）、`node_modules/`、`.web_port`、`.auth_port`、`__pycache__/`。
解析キャッシュは `database.sqlite` 内のテーブルなので、DB をコピーすれば一緒に移ります。

---

## 5. 本番サーバーとして動かす場合

- **常時起動**: `start.cmd` をそのまま常駐させるか、Windows サービス化（`NSSM` 等）や
  タスクスケジューラの「スタートアップ時」に `start.cmd` を登録します。
  サービス化する場合は `start.cmd` ではなく
  `python start.py` を「作業ディレクトリ = プロジェクト」で実行してください。
- **外部公開**: Python の認証サーバーと PHP はどちらも `127.0.0.1` で待ち受けるため、
  外部へはリバースプロキシ（Cloudflare Tunnel など）経由で 8888 を公開します。
  `docs/DEPLOY_GITHUB_CLOUDFLARE.md` の手順がそのまま使えます。
- **LAN 内の別端末から**: Windows ファイアウォールで 8888 を許可します。
  ```bat
  netsh advfirewall firewall add rule name="Tunedrop 8888" dir=in action=allow protocol=TCP localport=8888
  ```
  （この場合はリバースプロキシ側の待受アドレス変更が必要です）
- **負荷対策**: PHP ビルトインサーバーのワーカー数 (`PHP_CLI_SERVER_WORKERS`) は
  POSIX 専用で Windows では無効です。アクセスが多い場合は IIS(または Apache) + PHP で
  `router.php` 相当の許可リストを `web.config`（IIS）に置く構成も検討してください。

---

## 6. トラブルシューティング

| 症状 | 対処 |
|---|---|
| `Python 3 が見つかりません` | `where.exe python` で確認。無ければ winget / python.org で導入（`py` は無くても可）。導入後は**新しいターミナル**で実行 |
| `Python依存関係が必要です` | `.\start.cmd --setup` を実行 |
| `No module named pip`（pip が無い） | `--setup` は `ensurepip` で自動復旧を試みます。直すなら `python -m ensurepip --upgrade`（`py` があれば `py -3 -m ensurepip`）。Microsoft Store 版は避け、python.org の公式版を入れてください |
| `pip install` がネット/SSL/プロキシで失敗 | 下の「プロキシ / オフライン」を参照 |
| サーバーがオフライン | 下の「プロキシ / オフライン」を参照 |
| `PHPが見つかりません` | PHP を PATH に追加。または PowerShell で `$env:PHP_BIN='C:\php\php.exe'`（cmd は `set PHP_BIN=...`）して起動 |
| `画面 (index.html) がありません` | `npm install && npm run build` を実行（Node.js が必要） |
| 画面は出るが API がエラー | `.env` と `php -m`（`pdo_sqlite`）を確認。`database.sqlite` の書き込み権限を確認 |
| Radar の解析が動かない | `ffmpeg` / `yt-dlp` を PATH に追加。`python -m pip install librosa soundfile` |
| ポートが使えない | `TUNEDROP_PORT=8010` を設定して起動 |

### pip をインストールする（`No module named pip` のとき）

`start.cmd --setup` は自動で復旧（`ensurepip` → 必要なら `get-pip.py`）を試みます。
手動でやる場合は次の順に:

```powershell
# 1) 同梱の ensurepip で導入（オフラインでも動く）
python -m ensurepip --upgrade --default-pip
python -m pip --version
```

`python` が見つからない / Microsoft Store 版のときは、先に Python 本体を入れてください
（セクション 1）。`py` があれば `python` を `py -3` に読み替えても同じです。

`ensurepip` でも入らないときは `get-pip.py` を使います:

```powershell
# ネット接続のあるPCで https://bootstrap.pypa.io/get-pip.py を保存し、
# プロジェクト直下にコピーしてから:
python get-pip.py
python -m pip --version
```

`.venv`（仮想環境）に入れる場合:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m ensurepip --upgrade --default-pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

> `pip` コマンド単体を使いたい場合は、Python の `Scripts` フォルダ
> （例 `%LOCALAPPDATA%\Programs\Python\Python312\Scripts`）を PATH に追加します。
> PATH を通さなくても **`python -m pip`** で常に使えます（こちらの方が確実です）。

### プロキシ / オフラインでの pip install

**プロキシ / SSL が原因のとき**:

```powershell
# PowerShell
$env:TUNEDROP_PIP_PROXY = 'http://user:pass@proxy:8080'
$env:TUNEDROP_PIP_EXTRA_ARGS = '--trusted-host pypi.org --trusted-host files.pythonhosted.org'
.\start.cmd --setup
```

```bat
rem cmd
set TUNEDROP_PIP_PROXY=http://user:pass@proxy:8080
set TUNEDROP_PIP_EXTRA_ARGS=--trusted-host pypi.org --trusted-host files.pythonhosted.org
start.cmd --setup
```

**完全オフラインのとき**（インターネットに接続できる別PCで wheel を用意して持ち込む）:

```bash
# ネット接続のあるPC (macOS/Linux/Windows いずれでも可)
pip download -r requirements.txt -d wheelhouse
```

`wheelhouse/` フォルダごと Windows サーバーのプロジェクト直下へコピーしてから:

```powershell
.\start.cmd --setup
```

`wheelhouse/` があれば `--setup` は自動で `--no-index --find-links wheelhouse` を使います
（`wheelhouse/` は Git 管理外です）。

| 環境変数 | 用途 |
|---|---|
| `TUNEDROP_PIP_INDEX_URL` | 社内 PyPI などの `--index-url` |
| `TUNEDROP_PIP_PROXY` | `--proxy`（例 `http://user:pass@proxy:8080`） |
| `TUNEDROP_PIP_EXTRA_ARGS` | 追加の pip 引数（`--trusted-host` など） |

> 環境変数の設定方法（PowerShell の `$env:` / cmd の `set` / 永続化）は
> セクション 3 の「環境変数」を参照してください。

---

## 7. 既存の clone を更新する

すでに clone 済みのフォルダを最新にしたい場合は、そのフォルダで `git pull` します
（**再cloneは不要**です）。

```powershell
cd C:\Users\<you>\Tunedrop
git status                     # ローカルに変更が無いか確認
git pull origin main
git log --oneline -1           # 最新コミットを確認
```

- ローカルに変更があって `git pull` が止まる場合は、退避してから取り込みます:
  ```powershell
  git stash
  git pull origin main
  git stash pop
  ```
- サーバー側では編集しておらず、**リモートの内容で上書きしてよい**場合:
  ```powershell
  git fetch origin
  git reset --hard origin/main
  ```
- `.env` / `database.sqlite` / `.venv` / `node_modules` / `analysis_*.json` などは
  Git 管理外なので、更新しても消えません（`git reset --hard` でも残ります）。
- **ZIPダウンロードで展開したフォルダは `.git` が無いため `git pull` できません**。
  その場合は `git clone` し直してください。

更新後の起動:

```powershell
.\start.cmd
```

> `start.cmd` / `start.ps1` / `start.py` が追加された版（`1c57ecf` 以降）を取り込むと、
> これらがフォルダに現れます。

