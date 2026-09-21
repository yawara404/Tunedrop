# Tune drop

> **お試し公開URL**: https://music.wawa-app.me/
> （Cloudflare Tunnelによる公開のため、サーバー停止中はアクセスできません）

YouTubeの音楽を自分好みにコレクション・整理し、みんなの公開プレイリストを発掘・共有できるセルフホスト型のWebアプリです。

> **本リポジトリについて**: 開発成果物の紹介（サイト説明・技術説明）を目的としており、オープンソースとしてのセットアップ手順の提供・再利用・再配布は想定していません。

## サイト説明（できること）

### Manager（コレクション管理）

- YouTubeのURLを貼るだけで楽曲を追加し、タイトル・チャンネル・サムネイルを自動取得
- ドラッグ＆ドロップ／スワイプでの直感的な並び替えと、カテゴリ（Vocaloid / J-POP / Anime / Lo-Fi / Other）での整理
- カバー画像（ジャケット）の自動選定、未整理・お気に入りの固定タブ管理
- インクリメンタル検索とリアルタイムのカテゴリ変更

### Radar（ディスカバリー）

- ブックマークした楽曲の「雰囲気」をAI×音源解析で2Dマップ化し、視覚的に探索
- みんなの公開プレイリストの探索・再生
- **Tune lot**: ランダム抽選で思いがけない1曲を発掘

### プレイヤー／共有

- YouTube公式埋め込みプレイヤー（IFrame Player API）による一括連続再生・サビからの再生
- キーボードショートカット対応、モバイル／デスクトップ両対応のレスポンシブUI
- プレイリストURLの一括エクスポート、Web Share APIによる共有

## 技術説明

### 全体構成

```text
ブラウザ (SPA, ビルド不要)
├─ フロントエンド: Vanilla JS (plain script) + Canvas マップ描画
├─ データ管理API: PHP + SQLite (PDO, WAL)
└─ 認証・解析サーバー: Python (Flask + Waitress) + 楽曲解析エンジン
配信: MAMP/Apache (:8888) + ngrok、または PHPビルトインサーバー (start.sh)
```

### フロントエンド

- フレームワークなしのVanilla JavaScript（classic script、ビルド・ES Modules不要）。`frontend/config.js` + `frontend/app.js` + `frontend/style.css` の3ファイルのみ
  （旧 `api-client.js` / `manager-lists.js` / `text-marquee.js` は `app.js` に統合済み、vendored Vueは削除しVue依存なし）
- API接続先の自動検出（同一originの `api.php` → `mampApiUrl` のhealthプローブ）とJWTの自動付与
- YouTube IFrame Player APIによる公式埋め込み再生（YouTube利用規約準拠）
- Google Identity ServicesによるGoogleログイン（任意）
- Inter + Material Symbols Rounded（`icon_names` サブセット約19KB）を使用
- 楽曲マップはCanvas描画で、ズーム・パン・色分け（カテゴリ別）に対応
- モダンCSS（CSS変数・`:has()`・pointer-events）によるタッチ／マウス両対応のドラッグ並び替えと、CSS変数ベースのテーマ

### データ管理API

- PHP + SQLite (PDO) によるプレイリスト・ブックマーク・公開プレイリストのCRUD
- トークンベースのセッション管理によるユーザーごとのデータ分離
- SQLiteはWALジャーナル + busy_timeoutで運用し、データAPI（PHP）と解析エンジン（Python）が
  同じDBを同時に読み書きしてもリクエストが待たされない構成（スキーマ更新は版管理で必要時のみ実行）
- 認証系はFlaskサーバーへのプロキシ（`.auth_port` → 既知ポート走査で動的検出）
- 公開ファイル制限は `.htaccess`（Apache）と `router.php`（開発サーバー）の許可リストで実施。
  FastCGI向けのAuthorizationヘッダ補正、gzip圧縮、`?v=` によるブラウザ資産のキャッシュ版管理付き

### 認証サーバー

