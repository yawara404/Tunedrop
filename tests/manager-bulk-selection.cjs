// ==========================================================
// Manager: 複数選択 (一括操作) の単体テスト
// ----------------------------------------------------------
// 使い方:
//   node tests/manager-bulk-selection.cjs
// ==========================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function assertArrayEqual(actual, expected, message) {
    assert.deepEqual(Array.from(actual), Array.from(expected), message);
}

function selectorList(selector) {
    return String(selector).split(',').map(part => part.trim()).filter(Boolean);
}

function matchesSelector(element, selector) {
    return selectorList(selector).some(part => (element.selectors || []).includes(part));
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
        this.disabled = false;
        this.hidden = false;
        this.innerText = '';
        this.textContent = '';
        this.innerHTML = '';
    }
    get className() { return this.classList.toString(); }
    set className(value) {
        this.classList = new FakeClassList();
        String(value).split(/\s+/).filter(Boolean).forEach(name => this.classList.add(name));
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) {
        if (child instanceof FakeElement) { child.parent = this; this.children.push(child); }
        return child;
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (matchesSelector(child, selector) || (selector.startsWith('#') && child.id === selector.slice(1))) {
                return child;
            }
            const found = child.querySelector(selector);
            if (found) return found;
        }
        return null;
    }
    querySelectorAll(selector) {
        const results = [];
        for (const child of this.children) {
            if (matchesSelector(child, selector) || (selector.startsWith('#') && child.id === selector.slice(1))) {
                results.push(child);
            }
            results.push(...child.querySelectorAll(selector));
        }
        return results;
    }
    addEventListener(type, handler) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type).push(handler);
    }
    removeEventListener() { }
    focus() { this.focused = true; }
    remove() {
        if (this.parent) {
            const idx = this.parent.children.indexOf(this);
            if (idx >= 0) this.parent.children.splice(idx, 1);
        }
    }
}

const elements = new Map();
function getOrCreateElement(id) {
    if (!elements.has(id)) {
        elements.set(id, new FakeElement({ id, selectors: [`#${id}`] }));
    }
    return elements.get(id);
}

// 必要な要素を事前に準備
const grid = getOrCreateElement('my-bookmarks');
const toggleBtn = getOrCreateElement('btn-manager-select-mode');
const toggleLabel = new FakeElement({ selectors: ['.manager-select-label'] });
toggleBtn.appendChild(toggleLabel);

const bulkBar = getOrCreateElement('manager-bulk-bar');
const bulkCount = getOrCreateElement('manager-bulk-count');
const favLabel = getOrCreateElement('manager-bulk-fav-label');
const favIcon = getOrCreateElement('manager-bulk-fav-icon');

const bulkPlayBtn = new FakeElement({ selectors: ['[data-manager-bulk-action]'] });
const bulkFavBtn = new FakeElement({ selectors: ['[data-manager-bulk-action]'] });
const bulkMoveBtn = new FakeElement({ selectors: ['[data-manager-bulk-action]'] });
const bulkDeleteBtn = new FakeElement({ selectors: ['[data-manager-bulk-action]'] });

bulkBar.appendChild(bulkCount);
bulkBar.appendChild(favLabel);
bulkBar.appendChild(favIcon);
bulkBar.appendChild(bulkPlayBtn);
bulkBar.appendChild(bulkFavBtn);
bulkBar.appendChild(bulkMoveBtn);
bulkBar.appendChild(bulkDeleteBtn);

const moveModal = getOrCreateElement('move-track-modal');
const moveSelect = getOrCreateElement('move-target-playlist-select');
const moveTitle = getOrCreateElement('move-track-modal-title');
const moveSubmitBtn = getOrCreateElement('move-track-submit');

const documentMock = {
    getElementById(id) { return getOrCreateElement(id); },
    createElement(tag) { return new FakeElement({ selectors: [tag] }); },
    querySelector(selector) {
        if (selector === '#btn-manager-select-mode') return toggleBtn;
        if (selector === '#manager-bulk-bar') return bulkBar;
        return null;
    },
    querySelectorAll(selector) {
        if (selector === '[data-manager-bulk-action]') {
            return [bulkPlayBtn, bulkFavBtn, bulkMoveBtn, bulkDeleteBtn];
        }
        return [];
    },
    addEventListener() { },
    body: new FakeElement({ id: 'body' }),
};

