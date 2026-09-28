# Tune drop ファイル構成スリム化・集約提案

本書は、**PHP（データAPI・Web配信）とPython（認証・楽曲解析エンジン）の2系統アーキテクチャをそのまま維持**しながら、散乱しているファイル数を減らし、責務を明確にして見通しを良くするための具体的な集約方針をまとめた提案書です。

---

## 1. 現状の構成と課題

### 現状の概要
- **ルート直下の項目数**: 45項目（ファイル37件、ディレクトリ8件）
- **Pythonスクリプト**: ルート直下に8ファイル（`app.py`, `vibe_analyzer.py`, `ai_analyzer.py`, `analysis_cache.py`, `audio_download.py`, `runtime_config.py`, `reanalyze_songs.py`, `make_favicon_card.py`）
- **PHPスクリプト**: ルート直下に3ファイル（`api.php`, `ogp.php`, `router.php`）＋ `admin/admin.php`
- **テストファイル**: `tests/` 配下に28個のスクリプト（Python 21本、CJS 7本）が平置き
- **ランタイム生成・一時ファイル**: `.auth_port`, `.admin_token`, `.jwt_secret`, `.sns_demo_credentials` などの状態ファイルがルート直下に平置き
- **フロントエンド成果物**: Viteのソース（`frontend/`）とビルド成果物（ルートの `index.html` および `assets/`）が同階層に混在

### 課題
1. **小さな補助スクリプトの平置き**: 数十〜百数十行程度の単一機能スクリプトがルート直下に点在している。
2. **テストコードの断片化**: 検証項目ごとに個別ファイルが作られており、全体実行やメンテナンスのコストが高い。
3. **動的生成ファイルの散乱**: 起動時に作られるポート番号やトークンがルートに直接書き込まれている。

---

## 2. 具体的なファイル削減・集約ポイント

### ① Python側の集約（8ファイル → 2〜3ファイル）
PHPとPythonを分離したまま、Pythonスクリプトを「主要な責務」ごとに集約します。

| ファイル | 行数 | 提案 | 集約先・理由 |
| :--- | :--- | :--- | :--- |
| `analysis_cache.py` | 171行 | **統合して削除** | `vibe_analyzer.py` または `app.py` へ統合。<br>SQLite の `analysis_cache` テーブルの読み書き関数群であり、独立したモジュールにする必然性が低いため。 |
| `audio_download.py` | 142行 | **統合して削除** | `vibe_analyzer.py` へ統合。<br>`yt-dlp` の呼び出しとYouTube ID抽出（正規表現）のみを担当しており、呼び出し元は実質 `vibe_analyzer.py` のみ。 |
| `runtime_config.py` | 38行 | **統合して削除** | `app.py` へ統合。<br>`.env` の読み込みと秘密鍵生成のみ。PHP起動コマンド連携機能も `app.py` のサブコマンド（例: `python app.py run-php ...`）に内包可能。 |
| `reanalyze_songs.py` | 159行 | **サブコマンド化して削除** | `app.py` または `vibe_analyzer.py` に内包。<br>`python app.py --reanalyze` のようにCLI引数でバッチ実行できるようにすることで、ルートの単独スクリプトを削減。 |
| `make_favicon_card.py` | 70行 | **移動または削除** | アイコン画像（`frontend/favicon-card.png`）を一度生成したら頻繁には実行しないため、削除するか `scripts/` ディレクトリ等へ退避。 |

**削減効果**: ルート直下のPythonファイルが **8個から最大2〜3個**（`app.py`、`vibe_analyzer.py`、`ai_analyzer.py`）に削減されます。

---

### ② PHP側の集約（3ファイル → 1〜2ファイル）

