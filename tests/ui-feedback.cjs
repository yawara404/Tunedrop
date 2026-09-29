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
const locationStub = { hash: '', origin: 'http://localhost', href: 'http://localhost:8888/tunedrop/index.html' };
// localStorage のスタブ (トークンやゲスト認証情報の保存/削除を検証する)
const storage = new Map();
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
    localStorage: {
        getItem: key => (storage.has(String(key)) ? storage.get(String(key)) : null),
        setItem: (key, value) => { storage.set(String(key), String(value)); },
        removeItem: key => { storage.delete(String(key)); },
    },
    alert(message) { context.window.__alerts.push(String(message)); },
    console,
    setTimeout: () => 0,
    clearTimeout: () => { },
});
context.window.__alerts = [];

// app.js は Vite が読む ES モジュール (export 付き)。vm では classic script として
// 評価するため export だけ外す (中身は同じ)。
vm.runInContext(fs.readFileSync(`${__dirname}/../frontend/app.js`, 'utf8').replace(/^export /gm, ''), context);
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
        // 後続のテストで本物の tunedropFetch に戻せるように退避しておく
        if (!window.__realTunedropFetch) window.__realTunedropFetch = tunedropFetch;
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

test('ゲスト初期化はHTML応答でも原因の分かるエラーにする', async () => {
    run(`
        tunedropGuestPromise = null;
        tunedropGuestRefreshAt = 0;
        window.__guestError = null;
        // 古い app.py は /auth/guest を知らず HTML の 404 を返す (api.php は JSON の
        // Content-Type を付けるため content-type だけでは防げない)
        fetch = async () => ({
            ok: false, status: 404,
            headers: { get: () => 'text/html; charset=utf-8' },
            json: async () => JSON.parse('<!doctype html><h1>404</h1>'),
        });
    `);
    await run("ensureTunedropGuest(new URL('http://localhost:8888/api.php'))"
        + ".catch(error => { window.__guestError = error.message; })");

    const message = run('window.__guestError');
    assert.match(message, /再起動/, `対処法が分かるエラーを出す: ${message}`);
    assert.doesNotMatch(message, /is not valid JSON/, '内部のJSONパースエラーをそのまま出さない');
});

test('ゲスト初期化はサーバーが返したJSONエラーをそのまま伝える', async () => {
    const reason = '認証サーバーの応答が不正です (古い app.py が動いている可能性があります)。./start.sh でサーバーを再起動してください。';
    run(`
        tunedropGuestPromise = null;
        tunedropGuestRefreshAt = 0;
        window.__guestError = null;
        fetch = async () => ({
            ok: false, status: 502,
            headers: { get: () => 'application/json; charset=utf-8' },
            json: async () => ({ success: false, error: ${JSON.stringify(reason)} }),
        });
    `);
    await run("ensureTunedropGuest(new URL('http://localhost:8888/api.php'))"
        + ".catch(error => { window.__guestError = error.message; })");

    assert.equal(run('window.__guestError'), reason);
});

// ----------------------------------------------------------
// ログイン状態の取り扱い (期限切れ・無効なトークン)
// ----------------------------------------------------------
test('無効なトークンで401になったらセッションを捨ててログインを促す', async () => {
    run(`
        tunedropFetch = window.__realTunedropFetch;   // addTrack テスト用のスタブを戻す
        localStorage.setItem('tunedrop_token', 'invalid-token');
        localStorage.setItem('tunedrop_username', 'demo-user');
        localStorage.setItem('tunedrop_login_id', 'user@example.com');
        sessionExpiredNoticeAt = 0;
        tunedropApiPromise = Promise.resolve(new URL('http://localhost:8888/api.php'));
        fetch = async () => ({
            ok: false, status: 401,
            headers: { get: () => 'application/json; charset=utf-8' },
            json: async () => ({ error: 'ログインの有効期限が切れています。' }),
        });
    `);

    const status = await run("tunedropFetch('api.php?action=get_playlists').then(r => r.status)");
    assert.equal(status, 401, '呼び出し側には今まで通り 401 を渡す');
    assert.equal(run("localStorage.getItem('tunedrop_token')"), null, '無効なトークンを捨てる');
    assert.equal(run("localStorage.getItem('tunedrop_username')"), null);
    assert.equal(run("document.getElementById('login-modal').style.display"), 'flex', 'ログインモーダルを開く');
    assert.match(lastToast().textContent, /有効期限が切れ/, lastToast().textContent);

    // 2回目以降 (並行リクエスト) はトーストを重ねない
    const before = toasts().length;
    run("localStorage.setItem('tunedrop_token', 'invalid-token');");
    await run("tunedropFetch('api.php?action=get_playlists')");
    assert.equal(toasts().length, before, '連続して通知しない');
    run("['tunedrop_token','tunedrop_username','tunedrop_login_id'].forEach(key => localStorage.removeItem(key))");
});

