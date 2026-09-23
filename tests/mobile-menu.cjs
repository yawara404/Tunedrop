// ==========================================================
// モバイルのハンバーガーメニュー (app.js) の挙動テスト
// ----------------------------------------------------------
// 実ブラウザを使わず、DOM を最小限スタブして app.js を読み込み
// 「メニューを開いている間に他の操作をしたら閉じる」ことを検証する。
//
// 使い方:
//   node tests/mobile-menu.cjs
// ==========================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// ----------------------------------------------------------
// 最小 DOM スタブ
// - 各要素は「自分を表すセレクタ」を持ち、closest / querySelector はその一致で判定する
// - app.js はメニュー判定に .sidebar / .radar-sidebar / .top-nav nav / #menu-toggle-btn
//   しか使わないため、この簡易マッチで十分に検証できる
// ----------------------------------------------------------
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
    toString() { return [...this.names].join(' '); }
}

class FakeElement {
    constructor({ id = '', selectors = [], parent = null } = {}) {
        this.id = id;
        this.selectors = selectors;
        this.parent = parent;
        this.classList = new FakeClassList();
        this.style = {};
        this.dataset = {};
        this.attributes = {};
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.innerText = '';
        this.textContent = '';
        this.innerHTML = '';
    }
    closest(selector) {
        const parts = selectorList(selector);
        for (let node = this; node; node = node.parent) {
            if (node.selectors.some(name => parts.includes(name))) return node;
        }
        return null;
    }
    matches(selector) { return matchesSelector(this, selector); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    appendChild(child) { if (child instanceof FakeElement) child.parent = this; return child; }
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

// 画面の要素 (index.html の構成に対応)
const body = new FakeElement({ selectors: ['body'] });
const hamburgerBtn = element({ id: 'menu-toggle-btn', selectors: ['#menu-toggle-btn'] });
const topNav = element({ selectors: ['.top-nav nav'] });
const sidebar = element({ selectors: ['.sidebar'] });
const radarSidebar = element({ selectors: ['.radar-sidebar'] });
const contentArea = element({ selectors: ['.content-area'] });
const sidebarFilterInput = element({ selectors: ['#manager-search'], parent: sidebar });
const playlistItem = element({ selectors: ['.playlist-nav li'], parent: sidebar });
const viewManager = element({ id: 'view-manager', selectors: ['#view-manager'] });
const viewRadar = element({ id: 'view-radar', selectors: ['#view-radar'] });
viewManager.classList.add('active');

const elementsById = new Map([
    ['menu-toggle-btn', hamburgerBtn],
    ['view-manager', viewManager],
    ['view-radar', viewRadar],
]);
function getElementById(id) {
    if (!elementsById.has(id)) elementsById.set(id, element({ id, selectors: [`#${id}`] }));
    return elementsById.get(id);
}

const handlers = new Map();   // `type|capture` -> [handler]
const documentStub = {
    body,
    getElementById,
    querySelector: selector => registry.find(node => matchesSelector(node, selector)) || null,
    querySelectorAll: selector => registry.filter(node => matchesSelector(node, selector)),
    createElement: () => new FakeElement(),
    addEventListener(type, handler, options) {
        const key = `${type}|${Boolean(options === true || options?.capture)}`;
        if (!handlers.has(key)) handlers.set(key, []);
        handlers.get(key).push(handler);
    },
};

function dispatch(type, target, extra = {}, capture = false) {
    const event = Object.assign({
        target, type,
        stopPropagation() { }, preventDefault() { }, defaultPrevented: false,
    }, extra);
    (handlers.get(`${type}|${capture}`) || []).forEach(handler => handler(event));
    return event;
}

const windowHandlers = new Map();   // `type` -> [handler]
const locationStub = { hash: '', origin: 'http://localhost' };
const context = vm.createContext({
    location: locationStub,
    window: {
        ManagerLists: { setData() { } },
        location: locationStub,
        innerWidth: 390,
        // テスト中はモバイル幅 (ハンバーガーが出る幅) として扱う
        matchMedia: () => ({ matches: true }),
        addEventListener(type, handler) {
            if (!windowHandlers.has(type)) windowHandlers.set(type, []);
            windowHandlers.get(type).push(handler);
        },
    },
    document: documentStub,
    Element: FakeElement,
    URL, URLSearchParams, Headers, AbortController,
    fetch: async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) }),
    requestAnimationFrame: (fn) => 0,
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    alert() { },
    console,
    setTimeout,
    clearTimeout,
    tunedropFetch: async () => ({ ok: true, json: async () => [] }),
});