| ファイル | 行数 | 提案 | 集約先・理由 |
| :--- | :--- | :--- | :--- |
| `ogp.php` | 187行 | **統合して削除** | `api.php` へ統合。<br>SNSクローラー向けのHTMLメタタグ出力エンドポイント。`api.php?action=ogp&playlist=...` として `api.php` の一アクションに統合し、`.htaccess` または `router.php` で内部リライトすれば、ルートの独立したPHPファイルを1つ削減可能。 |
| `router.php` | 27行 | **保持または統合検討** | 開発サーバー用ルーター。非常にコンパクト（27行）なためこのままでも良いが、`api.php` の先頭にルーター判定を組み込んで `php -S 127.0.0.1:8000 api.php` で直接起動させることも可能。 |
| `admin/admin.sh` | 227行 | **統合して削除** | `./start.sh` へ統合。<br>`./start.sh --admin` や `./start.sh admin` という引数で管理者URLのオープンやトークン発行を行えるようにすれば、シェルスクリプトのエントリポイントが1本化されます。 |

**削減効果**: ルート直下のPHPファイルが **3個から1〜2個**（`api.php` のみ、または `api.php` と `router.php`）に削減されます。

---

### ③ テストファイル群の統合（`tests/` 内の28ファイル → 4〜6ファイル）
現在 `tests/` には 28 本のスクリプトが細分化されて置かれています。機能ドメインごとにテストスイートとして束ねることで、ファイル数を大幅に削減し、一括実行（CIやローカル検証）を容易にします。

| 現在の個別テストファイル例 | 推奨する統合後ファイル | 対象・役割 |
| :--- | :--- | :--- |
| `bookmark-unique.py`<br>`playlist-order.py`<br>`system-playlist-dedupe.py`<br>`share-favorites.py`<br>`public-playlist-read.py`<br>`default-playlist-covers.py` | `tests/test_playlists.py` | プレイリスト・ブックマーク関連のDBロジック・整合性テストを一括検証 |
| `login-id.py`<br>`guest-local.py`<br>`php_auth_fixture.py`<br>`publication-security.py`<br>`environment-config.py`<br>`user-profile-api.py` | `tests/test_auth_security.py` | 認証、ゲストセッション、権限分離、設定セキュリティの検証 |
| `tempo-accuracy.py`<br>`clap-scoring.py`<br>`analysis-cache-protect.py`<br>`ogp-card.py` | `tests/test_analyzer.py` | BPM測定精度、CLAPスコアリング、キャッシュ保護のテスト |
| `api-client.cjs`<br>`api-proxy-json.py`<br>`sqlite-concurrency.py`<br>`public-files.py` | `tests/test_api_concurrency.py` | API通信仕様、JSONプロキシ、SQLiteの同時実行耐性テスト |
| `mobile-menu.cjs`<br>`mobile-menu-e2e.cjs`<br>`ui-feedback.cjs`<br>`hash-routing.cjs`<br>`icon-subset.py`<br>`admin-render.cjs` | `tests/test_frontend_e2e.cjs` | フロントエンドUI、ルーティング、メニュー操作のE2Eテスト |

**削減効果**: `tests/` ディレクトリ内のファイル数が **28個から5個前後** に削減されます。

---

### ④ フロントエンド・ソースファイルの簡素化
- **`frontend/main.js`（1KB）の統合**:
  - 現在 `main.js` は `frontend/app.js` を読み込んで `Object.assign(window, app)` を実行しているだけのラッパーです。
  - この処理を `frontend/app.js` 自体の末尾に直接記述し、Vite のビルド設定（`vite.config.mjs`）のエントリを `app.js` に変更すれば、`frontend/main.js` を1ファイル削減できます。

---

### ⑤ ドキュメント・ランタイム生成ファイル・バックアップの整理

1. **ドキュメントの整理**:
   - ルート直下の `README.local.md`（57KB、ローカル運用マニュアル）は、すでに存在する `docs/` ディレクトリに移動（例: `docs/README.local.md` または `docs/LOCAL_MANUAL.md`）することで、ルートのドキュメントを公開用の `README.md` と `SECURITY.md` のみに整頓できます。
2. **ランタイム状態ファイルの格納先隔離**:
   - 現在ルートにある `.auth_port`, `.admin_token`, `.jwt_secret`, `.sns_demo_credentials` などの生成ファイルを、単一の一時ディレクトリ（例: `.run/` または `tmp/`）にまとめて出力するようにパス定義を変更します。
   - ルート直下の隠しファイルが散乱せず、`.gitignore` にも `.run/` を1行追加するだけで済みます。
