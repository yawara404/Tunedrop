// ==========================================================
// ハッシュルーティング + ロゴ (goToHome) の挙動テスト
// ----------------------------------------------------------
// 実ブラウザを使わず、DOM を最小限スタブして app.js を読み込み
// - Manager ビューのハッシュが #/tunedrop であること (旧 #/manager も読める)
// - ロゴクリック (goToHome) で Manager + ホーム選択に戻ること
//
// 使い方:
//   node tests/hash-routing.cjs
// ==========================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function selectorList(selector) {
    return String(selector).split(',').map(part => part.trim()).filter(Boolean);
}

function matchesSelector(element, selector) {
    return selectorList(selector).some(part => element.selectors.includes(part));
}

class FakeClassList {
    constructor() { this.names = new Set(); }
    add(...names) { names.forEach(name => this.names.add(name)); return this; }
    remove(...names) { names.forEach(name => this.names.delete(name)); return this; }
    contains(name) { return this.names.has(name); }
    toggle(name, force) {
        const next = force === undefined ? !this.names.has(name) : Boolean(force);
        if (next) this.names.add(name); else this.names.delete(name);
        return next;
    }
}

class FakeElement {
    constructor({ id = '', selectors = [] } = {}) {
        this.id = id;
        this.selectors = selectors;
        this.classList = new FakeClassList();
        this.style = {};
        this.dataset = {};
        this.value = '';
        this.innerText = '';
        this.textContent = '';
        this.innerHTML = '';
    }
    closest() { return null; }
    matches(selector) { return matchesSelector(this, selector); }
    setAttribute() { }
    getAttribute() { return null; }
    appendChild(child) { return child; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener() { }
    removeEventListener() { }
    remove() { }
}

const registry = [];
function element(options) {
    const node = new FakeElement(options);
    registry.push(node);
    return node;
}

const body = new FakeElement({ selectors: ['body'] });
const viewManager = element({ id: 'view-manager', selectors: ['#view-manager', '.view-section'] });
const viewRadar = element({ id: 'view-radar', selectors: ['#view-radar', '.view-section'] });
const viewShare = element({ id: 'view-share', selectors: ['#view-share', '.view-section'] });
const viewProfile = element({ id: 'view-profile', selectors: ['#view-profile', '.view-section'] });
const viewPlaylistDetail = element({ id: 'view-playlist-detail', selectors: ['#view-playlist-detail', '.view-section'] });

const elementsById = new Map([
    ['view-manager', viewManager],
    ['view-radar', viewRadar],
    ['view-share', viewShare],
    ['view-profile', viewProfile],
    ['view-playlist-detail', viewPlaylistDetail],
]);
function getElementById(id) {
    if (!elementsById.has(id)) elementsById.set(id, element({ id, selectors: [`#${id}`] }));
    return elementsById.get(id);
}

const documentStub = {
    body,
    getElementById,
    querySelector: selector => registry.find(node => matchesSelector(node, selector)) || null,
    querySelectorAll: selector => registry.filter(node => matchesSelector(node, selector)),
    createElement: () => new FakeElement(),
    addEventListener() { },
};

// location.hash の代入をブラウザ同様 '#' 付きに正規化する
const locationStub = {
    _hash: '',
    get hash() { return this._hash; },
    set hash(value) {
        const text = String(value);
        this._hash = text.startsWith('#') ? text : `#${text}`;
        (windowHandlers.get('hashchange') || []).forEach(handler => handler({ type: 'hashchange' }));
    },
    origin: 'http://localhost',
};

const windowHandlers = new Map();
const context = vm.createContext({
    window: {
        location: locationStub,
        innerWidth: 1280,
        matchMedia: () => ({ matches: false }),
        addEventListener(type, handler) {
            if (!windowHandlers.has(type)) windowHandlers.set(type, []);
            windowHandlers.get(type).push(handler);
        },
    },
    location: locationStub,
    document: documentStub,
    Element: FakeElement,
    URL, URLSearchParams, Headers, AbortController,
    fetch: async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) }),
    requestAnimationFrame: () => 0,
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    alert() { },
    console,
    setTimeout,
    clearTimeout,
});

vm.runInContext(fs.readFileSync(`${__dirname}/../frontend/app.js`, 'utf8'), context);
const run = code => vm.runInContext(code, context);
// ビュー切替時のデータ取得とリスト選択は記録だけ行う (DOM/API 不要)
vm.runInContext(`
    loadPlaylists = async () => {};
    loadRadarData = async () => {};
    loadSharePlaylists = async () => {};
    loadProfile = async () => {};
    window.__selectedPlaylist = null;
    selectPlaylist = async (id) => { window.__selectedPlaylist = id; };
`, context);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function activeViewId() {
    const active = [viewManager, viewRadar, viewShare, viewProfile, viewPlaylistDetail]
        .find(view => view.classList.contains('active'));
    return active ? active.id : null;
}

test('Manager へ遷移するとハッシュが #tunedrop になる', () => {
    run(`navigateView('manager')`);
    assert.equal(locationStub.hash, '#tunedrop');
    run('applyHashView()');   // ブラウザの hashchange 発火を模擬
    assert.equal(activeViewId(), 'view-manager');
});

test('旧ハッシュ #/manager でも Manager が復元できる', () => {
    locationStub._hash = '#/manager';
    run('applyHashView()');
    assert.equal(activeViewId(), 'view-manager');
});

test('ロゴ (goToHome) で Radar から Manager + ホーム選択に戻る', async () => {
    run(`navigateView('radar')`);
    run('applyHashView()');   // ブラウザの hashchange 発火を模擬
    assert.equal(activeViewId(), 'view-radar');
    await run('goToHome()');
    assert.equal(locationStub.hash, '#tunedrop');
    run('applyHashView()');   // ブラウザの hashchange 発火を模擬
    assert.equal(activeViewId(), 'view-manager');
    assert.equal(context.window.__selectedPlaylist, 'home');
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`ok - ${name}`);
        } catch (error) {
            failed += 1;
            console.error(`FAIL - ${name}`);
            console.error(error);
        }
    }
    if (failed > 0) process.exit(1);
    console.log(`${tests.length} tests passed`);
})();
