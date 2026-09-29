# Tune drop

> **お試し公開URL**: https://music.wawa-app.me/tunedrop/
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
- 公開リストの共有URLはOGP/Twitterカード対応（サムネイル付きプレビュー）

## 技術説明

### 全体構成

```text
ブラウザ (SPA)
├─ フロントエンド: Vanilla JS (Vite でビルドした ES Modules) + Canvas マップ描画
├─ データ管理API: PHP + SQLite (PDO, WAL)
└─ 認証・解析サーバー: Python (Flask + Waitress) + 楽曲解析エンジン
配信: PHPビルトインサーバー (./start.sh :8888) + Cloudflare Tunnel。開発は Vite開発サーバー (npm run dev :5173、APIはstart.shへプロキシ)
ビルド: Vite (ソースは frontend/、成果物はプロジェクト直下の index.html + assets/)
```

### フロントエンド

- フレームワークなしのVanilla JavaScript。ソースは `frontend/main.js`（エントリ）+ `frontend/config.js` + `frontend/app.js` + `frontend/style.css`
  （旧 `api-client.js` / `manager-lists.js` / `text-marquee.js` は `app.js` に統合済み、vendored Vueは削除しVue依存なし）
- Vite でビルドし、成果物はプロジェクト直下の `index.html` と `assets/`（内容ハッシュ付きファイル名）。
  テンプレートは `frontend/index.html`。`./start.sh` と `./sync.sh` はビルド元が新しいとき `npm run build` を自動実行する
- `app.js` のトップレベル関数は `main.js` の `Object.assign(window, app)` で window に公開し、
  マークアップの `onclick="..."` と外部スクリプト（YouTube IFrame API / Google Identity Services）のコールバックから呼べる
- API接続先の自動検出（同一originの `api.php` → `fallbackApiUrl` のhealthプローブ）とJWTの自動付与
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
  FastCGI向けのAuthorizationヘッダ補正、gzip圧縮、キャッシュ制御付き。配信するのは画面の
  ビルド成果物（`index.html` と `assets/` のハッシュ付き資産）とOGPカード画像（`frontend/favicon-card.png`）だけで、
  ビルド元の `frontend/*.js`・`*.css` や `node_modules` は配信しない
  （`assets/` はファイル名に内容のハッシュが入るため長期キャッシュ、`index.html` は毎回検証）

### 認証サーバー

- Python (Flask + flask-cors + PyJWT + Werkzeug + google-auth) によるメール登録・ログイン・Googleログイン検証
- ログインIDは登録時に入力した値（メールアドレスなど）で、プロフィールで変更できる「表示名」とは別。プロフィール画面にログインIDを表示して取り違えを防ぐ
- ゲストは Flask が端末ごとに SQLite のユーザーを作成し、ブラウザの `localStorage` に保存した認証情報で再訪時に復元する。ゲストのプレイリストや曲も端末ごとに分離される。ブラウザの保存情報を消すと以前のゲストデータにはアクセスできない
- Waitressで配信（未導入時はFlask開発サーバーにフォールバック）。空きポートを自動選択し `.auth_port` に記録
- パスワードはハッシュ化して保存し、署名付きJWT（24時間）でセッションを維持
- 楽曲メタデータ取得はYouTube Data API v3（任意、未設定時はoEmbed/noembedフォールバック）

### 楽曲解析エンジン（Radarの中核）

**音源の実測解析（librosa）**

- yt-dlp + ffmpeg でYouTube音源を取得し、librosaで直接解析
- ブックマーク登録時はAI推定を即時反映しつつ、**バックグラウンドで音源解析を自動実行**して実測BPM・雰囲気で上書きする（1曲ずつ順に処理）
- HPSSで分離した打楽器成分と楽曲全体の両方から独立にテンポ候補を取り、証拠を統合して**実測BPM・ビート位置**を算出
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

**AI推定（Gemini / Ollama）**