vm.runInContext(fs.readFileSync(`${__dirname}/../frontend/app.js`, 'utf8'), context);
// 統合後の app.js は tunedropFetch を内包するため、メニュー挙動に関係ない
// 非同期API呼び出しがテスト後に落ちないようスタブで上書きする。
vm.runInContext('tunedropFetch = async () => ({ ok: true, json: async () => ({ success: true }) }); syncPlayerFavorite = async () => {};', context);
const run = code => vm.runInContext(code, context);

// ----------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------
function assertMenuOpen(expected, message) {
    const label = expected ? '開いている' : '閉じている';
    assert.equal(body.classList.contains('mobile-menu-open'), expected, `${message}: body の状態 (${label}想定)`);
    assert.equal(topNav.classList.contains('show-mobile'), expected, `${message}: 上部ナビの状態 (${label}想定)`);
}

function openMenu() {
    run('closeMobileMenu()');   // 前のテストの状態に依存しない
    run('toggleSidebar()');
    assertMenuOpen(true, 'メニューを開く');
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ビューポート幅を切り替えて resize を発火する (window.matchMedia を差し替え)
function setViewport({ mobile }) {
    context.window.matchMedia = () => ({ matches: mobile });
    (windowHandlers.get('resize') || []).forEach(handler => handler({ type: 'resize' }));
}

// ----------------------------------------------------------
// テスト
// ----------------------------------------------------------
test('ハンバーガーボタンで開閉でき、サイドバー (リスト) も一緒に開閉する', () => {
    assert.equal(run('toggleSidebar()'), true);
    assertMenuOpen(true, 'ハンバーガー1回目');
    assert.equal(sidebar.classList.contains('show-mobile'), true, 'Manager のサイドバーが開く');
    assert.equal(run('toggleSidebar()'), false);
    assertMenuOpen(false, 'ハンバーガー2回目');
    assert.equal(sidebar.classList.contains('show-mobile'), false, 'Manager のサイドバーが閉じる');
});

test('メニュー内の項目 (リスト・絞り込み) のタップでは閉じない', () => {
    openMenu();
    dispatch('click', playlistItem);
    assertMenuOpen(true, 'リスト項目タップ');
    dispatch('click', sidebarFilterInput);
    assertMenuOpen(true, '絞り込み欄タップ');
});

test('メニュー外 (コンテンツ) のタップで閉じる', () => {
    openMenu();
    dispatch('click', contentArea);
    assertMenuOpen(false, 'コンテンツタップ');
});

test('メニューの余白 (ドロワー背景) のタップで閉じる', () => {
    openMenu();
    dispatch('click', sidebar);
    assertMenuOpen(false, 'ドロワー背景タップ');
});

test('ハンバーガーボタン自身のタップ直後に閉じてしまわない', () => {
    // 実機では onclick="toggleSidebar()" のあとに document の click listener が動く
    assert.equal(run('toggleSidebar()'), true);
    dispatch('click', hamburgerBtn);
    assertMenuOpen(true, 'ハンバーガーボタンタップ直後');
    assert.equal(run('toggleSidebar()'), false, 'もう一度押すと閉じる');
});

test('コンテンツのスクロールで閉じ、ドロワー内のスクロールでは閉じない', () => {
    openMenu();
    dispatch('scroll', sidebar, {}, true);
    assertMenuOpen(true, 'ドロワー内スクロール');
    dispatch('scroll', contentArea, {}, true);
    assertMenuOpen(false, 'コンテンツスクロール');

    openMenu();
    dispatch('scroll', documentStub, {}, true);   // ページ全体 (document) のスクロール
    assertMenuOpen(false, 'ページスクロール');
});

test('Escape キーで閉じる', () => {
    openMenu();
    dispatch('keydown', body, { key: 'Escape' });
    assertMenuOpen(false, 'Escape');
});

test('ハンバーガーボタンの aria-expanded / aria-label が状態と揃う', () => {
    openMenu();
    assert.equal(hamburgerBtn.getAttribute('aria-expanded'), 'true');
    assert.equal(hamburgerBtn.getAttribute('aria-label'), 'メニューを閉じる');
    dispatch('keydown', body, { key: 'Escape' });
    assert.equal(hamburgerBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(hamburgerBtn.getAttribute('aria-label'), 'メニューを開く');
});

test('モバイル幅を外れたら (回転など) 閉じる', () => {
    openMenu();
    setViewport({ mobile: false });
    assertMenuOpen(false, 'PC幅へリサイズ');
    assert.equal(sidebar.classList.contains('show-mobile'), false, 'サイドバーも閉じる');

    setViewport({ mobile: true });
    openMenu();
    setViewport({ mobile: true });
    assertMenuOpen(true, 'モバイル幅のままリサイズ');
});

test('画面遷移 (switchView) で閉じる', () => {
    openMenu();
    run("switchView('manager')");
    assertMenuOpen(false, 'Manager へ遷移');
    assert.equal(sidebar.classList.contains('show-mobile'), false, 'サイドバーも閉じる');
});

test('プレイリスト選択 (selectPlaylist) で閉じる', () => {
    openMenu();
    run("selectPlaylist('home')");
    assertMenuOpen(false, 'プレイリスト選択');
});

test('モーダルを開いたら閉じる', () => {
    openMenu();
    run('openCreatePlaylistModal()');
    assertMenuOpen(false, '新規リスト作成モーダル');

    openMenu();
    run('showLoginModal()');
    assertMenuOpen(false, 'ログインモーダル');
});

test('再生を始めたら閉じる', () => {
    openMenu();
    run("playTrackFromQueue(0, [{ id: 1, youtube_id: 'abc123', title: 't', channel: 'c', is_favorite: 0 }])");
    assertMenuOpen(false, '再生開始');
});

test('Radar 画面では Radar サイドバーが開き、Manager のサイドバーは開かない', () => {
    run("document.getElementById('view-manager').classList.remove('active');"
        + "document.getElementById('view-radar').classList.add('active')");
    run('toggleSidebar()');
    assert.equal(radarSidebar.classList.contains('show-mobile'), true, 'Radar サイドバーが開く');
    assert.equal(sidebar.classList.contains('show-mobile'), false, 'Manager のサイドバーは開かない');

    dispatch('click', contentArea);   // Radar 画面でも他の操作で閉じる
    assert.equal(radarSidebar.classList.contains('show-mobile'), false, 'Radar サイドバーが閉じる');
    assertMenuOpen(false, 'Radar 画面でのコンテンツタップ');

    run("document.getElementById('view-radar').classList.remove('active');"
        + "document.getElementById('view-manager').classList.add('active')");
});

test('closeMobileMenu は開いているときだけ true を返し、状態が壊れない', () => {
    assert.equal(run('closeMobileMenu()'), false, '閉じているとき');
    run('toggleSidebar()');
    assert.equal(run('closeMobileMenu()'), true, '開いているとき');
    assertMenuOpen(false, 'closeMobileMenu');
    assert.equal(run('isMobileMenuOpen()'), false, '状態が閉じている');
});

let passed = 0;
for (const { name, fn } of tests) {
    try {
        fn();
    } catch (error) {
        console.error(`FAILED: ${name}`);
        throw error;
    }
    passed++;
}
console.log(`PASS: モバイルメニュー ${passed} 件 (他の操作で自動的に閉じる)`);