3. **過去バックアップファイルの整理**:
   - `backups/` 配下の古いDBダンプ（`before-cloudflare-*.sqlite` など）や動画ファイル（`tunedrop_sns.mp4` 3.4MB）は、Git管理外の別ストレージやアーカイブフォルダに移動することでリポジトリ容量とファイル数を削減できます。

---

## 3. 整理後の推奨ディレクトリ構造（Before / After 比較）

### 【Before】現状（ルート直下 45項目、tests 28項目）
```text
Tunedrop/
├── .admin_token
├── .auth_port
├── .env
├── .env.example
├── .gitignore
├── .htaccess
├── .jwt_secret
├── .sns_demo_credentials
├── README.local.md
├── README.md
├── SECURITY.md
├── ai_analyzer.py
├── analysis_cache.py
├── api.php
├── app.py
├── audio_download.py
├── make_favicon_card.py
├── ogp.php
├── reanalyze_songs.py
├── robots.txt
├── router.php
├── runtime_config.py
├── setup.sql
├── sitemap.xml
├── start.sh
├── sync.sh
├── vibe_analyzer.py
├── vite.config.mjs
├── package.json
├── package-lock.json
├── requirements.txt
├── database.sqlite
├── index.html (ビルド成果物)
├── assets/ (ビルド成果物)
├── admin/ (4ファイル)
├── docs/ (3ファイル)
├── frontend/ (7ファイル)
└── tests/ (28ファイル)
```

### 【After】集約後（ルート直下 約22項目、tests 5項目）
```text
Tunedrop/
├── .run/                        # ランタイム生成ファイルを集約 (.auth_port, .admin_token, .jwt_secret 等)
├── .env / .env.example
├── .gitignore / .htaccess
├── README.md / SECURITY.md
├── setup.sql
├── robots.txt / sitemap.xml
├── start.sh (admin機能も内包)
├── sync.sh
│
├── [PHP側]
│   ├── api.php                  # ogp出力機能もアクションとして内包
│   ├── router.php               # 開発用ルーター
│   └── admin/                   # 管理画面
│
├── [Python側]
│   ├── app.py                   # 認証API、秘密鍵管理、CLI再解析機能(reanalyze)を内包
│   ├── vibe_analyzer.py         # 音源取得(audio_download)、キャッシュ(analysis_cache)を内包
│   └── ai_analyzer.py           # Gemini AI推定
│
├── [Frontend & Build]
│   ├── vite.config.mjs
│   ├── package.json / package-lock.json
│   ├── index.html / assets/     # ビルド成果物 (公開配信維持)
│   └── frontend/                # main.js を app.js に統合
│
├── docs/                        # README.local.md を docs/ 配下へ集約
└── tests/                       # 28ファイルをドメイン別 4〜5 スイートに集約
```

---

## 4. 実施の推奨ステップ

安全に移行するため、以下の4段階で進めることを推奨します。

1. **Step 1: 低リスクなファイル整理（既存動作への影響ゼロ）**
   - `README.local.md` を `docs/` 配下へ移動。
   - `make_favicon_card.py` などの単発作成スクリプトの整理・退避。
   - `backups/` 配下の古いスナップショットの整理。
2. **Step 2: テストスクリプトの統合（tests/）**
   - 関連するテスト同士をまとめ、共通フィクスチャを用いてファイル数を圧縮。
3. **Step 3: Python補助モジュールの統合**
   - `audio_download.py` と `analysis_cache.py` を `vibe_analyzer.py` へ取り込み。
   - `runtime_config.py` と `reanalyze_songs.py` を `app.py` に内包。
4. **Step 4: PHP/エンドポイントの整理**
   - `ogp.php` の処理を `api.php` のアクションへ統合し、ルーティングを更新。
   - ランタイム生成ファイル群の `.run/` 等への集約。
