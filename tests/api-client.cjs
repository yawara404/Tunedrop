const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// api-client は frontend/app.js 先頭に統合済み。統合部分だけ切り出して検証する。
const bundled = fs.readFileSync(`${__dirname}/../frontend/app.js`, 'utf8');
const apiStart = bundled.indexOf('// ===== api-client');
const appStart = bundled.indexOf('let player;');
const source = bundled.slice(apiStart, appStart);

async function scenario(page, replies, expected, options = {}) {
    const calls = [];
    const context = vm.createContext({
        window: { location: { href: page }, TUNEDROP_CONFIG: options },
        URL, Headers, AbortController, setTimeout, clearTimeout,
        localStorage: { getItem: () => null },
        fetch: async (url, init) => {
            calls.push({ url: url.href, init });
            const reply = replies[url.href];
            if (!reply) throw new Error(`Unexpected request: ${url}`);
            return { ok: true, headers: { get: () => reply.type || 'application/json' }, json: async () => reply.data };
        }
    });
    vm.runInContext(source, context);
    const result = await vm.runInContext("tunedropFetch('api.php?action=create_playlist', { method: 'POST', body: '{}'})", context);
    assert.equal(calls.at(-1).url, expected);
    assert.equal(calls.at(-1).init.method, 'POST');
    assert.deepEqual(await result.json(), { success: true });
    const healthCount = calls.filter(call => call.url.includes('action=health')).length;
    await vm.runInContext("tunedropFetch('api.php?action=create_playlist')", context);
    assert.equal(calls.filter(call => call.url.includes('action=health')).length, healthCount);
}
const health = { data: { status: 'ok', service: 'TuneDrop PHP API' } };
(async () => {
    await scenario('http://localhost:8888/Tunedrop/index.html', {
        'http://localhost:8888/Tunedrop/api.php?action=health': health,
        'http://localhost:8888/Tunedrop/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://localhost:8888/Tunedrop/api.php?action=create_playlist');
    await scenario('http://127.0.0.1:5503/index.html', {
        'http://127.0.0.1:5503/api.php?action=health': { type: 'text/plain', data: '<?php' },
        'http://localhost:8888/Tunedrop/api.php?action=health': health,
        'http://localhost:8888/Tunedrop/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://localhost:8888/Tunedrop/api.php?action=create_playlist');
    await scenario('http://localhost:5503/index.html', {
        'http://localhost:9999/custom/api.php?action=health': health,
        'http://localhost:9999/custom/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://localhost:9999/custom/api.php?action=create_playlist', { apiUrl: 'http://localhost:9999/custom/api.php' });
    console.log('PASS: MAMP, Live Server PHP source fallback, custom URL, POST forwarding, cached discovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
