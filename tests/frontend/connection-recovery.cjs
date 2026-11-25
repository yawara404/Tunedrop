const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// 接続断バナー / 自動再接続 (frontend/src/app.js) の検証。
// 実ブラウザは使わず、DOM と fetch を最小限スタブして次を確認する:
//   - 起動後の切断は全面オーバーレイではなくバナーを出す
//   - バナーの「再試行」で health を確認し、復旧したら自動で消える
//   - 復旧時に tunedrop:reconnected を1回だけ通知する
//   - オフライン (navigator.onLine=false) では無駄な再試行をしない
const bundled = fs.readFileSync(`${__dirname}/../../frontend/src/app.js`, 'utf8').replace(/^export /gm, '');
const source = bundled.slice(bundled.indexOf('// ===== api-client'), bundled.indexOf('let player;'));

function element() {
    return {
        hidden: true,
        textContent: '',
        classList: {
            names: new Set(),
            add(name) { this.names.add(name); },
            remove(name) { this.names.delete(name); },
            contains(name) { return this.names.has(name); },
        },
    };
}

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json; charset=utf-8' },
        json: async () => data,
        clone() { return this; },
    };
}

function fakeNode() {
    const node = {
        id: '', className: '', textContent: '', offsetWidth: 0,
        children: [],
        parent: null,
        classList: {
            names: new Set(),
            add(name) { this.names.add(name); },
            remove(name) { this.names.delete(name); },
            contains(name) { return this.names.has(name); },
        },
        setAttribute() {},
        appendChild(child) { child.parent = node; node.children.push(child); return child; },
        remove() {
            if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node);
        },
        get firstElementChild() { return node.children[0] || null; },
    };
    return node;
}

function makeContext({ healthOk = true, online = true } = {}) {
    const elements = {
        'connection-banner': element(),
        'connection-text': element(),
        'maintenance-overlay': element(),
        'maintenance-message': element(),
        'maintenance-note': element(),
        'toast-host': fakeNode(),
    };
    const banner = elements['connection-banner'];
    banner.hidden = true;
    const host = elements['toast-host'];
    const calls = [];
    const events = [];
    const windowListeners = {};
    const saved = new Map([['tunedrop_token', 'account-jwt']]);
    let health = healthOk;
    const context = vm.createContext({
        window: {
            location: { href: 'http://localhost:8888/' },
            TUNEDROP_CONFIG: { retryDelays: [1, 1] },
            addEventListener: (type, listener) => { windowListeners[type] = listener; },
            dispatchEvent: event => { events.push(event); return true; },
        },
        document: {
            getElementById: id => elements[id] || null,
            createElement: () => fakeNode(),
            body: { classList: { add() {}, remove() {} } },
        },
        navigator: { onLine: online },
        CustomEvent: class { constructor(type) { this.type = type; } },
        URL, Headers, AbortController, setTimeout, clearTimeout, console,
        localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
        fetch: async (url, init) => {
            const href = String(url.href || url);
            calls.push({ href, init });
            if (href.includes('action=health')) {
                return health
                    ? jsonResponse({ status: 'ok', service: 'TuneDrop PHP API', features: ['auth_proxy', 'auth_guest'] })
                    : jsonResponse({ status: 'error' }, 503);
            }
            throw new TypeError('Failed to fetch');
        },
    });
    vm.runInContext(source, context);
    return {
        context, elements, calls, host, events, windowListeners, banner,
        setHealth: value => { health = value; },
    };
}

(async () => {
    // 1) 起動後の切断はバナー (画面全体を覆わない) を出し、復旧で自動的に消える
    {
        const test = makeContext();
        await assert.rejects(vm.runInContext(
            "tunedropFetch('api.php?action=get_playlists')", test.context));
        assert.equal(test.banner.hidden, false, 'バナーが出ていない');
        assert.match(test.elements['connection-text'].textContent, /再接続/);
        assert.equal(test.elements['maintenance-overlay'].hidden, true, '全面の案内を出してはいけない');

        // 3秒以上出ていた場合だけ「再接続しました」を通知する
        vm.runInContext('reconnectShownAt = Date.now() - 5000', test.context);
        test.setHealth(true);
        await vm.runInContext('retryConnection()', test.context);
        assert.equal(test.banner.hidden, true, '復旧してもバナーが残っている');
        assert.deepEqual(test.host.children.map(node => node.textContent), ['再接続しました。']);
        assert.deepEqual(test.events.map(event => event.type), ['tunedrop:reconnected']);
    }

    // 2) まだ復旧していなければバナーを出したまま、間隔を空けて再確認する
    {
        const test = makeContext();
        await assert.rejects(vm.runInContext(
            "tunedropFetch('api.php?action=get_playlists')", test.context));
        test.setHealth(false);   // まだ復旧していない
        await vm.runInContext('retryConnection()', test.context);
        assert.equal(test.banner.hidden, false, '復旧前にバナーを消してはいけない');
        assert.equal(test.elements['maintenance-overlay'].hidden, true);
        vm.runInContext('hideConnectionBanner(false)', test.context);   // タイマーを止める
    }

    // 3) オフライン中は自動再試行しない (1回だけ試してバナー)
    {
        const test = makeContext({ online: false });
        await assert.rejects(vm.runInContext(
            "tunedropFetch('api.php?action=get_playlists')", test.context));
        const attempts = test.calls.filter(call => call.href.includes('action=get_playlists')).length;
        assert.equal(attempts, 1, `オフラインなのに ${attempts} 回試した`);
        assert.equal(test.banner.hidden, false);
        assert.match(test.elements['connection-text'].textContent, /オフライン/);
        vm.runInContext('hideConnectionBanner(false)', test.context);
    }

    // 4) online イベントで即座に復旧確認を始める
    {
        const test = makeContext({ online: false });
        vm.runInContext('initConnectionRecovery()', test.context);
        vm.runInContext("showConnectionBanner('オフラインです')", test.context);
        test.setHealth(true);
        const before = test.calls.length;
        test.windowListeners.online();
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(test.calls.length > before, 'online で health を確認していない');
        assert.equal(test.banner.hidden, true, 'オンライン復帰でバナーが消えない');
    }

    console.log('PASS: connection banner appears on mid-session outages, recovers automatically, '
        + 'and skips retries while offline.');
})().catch(error => { console.error(error); process.exitCode = 1; });
