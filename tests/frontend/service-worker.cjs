const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

// frontend/public/sw.js の配信キャッシュ戦略を、Service Worker 環境の最小スタブで検証する。
//   - API / 管理画面はキャッシュせず、fetch にも触らない
//   - 画面遷移はネットワーク優先。届かないときだけキャッシュ済みの画面を返す
//   - 503 (メンテナンス画面) は差し替えずそのまま表示する
//   - ビルド済み資産はキャッシュ優先
const ROOT = path.join(__dirname, '..', '..');
const SOURCE_FILE = path.join(ROOT, 'frontend', 'public', 'sw.js');
const DIST_FILE = path.join(ROOT, 'frontend', 'dist', 'sw.js');
const source = fs.readFileSync(SOURCE_FILE, 'utf8');

execFileSync(process.execPath, ['--check', SOURCE_FILE], { stdio: 'pipe' });
assert.ok(fs.existsSync(DIST_FILE), 'frontend/dist/sw.js がありません (npm run build が必要)');
assert.equal(fs.readFileSync(DIST_FILE, 'utf8'), source, 'dist/sw.js が public/sw.js と同期していません');

const SCOPE = 'https://example.com/tunedrop/';

function loadWorker(fetchImpl, initial = {}) {
    const listeners = {};
    const store = new Map(Object.entries(initial));
    const cache = {
        match: async key => store.get(typeof key === 'string' ? key : key.url) || null,
        put: async (key, response) => { store.set(typeof key === 'string' ? key : key.url, response); },
        delete: async key => store.delete(typeof key === 'string' ? key : key.url),
        keys: async () => [...store.keys()].map(url => new Request(url)),
    };
    const context = vm.createContext({
        self: {
            registration: { scope: SCOPE },
            location: { origin: 'https://example.com' },
            clients: { claim: async () => {} },
            skipWaiting: async () => {},
            addEventListener: (type, listener) => { listeners[type] = listener; },
        },
        caches: {
            open: async () => cache,
            keys: async () => [...store.keys()],
            delete: async () => true,
        },
        fetch: fetchImpl,
        URL, Request, Response, Headers, Set, Promise, console,
    });
    vm.runInContext(source, context);
    return { listeners, store };
}

function request(url, mode = 'no-cors') {
    return { url, method: 'GET', mode, headers: new Headers() };
}

function dispatch(listeners, req) {
    let responded = null;
    listeners.fetch({ request: req, respondWith: value => { responded = value; } });
    return responded;
}

(async () => {
    // 1) API は Service Worker が触らない (キャッシュも fetch もしない)
    {
        let fetched = 0;
        const { listeners } = loadWorker(async () => { fetched += 1; throw new Error('APIを取得してはいけない'); });
        for (const url of [`${SCOPE}api.php?action=health`, `${SCOPE}ogp.php`, `${SCOPE}admin/admin.php`]) {
            const responded = dispatch(listeners, request(url));
            assert.equal(responded, null, `${url} を横取りしている`);
        }
        assert.equal(fetched, 0);
    }

    // 2) サーバーが落ちている (fetch 失敗) → キャッシュ済みの画面を返す
    {
        const shell = new Response('<!doctype html><title>cached</title>',
            { status: 200, headers: { 'content-type': 'text/html' } });
        const { listeners } = loadWorker(async () => { throw new TypeError('Failed to fetch'); }, { [SCOPE]: shell });
        const responded = dispatch(listeners, request(`${SCOPE}radar`, 'navigate'));
        assert.ok(responded, 'キャッシュから返していない');
        assert.equal(await (await responded).text(), '<!doctype html><title>cached</title>');
    }

    // 3) 502/521 など「届いていない」応答もキャッシュ画面へ切り替える
    {
        const shell = new Response('cached', { status: 200 });
        const { listeners } = loadWorker(async () => new Response('bad gateway', { status: 502 }), { [SCOPE]: shell });
        const responded = await dispatch(listeners, request(SCOPE, 'navigate'));
        assert.equal(await responded.text(), 'cached');
    }

    // 4) 503 (メンテナンス) はそのまま表示する (キャッシュで隠さない)
    {
        const shell = new Response('cached', { status: 200 });
        const { listeners } = loadWorker(
            async () => new Response('maintenance', { status: 503 }),
            { [SCOPE]: shell },
        );
        const responded = await dispatch(listeners, request(SCOPE, 'navigate'));
        assert.equal(responded.status, 503);
        assert.equal(await responded.text(), 'maintenance');
    }

    // 5) 資産 (/assets/<hash>.js) はキャッシュ優先 (2回目はネットワークへ行かない)
    {
        let fetched = 0;
        const { listeners, store } = loadWorker(async () => {
            fetched += 1;
            return new Response('asset', { status: 200 });
        });
        const asset = `${SCOPE}assets/index-abc123.js`;
        const first = await dispatch(listeners, request(asset));
        assert.equal(await first.text(), 'asset');
        const second = await dispatch(listeners, request(asset));
        assert.equal(await second.text(), 'asset');
        assert.equal(fetched, 1, '2回目はキャッシュから返す');
        assert.ok(store.has(asset), '資産がキャッシュされていない');
    }

    // 6) メンテナンスページを開いてもアプリ本体のキャッシュを上書きしない
    {
        const shell = new Response('<!doctype html><title>app</title>',
            { status: 200, headers: { 'content-type': 'text/html' } });
        const { listeners, store } = loadWorker(async () => new Response(
            '<!doctype html><title>maintenance</title>',
            { status: 200, headers: { 'content-type': 'text/html' } },
        ), { [SCOPE]: shell });
        await dispatch(listeners, request(`${SCOPE}maintenance.html`, 'navigate'));
        assert.equal(await store.get(SCOPE).text(), '<!doctype html><title>app</title>');
    }

    console.log('PASS: service worker caches the app shell only, falls back when the server is down, '
        + 'and never caches the API.');
})().catch(error => { console.error(error); process.exitCode = 1; });
