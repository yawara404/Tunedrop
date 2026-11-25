/* Tune drop のサービスワーカー。
 *
 * 目的: サーバー (PHP / トンネル) が落ちている間でも、画面の外枠だけは
 * キャッシュから開けるようにする。画面が開けば app.js の再接続バナーが
 * 自動で health を確認し、復旧したら元の画面に戻る (midair 方式の「落ちても
 * 真っ白にならない」対策)。
 *
 * 方針:
 *   - API (api.php / ogp.php) と管理画面は絶対にキャッシュしない
 *     (古いデータや認証情報を返さない)。
 *   - 画面遷移 (navigation) はネットワーク優先。失敗時、または 502/504 など
 *     「サーバーに届いていない」ステータスのときだけキャッシュ済みの
 *     index.html を返す。503 のメンテナンス画面はそのまま表示する。
 *   - ビルド済み資産 (/assets/<hash>.js など) はファイル名が内容のハッシュなので
 *     キャッシュ優先 (オフラインでも画面が組み立てられる)。
 *
 * 更新: このファイルを変更したら VERSION を上げる (古いキャッシュを activate で削除)。
 */
const VERSION = 'tunedrop-v1';
const SHELL_CACHE = VERSION + '-shell';
const ASSET_CACHE = VERSION + '-assets';
const MAX_ASSETS = 80;

const SHELL_URL = new URL('./', self.registration.scope);
const SHELL_KEY = SHELL_URL.href;
const INDEX_KEY = new URL('index.html', SHELL_URL).href;

// これらは「アプリまで届いていない」状態。キャッシュ済みの画面に切り替える。
// (Cloudflare: 521=Origin Down, 522=Timeout, 523=Unreachable, 524=Timeout)
const OFFLINE_STATUSES = new Set([502, 504, 521, 522, 523, 524]);
// キャッシュしてはいけないパス (API / OGP / 管理画面)
const UNCACHEABLE = /\/(?:api\.php|ogp\.php|admin)(?:\/|$)/i;
// 画面が参照する資産 (index.html から取り出して install 時に先読みする)
const ASSET_REFERENCE = /(?:\.\/)?(?:assets\/[A-Za-z0-9_.-]+\.(?:js|css|svg|png|jpe?g|webp|gif|ico|woff2?)|favicon[^"'\s>]*)/g;
const ASSET_PATH = /\/assets\/[A-Za-z0-9_-]+\.(?:js|css|svg|png|jpe?g|webp|gif|ico|woff2?)$/;

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        try {
            const response = await fetch(SHELL_URL.href, { cache: 'reload' });
            if (response.ok) {
                const html = await response.clone().text();
                const cache = await caches.open(SHELL_CACHE);
                await cache.put(SHELL_KEY, response.clone());
                await cache.put(INDEX_KEY, response);
                await precacheAssets(html);
            }
        } catch (_) {
            // オフラインでインストールされた場合は、次にオンラインで開いたときに
            // navigation の応答がキャッシュされる。
        }
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
        const names = await caches.keys();
        await Promise.all(names.filter(name => !keep.has(name)).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET' || request.headers.has('range')) return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (UNCACHEABLE.test(url.pathname)) return;
    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
        return;
    }
    if (ASSET_PATH.test(url.pathname)) {
        event.respondWith(cacheFirst(request));
    }
});

/** 画面遷移: ネットワーク優先。届かないときだけキャッシュ済みの画面を返す。 */
async function handleNavigation(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            // maintenance.html を開いたときにアプリ本体としてキャッシュしない
            // (次に落ちたとき、メンテナンス画面が出てしまう)。
            const html = (response.headers.get('content-type') || '').includes('text/html');
            const maintenance = /\/maintenance\.html$/i.test(new URL(request.url).pathname);
            if (html && !maintenance) {
                const cache = await caches.open(SHELL_CACHE);
                await cache.put(SHELL_KEY, response.clone());
            }
            return response;
        }
        if (OFFLINE_STATUSES.has(response.status)) {
            return (await cachedShell()) || response;
        }
        return response;
    } catch (error) {
        const cached = await cachedShell();
        if (cached) return cached;
        throw error;
    }
}

async function cachedShell() {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match(SHELL_KEY)) || (await cache.match(INDEX_KEY)) || null;
}

/** 資産: キャッシュ優先 (内容ハッシュ付きのファイル名なので安全)。 */
async function cacheFirst(request) {
    const cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.status === 200) {
        await cache.put(request, response.clone());
        await trimAssets(cache);
    }
    return response;
}

async function precacheAssets(html) {
    const urls = new Set();
    for (const match of String(html).matchAll(ASSET_REFERENCE)) {
        urls.add(new URL(match[0].replace(/^\.\//, ''), SHELL_URL).href);
    }
    if (!urls.size) return;
    const cache = await caches.open(ASSET_CACHE);
    await Promise.all([...urls].map(async url => {
        if (await cache.match(url)) return;
        try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok && response.status === 200) await cache.put(url, response);
        } catch (_) {
            // 1つ失敗しても画面の骨格は表示できる (その資産は次回のオンライン時にキャッシュ)
        }
    }));
    await trimAssets(cache);
}

/** 古いハッシュの資産が溜まり続けないよう、古い順に削除する。 */
async function trimAssets(cache) {
    const keys = await cache.keys();
    if (keys.length <= MAX_ASSETS) return;
    for (const key of keys.slice(0, keys.length - MAX_ASSETS)) {
        await cache.delete(key);
    }
}