const windowMock = {
    addEventListener() { },
    location: { href: 'http://localhost/' },
    localStorage: {
        getItem() { return null; },
        setItem() { },
        removeItem() { },
    },
    matchMedia() { return { matches: false, addEventListener() { } }; },
};

const code = fs.readFileSync('frontend/app.js', 'utf8')
    .replace(/^export /gm, '');

const fetchCalls = [];
const toasts = [];
let confirmResult = true;

const sandbox = {
    document: documentMock,
    window: windowMock,
    console,
    URL,
    URLSearchParams,
    Headers,
    AbortController,
    setTimeout: (fn) => fn(),
    clearTimeout() { },
    setInterval() { },
    clearInterval() { },
    localStorage: windowMock.localStorage,
    fetchCalls,
    toasts,
    get confirmResult() { return confirmResult; },
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

// テスト用データ設定・関数スタブの差し替え
vm.runInContext(`
tunedropFetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    const urlStr = String(url);
    let data;
    if (urlStr.includes('get_my_bookmarks') || urlStr.includes('get_bookmarks')) {
        data = [
            { id: 101, youtube_id: 'vid1', title: 'Song 1', channel: 'Artist 1', is_favorite: 0 },
            { id: 102, youtube_id: 'vid2', title: 'Song 2', channel: 'Artist 2', is_favorite: 0 },
            { id: 103, youtube_id: 'vid3', title: 'Song 3', channel: 'Artist 3', is_favorite: 1 },
        ];
    } else if (urlStr.includes('action=get_playlists')) {
        data = [
            { id: 1, name: 'List A', category: 'J-POP' },
            { id: 2, name: 'List B', category: 'Anime' },
        ];
    } else {
        data = { success: true, moved: 2, deleted: 2, is_favorite: 1, youtube_ids: ['vid1', 'vid2'] };
    }
    return {
        ok: true,
        json: async () => data,
    };
};
showToast = (msg, kind) => { toasts.push({ msg, kind }); };
showConfirm = async () => confirmResult;

currentTracks = [
    { id: 101, youtube_id: 'vid1', title: 'Song 1', channel: 'Artist 1', is_favorite: 0 },
    { id: 102, youtube_id: 'vid2', title: 'Song 2', channel: 'Artist 2', is_favorite: 0 },
    { id: 103, youtube_id: 'vid3', title: 'Song 3', channel: 'Artist 3', is_favorite: 1 },
];
allPlaylists = [
    { id: 1, name: 'List A', category: 'J-POP' },
    { id: 2, name: 'List B', category: 'Anime' },
];
`, sandbox);

(async () => {
console.log('--- テスト開始: Manager複数選択 ---');

// 1. 初期状態
assert.equal(sandbox.isManagerSelectMode(), false, '初期状態は選択モードOFF');
assert.equal(sandbox.selectedManagerTrackIds().length, 0, '初期状態は選択曲なし');

// 2. toggleManagerSelectMode
sandbox.toggleManagerSelectMode(true);
assert.equal(sandbox.isManagerSelectMode(), true, '選択モードON');
assert.equal(toggleBtn.classList.contains('is-active'), true, 'トグルボタンがis-active');
assert.equal(toggleLabel.textContent, '選択中', 'トグルボタンのラベルが「選択中」');
assert.equal(bulkBar.hidden, false, '一括操作バーが表示される');
assert.equal(bulkCount.textContent, '0', '初期選択数は0');
assert.equal(bulkDeleteBtn.disabled, true, '選択数0の時は一括操作ボタンdisabled');

// 3. toggleTrackSelection (個別選択)
sandbox.toggleTrackSelection(101);
assertArrayEqual(sandbox.selectedManagerTrackIds(), [101], '101が選択された');
assert.equal(bulkCount.textContent, '1', '選択数が1件に更新');
assert.equal(bulkDeleteBtn.disabled, false, '選択がある時は一括操作ボタン有効');
assert.equal(favLabel.textContent, 'お気に入り追加', '101は未お気に入りなので「お気に入り追加」');

// 4. toggleTrackSelection (解除)
sandbox.toggleTrackSelection(101);
assertArrayEqual(sandbox.selectedManagerTrackIds(), [], '101が解除された');
assert.equal(bulkCount.textContent, '0', '選択数が0件に戻る');

// 5. Shift+クリック範囲選択
sandbox.toggleTrackSelection(101);
sandbox.toggleTrackSelection(103, { shiftKey: true });
assertArrayEqual(sandbox.selectedManagerTrackIds().sort(), [101, 102, 103], '101から103までまとめて範囲選択');
assert.equal(bulkCount.textContent, '3', '選択数が3件');

// 6. 全選択と全解除
sandbox.clearManagerSelection();
assert.equal(sandbox.selectedManagerTrackIds().length, 0, 'クリアで0件');
assert.equal(bulkCount.textContent, '0');

sandbox.selectAllVisibleTracks();
assertArrayEqual(sandbox.selectedManagerTrackIds().sort(), [101, 102, 103], '表示中の全曲が選択');

// 7. お気に入り一括更新
fetchCalls.length = 0;
toasts.length = 0;
await sandbox.bulkToggleSelectedFavorite();
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].url, 'api.php?action=bulk_set_favorite_bookmarks');
const favPayload = JSON.parse(fetchCalls[0].opts.body);
assertArrayEqual(favPayload.ids.sort(), [101, 102, 103]);
assert.ok(toasts.some(t => t.msg.includes('お気に入り')));

// 8. 移動モーダル
sandbox.bulkOpenMoveModal();
assert.equal(moveModal.style.display, 'flex', '移動モーダルが表示');
assert.ok(moveTitle.textContent.includes('3曲'), 'タイトルに件数表示');

// 移動実行
fetchCalls.length = 0;
moveSelect.value = '2';
await sandbox.submitMoveTrack();
assert.equal(fetchCalls.length >= 1, true);
const moveCall = fetchCalls.find(c => c.url.includes('bulk_move_bookmarks'));
assert.ok(moveCall, 'bulk_move_bookmarks が呼ばれた');
const movePayload = JSON.parse(moveCall.opts.body);
assertArrayEqual(movePayload.ids.sort(), [101, 102, 103]);
assert.equal(movePayload.target_playlist_id, '2');

// 9. 削除実行
sandbox.selectAllVisibleTracks();
fetchCalls.length = 0;
toasts.length = 0;
await sandbox.bulkDeleteSelectedTracks();
const deleteCall = fetchCalls.find(c => c.url.includes('bulk_delete_bookmarks'));
assert.ok(deleteCall, 'bulk_delete_bookmarks が呼ばれた');
const deletePayload = JSON.parse(deleteCall.opts.body);
assertArrayEqual(deletePayload.ids.sort(), [101, 102, 103]);
assert.ok(toasts.some(t => t.msg.includes('削除しました')));
assert.equal(sandbox.selectedManagerTrackIds().length, 0, '削除後は選択がクリアされる');

// 10. 選択モードOFFでの復帰
sandbox.toggleTrackSelection(101); // 選択モードOFF状態からチェックボックスを押すと自動でONになる
assert.equal(sandbox.isManagerSelectMode(), true, '自動で選択モードON');
sandbox.toggleManagerSelectMode(false);
assert.equal(sandbox.isManagerSelectMode(), false, '選択モードOFF');
assert.equal(bulkBar.hidden, true, 'バーが隠れる');
assert.equal(toggleLabel.textContent, '選択', 'ラベルが「選択」に戻る');

// 11. プレイリスト切替・画面切替時のリセット
sandbox.toggleManagerSelectMode(true);
sandbox.toggleTrackSelection(102);
assert.equal(sandbox.selectedManagerTrackIds().length, 1);
sandbox.selectPlaylist('fav_tracks');
assert.equal(sandbox.isManagerSelectMode(), false, 'リスト切替でリセット');
assert.equal(sandbox.selectedManagerTrackIds().length, 0);

console.log('PASS: Manager複数選択の全テスト項目が成功しました！');
})().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