test('ゲスト認証情報が無効なら作り直して表示を止めない', async () => {
    run(`
        localStorage.setItem('tunedrop_guest_credential', '13.deadbeef');
        tunedropGuestPromise = null;
        tunedropGuestRefreshAt = 0;
        window.__guestBodies = [];
        fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            window.__guestBodies.push(body.credential);
            const denied = body.credential !== '';
            return {
                ok: !denied, status: denied ? 401 : 200,
                headers: { get: () => 'application/json; charset=utf-8' },
                json: async () => (denied
                    ? { error: 'ゲスト認証情報が無効です。' }
                    : { success: true, token: 'fresh-guest-token', credential: '20.newsecret' }),
            };
        };
    `);

    const token = await run("ensureTunedropGuest(new URL('http://localhost:8888/api.php'))");
    assert.equal(token, 'fresh-guest-token', '新しいゲストで続行できる');
    assert.deepEqual(vmValue('window.__guestBodies'), ['13.deadbeef', ''], '無効なら空の認証情報で作り直す');
    assert.equal(run("localStorage.getItem('tunedrop_guest_credential')"), '20.newsecret', '新しい認証情報を保存する');
});

// ----------------------------------------------------------
// モバイル Radar: 絞り込みの折りたたみ
// ----------------------------------------------------------
test('モバイルのRadar絞り込みは画面中央のモーダルで開閉でき、条件クリアは常に4つ目の枠にある', () => {
    // スマホ幅 (600px以下) を再現する
    run("window.innerWidth = 390; window.matchMedia = q => ({ matches: /max-width: 600px/.test(String(q)) });");
    run(`
        ['radar-vibe-filter', 'radar-tempo-filter'].forEach(id => { document.getElementById(id).value = ''; });
        document.getElementById('radar-sort').value = 'default';
        document.getElementById('radar-title-search').value = '';
        document.getElementById('radar-category-filter').value = '';
        closeRadarFilters();
        updateRadarFiltersToggle();
    `);
    assert.equal(run('isRadarFiltersOpen()'), false, '既定は閉じておく (マップの高さを確保)');
    assert.equal(run('isRadarFiltersSheetOpen()'), false);
    assert.equal(run("document.getElementById('btn-radar-filters-toggle').textContent"), '絞り込み');
    assert.notEqual(run("document.getElementById('btn-radar-filters-toggle').getAttribute('aria-expanded')"), 'true');
    assert.equal(run("document.getElementById('btn-radar-clear').classList.contains('is-empty')"), true, '条件が無ければ条件クリアは控えめ (PCのツールバーでは出さない)');
    assert.equal(run("document.getElementById('btn-radar-clear').hidden"), false, 'モーダルでは隠さず4つ目の枠に置く');

    // 開く: モーダル (dialog) として扱い、フォーカスも移す
    run('openRadarFilters()');
    assert.equal(run('isRadarFiltersOpen()'), true, 'タップでシートが開く');
    assert.equal(run('isRadarFiltersSheetOpen()'), true);
    assert.equal(run("document.getElementById('radar-subcontrols').getAttribute('role')"), 'dialog');
    assert.equal(run("document.getElementById('radar-subcontrols').getAttribute('aria-modal')"), 'true');
    assert.equal(run("document.getElementById('btn-radar-filters-toggle').getAttribute('aria-expanded')"), 'true');
    assert.equal(run("document.getElementById('radar-subcontrols').focused"), true, '開いたらシートへフォーカス');

    // Esc (closeTopmostModal) で閉じ、開いたボタンへフォーカスが戻る
    // (他のモーダルが開いたままだとそちらが優先されるため、初期状態に戻しておく)
    run("['create-playlist-modal', 'edit-playlist-modal', 'move-track-modal', 'export-preview-modal', 'login-modal'].forEach(id => { document.getElementById(id).style.display = 'none'; });");
    assert.equal(run('closeTopmostModal()'), true, 'Escで閉じる');
    assert.equal(run('isRadarFiltersOpen()'), false);
    assert.equal(run('isRadarFiltersSheetOpen()'), false);
    assert.equal(run("document.getElementById('radar-subcontrols').getAttribute('role')"), null, '通常のツールバーに戻す');
    assert.equal(run("document.getElementById('radar-subcontrols').getAttribute('aria-modal')"), null);
    assert.equal(run("document.getElementById('btn-radar-filters-toggle').getAttribute('aria-expanded')"), 'false', '閉じたら展開状態を戻す');
    assert.equal(run("document.getElementById('btn-radar-filters-toggle').focused"), true, '開いたボタンへ戻す');
    assert.equal(run('closeTopmostModal()'), false, '閉じたあとは閉じる対象が無い');

    // トグルでも開閉できる
    run('toggleRadarFilters()');
    assert.equal(run('isRadarFiltersOpen()'), true);
    run('toggleRadarFilters()');
    assert.equal(run('isRadarFiltersOpen()'), false);
});

test('Radarの絞り込みは適用中なら件数を出し、シートを開いて見せる', () => {
    run("window.innerWidth = 390; window.matchMedia = q => ({ matches: /max-width: 600px/.test(String(q)) });");
    run(`
        closeRadarFilters();
        document.getElementById('radar-category-filter').value = 'Vocaloid';
        document.getElementById('radar-tempo-filter').value = 'fast';
        updateRadarFiltersToggle();
    `);
    assert.equal(run("document.getElementById('btn-radar-filters-toggle').textContent"), '絞り込み(2)');
    assert.equal(run("document.getElementById('btn-radar-filters-toggle').classList.contains('is-active')"), true);
    assert.equal(run('isRadarFiltersOpen()'), true, '畳んだままだと変えられない条件はシートを開いて見せる');
    assert.equal(run("document.getElementById('btn-radar-clear').classList.contains('is-empty')"), false, '条件があれば条件クリアを有効な見た目にする');

    run(`
        document.getElementById('radar-category-filter').value = '';
        document.getElementById('radar-tempo-filter').value = '';
        updateRadarFiltersToggle();
        closeRadarFilters();
    `);
    assert.equal(run("document.getElementById('btn-radar-filters-toggle').textContent"), '絞り込み');
    assert.equal(run("document.getElementById('btn-radar-clear').classList.contains('is-empty')"), true);
});

test('PC幅ではRadarの絞り込みはシートにせず、ツールバー内のまま扱う', () => {
    run("window.innerWidth = 1280; window.matchMedia = () => ({ matches: false });");
    run(`
        document.getElementById('radar-tempo-filter').value = 'fast';
        closeRadarFilters();
        updateRadarFiltersToggle();
    `);
    assert.equal(run('isRadarFiltersSheetOpen()'), false, 'PCではシート扱いにしない');
    assert.equal(run("document.getElementById('btn-radar-filters-toggle').textContent"), '絞り込み(1)');
    run("document.getElementById('radar-tempo-filter').value = ''; updateRadarFiltersToggle();");
    assert.equal(run("document.getElementById('btn-radar-clear').classList.contains('is-empty')"), true);
});

test('Radar下部一覧は横端でもトラックパッド操作を一覧内で消費する', () => {
    const strip = elementById('vibe-track-strip');
    strip.scrollWidth = 1200;
    strip.clientWidth = 400;
    strip.scrollLeft = 800;
    strip.scrollBy = ({ left }) => { strip.scrollLeft += left; };
    strip.scrollTo = ({ left }) => { strip.scrollLeft = left; };
    run('bindRadarStripScroll()');
    assert.equal(strip.handlers.get('wheel').length, 1, 'wheelリスナーは1回だけ登録');
    run('bindRadarStripScroll()');
    assert.equal(strip.handlers.get('wheel').length, 1, '再初期化でも多重登録しない');

    let prevented = false;
    let stopped = false;
    strip.fire('wheel', {
        deltaX: 80, deltaY: 2, deltaMode: 0,
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
    });
    assert.equal(strip.scrollLeft, 800, '右端を越えてスクロールしない');
    assert.equal(prevented, true, '端でも既定動作を止めて履歴ジェスチャーへ渡さない');
    assert.equal(stopped, true, '親要素へ伝播しない');

    prevented = false;
    strip.fire('wheel', {
        deltaX: 1, deltaY: 80, deltaMode: 0,
        preventDefault() { prevented = true; },
    });
    assert.equal(prevented, false, '縦方向のページスクロールは妨げない');

    let keyPrevented = false;
    strip.fire('keydown', {
        key: 'Home', preventDefault() { keyPrevented = true; }, stopPropagation() { },
    });
    assert.equal(strip.scrollLeft, 0, 'Homeキーで先頭へ移動');
    assert.equal(keyPrevented, true);

    keyPrevented = false;
    strip.fire('keydown', {
        key: 'ArrowLeft', metaKey: true,
        preventDefault() { keyPrevented = true; }, stopPropagation() { },
    });
    assert.equal(keyPrevented, false, 'Cmd/Ctrl等を伴うキーはブラウザ・OSへ渡す');
});

test('Radarマップのキー操作はブラウザ標準ショートカットと競合しない', () => {
    assert.equal(run("radarKeyboardAction({ key: '+', metaKey: true })"), '', 'Cmd+Plusはブラウザへ渡す');
    assert.equal(run("radarKeyboardAction({ key: '-', ctrlKey: true })"), '', 'Ctrl+Minusはブラウザへ渡す');
    assert.equal(run("radarKeyboardAction({ key: '0', ctrlKey: true })"), '', 'Ctrl+0はブラウザへ渡す');
    assert.equal(run("radarKeyboardAction({ key: 'ArrowLeft', metaKey: true })"), '', 'Cmd+左はブラウザへ渡す');
    assert.equal(run("radarKeyboardAction({ key: ':' })"), 'zoom-in', 'コロンでズームインする');
    assert.equal(run("radarKeyboardAction({ key: ';' })"), 'zoom-out', 'セミコロンでズームアウトする');
    assert.equal(run("radarKeyboardAction({ key: ':', metaKey: true })"), '', 'Cmd+コロンはブラウザへ渡す');
    assert.equal(run("radarKeyboardAction({ key: ';', ctrlKey: true })"), '', 'Ctrl+セミコロンはブラウザへ渡す');
    assert.equal(run("radarKeyboardAction({ key: '+', shiftKey: true })"), 'zoom-in', 'Shiftで入力したPlusもズームインに使う');
    assert.equal(run("radarKeyboardAction({ key: '-' })"), 'zoom-out', 'Minusもズームアウトに使う');
    assert.equal(run("radarKeyboardAction({ key: 'F' })"), 'fit', 'Fで表示中の曲を全体表示する');
});

