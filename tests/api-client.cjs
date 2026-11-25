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
// reply.status で HTTP ステータス、配列で「1回目は失敗、2回目は成功」を表せる。
function makeContext(page, replies, options = {}) {
    const calls = [];
    const saved = new Map();
    const context = vm.createContext({
        window: { location: { href: page }, TUNEDROP_CONFIG: options },
        URL, Headers, AbortController, setTimeout, clearTimeout,
        localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
        fetch: async (url, init) => {
            calls.push({ url: url.href, init });
            let reply = replies[url.href];
            if (!reply) throw new TypeError(`Failed to fetch: ${url}`);
            if (Array.isArray(reply)) reply = reply.length > 1 ? reply.shift() : reply[0];
            const status = reply.status || 200;
            const type = reply.type || 'application/json';
            const response = {
                ok: status >= 200 && status < 300,
                status,
                headers: { get: name => (String(name).toLowerCase() === 'content-type' ? type : null) },
                json: async () => reply.data,
                clone() { return { ...response, clone: response.clone }; },
            };
            return response;
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
        'http://localhost:8888/api.php?action=health': health,
        'http://localhost:8888/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://localhost:8888/api.php?action=create_playlist');
    await scenario('http://localhost:5503/index.html', {
        'http://localhost:9999/custom/api.php?action=health': health,
        'http://localhost:9999/custom/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://localhost:9999/custom/api.php?action=create_playlist', { apiUrl: 'http://localhost:9999/custom/api.php' });
    // Live Server (5503) で開き、./start.sh が 8888 ではなく 8001 で動いている場合でも検出できる。
    // (start.py は 8888 が使用中だと 8000/8001… へ自動で移る)
    await scenario('http://localhost:5503/index.html', {
        'http://localhost:5503/api.php?action=health': { type: 'text/plain', data: '<?php' },
        'http://127.0.0.1:8001/api.php?action=health': health,
        'http://127.0.0.1:8001/api.php?action=create_playlist': { data: { success: true } }
    }, 'http://127.0.0.1:8001/api.php?action=create_playlist',
       { fallbackApiPorts: [8888, 8000, 8001] });
    // 古い api.php しか無い場合は接続先に採用せず、対処法の分かるエラーにする。
    {
        const replies = {
            'http://127.0.0.1:5503/api.php?action=health': { type: 'text/plain', data: '<?php' },
            'http://localhost:8888/api.php?action=health': staleHealth,
            'http://127.0.0.1:8888/api.php?action=health': staleHealth
        };
        const { calls, context } = makeContext('http://127.0.0.1:5503/index.html', replies);
        await assert.rejects(vm.runInContext('resolveTunedropApi()', context), /APIに接続できません/);
        assert.equal(calls.filter(call => call.url.includes('endpoint=guest')).length, 0);
    }
    // Radarの一時的な通信失敗は画面全体を覆わず、通常のAPIエラー表示は維持する。
    {
        const { calls, saved, context } = makeContext('http://localhost:8888/', {
            'http://localhost:8888/api.php?action=health': health,
        }, { retryDelays: [1, 1] });
        saved.set('tunedrop_token','account-jwt');
        let maintenance=0, banners=0;
        context.showMaintenanceScreen=()=>{maintenance++;};
        context.showConnectionBanner=()=>{banners++;};
        await assert.rejects(vm.runInContext("tunedropFetch('api.php?action=radar_map', {recoverable:true})",context));
        assert.equal(maintenance,0);
        assert.equal(banners,0);
        assert.equal('recoverable' in calls.at(-1).init,false);
        // 起動後 (health 解決済み) の切断は再生を止めないバナーだけを出す
        await assert.rejects(vm.runInContext("tunedropFetch('api.php?action=radar_map')",context));
        assert.equal(maintenance,0);
        assert.equal(banners,1);
        // GET は 2回まで自動再試行する (1回の呼び出しで最大3回)
        assert.equal(calls.filter(call => call.url.includes('action=radar_map')).length, 6);
    }
    // 一時的な 502 は GET だけ自動で再試行する (POST は二重作成を避けて再試行しない)。
    {
        const { calls, saved, context } = makeContext('http://localhost:8888/', {
            'http://localhost:8888/api.php?action=health': health,
            'http://localhost:8888/api.php?action=radar_map': [
                { status: 502, data: { status: 'error' } },
                { status: 502, data: { status: 'error' } },
                { status: 200, data: { success: true } }
            ]
        }, { retryDelays: [1, 1] });
        saved.set('tunedrop_token','account-jwt');
        const response = await vm.runInContext("tunedropFetch('api.php?action=radar_map')",context);
        assert.equal((await response.json()).success, true);
        assert.equal(response.status, 200);
        assert.equal(calls.filter(call => call.url.includes('action=radar_map')).length, 3);
    }
    {
        const { calls, saved, context } = makeContext('http://localhost:8888/', {
            'http://localhost:8888/api.php?action=health': health,
            'http://localhost:8888/api.php?action=create_playlist': [
                { status: 502, data: { status: 'error' } },
                { status: 200, data: { success: true } }
            ]
        }, { retryDelays: [1, 1] });
        saved.set('tunedrop_token','account-jwt');
        const response = await vm.runInContext(
            "tunedropFetch('api.php?action=create_playlist', {method: 'POST', body: '{}'})", context);
        assert.equal(response.status, 502);
        assert.equal(calls.filter(call => call.url.includes('action=create_playlist')).length, 1);
    }
    console.log('PASS: PHP source fallback, custom URL, POST forwarding, cached discovery, alternate port discovery, stale API rejection, retry/reconnect policy');
})().catch(error => { console.error(error); process.exitCode = 1; });