- Python (Flask + flask-cors + PyJWT + Werkzeug + google-auth) によるメール登録・ログイン・Googleログイン検証
- Waitressで配信（未導入時はFlask開発サーバーにフォールバック）。空きポートを自動選択し `.auth_port` に記録
- パスワードはハッシュ化して保存し、署名付きJWT（24時間）でセッションを維持
- 楽曲メタデータ取得はYouTube Data API v3（任意、未設定時はoEmbed/noembedフォールバック）

### 楽曲解析エンジン（Radarの中核）

**音源の実測解析（librosa）**

- yt-dlp + ffmpeg でYouTube音源を取得し、librosaで直接解析
- HPSSで分離した**打楽器成分のオンセット**からビートトラッキングし、**実測BPM・ビート位置**を算出
- BPMは候補（半速/倍速/4倍と付点・3連=3:2）を、**オンセット包絡の自己相関**（周期の証拠）・格子が捉えたオンセット量・格子の強さ・120BPM付近を好む対数正規事前分布・**CLAPのテンポ感**で採点し、各候補の近傍を微調整して決める
  （AI推定BPMは、別のテンポ系列の候補がほぼ同点のときだけ採用。アルゴリズム版をキャッシュに記録し、版が上がった曲は再測定する）
- スペクトル重心・ロールオフ・フラットネス・ゼロ交差率・HPSS・クロマ等の解析結果から、energy / danceability / valence / acousticness / instrumentalness / speechiness / liveness の**雰囲気特徴量**と、マップ配置用の8次元特徴ベクトルを算出

**mood判定（laion-clap / CLAP、任意）**

- 音声×テキスト類似度モデル（CLAP）により、happy / sad / calm / energetic / dark / dreamy / aggressive / warm のmoodラベルを判定
- 埋め込みはサビ候補（RMS最大区間）と曲全体をカバーする10秒区間から取り、クリップ単位で確率化して平均する
  （テキスト埋め込みはプロセス内キャッシュ。確率の尖り方は `TUNEDROP_CLAP_TEMPERATURE` で調整）
- **英語プロンプトによる「テンポ感」**（slow / mid / upbeat / fast）も判定し、実測BPMの候補選びに効かせる
  （重みは `TUNEDROP_CLAP_TEMPO_WEIGHT`。ドラムが薄くビートの証拠が弱い曲で効く）
- インストゥルメンタル／ボーカル判定は、CLAPが僅差で決めた場合は上書きせずlibrosaの推定を残す。声域推定のプロンプトも内蔵
- 未導入時はlibrosaの特徴量からのフォールバック推定で動作

**AI推定（Gemini API）**

- 曲名・アーティスト名から音楽特徴量（tempo / energy / valence 等）を推定（音源ダウンロード不要。Gemini 3系は `thinkingBudget=0` でJSON取得）
- 未設定・失敗時は決定的なルールベースにフォールバック

**マップ配置（UMAP、任意）**

- 8次元特徴ベクトルをUMAPで2次元へ射影し、[0,1]に正規化してマップ描画に使用（numpy必須、UMAP任意）
- UMAP未導入・サンプル数不足時はPCA / 円配置にフォールバック

**解析キャッシュ**

- 解析結果は `analysis_cache.py` にキャッシュして再利用し、AI推定値より音源実測値（librosa / CLAP）を優先してマージ保存
- `TUNEDROP_AUDIO_ENGINE=none` で音源解析をスキップ可。全曲再解析は `reanalyze_songs.py` でバッチ実行
- 全曲解析の際は実測BPMが既にある曲の音源再取得を省略し、高速化（アルゴリズム版が古い曲は測り直す）
- ツールチップのBPM表示には、実測/推定の別に加えてオクターブ補正の有無も表示する

## 注意

- 本リポジトリはオープンソースではありません。セットアップ手順・内部運用情報は含めていません。
- 動画再生にはYouTubeの公式埋め込みプレイヤーを使用し、YouTube利用規約に準拠しています。
- 公開サーバーとして運用する場合は、十分なセキュリティ設定を行った上で自己責任でお願いします。

