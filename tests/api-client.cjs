const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// api-client は frontend/app.js 先頭に統合済み。統合部分だけ切り出して検証する。
// app.js は Vite が読む ES モジュール (export 付き) なので、vm で classic script として
// 評価するために export だけ外す (中身は同じ)。
const bundled = fs.readFileSync(`${__dirname}/../frontend/app.js`, 'utf8').replace(/^export /gm, '');
const apiStart = bundled.indexOf('// ===== api-client');
const appStart = bundled.indexOf('let player;');
const source = bundled.slice(apiStart, appStart);

// 接続先候補とその応答を模した実行環境を作る (scenario と異常系テストで共用)。
function makeContext(page, replies, options = {}) {
    const calls = [];
    const saved = new Map();
    const context = vm.createContext({
        window: { location: { href: page }, TUNEDROP_CONFIG: options },
        URL, Headers, AbortController, setTimeout, clearTimeout,
        localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
        fetch: async (url, init) => {
            calls.push({ url: url.href, init });
            const reply = replies[url.href];
            if (!reply) throw new Error(`Unexpected request: ${url}`);
            return { ok: true, headers: { get: () => reply.type || 'application/json' }, json: async () => reply.data };
        }
    });
    vm.runInContext(source, context);
    return { calls, saved, context, replies };
}

async function scenario(page, replies, expected, options = {}) {
    const { calls, saved, context } = makeContext(page, replies, options);
    const guestUrl = new URL(expected);
    guestUrl.search = '?action=auth&endpoint=guest';
    replies[guestUrl.href] = { data: { success: true, credential: '1.secret', token: 'guest-jwt' } };
    const result = await vm.runInContext("tunedropFetch('api.php?action=create_playlist', { method: 'POST', body: '{}'})", context);
    assert.equal(calls.at(-1).url, expected);
    assert.equal(calls.at(-1).init.method, 'POST');
    assert.deepEqual(await result.json(), { success: true });
    assert.equal(calls.at(-1).init.headers.get('Authorization'), 'Bearer guest-jwt');
    assert.equal(saved.get('tunedrop_guest_credential'), '1.secret');
    const healthCount = calls.filter(call => call.url.includes('action=health')).length;
    await vm.runInContext("tunedropFetch('api.php?action=create_playlist')", context);
    assert.equal(calls.filter(call => call.url.includes('action=health')).length, healthCount);
    assert.equal(calls.filter(call => call.url.includes('endpoint=guest')).length, 1);
}
const health = { data: { status: 'ok', service: 'TuneDrop PHP API', features: ['auth_proxy', 'auth_guest'] } };
// 別フォルダ (旧DocumentRoot) に残った古い api.php の応答。health には応答するが features が無い。
const staleHealth = { data: { status: 'ok', service: 'TuneDrop PHP API' } };
(async () => {
    await scenario('http://localhost:8888/tunedrop/index.html', {
        'http://localhost:8888/tunedrop/api.php?action=health': health,
        'http://localhost:8888/tunedrop/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://localhost:8888/tunedrop/api.php?action=create_playlist');
    await scenario('http://127.0.0.1:5503/index.html', {
        'http://127.0.0.1:5503/api.php?action=health': { type: 'text/plain', data: '<?php' },
        'http://localhost:8888/tunedrop/api.php?action=health': health,
        'http://localhost:8888/tunedrop/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://localhost:8888/tunedrop/api.php?action=create_playlist');
    await scenario('http://localhost:5503/index.html', {
        'http://localhost:9999/custom/api.php?action=health': health,
        'http://localhost:9999/custom/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://localhost:9999/custom/api.php?action=create_playlist', { apiUrl: 'http://localhost:9999/custom/api.php' });
    // 古い api.php しか無い場合は接続先に採用せず、対処法の分かるエラーにする。
    {
        const replies = {
            'http://127.0.0.1:5503/api.php?action=health': { type: 'text/plain', data: '<?php' },
            'http://localhost:8888/tunedrop/api.php?action=health': staleHealth,
            'http://localhost:8888/api.php?action=health': staleHealth
        };
        const { calls, context } = makeContext('http://127.0.0.1:5503/index.html', replies);
        await assert.rejects(vm.runInContext('resolveTunedropApi()', context), /APIに接続できません/);
        assert.equal(calls.filter(call => call.url.includes('endpoint=guest')).length, 0);
    }
    console.log('PASS: MAMP, Live Server PHP source fallback, custom URL, POST forwarding, cached discovery, stale API rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });
