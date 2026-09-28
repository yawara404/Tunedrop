// ==========================================================
// 使い勝手まわりの共通UI (app.js) の挙動テスト
// ----------------------------------------------------------
// 実ブラウザを使わず、DOM を最小限スタブして app.js を読み込み
// - トースト通知 (alert の代わり) が種類ごとの見た目で積まれる
// - Esc キーで開いているモーダルが1枚だけ閉じる
// - YouTube URL の複数まとめ貼り付けを動画IDへ分解できる
// - 曲の追加でURL欄がクリアされ、追加中はボタンが押せない
// - 曲検索の Enter=先頭を再生 / Escape=クリア
//
// 使い方:
//   node tests/ui-feedback.cjs
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
        this.handlers = new Map();
        this.children = [];
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        this.focused = false;
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
    // 実ブラウザ同様、className の代入で classList も入れ替わるようにする
    get className() { return this.classList.toString(); }
    set className(value) {
        this.classList = new FakeClassList();
        String(value).split(/\s+/).filter(Boolean).forEach(name => this.classList.add(name));
    }
    matches(selector) { return matchesSelector(this, selector); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) {
        if (child instanceof FakeElement) { child.parent = this; this.children.push(child); }
        return child;
    }
    remove() {
        if (!this.parent) return;
        const index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
        this.parent = null;
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener(type, handler) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type).push(handler);
    }
    removeEventListener() { }
    focus() { this.focused = true; }
    select() { this.selected = true; }
    // テスト用: 要素自身のリスナーを発火する
    fire(type, extra = {}) {
        (this.handlers.get(type) || []).forEach(handler => handler(Object.assign({
            target: this, type, stopPropagation() { }, preventDefault() { },
        }, extra)));
    }
}

const registry = [];
function element(options) {
    const node = new FakeElement(options);
    registry.push(node);
    return node;
}

const body = new FakeElement({ selectors: ['body'] });
function getElementById(id) {
    const found = registry.find(node => node.id === id);
    if (found) return found;
    return element({ id, selectors: [`#${id}`] });
}

const handlers = new Map();   // `type|capture` -> [handler]
const documentStub = {
    body,
    visibilityState: 'visible',
    getElementById,
    querySelector: selector => registry.find(node => matchesSelector(node, selector)) || null,
    querySelectorAll: selector => registry.filter(node => matchesSelector(node, selector)),
    // 生成した要素も id で引けるように registry へ入れる (トーストの親など)
    createElement: () => element({}),
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

const windowHandlers = new Map();
const locationStub = { hash: '', origin: 'http://localhost' };
const context = vm.createContext({
    location: locationStub,
    window: {
        location: locationStub,
        innerWidth: 1280,
        matchMedia: () => ({ matches: false }),
        addEventListener(type, handler) {
            if (!windowHandlers.has(type)) windowHandlers.set(type, []);
            windowHandlers.get(type).push(handler);
        },
    },
    document: documentStub,
    Element: FakeElement,
    URL, URLSearchParams, Headers, AbortController,
    fetch: async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) }),
    // トーストの中身を検証したいだけなので、自動削除のタイマーは動かさない
    requestAnimationFrame: handler => { handler(); return 0; },
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    alert(message) { context.window.__alerts.push(String(message)); },
    console,
    setTimeout: () => 0,
    clearTimeout: () => { },
});
context.window.__alerts = [];

vm.runInContext(fs.readFileSync(`${__dirname}/../frontend/app.js`, 'utf8'), context);
const run = code => vm.runInContext(code, context);

// index.html のモーダルは初期状態が display:none (JSが flex にして表示する)
// スタブは HTML を読まないため、同じ初期状態をここで作っておく。
const MODAL_IDS = ['create-playlist-modal', 'edit-playlist-modal', 'move-track-modal', 'export-preview-modal', 'login-modal'];
MODAL_IDS.forEach(id => { getElementById(id).style.display = 'none'; });

// ----------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function elementById(id) { return run(`document.getElementById(${JSON.stringify(id)})`); }
function addedCalls() { return vmValue('window.__addedCalls'); }
function toasts() {
    const host = elementById('toast-host');
    return (host && host.children) || [];
}
function lastToast() { return toasts()[toasts().length - 1] || null; }
// vm の中で作られた配列・オブジェクトは別レルムのため、
// プロトタイプまで比較する deepStrictEqual 用に素の値へ戻す。
function vmValue(expression) { return JSON.parse(run(`JSON.stringify(${expression})`)); }

// ----------------------------------------------------------
// トースト通知
// ----------------------------------------------------------
test('showToast は種類ごとの見た目でトーストを積む', () => {
    run("showToast('リストを作成しました。')");
    const success = lastToast();
    assert.ok(success, 'トーストが追加される');
    assert.equal(success.textContent, 'リストを作成しました。');
    assert.equal(success.classList.contains('toast'), true);
    assert.equal(success.classList.contains('toast-success'), true);
    assert.equal(success.classList.contains('is-visible'), true, 'フェードインが適用される');
    assert.equal(success.getAttribute('role'), 'status', '成功は読み上げを邪魔しない');

    run("showToast('失敗しました。', 'error')");
    const error = lastToast();
    assert.equal(error.classList.contains('toast-error'), true);
    assert.equal(error.getAttribute('role'), 'alert');

    run("showToast('お知らせ', 'info')");
    assert.equal(lastToast().classList.contains('toast-info'), true);
});

test('空メッセージではトーストを積まない', () => {
    const before = toasts().length;
    run("showToast('')");
    run('showToast(null)');
    assert.equal(toasts().length, before);
});

// ----------------------------------------------------------
// モーダルの Esc キー
// ----------------------------------------------------------
test('Esc キーで開いているモーダルが閉じる', () => {
    run('openCreatePlaylistModal()');
    assert.equal(run("isModalVisible('create-playlist-modal')"), true);
    dispatch('keydown', body, { key: 'Escape' });
    assert.equal(run("isModalVisible('create-playlist-modal')"), false, 'Escで閉じる');
});

test('モーダルが重なったときは最後に開いたものから閉じる', () => {
    run('openCreatePlaylistModal()');
    run("openMoveModal({ stopPropagation: function () {}, preventDefault: function () {} }, 1)");
    dispatch('keydown', body, { key: 'Escape' });
    assert.equal(run("isModalVisible('move-track-modal')"), false, '後から開いたモーダルが閉じる');
    assert.equal(run("isModalVisible('create-playlist-modal')"), true, '先のモーダルは残る');

    dispatch('keydown', body, { key: 'Escape' });
    assert.equal(run("isModalVisible('create-playlist-modal')"), false, '続けて閉じられる');
});

test('開いているモーダルが無ければ closeTopmostModal は false', () => {
    assert.equal(run('closeTopmostModal()'), false);
});

// ----------------------------------------------------------
// YouTube URL の複数まとめ貼り付け
// ----------------------------------------------------------
test('extractYouTubeIds は各書式のURLをすべて拾い、重複を落とす', () => {
    const text = [
        'https://youtu.be/aaaaaaaaaaa',
        'https://www.youtube.com/watch?v=bbbbbbbbbbb',
        'https://music.youtube.com/watch?v=ccccccccccc&list=RD',
        'https://www.youtube.com/shorts/ddddddddddd',
        'https://youtu.be/aaaaaaaaaaa',
    ].join(' ');
    const ids = vmValue(`extractYouTubeIds(${JSON.stringify(text)})`);
    assert.deepEqual(ids, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd']);
});

test('extractYouTubeIds はURLが無ければ空配列', () => {
    assert.deepEqual(vmValue("extractYouTubeIds('こんにちは')"), []);
    assert.deepEqual(vmValue('extractYouTubeIds(null)'), []);
});

// ----------------------------------------------------------
// 曲の追加 (URL欄とボタン)
// ----------------------------------------------------------
function stubAddTrackBackend() {
    run(`
        window.__addedCalls = [];
        window.__buttonDisabledDuringCall = null;
        allPlaylists = [{ id: 5, name: '未整理', system_key: 'inbox' }];
        currentPlaylistId = 'home';
        tunedropFetch = async (path, options) => {
            const payload = JSON.parse(options.body);
            window.__addedCalls.push(payload.youtube_id);
            window.__buttonDisabledDuringCall = document.getElementById('add-track-btn').disabled;
            return {
                ok: true,
                json: async () => (payload.youtube_id === 'bbbbbbbbbbb'
                    ? { success: false, error: 'この曲は既にこのリストに登録されています。' }
                    : { success: true, title: 'テスト曲' }),
            };
        };
        loadMyBookmarks = async () => {};
        loadPlaylists = async () => {};
    `);
}

test('追加中はボタンを止め、複数URLをまとめて追加してURL欄を空にする', async () => {
    stubAddTrackBackend();
    run("document.getElementById('youtube-url').value = 'https://youtu.be/aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb'");

    await run('addTrack()');

    assert.deepEqual(addedCalls(), ['aaaaaaaaaaa', 'bbbbbbbbbbb'], '貼り付けた順に1件ずつ追加する');
    assert.equal(run('window.__buttonDisabledDuringCall'), true, '追加中はボタンを押せない (二重登録の防止)');
    assert.equal(elementById('add-track-btn').disabled, false, '完了後は押せる状態に戻る');
    assert.equal(elementById('add-track-btn').getAttribute('aria-busy'), null);
    assert.equal(elementById('youtube-url').value, '', 'URL欄が空になって次の貼り付けができる');
    assert.equal(lastToast().textContent, '1曲を追加しました（1曲は登録済み）', '追加件数と重複をまとめて知らせる');
});

test('すべて登録済みのときはURL欄を残して知らせる', async () => {
    stubAddTrackBackend();
    run("document.getElementById('youtube-url').value = 'https://youtu.be/bbbbbbbbbbb'");

    await run('addTrack()');

    assert.equal(elementById('youtube-url').value, 'https://youtu.be/bbbbbbbbbbb', '貼り付けたURLは消さない');
    assert.equal(lastToast().textContent, 'すべて登録済みの曲でした。');
    assert.equal(lastToast().classList.contains('toast-error'), true);
});

test('URLが空・不正ならAPIを呼ばずに案内し、入力欄へフォーカスする', async () => {
    stubAddTrackBackend();
    run("document.getElementById('youtube-url').value = '   '");

    await run('addTrack()');

    assert.deepEqual(addedCalls(), [], 'APIを呼ばない');
    assert.equal(elementById('youtube-url').focused, true, '入力欄へフォーカスが戻る');
    assert.equal(lastToast().textContent, 'YouTubeのURL（https://youtu.be/...）を貼り付けてください。');
});

test('通知に alert を使わない (操作をブロックしない)', async () => {
    stubAddTrackBackend();
    run('window.__alerts = []');
    run("document.getElementById('youtube-url').value = 'https://youtu.be/aaaaaaaaaaa'");
    await run('addTrack()');
    assert.deepEqual(vmValue('window.__alerts'), [], '追加の結果通知はトーストで出す');

    run("window.__alerts = []; document.getElementById('youtube-url').value = 'no-url';");
    await run('addTrack()');
    assert.deepEqual(vmValue('window.__alerts'), [], '入力ミスの案内もトーストで出す');
});

// ----------------------------------------------------------
// 曲検索のキーボード操作
// ----------------------------------------------------------
test('検索欄の Enter=先頭の曲を再生、Escape=クリア', () => {
    run(`
        window.__played = null;
        playTrackFromQueue = (index, queue) => { window.__played = { index, titles: queue.map(t => t.title) }; };
        currentTracks = [
            { id: 1, youtube_id: 'aaaaaaaaaaa', title: 'Alpha', channel: 'ch', is_favorite: 0 },
            { id: 2, youtube_id: 'bbbbbbbbbbb', title: 'Beta', channel: 'ch', is_favorite: 0 },
        ];
        document.getElementById('track-search').value = 'beta';
    `);

    run("onTrackSearchKey({ key: 'Enter', preventDefault() {}, stopPropagation() {} })");
    assert.deepEqual(vmValue('window.__played'), { index: 0, titles: ['Beta'] }, '絞り込み後の先頭を再生する');

    run("onTrackSearchKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} })");
    assert.equal(elementById('track-search').value, '', 'Escape で検索語を消す');
    assert.equal(elementById('track-search').focused, true);
});

// ----------------------------------------------------------
// 実行
// ----------------------------------------------------------
(async () => {
    let passed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
        } catch (error) {
            console.error(`FAILED: ${name}`);
            throw error;
        }
        passed++;
    }
    console.log(`PASS: 使い勝手まわりの共通UI ${passed} 件 (トースト / モーダル / URL追加 / 検索)`);
})();

