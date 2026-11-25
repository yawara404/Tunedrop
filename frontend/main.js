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
import './mobile.css';

// app.js は元々 classic script で、トップレベル関数がそのまま window に載っていた。
// ES モジュールではモジュールスコープに入ってしまうため、以下の呼び出し元から
// 名前で呼べるように、ここで明示的に window へ載せる。
//   - frontend/index.html の onclick="..." など
//   - app.js が生成する HTML に埋め込む onclick="..." (曲の並び替え・モーダル等)
//   - 外部スクリプトのコールバック (YouTube IFrame API / Google Identity Services)
// Object.assign なので、app.js で新しい関数を宣言すれば自動で window に載る
// (個別の window.foo = foo を書き足す必要はない)。
Object.assign(window, app);

// ルーティング関数は popstate やデバッグから直接呼ぶため、名前空間オブジェクトから
// 明示的に載せる (バンドラの tree-shaking で Object.assign の対象から外れるのを防ぐ)。
window.applyPathView = app.applyPathView;
window.parseLocationPath = app.parseLocationPath;
window.migrateLegacyHash = app.migrateLegacyHash;
window.applyHashView = app.applyHashView;

// ==========================================================
// Service Worker (鯖落ち時も画面の外枠を表示する)
// ----------------------------------------------------------
// frontend/public/sw.js は Vite が dist/sw.js (= /sw.js) へコピーする。
// 画面遷移はネットワーク優先で、サーバーに届かないときだけキャッシュ済みの
// アプリシェルを返す。API は一切キャッシュしない。
//
// import.meta.url はバンドル後の /assets/index-<hash>.js を指すため、
// その1つ上 (公開ルート) が sw.js になる (/tunedrop/ 配下でも同じ)。
// 開発サーバー (npm run dev) では HMR と衝突するので登録しない。
// ==========================================================
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
        // ビルド時に解決させない (実行時のURLとして扱う)。
        const swUrl = new URL(/* @vite-ignore */ '../sw.js', import.meta.url);
        navigator.serviceWorker.register(swUrl).catch(() => {
            // 登録できなくてもアプリは通常どおり動く (オフライン時の画面だけが失われる)
        });
    });
}