test('ヘルプに実装済みのキーボードショートカットを案内する', () => {
    const html = fs.readFileSync(`${__dirname}/../frontend/index.html`, 'utf8');
    assert.match(html, /href="#help-shortcuts"/, '目次からショートカット欄へ移動できる');
    const section = html.match(/<section class="help-section" id="help-shortcuts">([\s\S]*?)<\/section>/)?.[1] || '';
    assert.match(section, /検索欄/, '検索欄の操作を説明する');
    assert.match(section, /Radarマップ/, 'Radarマップの操作を説明する');
    assert.match(section, /Radar下部の楽曲一覧/, 'Radar下部一覧の操作を説明する');
    for (const key of ['Enter', 'Esc', 'F', 'Home', 'End']) {
        assert.match(section, new RegExp(`<kbd>${key}<\\/kbd>`), `${key}キーを掲載する`);
    }
    assert.match(section, /<kbd>:<\/kbd> \/ <kbd>;<\/kbd><span>ズームイン \/ ズームアウト<\/span>/, 'ズームは コロン / セミコロン を掲載する');
    assert.match(section, /<kbd>:<\/kbd>（拡大）と<kbd>;<\/kbd>（縮小）/, 'どちらが拡大/縮小かを説明する');
    const guide = html.match(/<div class="radar-keyboard-guide" id="radar-keyboard-guide">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.match(guide, /<kbd>:<\/kbd><kbd>;<\/kbd> ズーム/, 'マップ上のキー案内にコロン/セミコロンを出す');
    assert.doesNotMatch(html, /プラスでズームイン/, '旧プラス/マイナス表記を残さない');
    assert.doesNotMatch(section, /Shift<\/kbd>\+<kbd>[NP]/, '未実装の曲送り操作を掲載しない');
});

test('並び順に新着順があり、追加日時 (added_at) の新しい順に並ぶ', () => {
    // 4つ目の枠と並び順は index.html (ビルド元のテンプレート) の構造もテストする
    const html = fs.readFileSync(`${__dirname}/../frontend/index.html`, 'utf8');
    assert.match(html, /<option value="newest">新着順<\/option>/, '並び順に新着順がある');
    const sheetBody = html.match(/<div class="radar-filters-body">([\s\S]*?)<\/div>/)[1];
    assert.equal((sheetBody.match(/<select /g) || []).length, 3, '絞り込みの選択肢は3つ');
    assert.match(sheetBody, /id="btn-radar-clear"/, '条件クリアを4つ目の枠に置く');
    assert.match(sheetBody, /id="radar-sort"[\s\S]*id="btn-radar-clear"/, '条件クリアは絞り込みの後ろ (4つ目)');

    const ordered = run(`
        (function () {
            const tracks = [
                { title: '古い曲', added_at: '2026-01-01 00:00:00' },
                { title: '日時なし', added_at: null },
                { title: '新しい曲', added_at: '2026-09-01 12:00:00' },
            ];
            const sorted = sortRadarTracks(tracks, 'newest');
            // 元の配列を書き換えないこと (呼び出し元の一覧を壊さない)
            return sorted.map(t => t.title).join(',') + ' / ' + tracks.map(t => t.title).join(',');
        })()
    `);
    assert.equal(ordered, '新しい曲,古い曲,日時なし / 古い曲,日時なし,新しい曲', '追加日時の新しい順・日時が無い曲は最後・元の配列は保持');

    // これまでの並び順は変わらない (default は API の返却順)
    const others = run(`
        (function () {
            const tracks = [
                { title: 'b', features: { tempo: 120 } },
                { title: 'a', features: { tempo: 90 } },
            ];
            return [
                sortRadarTracks(tracks, 'title'),
                sortRadarTracks(tracks, 'bpm-desc'),
                sortRadarTracks(tracks, 'bpm-asc'),
                sortRadarTracks(tracks, 'default'),
            ].map(list => list.map(t => t.title).join('')).join(' ');
        })()
    `);
    assert.equal(others, 'ab ba ab ba', 'タイトル順 / BPM降順 / BPM昇順 / 既定の順');
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
