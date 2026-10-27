import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// OGPカード画像 (favicon-card.png = ファビコンと同じ意匠の512x512) の ?v= を、
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
    const image = resolve(import.meta.dirname, 'favicon-card.png');
    return {
        name: 'tunedrop-favicon-card-version',
        transformIndexHtml(html) {
            const hash = createHash('sha256').update(readFileSync(image)).digest('hex').slice(0, 10);
            return html.replace(/favicon-card\.png\?v=[0-9a-z]*/g, `favicon-card.png?v=${hash}`);
        },
    };
}

// 開発サーバー (npm run dev) のプロキシ先を決める。
// backend/start.sh が実際に使ったポートをプロジェクト直下の .web_port に書くので、
// それを読む (決め打ちをやめ、空きポートへ自動でずれても追従できる)。
// 直接指定したいときは TUNEDROP_DEV_API=http://127.0.0.1:8001 のように上書きする。
function devApiTarget() {
    const override = (process.env.TUNEDROP_DEV_API || '').trim();
    if (override) return override.replace(/\/+$/, '');
    try {
        const port = readFileSync(resolve(import.meta.dirname, '..', '.web_port'), 'utf8').trim();
        if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
    } catch (_) {
        // start.sh 未起動 (.web_port が無い) ときは既定ポートへ
    }
    return 'http://127.0.0.1:8888';
}

// Tune drop のフロントエンドビルド設定。
//
// 構成 (backend/ と frontend/ の分離):
//   - 画面のソースはこのファイルと同じ frontend/ 直下、
//     ビルド成果物は frontend/dist/ (index.html + assets/)。
//   - 配信は backend/router.php が行い、公開URLは変えない:
//       /                    → frontend/dist/index.html
//       /assets/<hash>.<ext> → frontend/dist/assets/<hash>.<ext>
//   - base: './' は、ルート直下で配信される場合 (backend/start.sh の PHP サーバー) と
//     /tunedrop/ 配下で配信される場合 (Cloudflare Tunnel) の両方で
//     同じ index.html が動くようにするため (絶対パスだと片方で壊れる)。
const frontendDir = import.meta.dirname;

export default defineConfig({
    root: frontendDir,
    base: './',
    plugins: [faviconCardVersion()],
    // 開発用 (npm run dev): 画面は Vite が HMR 付きで配信し、PHP 側 (API / OGP /
    // 管理画面) は backend/start.sh のPHPビルトインサーバーへプロキシする。
    // これで `./backend/start.sh` + `npm run dev` の2つだけで開発できる。
    server: {
        port: 5173,
        proxy: {
            '/api.php': devApiTarget(),
            '/ogp.php': devApiTarget(),
            '/admin': devApiTarget(),
        },
    },
    build: {
        // dist/ はビルド成果物だけが入る場所なので、毎回空にしてから出力する
        // (古いハッシュの assets が残らない = 古い HTML を配っても壊れない)。
        outDir: resolve(frontendDir, 'dist'),
        emptyOutDir: true,
        assetsDir: 'assets',
    },
});
