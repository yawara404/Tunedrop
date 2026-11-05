// ==========================================================
// パスルーティング + ロゴ (goToHome) の挙動テスト
// ----------------------------------------------------------
// 実ブラウザを使わず、DOM を最小限スタブして app.js を読み込み
// - Manager はトップURL (/) のまま表示されること
// - /radar などの標準パスへ遷移できること
// - 旧ハッシュ (#/manager など) がパスへ移行されること
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
const viewHelp = element({ id: 'view-help', selectors: ['#view-help', '.view-section'] });
// ナビのボタン (点灯/消灯の検証用)。.top-nav button として querySelectorAll に拾わせる
const navManagerBtn = element({ id: 'nav-manager', selectors: ['#nav-manager', '.top-nav button'] });
const navProfileBtn = element({ id: 'nav-profile', selectors: ['#nav-profile', '.top-nav button'] });
const navHelpBtn = element({ id: 'nav-help', selectors: ['#nav-help', '.top-nav button'] });

const elementsById = new Map([
    ['view-manager', viewManager],
    ['view-radar', viewRadar],
    ['view-share', viewShare],
    ['view-profile', viewProfile],
    ['view-playlist-detail', viewPlaylistDetail],
    ['view-help', viewHelp],
    ['nav-manager', navManagerBtn],
    ['nav-profile', navProfileBtn],
    ['nav-help', navHelpBtn],
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

// location.pathname / hash の代入をブラウザ同様に扱う
const locationStub = {
    _pathname: '/',
    _hash: '',
    search: '',
    get pathname() { return this._pathname; },
    set pathname(value) { this._pathname = String(value); },
    get hash() { return this._hash; },
    set hash(value) {
        const text = String(value);
        this._hash = text.startsWith('#') ? text : `#${text}`;
        (windowHandlers.get('hashchange') || []).forEach(handler => handler({ type: 'hashchange' }));
    },
    origin: 'http://localhost',
};

// History API スタブ (pushState / replaceState で pathname を更新する)
const historyStub = {
    length: 1,
    pushState(state, title, path) {
        locationStub._pathname = String(path);
        locationStub._hash = '';
    },
    replaceState(state, title, path) {
        locationStub._pathname = String(path);
        locationStub._hash = '';
    },
    back() { },
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
    history: historyStub,
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

// app.js は Vite が読む ES モジュール (export 付き)。vm では classic script として
// 評価するため export だけ外す (中身は同じ)。
vm.runInContext(fs.readFileSync(`${__dirname}/../frontend/app.js`, 'utf8').replace(/^export /gm, ''), context);
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
    const active = [viewManager, viewRadar, viewShare, viewProfile, viewPlaylistDetail, viewHelp]
        .find(view => view.classList.contains('active'));
    return active ? active.id : null;
}

test('Manager はトップURL (/) のまま表示される', () => {
    locationStub._pathname = '/';
    run('applyPathView()');
    assert.equal(activeViewId(), 'view-manager');
    assert.equal(locationStub.pathname, '/');
});

test('Radar へ遷移すると /radar になる', () => {
    run(`navigateView('radar')`);
    assert.equal(locationStub.pathname, '/radar');
    assert.equal(activeViewId(), 'view-radar');
});

test('旧ハッシュ #/manager はトップ (/) に移行される', () => {
    locationStub._pathname = '/';
    locationStub._hash = '#/manager';
    run('migrateLegacyHash()');
    assert.equal(locationStub.pathname, '/');
    assert.equal(locationStub.hash, '');
});

test('旧ハッシュ #help は /help に移行される', () => {
    locationStub._pathname = '/';
    locationStub._hash = '#help';
    assert.equal(run('migrateLegacyHash()'), true);
    assert.equal(locationStub.pathname, '/help');
    run('applyPathView()');
    assert.equal(activeViewId(), 'view-help');
});

test('ページ内アンカー (#help-manager) はルートとして扱わない', () => {
    locationStub._pathname = '/help';
    locationStub._hash = '#help-manager';
    assert.equal(run('migrateLegacyHash()'), false);
    assert.equal(locationStub.pathname, '/help');
});

test('本番プレフィックス /tunedrop/ でもトップはそのまま Manager ホーム', () => {
    locationStub._pathname = '/tunedrop/';
    run('applyPathView()');
    assert.equal(activeViewId(), 'view-manager');
    assert.equal(locationStub.pathname, '/tunedrop/');
});

test('/tunedrop/radar を直接開ける', () => {
    locationStub._pathname = '/tunedrop/radar';
    run('applyPathView()');
    assert.equal(activeViewId(), 'view-radar');
    assert.equal(locationStub.pathname, '/tunedrop/radar');
});

test('/index.html はトップ (/) に正規化される', () => {
    locationStub._pathname = '/index.html';
    run('applyPathView()');
    assert.equal(locationStub.pathname, '/');
    assert.equal(activeViewId(), 'view-manager');
});

test('ユーザーメニューのナビ点灯は他画面へ移ると解除される', () => {
    run(`navigateView('profile')`);
    assert.equal(locationStub.pathname, '/profile');
    assert.equal(navProfileBtn.classList.contains('active'), true, 'プロフィール表示中は点灯');
    assert.equal(navHelpBtn.classList.contains('active'), false, 'ヘルプは消灯');

    run(`navigateView('manager')`);
    assert.equal(locationStub.pathname, '/');
    assert.equal(navProfileBtn.classList.contains('active'), false, 'マネージャーへ移ると消灯');
    assert.equal(navProfileBtn.style.color, '', 'インラインの色指定も戻る');
    assert.equal(navManagerBtn.classList.contains('active'), true, 'マネージャーが点灯');

    run(`navigateView('help')`);
    assert.equal(locationStub.pathname, '/help');
    assert.equal(navHelpBtn.classList.contains('active'), true, 'ヘルプ表示中は点灯');
    assert.equal(navProfileBtn.classList.contains('active'), false, 'プロフィールは消灯');
});

test('ロゴ (goToHome) で Radar から Manager + ホーム選択に戻る', async () => {
    run(`navigateView('radar')`);
    assert.equal(locationStub.pathname, '/radar');
    assert.equal(activeViewId(), 'view-radar');
    await run('goToHome()');
    assert.equal(locationStub.pathname, '/');
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
