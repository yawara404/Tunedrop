// ==========================================================
// Manager プレイリスト一覧のリアクティブ描画 (Vue 3)
// ----------------------------------------------------------
// サイドバー (#playlist-nav) と カード一覧 (#my-playlists-grid) を
// Vue の keyed v-for で描画し、並び替えはリアクティブ配列の並び替えだけで完結させる。
// これにより「並び替えで画面を丸ごと作り直す (リロードに見える)」ことがなくなる。
// ==========================================================
import { createApp, reactive, computed } from '../vendor/vue.esm-browser.prod.js';

const CATEGORIES = ['Vocaloid', 'J-POP', 'Anime', 'Lo-Fi', 'Other'];
const SYSTEM_ORDER = { inbox: 0, public_favorites: 1 };

const isSystem = (list) => Boolean(list && (list.system_key || list.is_default == 1));
const compareSystem = (a, b) => {
    const oa = SYSTEM_ORDER[a.system_key] ?? 9;
    const ob = SYSTEM_ORDER[b.system_key] ?? 9;
    return oa - ob || (a.id ?? 0) - (b.id ?? 0);
};
const coverUrl = (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`;

const store = reactive({
    systemLists: [],     // 固定タブ (未整理 / 公開用お気に入り) — 常に表示・並び替え不可
    userLists: [],       // ユーザー作成リスト (検索・カテゴリで絞り込み済み、並び替え可能)
    currentPlaylistId: 'home',
    homeMode: 'home',    // 'home' | 'fav_playlists'
    sortMode: 'custom',
});

// グリッド表示用: 固定タブ + ユーザーリスト (お気に入りモード・ソートを反映)
const gridLists = computed(() => {
    let systems = store.homeMode === 'fav_playlists'
        ? store.systemLists.filter(l => l.is_favorite == 1)
        : store.systemLists;
    let users = store.homeMode === 'fav_playlists'
        ? store.userLists.filter(l => l.is_favorite == 1)
        : [...store.userLists];
    users = sortLists(users, store.sortMode);
    return [...systems, ...users];
});

function sortLists(arr, mode) {
    const out = [...arr];
    switch (mode) {
        case 'newest':
            return out.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
        case 'oldest':
            return out.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        case 'name':
            return out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
        default:
            return out.sort((a, b) => ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || ((a.id ?? 0) - (b.id ?? 0)));
    }
}

// dragId を targetId の位置へ移動する (after=true なら target の直後)。並び替え可能なユーザーリストのみ対象。
function moveUserListRelative(dragId, targetId, after) {
    const arr = store.userLists;
    const from = arr.findIndex(l => l.id === dragId);
    if (from < 0) return false;
    const [moved] = arr.splice(from, 1);
    let to = arr.findIndex(l => l.id === targetId);
    if (to < 0) { arr.splice(from, 0, moved); return false; }
    if (after) to += 1;
    arr.splice(to, 0, moved);
    arr.forEach((l, i) => { l.sort_order = i; });
    return true;
}

function persistOrder() {
    if (typeof window.onPlaylistsReordered === 'function') {
        window.onPlaylistsReordered(store.userLists.map(l => l.id));
    }
}
function markDragEnded() {
    if (typeof window.markDragEnded === 'function') window.markDragEnded();
}

// --- サイドバー ---
const Sidebar = {
    setup() {
        return { store, CATEGORIES };
    },
    methods: {
        select(id) { window.selectPlaylist(id); },
        onUserClick(l, e) {
            if (e.currentTarget._dragged || e.currentTarget._pointerDragged) return;
            window.selectPlaylist(l.id);
        },
        menu(e) { window.toggleSidebarMenu(e, e.currentTarget); },
        edit(e, id) { window.openEditPlaylistModal(e, id); },
        del(e, id) { window.deletePlaylistFromSidebar(e, id); },
        dragStart(l, e) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(l.id));
            e.currentTarget.classList.add('dragging');
            e.currentTarget._dragged = true;
        },
        dragEnd(e) {
            const el = e.currentTarget;
            markDragEnded();
            el.classList.remove('dragging');
            document.querySelectorAll('.playlist-nav li').forEach(x => x.classList.remove('drag-over'));
            setTimeout(() => { el._dragged = false; }, 0);
        },
        dragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const el = e.currentTarget;
            if (!el.classList.contains('drag-over')) el.classList.add('drag-over');
        },
        dragLeave(e) { e.currentTarget.classList.remove('drag-over'); },
        drop(l, e) {
            e.preventDefault();
            e.currentTarget.classList.remove('drag-over');
            const draggedId = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (!draggedId || draggedId === l.id) return;
            moveUserListRelative(draggedId, l.id, false);
            markDragEnded();
            persistOrder();
        },
    },
    template: `
      <li @click="select('home')" :class="{ active: store.currentPlaylistId === 'home' }"><span class="material-symbols-rounded nav-li-icon">home</span>ホーム (リスト一覧)</li>
      <li @click="select('fav_playlists')" :class="{ active: store.currentPlaylistId === 'fav_playlists' }"><span class="material-symbols-rounded nav-li-icon">favorite</span>お気に入りリスト</li>
      <li @click="select('fav_tracks')" :class="{ active: store.currentPlaylistId === 'fav_tracks' }"><span class="material-symbols-rounded nav-li-icon">music_note</span>お気に入り曲</li>
      <li @click="select(null)" :class="{ active: store.currentPlaylistId === null }"><span class="material-symbols-rounded nav-li-icon">library_music</span>すべてのブックマーク</li>
      <li v-for="l in store.systemLists" :key="'sys' + l.id" class="drag-static" :class="{ active: store.currentPlaylistId === l.id }" :data-plid="l.id" @click="select(l.id)">
        <span class="list-name-wrap"><span class="list-name" :title="l.name">{{ l.name }}</span></span><span class="material-symbols-rounded nav-drag-icon drag-static">lock</span>
      </li>
      <li v-for="l in store.userLists" :key="l.id" class="draggable-pl" :class="{ active: store.currentPlaylistId === l.id }" :data-plid="l.id" draggable="true"
          @click="onUserClick(l, $event)"
          @dragstart="dragStart(l, $event)" @dragend="dragEnd($event)" @dragover="dragOver($event)" @dragleave="dragLeave($event)" @drop="drop(l, $event)">
        <div style="display:flex; align-items:center; overflow:hidden; flex:1;">
          <span class="material-symbols-rounded nav-drag-icon">drag_indicator</span>
          <span class="list-name-wrap"><span class="list-name" :title="l.name">{{ l.name }}</span></span><span v-if="l.category" class="cat-badge">{{ l.category }}</span>
        </div>
        <div class="sidebar-menu-container" @click.stop>
          <button class="sidebar-menu-btn" @click="menu"><span class="material-symbols-rounded">more_vert</span></button>
          <div class="sidebar-dropdown-menu">
            <button @click="edit($event, l.id)"><span class="material-symbols-rounded">edit</span>編集・公開</button>
            <button @click="del($event, l.id)"><span class="material-symbols-rounded">delete</span>削除</button>
          </div>
        </div>
      </li>
    `,
};

// --- カード一覧 (グリッド) ---
const Grid = {
    setup() {
        return { store, gridLists, CATEGORIES, coverUrl, isSystem };
    },
    methods: {
        select(id) { window.selectPlaylist(id); },
        onUserClick(l, e) {
            if (e.currentTarget._dragged || e.currentTarget._pointerDragged) return;
            window.selectPlaylist(l.id);
        },
        changeCat(id, e) { window.updatePlaylistCategory(id, e.target.value, e); },
        dragStart(l, e) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(l.id));
            e.currentTarget.classList.add('dragging');
            e.currentTarget._dragged = true;
        },
        dragEnd(e) {
            const el = e.currentTarget;
            markDragEnded();
            el.classList.remove('dragging');
            document.querySelectorAll('#my-playlists-grid .card').forEach(x => x.classList.remove('drag-over'));
            setTimeout(() => { el._dragged = false; }, 0);
        },
        dragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const el = e.currentTarget;
            if (!el.classList.contains('drag-over')) el.classList.add('drag-over');
        },
        dragLeave(e) { e.currentTarget.classList.remove('drag-over'); },
        drop(l, e) {
            e.preventDefault();
            e.currentTarget.classList.remove('drag-over');
            const draggedId = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (!draggedId || draggedId === l.id) return;
            moveUserListRelative(draggedId, l.id, false);
            markDragEnded();
            persistOrder();
        },
    },
    template: `
      <p v-if="!gridLists.length" style="color:var(--text-sub); grid-column: 1 / -1;">プレイリストがありません。</p>
      <div v-for="l in gridLists" :key="l.id" class="card draggable-track" :class="{ 'is-system': isSystem(l) }"
           :data-plid="l.id" :draggable="!isSystem(l)"
           @click="isSystem(l) ? select(l.id) : onUserClick(l, $event)"
           @dragstart="!isSystem(l) && dragStart(l, $event)" @dragend="!isSystem(l) && dragEnd($event)"
           @dragover="!isSystem(l) && dragOver($event)" @dragleave="!isSystem(l) && dragLeave($event)"
           @drop="!isSystem(l) && drop(l, $event)">
        <select v-if="!isSystem(l)" class="card-cat-select" @change="changeCat(l.id, $event)" @click.stop>
          <option v-for="c in CATEGORIES" :key="c" :value="c" :selected="l.category === c">{{ c }}</option>
        </select>
        <div class="card-img-wrapper">
          <img v-if="l.cover_id" :src="coverUrl(l.cover_id)" alt="cover">
          <div v-else style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:40px;">🎵</div>
        </div>
        <div class="info with-handle">
          <div class="info-text">
            <div class="title">{{ l.name }}</div>
            <div class="artist">マイリスト</div>
          </div>
          <div v-if="!isSystem(l)" class="drag-handle" title="ドラッグで並び替え"><span class="material-symbols-rounded">drag_indicator</span></div>
        </div>
      </div>
    `,
};

// --- タッチ端末 (Pointer Events) の並び替え ---
function attachPointerReorder(containerEl) {
    if (!containerEl) return;
    containerEl.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
        const handle = e.target.closest('.nav-drag-icon, .drag-handle');
        if (!handle) return;
        const item = handle.closest('[data-plid]');
        if (!item || !containerEl.contains(item)) return;
        const dragId = Number(item.dataset.plid);
        if (!dragId) return;
        e.preventDefault();
        e.stopPropagation();

        item.classList.add('dragging');
        let moved = false;
        let dragOverTarget = null;
        let ghost = null;
        let pointerId = e.pointerId;
        const startX = e.clientX;
        const startY = e.clientY;
        try { handle.setPointerCapture(pointerId); } catch (_) {}

        // マウスのドラッグゴースト相当の浮遊コピーを作る (見た目を保つため実体を複製)
        const rect = item.getBoundingClientRect();
        ghost = item.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        ghost.style.left = rect.left + 'px';
        ghost.style.top = rect.top + 'px';
        document.body.appendChild(ghost);

        const clearDragOver = () => {
            if (dragOverTarget) { dragOverTarget.classList.remove('drag-over'); dragOverTarget = null; }
        };
        const removeGhost = () => {
            if (ghost) { ghost.remove(); ghost = null; }
        };

        const move = (ev) => {
            if (ev.pointerId !== pointerId) return;
            ev.preventDefault();
            if (ghost) {
                ghost.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`;
            }
            // 浮遊コピーが hit-test を邪魔しないよう一時的に隠して、指の下の要素を特定する
            if (ghost) ghost.style.display = 'none';
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            if (ghost) ghost.style.display = '';
            const target = el && el.closest('[data-plid]');
            if (!target || target === item || !containerEl.contains(target)) { clearDragOver(); return; }
            const tid = Number(target.dataset.plid);
            if (!tid || tid === dragId) { clearDragOver(); return; }
            // マウスの dragover と同じように、指の下にある要素へ黄色い枠を表示する
            if (target !== dragOverTarget) {
                clearDragOver();
                dragOverTarget = target;
                target.classList.add('drag-over');
            }
            const targetRect = target.getBoundingClientRect();
            const after = ev.clientY > targetRect.top + targetRect.height / 2;
            if (moveUserListRelative(dragId, tid, after)) moved = true;
        };
        const up = (ev) => {
            if (ev && ev.pointerId !== pointerId) return;
            // 指を離したら必ず元の見た目へ戻す (ゴースト・黄色枠・半透明をすべて解除)
            document.removeEventListener('pointermove', move, true);
            document.removeEventListener('pointerup', up, true);
            document.removeEventListener('pointercancel', up, true);
            clearDragOver();
            removeGhost();
            item.classList.remove('dragging');
            try { handle.releasePointerCapture(pointerId); } catch (_) {}
            pointerId = null;
            if (moved) { markDragEnded(); persistOrder(); }
        };
        // 指が要素の外へ出ても確実に終了処理が走るよう document レベルで監視する
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', up, true);
        document.addEventListener('pointercancel', up, true);
    });
}

// --- マウント ---
createApp(Sidebar).mount('#playlist-nav');
createApp(Grid).mount('#my-playlists-grid');

attachPointerReorder(document.getElementById('playlist-nav'));
attachPointerReorder(document.getElementById('my-playlists-grid'));

// --- app.js から呼ばれるブリッジ ---
window.ManagerLists = {
    store,
    setData({ systemLists = [], userLists = [], currentPlaylistId = 'home', homeMode = 'home', sortMode = 'custom' } = {}) {
        store.systemLists = [...systemLists];
        store.userLists = [...userLists];
        store.currentPlaylistId = currentPlaylistId;
        store.homeMode = homeMode;
        store.sortMode = sortMode;
    },
    setCurrent(currentPlaylistId, homeMode) {
        store.currentPlaylistId = currentPlaylistId;
        if (homeMode) store.homeMode = homeMode;
    },
    reorder(draggedId, targetId) {
        if (moveUserListRelative(draggedId, targetId, false)) persistOrder();
    },
};
