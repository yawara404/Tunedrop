// ==========================================================
// Tune drop フロントエンドのエントリ (Vite)
// ----------------------------------------------------------
// frontend/index.html はこのファイルだけを読み込み、config.js / app.js /
// style.css はここから取り込む (index.html に個別の <script> / <link> は書かない)。
// ビルド成果物はプロジェクト直下の index.html + assets/ (PHP と同じ docroot)。
//
// config.js は window.TUNEDROP_CONFIG を作るのが目的なので、名前を付けずに
// 副作用として読み込む。export して値として受け取る形にすると、使われていない
// とみなされて tree-shake され、googleClientId (GoogleログインのクライアントID) が
// バンドルから消える。
import './config.js';
import * as app from './app.js';
import './style.css';

// app.js は元々 classic script で、トップレベル関数がそのまま window に載っていた。
// ES モジュールではモジュールスコープに入ってしまうため、以下の呼び出し元から
// 名前で呼べるように、ここで明示的に window へ載せる。
//   - frontend/index.html の onclick="..." など
//   - app.js が生成する HTML に埋め込む onclick="..." (曲の並び替え・モーダル等)
//   - 外部スクリプトのコールバック (YouTube IFrame API / Google Identity Services)
// Object.assign なので、app.js で新しい関数を宣言すれば自動で window に載る
// (個別の window.foo = foo を書き足す必要はない)。
Object.assign(window, app);