- 曲名・アーティスト名から音楽特徴量（tempo / energy / valence 等）とジャンルを推定（音源ダウンロード不要。Gemini 3系は `thinkingBudget=0` でJSON取得）
- Gemini が未設定・失敗時（課金切れの HTTP 402 など）は **ローカルの Ollama にフォールバック**（既定モデル `qwen3:8b`。`TUNEDROP_AI_ENGINE=auto|gemini|ollama|rules` で固定できる）
- どちらも不可のときは決定的なルールベースにフォールバックする（`engine: rules`）
- 推定したジャンルは `ai_category` として保存する
- Vocaloid は実際に合成音声が歌っている場合に限定し、LLM に歌唱主体（人声/合成音声）を個別判定させる
- 表示ジャンル（カテゴリ）の決め方:
  1. 曲名/アーティストにボカロ歌手名（初音ミク, 可不, 歌愛ユキ 等）がある → **Vocaloid**（解析前でも即時反映）
  2. LLM が曲ごとに判定したジャンル（`ai_category`）。人声と判定された曲を Vocaloid と回答した場合は **J-POP** に補正
  3. それ以外（未解析）は **Other**
  プレイリストのカテゴリは表示には使わない（複数ジャンルを混ぜたリストで実態と合わないため）
- 「⟳ 全曲解析」は **Gemini のAI推定値を保護**し、未解析/旧版の音源特徴だけを更新する。AI自体をやり直す曲は管理者ページの「解析キャッシュ」で削除してから実行する（「Geminiのみ」で絞り込める）

**マップ配置（UMAP、任意）**

- 8次元特徴ベクトルをUMAPで2次元へ射影し、[0,1]に正規化してマップ描画に使用（numpy必須、UMAP任意）
- UMAP未導入・サンプル数不足時はPCA / 円配置にフォールバック

**おすすめ順（Ollama による自動推薦）**

- Radar の「おすすめ順」は、Ollama が好みプロファイル（ジャンル/ムード分布・テンポ・エネルギー概況）を解釈して「優先するジャンル/ムード/テンポ」のレシピを出し、お気に入り・発掘（少数派ジャンル/ムード）・好み一致・新着をスコア化して曲を並べる（新着は弱いタイブレークのみ）
- おすすめ結果は **12時間ごとに再計算**し、`analysis_recommend.json` に永続化して再起動後も即返す（ブックマーク/解析結果が変われば即再計算）。画面遷移のたびに Ollama を呼ばないため切り替えが速い（`TUNEDROP_RECOMMEND_CACHE_TTL` で間隔変更）
- Ollama が使えない場合は分布上位を既定の好みとして決定的スコアで並べる（`/radar/recommend`）

**解析キャッシュ**

- 解析結果は `analysis_cache.py` にキャッシュして再利用し、AI推定値より音源実測値（librosa / CLAP）を優先してマージ保存
- `TUNEDROP_AUDIO_ENGINE=none` で音源解析をスキップ可。全曲再解析は `reanalyze_songs.py` でバッチ実行
- 全曲解析の際は実測BPMが既にある曲の音源再取得を省略し、高速化（アルゴリズム版が古い曲は測り直す）
- 全曲解析は**途中保存**される。1曲ごとに結果を `analysis_cache` へ、進捗を `analysis_batch_state.json` へ逐次保存するため、サーバ再起動や中断で完了済みの曲は失われず、再実行すると未解析の残りだけを続行する（`/radar/analyze_all?resume=1` で前回の残キューを優先、`reset=1` で最初から）
- ツールチップのBPM表示には、実測/推定の別に加えてオクターブ補正の有無も表示する

**負荷対策**

- 音源解析（librosa / CLAP・torch）は `TUNEDROP_CPU_THREADS`（既定: コア数の半分、`all` で無制限）でスレッド数を制限し、解析バッチは `TUNEDROP_ANALYZE_THROTTLE`（既定 0.5秒）で曲間に待ちを入れてマシンを占有し続けないようにする
- `/radar/map` の応答はキャッシュ（`TUNEDROP_MAP_CACHE_TTL`、既定60秒。ブックマークや解析結果が変われば即座に作り直す）
- UMAP の計算はロックで直列化する（numba の workqueue スレッド層はスレッドセーフではなく、同時実行でプロセスごと落ちるため）

## 注意

- 本リポジトリはオープンソースではありません。セットアップ手順・内部運用情報は含めていません。
- 動画再生にはYouTubeの公式埋め込みプレイヤーを使用し、YouTube利用規約に準拠しています。
- 公開サーバーとして運用する場合は、十分なセキュリティ設定を行った上で自己責任でお願いします。
