import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// OGPカード画像 (frontend/favicon-card.png = ファビコンと同じ意匠の512x512) の ?v= を、
// ファイル内容のハッシュ (sha256 の先頭10文字) に揃えるプラグイン。
//
// なぜ必要か:
//   この画像は <meta property="og:image"> に絶対URLで書くため、Vite の
//   ハッシュ付き出力 (assets/*) にできない (frontend/ から直接配信している)。
//   URL が固定だと、画像を差し替えても前段の Cloudflare (7日キャッシュ) と
//   SNS 側のキャッシュに古い画像が残る。中身のハッシュを ?v= に入れておけば、
//   差し替えたときに URL が変わるので必ず新しい画像が使われる。
//   (以前は独立したスクリプト (bump_assets.sh) が同じことをしていたが、CSS/JS は
//    Vite のファイル名ハッシュへ移行したため、このプラグインへ統合してスクリプトは削除した)
function faviconCardVersion() {
    const image = resolve(import.meta.dirname, 'frontend/favicon-card.png');
    return {
        name: 'tunedrop-favicon-card-version',
        transformIndexHtml(html) {
            const hash = createHash('sha256').update(readFileSync(image)).digest('hex').slice(0, 10);
            return html.replace(/favicon-card\.png\?v=[0-9a-z]*/g, `favicon-card.png?v=${hash}`);
        },
    };
}

// Tune drop のフロントエンドビルド設定。
//
// 構成の考え方 (なぜ root を frontend/ にして outDir を .. にするのか):
//   - サーバー側 (PHP: api.php / ogp.php / router.php / .htaccess、SQLite、Python) は
//     プロジェクト直下を docroot として動く。MAMP の /tunedrop/ エイリアスと
//     ./start.sh の PHP ビルドインサーバー (-t プロジェクト直下) がそうなっている。
//   - そのためビルド成果物 (index.html と assets/) もプロジェクト直下に置く必要がある。
//   - 一方で、テンプレートの index.html をプロジェクト直下に置くと、ビルド出力が
//     テンプレート自身を上書きしてしまい、2回目のビルドで壊れる。
//   - そこで「ブラウザ側のソースは frontend/」（既存の構成のまま）とし、Vite の root を
//     frontend/、出力先をその親 (プロジェクト直下) にする。テンプレートは
//     frontend/index.html、エントリは frontend/main.js。
//   - base: './' は、ルート直下で配信される場合 (./start.sh の PHP サーバー) と
//     /tunedrop/ 配下で配信される場合 (MAMP + Cloudflare Tunnel) の両方で
//     同じ index.html が動くようにするため (絶対パスだと片方で壊れる)。
export default defineConfig({
    root: 'frontend',
    base: './',
    plugins: [faviconCardVersion()],
    build: {
        outDir: '..',
        // outDir はプロジェクト直下 (PHP・DB・テストと同じ場所) なので、
        // ビルド時にフォルダを空にしない。古いハッシュ資産の削除は
        // package.json の build スクリプト (rm -rf assets) が行う。
        //
        // ★ emptyOutDir を true にしてはいけない ★
        // Vite は「outDir が root の親ディレクトリ」の場合に警告を出す
        // (build.outDir must not be the same directory of root or a parent directory of root)。
        // この構成では意図的に親 (= プロジェクト直下) へ出しているため警告は想定内で、
        // 書き出されるのは index.html と assets/ だけで、ソース (frontend/) には触れない。
        // ただし emptyOutDir を有効にすると outDir 全体 (= プロジェクト直下) を
        // 消してしまうので、必ず false のままにすること。
        emptyOutDir: false,
        assetsDir: 'assets',
    },
});
