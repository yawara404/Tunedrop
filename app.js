let player;
let playerReady = false;
let isPlaying = false;
let progressInterval;
let currentPlaylistId = 'home';
let currentQueue = [];
let currentTrackIndex = -1;

let allPlaylists = [];
let allRadarPlaylists = [];
let allRadarRecentPlaylists = [];
let sharePlaylists = [];
let currentTracks = [];
let currentDetailTracks = [];
let selectedTrackIdForMove = null;
let playlistSortMode = 'custom';   // custom | newest | oldest | name
let trackSortMode = 'custom';      // custom | newest | oldest | name

// ==========================================================
// 固定タブ (未整理 / 公開用お気に入り)
// 全ユーザー共通でサイドバーに常時表示し、並び替え・削除・タグ変更ができない。
// サムネイルは api.php が「最後に保存した曲」を返す。
// ==========================================================
const SYSTEM_PLAYLIST_ORDER = { inbox: 0, public_favorites: 1 };

function isSystemPlaylist(list) {
    if (!list) return false;
    return Boolean(list.system_key) || list.is_default == 1;
}

function compareSystemPlaylists(a, b) {
    const orderA = SYSTEM_PLAYLIST_ORDER[a.system_key] ?? 9;
    const orderB = SYSTEM_PLAYLIST_ORDER[b.system_key] ?? 9;
    return orderA - orderB || (a.id ?? 0) - (b.id ?? 0);
}



// ==========================================================
// モバイルのハンバーガーメニュー
// 上部ナビ (通常は非表示) と Manager/Radar のサイドバー (リスト・Radar操作) を
// まとめて開閉する。body.mobile-menu-open を状態の唯一の基準にすることで、
// 一部だけ開いたまま・閉じたままになる不整合を防ぐ。
// 開いている間に「他の操作」をした場合は自動的に閉じる (下の listeners を参照)。
// ==========================================================
function isMobileMenuOpen() {
    return document.body.classList.contains('mobile-menu-open');
}

// ハンバーガーボタンの見た目以外の状態 (スクリーンリーダー向け) を揃える
function syncMobileMenuButton(open) {
    const button = document.getElementById('menu-toggle-btn');
    if (!button) return;
    const label = open ? 'メニューを閉じる' : 'メニューを開く';
    button.setAttribute('aria-expanded', String(Boolean(open)));
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
}

// メニューを閉じる (開いていた場合のみ true)
function closeMobileMenu() {
    const wasOpen = isMobileMenuOpen();
    document.querySelectorAll('.sidebar, .radar-sidebar, .top-nav nav')
        .forEach(el => el.classList.remove('show-mobile'));
    document.body.classList.remove('mobile-menu-open');
    if (wasOpen) syncMobileMenuButton(false);
    return wasOpen;
}

// メニューを開く (モバイル幅でのみ見た目に反映される)
function openMobileMenu() {
    document.querySelector('.top-nav nav')?.classList.add('show-mobile');
    if (document.getElementById('view-manager')?.classList.contains('active')) {
        document.querySelector('.sidebar')?.classList.add('show-mobile');
    } else if (document.getElementById('view-radar')?.classList.contains('active')) {
        document.querySelector('.radar-sidebar')?.classList.add('show-mobile');
    }
    document.body.classList.add('mobile-menu-open');
    syncMobileMenuButton(true);
}

function toggleSidebar() {
    if (isMobileMenuOpen()) {
        closeMobileMenu();
        return false;
    }
    openMobileMenu();
    return true;
}

// メニュー本体 (ドロワー・ナビ) の中かどうか。スクロール判定にも使う。
function isInsideMobileMenu(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('.sidebar, .radar-sidebar, .top-nav nav'));
}

// メニューを開いたままにする操作かどうか
// - ハンバーガーボタン: onclick="toggleSidebar()" が開閉を担当する
// - メニュー内の項目 (リスト選択・絞り込みなど) のタップ
//   ただしメニュー自身の余白 (背景) をタップしたときは閉じる対象にする
function keepsMobileMenuOpen(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest('#menu-toggle-btn')) return true;
    const menu = target.closest('.sidebar, .radar-sidebar, .top-nav nav');
    return Boolean(menu) && menu !== target;
}

// メニュー外のタップ (ハンバーガー・メニュー項目以外) で閉じる
document.addEventListener('click', (event) => {
    if (!isMobileMenuOpen() || keepsMobileMenuOpen(event.target)) return;
    closeMobileMenu();
});

// メニューを開いたままコンテンツをスクロールしたら閉じる
// (ドロワー内の長いリストをスクロールしている間は閉じない)
document.addEventListener('scroll', (event) => {
    if (!isMobileMenuOpen()) return;
    if (event.target instanceof Element && isInsideMobileMenu(event.target)) return;
    closeMobileMenu();
}, true);

// Escape キーでも閉じる
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMobileMenu();
});

// モバイル幅を外れたら (端末の回転など) メニューを閉じる
// ハンバーガーが消える幅でメニューの状態が残り、プレイヤーが操作できなくなるのを防ぐ
function isMobileMenuViewport() {
    return typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 600px)').matches
        : window.innerWidth <= 600;
}

window.addEventListener('resize', () => {
    if (isMobileMenuOpen() && !isMobileMenuViewport()) closeMobileMenu();
});

function toggleBottomPlayer() {
    const hidden = document.body.classList.toggle('player-bar-hidden');
    const button = document.getElementById('player-bar-toggle');
    if (button) {
        button.innerText = hidden ? '＋' : '×';
        button.title = hidden ? '再生バーを表示' : '再生バーを隠す';
        button.setAttribute('aria-label', button.title);
    }
}

function closeYoutubePlayer() {
    const popup = document.getElementById('youtube-popup');
    if (!popup) return;
    popup.classList.remove('is-active');
    if (player && player.stopVideo) player.stopVideo();
    isPlaying = false;
    clearInterval(progressInterval);
}

function goToHome() {
    navigateView('manager');
    selectPlaylist('home');
}

// ==========================================================
// ルーティング (URLハッシュでブラウザ戻る/進むボタン対応)
// ==========================================================
const VIEW_FOR_HASH = { manager: 'manager', radar: 'radar', share: 'share', profile: 'profile', playlist: 'playlist-detail' };

function currentHashView() {
    const hash = (location.hash || '').replace(/^#\/?/, '');
    const parts = hash.split('/');
    const base = parts[0];
    if (VIEW_FOR_HASH[base]) return { view: VIEW_FOR_HASH[base], id: parts[1] || null };
    return { view: 'manager', id: null };
}

// ビューをURLに記録しつつ遷移する (戻る履歴へ積む)
function navigateView(viewName, id) {
    let hashPath = viewName === 'playlist-detail' ? 'playlist' : viewName;
    if (id) hashPath += '/' + id;
    if (('#' + hashPath) !== location.hash) {
        location.hash = hashPath;
    } else {
        // ハッシュが既に同じ場合は直接表示 (hashchangeが発火しないため)
        applyHashView();
    }
}

// ハッシュからビューを復元して表示する
function applyHashView() {
    const { view, id } = currentHashView();
    if (view === 'playlist-detail' && id) {
        // 詳細は実データロード (履歴復元のためハッシュ更新しない)
        renderPlaylistDetail(parseInt(id, 10), '', '');
    } else {
        switchView(view);
    }
}

function switchView(viewName) {
    document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');

    // Radar画面では動画プレイヤーを左サイドバー上に固定配置する
    document.body.classList.toggle('player-in-sidebar', viewName === 'radar');

    document.querySelectorAll('.top-nav nav button').forEach(btn => {
        btn.classList.remove('active');
        btn.style.color = "var(--text-sub)";
    });

    const navBtn = document.getElementById(`nav-${viewName}`) || document.getElementById(`nav-${viewName === 'manager' ? 'manager' : viewName}`);
    if (navBtn) navBtn.classList.add('active');
    // 既存の className.active と btn 色のどちらも揃える
    document.querySelectorAll('.top-nav nav button').forEach(btn => {
        if (btn.id === `nav-${viewName}`) { btn.classList.add('active'); btn.style.color = "var(--accent-color)"; }
    });

    // 画面遷移したらモバイルメニューは必ず閉じる
    closeMobileMenu();

    if (viewName === 'manager') loadPlaylists().catch(err => alert(err.message));
    else if (viewName === 'radar') loadRadarData();
    else if (viewName === 'share') loadSharePlaylists();
    else if (viewName === 'profile') loadProfile();
}

function checkLoginStatus() {
    const token = localStorage.getItem('tunedrop_token');
    const username = localStorage.getItem('tunedrop_username');
    if (token && username) {
        document.getElementById('nav-login').style.display = 'none';
        document.getElementById('nav-profile').style.display = 'inline-block';
        document.getElementById('profile-name').innerText = username;
        document.getElementById('profile-avatar').innerText = username.charAt(0).toUpperCase();
    } else {
        document.getElementById('nav-login').style.display = 'inline-block';
        document.getElementById('nav-profile').style.display = 'none';
    }
}

// ログインセッションを破棄し、ヘッダー等を未ログイン表示へ戻す
function clearSession() {
    localStorage.removeItem('tunedrop_token');
    localStorage.removeItem('tunedrop_username');
    checkLoginStatus();
}

// プロフィール画面を開いているときだけ再読み込みする (ログイン直後の反映用)
function refreshProfileIfVisible() {
    const view = document.getElementById('view-profile');
    if (view && view.classList.contains('active')) loadProfile();
}

// プロフィール画面のログイン時 / 未ログイン時の表示を切り替える
function setProfileVisibility(loggedIn) {
    document.getElementById('profile-header').hidden = !loggedIn;
    document.getElementById('profile-stats').hidden = !loggedIn;
    document.getElementById('profile-form').hidden = !loggedIn;
    document.getElementById('profile-guest-notice').hidden = loggedIn;
}

// 登録日をプロフィールカードのサブタイトルに表示する (created_at: YYYY-MM-DD HH:MM:SS)
function renderProfileMeta(user) {
    const meta = document.getElementById('profile-meta');
    if (!meta) return;
    const created = String((user && user.created_at) || '').slice(0, 10).replace(/-/g, '/');
    meta.textContent = created ? `登録日 ${created}` : 'プロフィール';
}

async function loadProfile() {
    const status = document.getElementById('profile-status');
    const input = document.getElementById('profile-username');
    const button = document.getElementById('profile-save');
    const loggedIn = Boolean(localStorage.getItem('tunedrop_token'));
    setProfileVisibility(loggedIn);
    if (!loggedIn) {
        // 未ログイン時は実データが無いため、ダミー表示ではなくログイン案内を出す
        status.textContent = '';
        showLoginModal();
        return;
    }
    input.value = localStorage.getItem('tunedrop_username') || '';
    button.disabled = true;
    status.textContent = '読み込み中…';
    try {
        const response = await tunedropFetch('api.php?action=auth&endpoint=me');
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
            // トークン期限切れ: セッションを破棄してログインをやり直してもらう
            clearSession();
            setProfileVisibility(false);
            status.textContent = '';
            showLoginModal();
            return;
        }
        if (!response.ok || !data.user) throw new Error(data.error || 'プロフィールを取得できませんでした。');
        localStorage.setItem('tunedrop_username', data.user.username);
        checkLoginStatus();
        input.value = data.user.username;
        renderProfileMeta(data.user);
        document.getElementById('profile-track-count').textContent = data.user.stats.bookmarks_count;
        document.getElementById('profile-list-count').textContent = data.user.stats.playlists_count;
        document.getElementById('profile-favorite-count').textContent = data.user.stats.favorites_count;
        status.textContent = '';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
}

async function saveProfile(event) {
    event.preventDefault();
    const button = document.getElementById('profile-save');
    if (button.disabled) return;
    const status = document.getElementById('profile-status');
    button.disabled = true;
    status.textContent = '保存中…';
    try {
        const response = await tunedropFetch('api.php?action=auth&endpoint=profile', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: document.getElementById('profile-username').value.trim() })
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
            clearSession();
            setProfileVisibility(false);
            status.textContent = '';
            showLoginModal();
            return;
        }
        if (!response.ok || !data.success) throw new Error(data.error || '保存できませんでした。');
        localStorage.setItem('tunedrop_token', data.token);
        localStorage.setItem('tunedrop_username', data.user.username);
        document.getElementById('profile-username').value = data.user.username;
        checkLoginStatus();
        status.textContent = 'ユーザー名を変更しました。';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
}

function showLoginModal() {
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく
    document.getElementById('login-modal').style.display = 'flex';
    initGoogleAuth();
}
function closeLoginModal() { document.getElementById('login-modal').style.display = 'none'; }

// ログイン後にユーザー固有のプレイリストを再取得して反映する
// (アカウント切り替えでゲストの一覧が残らないようにホームへ戻して再読込する)
function reloadPlaylistsAfterAuth() {
    currentPlaylistId = 'home';
    loadPlaylists();
}

async function loginWithEmail() {
    const username = document.getElementById('auth-username').value;
    const password = document.getElementById('auth-password').value;
    if (!username || !password) return alert("入力が不完全です。");
    try {
        const res = await tunedropFetch('api.php?action=auth&endpoint=login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            localStorage.setItem('tunedrop_token', data.token);
            localStorage.setItem('tunedrop_username', data.user.username);
            closeLoginModal(); checkLoginStatus(); refreshProfileIfVisible(); reloadPlaylistsAfterAuth(); alert("ログインしました！");
        } else alert(data.error || "ログインに失敗しました。");
    } catch (err) { alert("認証サーバーに接続できません。"); }
}

async function registerWithEmail() {
    const username = document.getElementById('auth-username').value;
    const password = document.getElementById('auth-password').value;
    if (!username || !password) return alert("入力が不完全です。");
    try {
        const res = await tunedropFetch('api.php?action=auth&endpoint=register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            localStorage.setItem('tunedrop_token', data.token);
            localStorage.setItem('tunedrop_username', data.user.username);
            closeLoginModal();
            checkLoginStatus();
            reloadPlaylistsAfterAuth();
            navigateView('profile');
        }
        else alert(data.error || "登録に失敗しました。");
    } catch (err) { alert("認証サーバーに接続できません。"); }
}

// ==========================================================
// Google ログイン (Google Identity Services)
// ==========================================================
let googleAuthInitialized = false;

function googleClientId() {
    return (window.TUNEDROP_CONFIG && window.TUNEDROP_CONFIG.googleClientId) || '';
}

// OAuth 2.0 クライアントIDの形式チェック (APIキー等の誤設定を検知する)
function isValidGoogleClientId(cid) {
    return /^[0-9a-z][0-9a-z-]*\.apps\.googleusercontent\.com$/i.test(String(cid || '').trim());
}

// ログインモーダル内の案内文を表示する
function showGoogleAuthHint(message, isError) {
    const hint = document.getElementById('google-origin-hint');
    if (!hint) return;
    hint.textContent = message;
    hint.style.color = isError ? '#ff8a80' : 'var(--text-sub)';
    hint.style.display = 'block';
}

function initGoogleAuth() {
    const cid = googleClientId();
    const origin = window.location.origin;
    if (!cid) {
        // クライアントID未設定なら枠を非表示
        const box = document.getElementById('g_id_signin');
        if (box) box.style.display = 'none';
        return;
    }
    if (!isValidGoogleClientId(cid)) {
        // APIキー (AQ.やAIzaで始まる値) が誤って設定されているケース:
        // Googleボタンを描画せず、正しい設定方法を案内する
        const box = document.getElementById('g_id_signin');
        if (box) {
            box.style.display = 'flex';
            box.innerHTML = '<p style="color:#ff8a80; font-size:11px; line-height:1.7; text-align:center; margin:0;">この値はAPIキーの形式です。<br>OAuth 2.0 クライアントID<br>(〜.apps.googleusercontent.com)を設定してください。</p>';
        }
        console.warn('TUNEDROP_CONFIG.googleClientId が OAuth クライアントIDの形式ではありません:', cid);
        showGoogleAuthHint(
            'Google Cloud Console > APIとサービス > 認証情報 で「OAuth クライアントID (ウェブ アプリケーション)」を作成し、'
            + '「承認済み JavaScript 生成元」に「' + origin + '」を登録してください。',
            true
        );
        return;
    }
    if (googleAuthInitialized) return;
    if (!(window.google && google.accounts && google.accounts.id)) return;

    googleAuthInitialized = true;
    google.accounts.id.initialize({
        client_id: cid,
        callback: handleGoogleCredential,
        auto_select: false,
        cancel_on_tap_outside: false,
    });

    const btnBox = document.getElementById('g_id_signin');
    if (btnBox) {
        btnBox.style.display = 'flex';
        try {
            google.accounts.id.renderButton(btnBox, {
                theme: 'outline',
                size: 'large',
                type: 'standard',
                shape: 'rectangular',
                text: 'continue_with',
                width: 240,
            });
        } catch (e) {
            console.error('Google renderButton error:', e);
        }
    }
    // 「no registered origin」対策: 現在ページを開いている origin を案内表示する。
    // この URL を Google Cloud Console の「承認済み JavaScript 生成元」に登録する。
    showGoogleAuthHint(
        'Googleログインができない (no registered origin) 場合は、Google Cloud Console > 認証情報 > OAuthクライアント の「承認済み JavaScript 生成元」に「' + origin + '」を登録してください。'
    );
}

// 既存互換: ログインモーダルを開いたら公式Googleボタンを表示する
function triggerGoogleLogin() {
    initGoogleAuth();
}

async function handleGoogleCredential(response) {
    const credential = response && response.credential;
    if (!credential) return;
    try {
        const res = await tunedropFetch('api.php?action=auth&endpoint=google', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential })
        });
        const data = await res.json();
        if (data.success) {
            localStorage.setItem('tunedrop_token', data.token);
            localStorage.setItem('tunedrop_username', data.user && data.user.username);
            closeLoginModal(); checkLoginStatus(); refreshProfileIfVisible(); reloadPlaylistsAfterAuth(); alert("Googleログインしました！");
        } else {
            alert(data.error || "Googleログインに失敗しました。");
        }
    } catch (err) {
        alert("認証サーバーに接続できません。");
        console.error(err);
    }
}

function logout() {
    clearSession();
    setProfileVisibility(false);
    navigateView('manager');
    alert("ログアウトしました。");
}

async function loadPlaylists() {
    const response = await tunedropFetch('api.php?action=get_playlists');
    // 未ログイン (401) の場合は空配列で安全に描画する (アカウントごとのデータ分離)
    allPlaylists = response.ok ? await response.json() : [];
    filterManagerPlaylists();
}

function filterManagerPlaylists() {
    const query = document.getElementById('manager-search').value.toLowerCase();
    const category = document.getElementById('manager-category').value;
    const filtered = allPlaylists.filter(list => list.name.toLowerCase().includes(query) && (category === "" || list.category === category));
    renderManagerLists(filtered);
}

// サイドバー・カード一覧の描画。Vue (frontend/manager-lists.js) が読み込まれていれば
// リアクティブ描画に委ね、未ロード時のみ従来の手動描画へフォールバックする。
function renderManagerLists(filtered) {
    const systemLists = allPlaylists.filter(isSystemPlaylist).sort(compareSystemPlaylists);
    const userLists = filtered.filter(list => !isSystemPlaylist(list));

    if (window.ManagerLists) {
        window.ManagerLists.setData({
            systemLists,
            userLists,
            currentPlaylistId,
            homeMode: currentPlaylistId === 'fav_playlists' ? 'fav_playlists' : 'home',
            sortMode: playlistSortMode,
        });
    } else {
        renderPlaylistNav(filtered);
        return;
    }

    // 見出しの更新 (従来 renderPlaylistNav が担っていた)
    if (currentPlaylistId === 'home' || currentPlaylistId === 'fav_playlists') {
        const titleEl = document.getElementById('home-section-title');
        if (titleEl) titleEl.innerText = currentPlaylistId === 'fav_playlists' ? "お気に入りリスト" : "マイ・プレイリスト";
    }
}

function renderPlaylistNav(playlists) {
    const nav = document.getElementById('playlist-nav');
    nav.innerHTML = `
        <li onclick="selectPlaylist('home')" class="${currentPlaylistId === 'home' ? 'active' : ''}"><span class="material-symbols-rounded nav-li-icon">home</span>ホーム (リスト一覧)</li>
        <li onclick="selectPlaylist('fav_playlists')" class="${currentPlaylistId === 'fav_playlists' ? 'active' : ''}"><span class="material-symbols-rounded nav-li-icon">favorite</span>お気に入りリスト</li>
        <li onclick="selectPlaylist('fav_tracks')" class="${currentPlaylistId === 'fav_tracks' ? 'active' : ''}"><span class="material-symbols-rounded nav-li-icon">music_note</span>お気に入り曲</li>
        <li onclick="selectPlaylist(null)" class="${currentPlaylistId === null ? 'active' : ''}"><span class="material-symbols-rounded nav-li-icon">library_music</span>すべてのブックマーク</li>
    `;

    // 固定タブ (未整理 / 公開用お気に入り) は全ユーザー共通で「すべてのブックマーク」の直下に常に固定表示する。
    // 検索・カテゴリ絞り込みの影響を受けず、並び替え・削除・タグ変更はできない。
    // ユーザー作成リストのみドラッグ&ドロップで並び替え可能。
    const systemLists = allPlaylists.filter(isSystemPlaylist).sort(compareSystemPlaylists);
    const userLists = playlists.filter(list => !isSystemPlaylist(list));

    const renderSystemTab = (list) => {
        const li = document.createElement('li');
        li.className = currentPlaylistId === list.id ? 'active' : '';
        li.dataset.plid = list.id;
        li.classList.add('drag-static');
        li.innerHTML = `<span class="list-name-wrap"><span class="list-name" title="${escapeHtml(list.name)}">${escapeHtml(list.name)}</span></span><span class="material-symbols-rounded nav-drag-icon drag-static">lock</span>`;
        li.onclick = () => selectPlaylist(list.id);
        nav.appendChild(li);
    };

    const renderUser = (list) => {
        const li = document.createElement('li');
        li.className = currentPlaylistId === list.id ? 'active' : '';
        li.dataset.plid = list.id;
        li.draggable = true;
        li.classList.add('draggable-pl');
        const catBadge = list.category ? `<span class="cat-badge">${list.category}</span>` : '';
        li.innerHTML = `
            <div style="display:flex; align-items:center; overflow:hidden; flex:1;">
                <span class="material-symbols-rounded nav-drag-icon">drag_indicator</span>
                <span class="list-name-wrap"><span class="list-name" title="${escapeHtml(list.name)}">${escapeHtml(list.name)}</span></span>${catBadge}
            </div>
            <div class="sidebar-menu-container" onclick="event.stopPropagation()">
                <button class="sidebar-menu-btn" onclick="toggleSidebarMenu(event, this)"><span class="material-symbols-rounded">more_vert</span></button>
                <div class="sidebar-dropdown-menu">
                    <button onclick="openEditPlaylistModal(event, ${list.id})"><span class="material-symbols-rounded">edit</span>編集・公開</button>
                    <button onclick="deletePlaylistFromSidebar(event, ${list.id})"><span class="material-symbols-rounded">delete</span>削除</button>
                </div>
            </div>
        `;
        li.onclick = () => { if (li._dragged || li._pointerDragged) return; selectPlaylist(list.id); };
        enablePointerReorder({
            handle: li.querySelector('.nav-drag-icon'),
            item: li,
            // 固定タブや静的項目を跨がず、ユーザー作成リスト同士でのみ入れ替える
            itemSelector: 'li.draggable-pl',
            container: nav,
            onDrop: persistPlaylistOrderFromDom
        });

        li.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            li.classList.add('dragging');
            li._dragged = true;
            e.dataTransfer.setData('text/plain', String(list.id));
        });
        li.addEventListener('dragend', () => {
            lastPointerDragEndedAt = Date.now();
            li.classList.remove('dragging');
            document.querySelectorAll('.playlist-nav li').forEach(el => el.classList.remove('drag-over'));
            setTimeout(() => { li._dragged = false; }, 0);
        });
        li.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!li.classList.contains('drag-over')) li.classList.add('drag-over');
        });
        li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
        li.addEventListener('drop', (e) => {
            e.preventDefault();
            li.classList.remove('drag-over');
            const draggedId = parseInt(e.dataTransfer.getData('text/plain'), 10);
            const targetId = list.id;
            if (!draggedId || draggedId === targetId) return;
            reorderUserPlaylists(draggedId, targetId);
        });

        nav.appendChild(li);
    };

    systemLists.forEach(renderSystemTab);
    userLists.forEach(renderUser);

    if (currentPlaylistId === 'home' || currentPlaylistId === 'fav_playlists') {
        const titleEl = document.getElementById('home-section-title');
        if (titleEl) titleEl.innerText = currentPlaylistId === 'fav_playlists' ? "お気に入りリスト" : "マイ・プレイリスト";
        const listsToRender = currentPlaylistId === 'fav_playlists' ? playlists.filter(p => p.is_favorite == 1) : playlists;
        renderManagerHome(listsToRender);
    }
}

// ==========================================================
// 並び替えの反映 (再取得・再描画をしない)
// loadPlaylists() で作り直すと画面が一瞬リセットされ、ドロップ直後のクリックが
// 別のカードに当たって画面が切り替わってしまうため、DOMとメモリ順だけを更新する。
// ==========================================================
function orderedUserListIds() {
    return allPlaylists.filter(list => !isSystemPlaylist(list)).map(list => list.id);
}

// 表示中の(ドラッグされた)リストの並びを状態へ反映する。表示外のリストは元の位置に残す。
function applyPlaylistOrderToState(orderedIds) {
    const visible = new Set(orderedIds);
    const queue = orderedIds
        .map(id => allPlaylists.find(list => list.id === id))
        .filter(Boolean);
    if (queue.length < 2) return;
    allPlaylists.forEach((list, index) => {
        if (!isSystemPlaylist(list) && visible.has(list.id)) allPlaylists[index] = queue.shift();
    });
    allPlaylists.forEach((list, index) => {
        if (!isSystemPlaylist(list)) list.sort_order = index;
    });
}

// 指定セレクタの要素を orderedIds の順に並べ替える (要素の作り直しはしない)
function reorderItemsById(selector, orderedIds) {
    const items = [...document.querySelectorAll(selector)];
    if (items.length < 2) return;
    const byId = new Map(items.map(el => [Number(el.dataset.plid), el]));
    const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
    items.forEach(el => { if (!ordered.includes(el)) ordered.push(el); });
    if (ordered.length !== items.length) return;
    const anchor = items[0];                       // 元の先頭位置へ順に詰め直す
    anchor.parentNode.insertBefore(ordered[0], anchor);
    let prev = ordered[0];
    for (let i = 1; i < ordered.length; i++) {
        prev.parentNode.insertBefore(ordered[i], prev.nextSibling);
        prev = ordered[i];
    }
}

// サイドバー・カード一覧の並びを状態に合わせる
function syncPlaylistOrderInDom() {
    const orderedIds = orderedUserListIds();
    reorderItemsById('#playlist-nav li.draggable-pl', orderedIds);
    reorderItemsById('#my-playlists-grid .card:not(.is-system)', orderedIds);
}

// 並び順をサーバーへ保存する (失敗時のみ再取得して整合を取る)
async function savePlaylistOrder() {
    try {
        await tunedropFetch('api.php?action=reorder_playlists', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ordered_ids: orderedUserListIds() })
        });
    } catch (err) {
        alert("並び替えの保存に失敗しました。");
        loadPlaylists();
    }
}

// ユーザープレイリストを並び替えて保存 (固定タブは対象外)
async function reorderUserPlaylists(draggedId, targetId) {
    const userLists = allPlaylists.filter(list => !isSystemPlaylist(list));
    const draggedIdx = userLists.findIndex(p => p.id === draggedId);
    const targetIdx = userLists.findIndex(p => p.id === targetId);
    if (draggedIdx === -1 || targetIdx === -1) return;

    userLists.splice(targetIdx, 0, userLists.splice(draggedIdx, 1)[0]);
    applyPlaylistOrderToState(userLists.map(p => p.id));
    syncPlaylistOrderInDom();
    await savePlaylistOrder();
}

// ==========================================================
// タッチ端末の並び替え (つまみをドラッグ)
// HTML5 の Drag & Drop はモバイルで動作しないため Pointer Events で実装する。
// ==========================================================
function isTouchPointer(event) {
    return event.pointerType === 'touch' || event.pointerType === 'pen';
}

// つまみをドラッグした直後のクリック (指を離した瞬間のタップ判定) を全体で抑止するための時刻。
// 再描画が無くてもブラウザが click を発火するため、画面が勝手に切り替わらないようにする。
// タッチ (Pointer Events) とマウス (HTML5 Drag & Drop) の両方で、ドラッグ終了時に必ず更新する。
let lastPointerDragEndedAt = 0;

document.addEventListener('click', (event) => {
    if (Date.now() - lastPointerDragEndedAt < 400) {
        event.stopPropagation();
        event.preventDefault();
    }
}, true);

// Vue (frontend/manager-lists.js) からドラッグ終了を通知してもらうためのブリッジ
window.markDragEnded = () => { lastPointerDragEndedAt = Date.now(); };

// Vue 側で並び替えたユーザーリスト順を app.js の状態とDBへ反映する (再描画はしない)
window.onPlaylistsReordered = (orderedIds) => {
    applyPlaylistOrderToState(orderedIds);
    savePlaylistOrder();
};

function enablePointerReorder({ handle, item, container, itemSelector, onDrop }) {
    if (!handle || !item || !container || typeof onDrop !== 'function') return;
    let active = false;
    let moved = false;
    let pointerId = null;
    let wasDraggable = null;
    let dragOverTarget = null;
    let ghost = null;
    let startX = 0;
    let startY = 0;

    const clearDragOver = () => {
        if (dragOverTarget) { dragOverTarget.classList.remove('drag-over'); dragOverTarget = null; }
    };
    const removeGhost = () => {
        if (ghost) { ghost.remove(); ghost = null; }
    };

    const onPointerMove = (event) => {
        if (!active || event.pointerId !== pointerId) return;
        event.preventDefault();
        // 浮遊コピー (マウスのドラッグゴースト相当) を指に追従させる
        if (ghost) {
            ghost.style.transform = `translate(${event.clientX - startX}px, ${event.clientY - startY}px)`;
        }
        // 浮遊コピーが hit-test を邪魔しないよう一時的に隠して、指の下の要素を特定する
        if (ghost) ghost.style.display = 'none';
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(itemSelector);
        if (ghost) ghost.style.display = '';
        if (!target || target === item || !container.contains(target)) {
            clearDragOver();
            return;
        }
        // マウスの dragover と同じように、指の下にある要素へ黄色い枠を表示する
        if (target !== dragOverTarget) {
            clearDragOver();
            dragOverTarget = target;
            target.classList.add('drag-over');
        }
        const rect = target.getBoundingClientRect();
        const insertAfter = event.clientY > rect.top + rect.height / 2;
        target.parentNode.insertBefore(item, insertAfter ? target.nextSibling : target);
        moved = true;
    };

    const onPointerEnd = (event) => {
        if (!active) return;
        if (event && event.pointerId !== pointerId) return;
        active = false;
        // 指を離したら必ず元の見た目へ戻す (ゴースト・黄色枠・半透明をすべて解除)
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('pointerup', onPointerEnd, true);
        document.removeEventListener('pointercancel', onPointerEnd, true);
        clearDragOver();
        removeGhost();
        item.classList.remove('dragging');
        if (wasDraggable) {           // 標準ドラッグの設定を元に戻す
            item.draggable = true;
            wasDraggable = null;
        }
        if (pointerId !== null) {
            try { handle.releasePointerCapture(pointerId); } catch (_) { /* noop */ }
        }
        pointerId = null;
        if (!moved) return;
        // ドラッグ直後のクリックで画面が切り替わらないようにする
        item._pointerDragged = true;
        setTimeout(() => { item._pointerDragged = false; }, 400);
        lastPointerDragEndedAt = Date.now();
        onDrop(container, itemSelector);
    };

    handle.addEventListener('pointerdown', (event) => {
        if (!isTouchPointer(event)) return;   // マウス操作は既存の HTML5 DnD に任せる
        if (active) return;
        event.preventDefault();
        event.stopPropagation();
        active = true;
        moved = false;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        // ブラウザ標準のドラッグ (長押しドラッグ) が割り込まないように一時的に無効化する
        if (item.draggable) {
            wasDraggable = true;
            item.draggable = false;
        }
        try { handle.setPointerCapture(pointerId); } catch (_) { /* 未対応環境は無視 */ }
        // マウスのドラッグゴースト相当の浮遊コピーを作る (見た目を保つため実体を複製)
        const rect = item.getBoundingClientRect();
        ghost = item.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        ghost.style.left = rect.left + 'px';
        ghost.style.top = rect.top + 'px';
        document.body.appendChild(ghost);
        item.classList.add('dragging');
        navigator.vibrate?.(10);
        // 指が要素の外へ出ても確実に終了処理が走るよう document レベルで監視する
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerEnd, true);
        document.addEventListener('pointercancel', onPointerEnd, true);
    });
}

// 並び替え後のDOM順をそのまま保存する (プレイリスト / 曲)
async function persistPlaylistOrderFromDom(container, itemSelector) {
    const ids = [...container.querySelectorAll(itemSelector)]
        .map(el => Number(el.dataset.plid))
        .filter(id => Number.isFinite(id) && id > 0)
        .filter(id => !isSystemPlaylist(allPlaylists.find(list => list.id === id)));
    if (ids.length < 2) return;
    // 再取得・再描画はしない (画面がリセットされ、直後のクリックで別画面が開いてしまうため)
    applyPlaylistOrderToState(ids);
    syncPlaylistOrderInDom();
    await savePlaylistOrder();
}

async function persistBookmarkOrderFromDom(container) {
    const visibleIds = [...container.querySelectorAll('.card')]
        .map(el => Number(el.dataset.trackId))
        .filter(id => Number.isFinite(id) && id > 0);
    if (visibleIds.length < 2) return;
    trackSortMode = 'custom';
    const sortSelect = document.getElementById('manager-track-sort-select');
    if (sortSelect) sortSelect.value = 'custom';
    // 状態(再生キュー)とクリック処理をDOMの並びに合わせる (再取得・再描画はしない)
    applyTrackOrderToState(visibleIds);
    syncTrackDomOrder();
    reorderBookmarks(currentTracks.map(track => track.id));
}

// プレイリスト詳細の曲リスト並び替え後のDOM順を状態とDBへ反映する (タッチ/マウス共通)
function persistDetailTrackOrderFromDom(container) {
    const visibleIds = [...container.querySelectorAll('.track-list-item')]
        .map(el => Number(el.dataset.trackId))
        .filter(id => Number.isFinite(id) && id > 0);
    if (visibleIds.length < 2) return;
    trackSortMode = 'custom';
    const sortSelect = document.getElementById('track-sort-select');
    if (sortSelect) sortSelect.value = 'custom';
    // DOM の並び順に状態(再生キュー)を合わせる (再取得・再描画はしない)
    const ordered = visibleIds
        .map(id => currentDetailTracks.find(track => track.id === id))
        .filter(Boolean);
    if (ordered.length !== currentDetailTracks.length) return;
    currentDetailTracks = ordered;
    currentDetailTracks.forEach((track, index) => { track.sort_order = index; });
    renderDetailTracks(currentDetailTracks);
    reorderBookmarks(currentDetailTracks.map(track => track.id));
}

// 表示中の曲の並びを再生キューへ反映する。表示外(検索中など)の曲は元の位置を保つ。
function applyTrackOrderToState(orderedVisibleIds) {
    const visible = new Set(orderedVisibleIds);
    const queue = orderedVisibleIds
        .map(id => currentTracks.find(track => track.id === id))
        .filter(Boolean);
    if (queue.length < 2) return;
    currentTracks.forEach((track, index) => {
        if (visible.has(track.id)) currentTracks[index] = queue.shift();
    });
    currentTracks.forEach((track, index) => { track.sort_order = index; });
}

// 曲カードの並びを再生キューに揃え、クリック時の再生インデックスを割り当て直す
function syncTrackDomOrder() {
    const container = document.getElementById('my-bookmarks');
    if (!container) return;
    const cards = [...container.querySelectorAll('.card')];
    if (!cards.length) return;
    const ordered = currentTracks.map(track => track.id)
        .map(id => cards.find(card => Number(card.dataset.trackId) === id))
        .filter(Boolean);
    cards.forEach(card => { if (!ordered.includes(card)) ordered.push(card); });
    if (ordered.length === cards.length) {
        const anchor = cards[0];
        anchor.parentNode.insertBefore(ordered[0], anchor);
        let prev = ordered[0];
        for (let i = 1; i < ordered.length; i++) {
            prev.parentNode.insertBefore(ordered[i], prev.nextSibling);
            prev = ordered[i];
        }
    }
    // 表示順(フィルタ中は絞り込み後)を再生キューとしてカードを結び直す
    const currentCards = [...container.querySelectorAll('.card')];
    const queue = currentCards
        .map(card => currentTracks.find(track => track.id === Number(card.dataset.trackId)))
        .filter(Boolean);
    currentCards.forEach((card, index) => {
        card.onclick = () => { if (card._dragged || card._pointerDragged) return; playTrackFromQueue(index, queue); };
    });
}

function selectPlaylist(id) {
    currentPlaylistId = id;
    filterManagerPlaylists();
    const homeArea = document.getElementById('manager-home-area');
    const trackArea = document.getElementById('manager-track-area');

    if (id === 'home' || id === 'fav_playlists') {
        homeArea.style.display = 'block'; trackArea.style.display = 'none';
    } else {
        homeArea.style.display = 'none'; trackArea.style.display = 'block';
        const titleEl = document.getElementById('current-list-title');
        if (id === null) titleEl.innerText = "すべてのブックマーク";
        else if (id === 'fav_tracks') titleEl.innerText = "お気に入り曲";
        else {
            const list = allPlaylists.find(p => p.id === id);
            titleEl.innerText = list ? list.name : "プレイリスト";
        }
        loadMyBookmarks(id);
    }
    // リストを選んだらメニューを閉じて選択内容を見せる
    closeMobileMenu();
}

async function togglePlaylistFavorite(id, event) {
    if (event) event.stopPropagation();
    try {
        const res = await tunedropFetch('api.php?action=toggle_favorite_playlist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (data.success) {
            loadPlaylists();
            if (document.getElementById('view-radar').classList.contains('active')) loadRadarData();
        } else if (data.error) {
            // 固定タブは各ユーザー専用のため、他人の固定タブを追加しようとすると失敗する
            alert(data.error);
        }
        return data;
    } catch (err) { console.error(err); }
}

async function toggleTrackFavorite(id, event) {
    if (event) event.stopPropagation();
    document.querySelectorAll('.track-dropdown-menu').forEach(m => m.style.display = 'none');

    // 数値なら bookmarks.id、それ以外(動画ID文字列)なら youtube_id として扱う
    const isNumeric = /^\d+$/.test(String(id));
    const payload = isNumeric ? { id } : { youtube_id: id };

    try {
        const res = await tunedropFetch('api.php?action=toggle_favorite_bookmark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            const t1 = currentTracks.find(t => t.id == id || t.youtube_id == id);
            const t2 = currentDetailTracks.find(t => t.id == id || t.youtube_id == id);
            const tPlayer = (currentQueue[currentTrackIndex] && (currentQueue[currentTrackIndex].id == id || currentQueue[currentTrackIndex].youtube_id == id)) ? currentQueue[currentTrackIndex] : null;

            const newStatus = data.is_favorite;

            if (t1) t1.is_favorite = newStatus;
            if (t2) t2.is_favorite = newStatus;
            if (tPlayer) {
                tPlayer.is_favorite = newStatus;
                updatePlayerFavButton(newStatus);
            }

            if (document.getElementById('view-playlist-detail').classList.contains('active')) {
                renderDetailTracks(currentDetailTracks);
            } else if (document.getElementById('view-manager').classList.contains('active')) {
                if (currentPlaylistId === 'fav_tracks') loadMyBookmarks('fav_tracks');
                else filterTracks();
            }
        } else {
            alert(data.error || 'お気に入りを更新できませんでした。');
        }
    } catch (err) {
        console.error(err);
        alert('お気に入りを更新できませんでした。もう一度お試しください。');
    }
}

let playerFavoriteVersion = 0;
function playerFavoriteKey(track) {
    return Number.isInteger(Number(track.id)) && String(track.id) !== String(track.youtube_id)
        ? { id: track.id } : { youtube_id: track.youtube_id };
}

async function syncPlayerFavorite(track) {
    const version = ++playerFavoriteVersion;
    const button = document.getElementById('btn-player-fav');
    button.disabled = true;
    try {
        const query = new URLSearchParams(playerFavoriteKey(track));
        const response = await tunedropFetch(`api.php?action=get_track_favorite&${query}`);
        const data = await response.json();
        if (version !== playerFavoriteVersion || currentQueue[currentTrackIndex] !== track) return;
        if (data.success) {
            track.is_favorite = data.is_favorite;
            updatePlayerFavButton(data.is_favorite);
        }
    } catch (error) { console.error(error); }
    finally {
        if (version === playerFavoriteVersion && currentQueue[currentTrackIndex] === track) button.disabled = false;
    }
}

async function togglePlayerFavorite() {
    const track = currentQueue[currentTrackIndex];
    const button = document.getElementById('btn-player-fav');
    if (!track || button.disabled) return;
    ++playerFavoriteVersion;
    button.disabled = true;
    try {
        const key = playerFavoriteKey(track);
        await toggleTrackFavorite(key.id ?? key.youtube_id, null);
    } finally {
        if (currentQueue[currentTrackIndex] === track) button.disabled = false;
    }
}

function updatePlayerFavButton(isFav) {
    const icon = document.getElementById('btn-player-fav-icon');
    const btn = document.getElementById('btn-player-fav');
    if (icon) {
        // Material Symbols は FILL 軸 (0=輪郭 / 1=塗りつぶし) で切り替えるため、単一グリフ + is-filled で制御する
        icon.textContent = 'favorite';
        icon.classList.toggle('is-filled', isFav == 1);
        icon.style.color = isFav == 1 ? 'var(--accent-color)' : 'var(--text-sub)';
    }
    if (btn) {
        btn.style.color = isFav == 1 ? 'var(--accent-color)' : 'var(--text-sub)';
        btn.setAttribute('aria-pressed', String(isFav == 1));
        btn.setAttribute('aria-label', isFav == 1 ? 'お気に入り解除' : 'お気に入り追加');
        btn.title = isFav == 1 ? 'お気に入り解除' : 'お気に入り追加';
    }
}

function toggleSidebarMenu(event, btn) {
    event.stopPropagation();
    document.querySelectorAll('.sidebar-dropdown-menu').forEach(menu => {
        if (menu !== btn.nextElementSibling) menu.style.display = 'none';
    });
    const menu = btn.nextElementSibling;
    menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
}

document.addEventListener('click', () => {
    closeTrackMenus();
    document.querySelectorAll('.sidebar-dropdown-menu').forEach(menu => menu.style.display = 'none');
});

function openCreatePlaylistModal() {
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく
    document.getElementById('new-playlist-title').value = '';
    document.getElementById('new-playlist-category').value = 'Other';
    document.getElementById('new-playlist-public').checked = false;
    document.getElementById('create-playlist-modal').style.display = 'flex';
}
function closeCreatePlaylistModal() { document.getElementById('create-playlist-modal').style.display = 'none'; }

async function submitNewPlaylist() {
    const name = document.getElementById('new-playlist-title').value.trim();
    const category = document.getElementById('new-playlist-category').value;
    const isPublic = document.getElementById('new-playlist-public').checked ? 1 : 0;
    if (!name) return alert("タイトルを入力してください。");
    try {
        const response = await tunedropFetch('api.php?action=create_playlist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, is_public: isPublic })
        });
        const result = await response.json();
        if (result.success) { closeCreatePlaylistModal(); loadPlaylists(); }
        else alert("作成に失敗しました。" + (result.error ? "\n" + result.error : ""));
    } catch (err) { alert("通信エラーが発生しました。"); }
}

async function openEditPlaylistModal(event, playlistId) {
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく
    event.stopPropagation();
    document.querySelectorAll('.sidebar-dropdown-menu').forEach(m => m.style.display = 'none');
    const list = allPlaylists.find(p => p.id === playlistId);
    if (!list) return;

    document.getElementById('edit-playlist-id').value = list.id;
    document.getElementById('edit-playlist-title').value = list.name;
    document.getElementById('edit-playlist-category').value = list.category || 'Other';
    document.getElementById('edit-playlist-public').checked = list.is_public == 1;

    const coverSelect = document.getElementById('edit-playlist-cover');
    coverSelect.innerHTML = '<option value="">設定しない / 今のまま</option>';
    try {
        const response = await tunedropFetch(`api.php?action=get_my_bookmarks&playlist_id=${playlistId}`);
        const tracks = await response.json();
        tracks.forEach(track => {
            const option = document.createElement('option');
            option.value = track.youtube_id;
            option.innerText = track.title;
            if (list.cover_id === track.youtube_id) option.selected = true;
            coverSelect.appendChild(option);
        });
    } catch (err) { console.error(err); }
    document.getElementById('edit-playlist-modal').style.display = 'flex';
}
function closeEditPlaylistModal() { document.getElementById('edit-playlist-modal').style.display = 'none'; }

async function submitEditPlaylist() {
    const id = document.getElementById('edit-playlist-id').value;
    const name = document.getElementById('edit-playlist-title').value.trim();
    const category = document.getElementById('edit-playlist-category').value;
    const isPublic = document.getElementById('edit-playlist-public').checked ? 1 : 0;
    const coverId = document.getElementById('edit-playlist-cover').value;

    if (!name) return alert("タイトルを入力してください。");
    try {
        const response = await tunedropFetch('api.php?action=edit_playlist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, name, category, is_public: isPublic, cover_id: coverId })
        });
        const result = await response.json();
        if (result.success) { closeEditPlaylistModal(); loadPlaylists(); }
        else alert("更新に失敗しました。");
    } catch (err) { alert("通信エラーが発生しました。"); }
}

async function deletePlaylistFromSidebar(event, playlistId) {
    event.stopPropagation();
    document.querySelectorAll('.sidebar-dropdown-menu').forEach(m => m.style.display = 'none');
    if (!confirm("このプレイリストを削除しますか？\n（リスト内の曲もすべて削除されます）")) return;
    try {
        const response = await tunedropFetch('api.php?action=delete_playlist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: playlistId })
        });
        const result = await response.json();
        if (result.success) {
            if (currentPlaylistId === playlistId) currentPlaylistId = 'home';
            loadPlaylists();
        } else alert("削除に失敗しました。");
    } catch (err) { alert("通信エラーが発生しました。"); }
}

async function updatePlaylistCategory(playlistId, newCategory, event) {
    event.stopPropagation();
    try {
        const response = await tunedropFetch('api.php?action=update_category', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: playlistId, category: newCategory })
        });
        const result = await response.json();
        if (result.success) loadPlaylists(); else alert("カテゴリの更新に失敗しました。");
    } catch (err) { alert("通信エラーが発生しました。"); }
}

function renderManagerHome(playlists) {
    const container = document.getElementById('my-playlists-grid');
    container.innerHTML = '';
    const query = document.getElementById('manager-search').value.toLowerCase();
    const categoryFilter = document.getElementById('manager-category').value;
    let filtered = playlists.filter(list => list.name.toLowerCase().includes(query) && (categoryFilter === "" || list.category === categoryFilter));

    // ソート適用 (カスタム順は sort_order、既定の並び)
    filtered = sortPlaylists(filtered, playlistSortMode);

    if (filtered.length === 0) return container.innerHTML = '<p style="color:var(--text-sub); grid-column: 1 / -1;">プレイリストがありません。</p>';

    const categories = ['Vocaloid', 'J-POP', 'Anime', 'Lo-Fi', 'Other'];
    filtered.forEach(list => {
        const card = document.createElement('div');
        card.className = 'card draggable-track';
        const isProtected = isSystemPlaylist(list);
        if (isProtected) card.classList.add('is-system');
        card.draggable = !isProtected;
        card.dataset.plid = list.id;
        card.onclick = () => selectPlaylist(list.id);
        const coverHtml = list.cover_id ? `<img src="https://img.youtube.com/vi/${list.cover_id}/hqdefault.jpg" alt="cover">` : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:40px;">🎵</div>`;

        let optionsHtml = '';
        categories.forEach(cat => optionsHtml += `<option value="${cat}" ${list.category === cat ? 'selected' : ''}>${cat}</option>`);
        // 固定タブ (未整理 / 公開用お気に入り) はタグ (カテゴリ) を持たないため表示しない
        const catSelect = isProtected ? '' : `<select class="card-cat-select" onchange="updatePlaylistCategory(${list.id}, this.value, event)" onclick="event.stopPropagation()">${optionsHtml}</select>`;

        const dragHandle = isProtected ? '' : `<div class="drag-handle" title="ドラッグで並び替え"><span class="material-symbols-rounded">drag_indicator</span></div>`;

        card.innerHTML = `${catSelect}<div class="card-img-wrapper">${coverHtml}</div>
            <div class="info with-handle">
                <div class="info-text">
                    <div class="title">${escapeHtml(list.name)}</div>
                    <div class="artist">マイリスト</div>
                </div>
                ${dragHandle}
            </div>`;

        if (!isProtected) {
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                card.classList.add('dragging');
                card._dragged = true;
                e.dataTransfer.setData('text/plain', String(list.id));
            });
            card.addEventListener('dragend', () => {
                lastPointerDragEndedAt = Date.now();
                card.classList.remove('dragging');
                document.querySelectorAll('#my-playlists-grid .card').forEach(c => c.classList.remove('drag-over'));
                setTimeout(() => { card._dragged = false; }, 0);
            });
            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (!card.classList.contains('drag-over')) card.classList.add('drag-over');
            });
            card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
            card.addEventListener('drop', (e) => {
                e.preventDefault();
                card.classList.remove('drag-over');
                const draggedId = parseInt(e.dataTransfer.getData('text/plain'), 10);
                if (!draggedId || draggedId === list.id) return;
                reorderUserPlaylists(draggedId, list.id);
            });
            card.onclick = () => { if (card._dragged || card._pointerDragged) return; selectPlaylist(list.id); };
            enablePointerReorder({
                handle: card.querySelector('.drag-handle'),
                item: card,
                // 固定タブのカードを跨いで並び替えないようにする
                itemSelector: '.card:not(.is-system)',
                container,
                onDrop: persistPlaylistOrderFromDom
            });
        }

        container.appendChild(card);
    });
}

function closeTrackMenus() {
    document.querySelectorAll('.track-dropdown-menu').forEach(menu => {
        menu.style.display = 'none';
        menu.previousElementSibling?.setAttribute('aria-expanded', 'false');
    });
}

function toggleTrackMenu(event, btn) {
    event.stopPropagation();
    const menu = btn.nextElementSibling;
    const opening = menu.style.display !== 'flex';
    closeTrackMenus();
    menu.style.display = opening ? 'flex' : 'none';
    btn.setAttribute('aria-expanded', String(opening));
}

document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const trigger = document.querySelector('[aria-expanded="true"].track-menu-btn');
    closeTrackMenus();
    trigger?.focus();
});

// ==========================================================
// ソート機能
// ==========================================================
function sortPlaylists(playlists, mode) {
    const arr = [...playlists];
    switch (mode) {
        case 'newest':
            // 新規順: id 降順 (新しいほど id 大)
            return arr.sort((a, b) => (b.id ?? 0) - (a.id ?? 0) || (b.created_at || '').localeCompare(a.created_at || ''));
        case 'oldest':
            // 古い順: id 昇順
            return arr.sort((a, b) => (a.id ?? 0) - (b.id ?? 0) || (a.created_at || '').localeCompare(b.created_at || ''));
        case 'name':
            // 名前順 (localeCompare で自然な並び)
            return arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
        case 'custom':
        default:
            // カスタム順: sort_order → id 昇順 (DBから返ってきた並びを尊重)
            return arr.sort((a, b) => ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || ((a.id ?? 0) - (b.id ?? 0)));
    }
}

function sortTracks(tracks, mode) {
    const arr = [...tracks];
    switch (mode) {
        case 'newest':
            return arr.sort((a, b) => (b.id ?? 0) - (a.id ?? 0) || (b.added_at || '').localeCompare(a.added_at || ''));
        case 'oldest':
            return arr.sort((a, b) => (a.id ?? 0) - (b.id ?? 0) || (a.added_at || '').localeCompare(b.added_at || ''));
        case 'name':
            return arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja'));
        case 'custom':
        default:
            return arr.sort((a, b) => ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || ((a.id ?? 0) - (b.id ?? 0)));
    }
}

function onPlaylistSortChange() {
    const sel = document.getElementById('playlist-sort-select');
    playlistSortMode = sel ? sel.value : 'custom';
    // ソート順の変更を反映 (Vue はリアクティブに再描画する)
    filterManagerPlaylists();
}

function onTrackSortChange() {
    const sel = document.getElementById('track-sort-select');
    trackSortMode = sel ? sel.value : 'custom';
    renderDetailTracks(currentDetailTracks);
}

function onManagerTrackSortChange() {
    const sel = document.getElementById('manager-track-sort-select');
    trackSortMode = sel ? sel.value : 'custom';
    renderTracks(currentTracks);
}

function openMoveModalFromMenu(event, trackId) {
    event.stopPropagation();
    document.querySelectorAll('.track-dropdown-menu').forEach(m => m.style.display = 'none');
    openMoveModal(event, trackId);
}

function deleteTrackFromMenu(event, trackId) {
    event.stopPropagation();
    document.querySelectorAll('.track-dropdown-menu').forEach(m => m.style.display = 'none');
    deleteTrack(event, trackId);
}

async function addTrack() {
    const url = document.getElementById('youtube-url').value;
    const regExp = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/;
    const videoIdMatch = url.match(regExp);
    if (!videoIdMatch) return alert("正しいYouTube URLを入力してください。");
    // 追加先: リストを開いていればそのリスト、一覧/お気に入り表示中は自分の固定タブ「未整理」
    const inbox = allPlaylists.find(list => list.system_key === 'inbox')
        || allPlaylists.find(isSystemPlaylist)
        || null;
    const inboxId = inbox ? inbox.id : 0;
    const targetPlaylistId = (currentPlaylistId === 'home' || currentPlaylistId === 'fav_tracks' || currentPlaylistId === 'fav_playlists')
        ? inboxId
        : (Number.isInteger(currentPlaylistId) ? currentPlaylistId : inboxId);
    try {
        const response = await tunedropFetch('api.php?action=add_bookmark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ youtube_id: videoIdMatch[1], playlist_id: targetPlaylistId })
        });
        const result = await response.json();
        if (result.success) { document.getElementById('youtube-url').value = ''; loadMyBookmarks(currentPlaylistId); await loadPlaylists(); }
        else alert(result.error || "曲を追加できませんでした。");
    } catch (error) { console.error("通信エラー:", error); }
}

async function deleteTrack(event, trackId) {
    event.stopPropagation();
    if (!confirm("この曲をリストから削除しますか？")) return;
    try {
        const res = await tunedropFetch('api.php?action=delete_bookmark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: trackId })
        });
        const result = await res.json();
        if (result.success) { loadMyBookmarks(currentPlaylistId); await loadPlaylists(); }
    } catch (err) { console.error(err); }
}

function openMoveModal(event, trackId) {
    event.stopPropagation();
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく
    selectedTrackIdForMove = trackId;
    const select = document.getElementById('move-target-playlist-select');
    select.innerHTML = '';
    allPlaylists.forEach(list => {
        const option = document.createElement('option');
        option.value = list.id;
        // 固定タブはカテゴリ (タグ) を持たないため名前だけを表示する
        option.innerText = isSystemPlaylist(list) ? list.name : `${list.name} (${list.category})`;
        select.appendChild(option);
    });
    document.getElementById('move-track-modal').style.display = 'flex';
}
function closeMoveModal() { document.getElementById('move-track-modal').style.display = 'none'; selectedTrackIdForMove = null; }

async function submitMoveTrack() {
    const targetPlaylistId = document.getElementById('move-target-playlist-select').value;
    if (!selectedTrackIdForMove || !targetPlaylistId) return;
    try {
        const response = await tunedropFetch('api.php?action=move_bookmark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: selectedTrackIdForMove, target_playlist_id: targetPlaylistId })
        });
        const result = await response.json();
        if (result.success) { closeMoveModal(); loadMyBookmarks(currentPlaylistId); await loadPlaylists(); } else alert(result.error || "移動に失敗しました。");
    } catch (err) { alert("通信エラーが発生しました。"); }
}

async function loadMyBookmarks(playlistId = null) {
    let url = 'api.php?action=get_my_bookmarks';
    if (playlistId && playlistId !== 'home') url += `&playlist_id=${playlistId}`;
    const response = await tunedropFetch(url);
    // 未ログイン (401) の場合は空配列で安全に描画する (アカウントごとのデータ分離)
    currentTracks = response.ok ? await response.json() : [];
    if (document.getElementById('track-search')) document.getElementById('track-search').value = '';
    renderTracks(currentTracks);
}

function filterTracks() {
    const query = document.getElementById('track-search').value.toLowerCase();
    const filtered = currentTracks.filter(track => (track.title && track.title.toLowerCase().includes(query)) || (track.channel && track.channel.toLowerCase().includes(query)));
    renderTracks(filtered);
}

function renderTracks(tracks) {
    const container = document.getElementById('my-bookmarks');
    container.innerHTML = '';
    if (tracks.length === 0) return container.innerHTML = '<p style="color:var(--text-sub);">曲が見つかりません。</p>';

    const displayTracks = sortTracks(tracks, trackSortMode);

    displayTracks.forEach((track, index) => {
        const card = document.createElement('div');
        card.className = 'card draggable-track';
        card.draggable = true;
        card.dataset.trackId = track.id;
        card.onclick = () => { if (card._dragged || card._pointerDragged) return; playTrackFromQueue(index, displayTracks); };

        card.innerHTML = `
            <div class="track-menu-container" onclick="event.stopPropagation()">
                <button class="track-menu-btn" onclick="toggleTrackMenu(event, this)"><span class="material-symbols-rounded">more_vert</span></button>
                <div class="track-dropdown-menu">
                    <button onclick="toggleTrackFavorite(${track.id}, event)"><span class="material-symbols-rounded">${track.is_favorite == 1 ? 'heart_broken' : 'favorite'}</span>${track.is_favorite == 1 ? 'お気に入り解除' : 'お気に入り追加'}</button>
                    <button onclick="openMoveModalFromMenu(event, ${track.id})"><span class="material-symbols-rounded">drive_file_move</span>移動</button>
                    <button onclick="deleteTrackFromMenu(event, ${track.id})"><span class="material-symbols-rounded">close</span>削除</button>
                </div>
            </div>
            <div class="card-img-wrapper">
                <img src="https://img.youtube.com/vi/${track.youtube_id}/hqdefault.jpg" alt="thumbnail">
                <div class="card-hover-play"></div>
            </div>
            <div class="info with-handle">
                <div class="info-text">
                    <div class="title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</div>
                    <div class="artist">${escapeHtml(track.channel)}</div>
                </div>
                <div class="drag-handle" title="ドラッグで並び替え"><span class="material-symbols-rounded">drag_indicator</span></div>
            </div>
        `;

        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            card.classList.add('dragging');
            card._dragged = true;
            e.dataTransfer.setData('text/plain', String(track.id));
        });
        card.addEventListener('dragend', () => {
            lastPointerDragEndedAt = Date.now();
            card.classList.remove('dragging');
            document.querySelectorAll('#my-bookmarks .card').forEach(c => c.classList.remove('drag-over'));
            setTimeout(() => { card._dragged = false; }, 0);
        });
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!card.classList.contains('drag-over')) card.classList.add('drag-over');
        });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.classList.remove('drag-over');
            const draggedId = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (!draggedId || draggedId === track.id) return;
            trackSortMode = 'custom';
            const sortSelect = document.getElementById('manager-track-sort-select');
            if (sortSelect) sortSelect.value = 'custom';
            const dragIdx = currentTracks.findIndex(t => t.id === draggedId);
            const targetIdx = currentTracks.findIndex(t => t.id === track.id);
            if (dragIdx === -1 || targetIdx === -1) return;
            currentTracks.splice(targetIdx, 0, currentTracks.splice(dragIdx, 1)[0]);
            currentTracks.forEach((t, index) => { t.sort_order = index; });
            syncTrackDomOrder();
            reorderBookmarks(currentTracks.map(t => t.id));
        });

        enablePointerReorder({
            handle: card.querySelector('.drag-handle'),
            item: card,
            container,
            itemSelector: '.card',
            onDrop: persistBookmarkOrderFromDom
        });

        container.appendChild(card);
    });
}

// ブックマークの並びを保存
async function reorderBookmarks(orderedIds) {
    try {
        await tunedropFetch('api.php?action=reorder_bookmarks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ordered_ids: orderedIds })
        });
        // 画面は既に並び替え済み。DB保存のみ。
    } catch (err) { alert("並び替えの保存に失敗しました。"); }
}

// ==========================================================
// 雰囲気 Radar: 音源実測特徴量 → UMAP で2次元マップ (kiite radar風)
// ==========================================================
let vibeMapData = [];    // APIから取得した全プロット
let vibeFiltered = [];   // 検索/カテゴリ絞り込み後
let radarZoom = 1.0;
let radarPan = { x: 0, y: 0 };   // 正規化空間(0..1)でのパン量
let radarDragging = false;
let radarMoved = false;
let radarSelectedId = null;

const CATEGORY_COLORS = {
    'Vocaloid': '#ff5c7a',
    'J-POP': '#ff9d3c',
    'Anime': '#7ad0ff',
    'Lo-Fi': '#b58cff',
    'Other': '#9aa0a6',
};

function radarCategoryColor(cat) {
    return CATEGORY_COLORS[cat] || CATEGORY_COLORS['Other'];
}

// 特徴量を生成したエンジンの表示ラベル
function radarEngineLabel(engine) {
    if (engine === 'gemini') return 'AI(Gemini)';
    if (engine === 'rules') return 'AI推定(ルール)';
    return engine || '—';
}

// BPM が音源実測か AI 推定かの表示ラベル ('essentia' は旧エンジン行の互換値)
function radarBpmLabel(features) {
    const f = features || {};
    const src = f.bpm_source || (['essentia', 'audio', 'librosa', 'clap'].includes(f.engine) ? 'audio' : null);
    if (['essentia', 'audio', 'librosa', 'clap'].includes(src)) return 'BPM実測';
    if (f.tempo && f.tempo > 0) return 'BPM推定';
    return '';
}

// 雰囲気タグ (vibe_tags) の表示ラベル。無ければ mood を返す
function radarVibeLabel(features) {
    const f = features || {};
    if (f.vibe_tags && f.vibe_tags.length) return f.vibe_tags.slice(0, 3).join('・');
    return f.mood || '';
}

async function loadRadarData() {
    const hud = document.getElementById('radar-map-hud');
    const statusBtn = document.getElementById('btn-vibe-radar');
    if (statusBtn) statusBtn.innerText = '解析中...';
    if (hud) hud.textContent = 'AIで楽曲特徴量を推定中…';
    try {
        const res = await tunedropFetch('api.php?action=radar_map');
        const data = await res.json();
        if (!data.success && data.error) {
            if (hud) hud.textContent = data.error;
            drawRadarMap([]);
            return;
        }
        vibeMapData = (data.points || []).map(p => ({
            youtube_id: p.youtube_id,
            title: p.title,
            channel: p.channel,
            category: p.category || 'Other',
            playlist_name: p.playlist_name,
            author: p.author,
            features: p.features || {},
        }));
        const eng = data.points && data.points.length && data.points[0].features
            ? data.points[0].features.engine : null;
        const engLabel = eng === 'gemini' ? 'Gemini AI' : (eng === 'rules' ? 'AI推定(ルール)' : '');
        if (hud) hud.textContent = data.method === 'umap'
            ? `${data.count} 曲を AI×UMAP で表示${engLabel ? ' · ' + engLabel : ''}`
            : `${data.count} 曲を表示` + (data.pending && data.pending.length ? ` · ${data.pending.length} 曲は解析待ち` : '');
        applyRadarFilter();
    } catch (err) {
        console.error('Radar map error:', err);
        if (hud) hud.textContent = 'Flaskサーバー (app.py) に接続できません。';
        drawRadarMap([]);
    } finally {
        if (statusBtn) statusBtn.innerText = '🔍 雰囲気検索';
    }
}

async function loadVibeRadar() {
    const statusBtn = document.getElementById('btn-vibe-radar');
    const hud = document.getElementById('radar-map-hud');
    if (statusBtn) { statusBtn.disabled = true; statusBtn.innerText = '検索中...'; }
    if (hud) hud.textContent = '未解析の楽曲を音源実測で解析中…';
    try {
        // 未解析の楽曲のみ、音源実測 (librosa/CLAP) で雰囲気特徴を解析する。
        // 解析バッチが終わるまで待ってからマップへ反映する (従来は待たずに再読込していた)。
        await tunedropFetch('api.php?action=radar_analyze_all&force=0&audio=1');
        await pollAnalyzeStatus(statusBtn);
        await loadRadarData();
    } catch (_) {
        await loadRadarData();
    } finally {
        if (statusBtn) { statusBtn.disabled = false; statusBtn.innerText = '🔍 雰囲気検索'; }
    }
}

function applyRadarFilter() {
    const query = (document.getElementById('radar-title-search')?.value || '').toLowerCase();
    const category = document.getElementById('radar-category-filter')?.value || '';
    vibeFiltered = vibeMapData.filter(t => {
        const text = `${t.title} ${t.channel} ${t.author} ${t.playlist_name}`.toLowerCase();
        const okText = !query || text.includes(query);
        const okCat = !category || (t.category || 'Other') === category;
        return okText && okCat;
    });
    radarZoom = 1.0;
    radarPan = { x: 0, y: 0 };
    radarSelectedId = null;
    drawRadarMap(vibeFiltered);
    renderVibeTracks(vibeFiltered);
    renderRadarLegend();
}

function bindRadarControls() {
    const zoomIn = document.getElementById('btn-radar-zoom-in');
    const zoomOut = document.getElementById('btn-radar-zoom-out');
    const zoomReset = document.getElementById('btn-radar-zoom-reset');
    const analyzeAll = document.getElementById('btn-radar-analyze-all');
    if (zoomIn) zoomIn.onclick = () => { radarZoom = Math.min(8, radarZoom * 1.25); drawRadarMap(vibeFiltered); };
    if (zoomOut) zoomOut.onclick = () => { radarZoom = Math.max(0.2, radarZoom * 0.8); drawRadarMap(vibeFiltered); };
    if (zoomReset) zoomReset.onclick = () => { radarZoom = 1.0; radarPan = { x: 0, y: 0 }; drawRadarMap(vibeFiltered); };
    if (analyzeAll) analyzeAll.onclick = async () => {
        if (!confirm("全曲を再解析します。\n\nGemini AI 推定に加えて、音源解析 (librosa/CLAP) で実測BPM・雰囲気を取得します。\n曲数が多いと数分〜数十分かかります。\n\n実行しますか？")) return;
        analyzeAll.disabled = true; analyzeAll.innerText = '再解析開始...';
        // 全曲を Gemini(AI) + 音源解析(librosa/CLAP) で再解析する
        let started = null;
        try {
            const res = await tunedropFetch('api.php?action=radar_analyze_all&force=1&audio=1');
            started = await res.json();
        } catch (_) { }
        if (!started || started.success === false) {
            const hud = document.getElementById('radar-map-hud');
            if (hud) hud.textContent = (started && started.error) || '再解析を開始できませんでした。';
            analyzeAll.disabled = false; analyzeAll.innerText = '⟳ 全曲解析';
            return;
        }
        if (!started.queued || started.queued.length === 0) {
            analyzeAll.innerText = '対象曲なし';
            await loadRadarData();
            setTimeout(() => { analyzeAll.disabled = false; analyzeAll.innerText = '⟳ 全曲解析'; }, 1500);
            return;
        }
        // AI分を先に反映
        await new Promise(r => setTimeout(r, 1500));
        await loadRadarData();
        // 音源解析(実測BPM)の進捗をポーリングして完了まで待つ
        await pollAnalyzeStatus(analyzeAll);
        await loadRadarData();
        analyzeAll.disabled = false; analyzeAll.innerText = '⟳ 全曲解析';
    };
}

// 再解析バッチの進捗をポーリングする (完了または上限到達で返る)
async function pollAnalyzeStatus(btn) {
    const hud = document.getElementById('radar-map-hud');
    let state = null;
    for (let i = 0; i < 1800; i++) {
        try {
            const res = await tunedropFetch('api.php?action=radar_analyze_status');
            const data = await res.json();
            state = data.state || null;
        } catch (_) { state = null; }
        if (!state) break;
        const total = state.total || 0;
        const done = state.done || 0;
        if (state.running) {
            const label = total ? `解析中 ${done}/${total}` : '解析中...';
            if (btn) btn.innerText = label;
            if (hud) hud.textContent = `Gemini推定 + 音源解析(librosa/CLAP) で再解析中… ${total ? done + '/' + total : ''}`;
        } else {
            break;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    if (state && hud) {
        const results = state.results || [];
        const measured = results.filter(r => r.measured).length;
        hud.textContent = `再解析完了: ${results.length} 曲中 ${measured} 曲で実測BPMを取得`
            + (results.length > measured ? '（残りはAI推定BPM）' : '');
    }
    return state;
}

function renderRadarLegend() {
    const legend = document.getElementById('radar-map-legend');
    if (!legend) return;
    const cats = [...new Set(vibeFiltered.map(t => t.category || 'Other'))];
    legend.innerHTML = cats.map(c =>
        `<span class="legend-item"><span class="legend-dot" style="background:${radarCategoryColor(c)}"></span>${c}</span>`
    ).join('');
}


// UMAP座標をキャンバスに描画 (パン/ズーム/ホバー/クリック対応)
function drawRadarMap(tracks) {
    const container = document.getElementById('radar-map-container');
    const canvas = document.getElementById('radar-map-canvas');
    const tooltip = document.getElementById('radar-map-tooltip');
    if (!canvas || !container) return;

    // コンテナサイズに Canvas 解像度を合わせる (Retina対応)
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, container.clientWidth);
    const H = Math.max(1, container.clientHeight);
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
    }
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 背景 (淡いグラデーション)
    const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#101018');
    bg.addColorStop(1, '#050508');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // グリッド
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
        const gx = (W / 8) * i;
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
        const gy = (H / 8) * i;
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    if (!tracks || tracks.length === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('解析済みの楽曲がありません。「⟳ 全曲解析」で解析を実行してください。', W / 2, H / 2);
        return;
    }

    // 射影変換: 正規化座標(0..1) → キャンバス座標 (パン+ズーム)
    const hasCoords = tracks.some(t => typeof (t.features || {}).x === 'number');
    const R = hasCoords ? 1.0 : 0.66;              // 座標なしは円配置
    function toPixel(x, y) {
        const cx = W / 2 + (x - 0.5) * W * radarZoom + radarPan.x * W;
        const cy = H / 2 + (y - 0.5) * H * radarZoom + radarPan.y * H;
        return [cx, cy];
    }

    // 円配置の角度生成（座標がない場合のフォールバック）
    function circleAngle(i, n) {
        return (Math.PI * 2 * i) / Math.max(1, n) - Math.PI / 2;
    }

    const plot = tracks.map((t, i) => {
        const f = t.features || {};
        const hasXY = typeof f.x === 'number' && typeof f.y === 'number';
        let x, y;
        if (hasXY) {
            x = Math.max(0, Math.min(1, f.x));
            y = Math.max(0, Math.min(1, f.y));
        } else {
            const a = circleAngle(i, tracks.length);
            x = 0.5 + 0.35 * Math.cos(a);
            y = 0.5 + 0.35 * Math.sin(a);
        }
        const [px, py] = toPixel(x, y);
        return { t, x, y, px, py, hasXY, i };
    });

    // 選択中の楽曲をハイライト
    const selected = plot.find(o => o.t.youtube_id === radarSelectedId);

    // 各点を描画
    plot.forEach((o) => {
        const isSel = radarSelectedId === o.t.youtube_id;
        const color = radarCategoryColor(o.t.category);
        const r = isSel ? 7 : 5;
        const glow = isSel ? 14 : 0;

        if (glow) {
            const g = ctx.createRadialGradient(o.px, o.py, 0, o.px, o.py, glow);
            g.addColorStop(0, color + '99');
            g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(o.px, o.py, glow, 0, Math.PI * 2); ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(o.px, o.py, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = isSel ? 2 : 1;
        ctx.stroke();
    });

    // 選択ラベル（タイトル吹き出し）
    if (selected) {
        const label = selected.t.title || selected.t.youtube_id;
        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(label).width;
        const bx = selected.px, by = selected.py - 16;
        ctx.fillStyle = 'rgba(20,20,28,0.9)';
        roundRect(ctx, bx - tw / 2 - 8, by - 12, tw + 16, 20, 4);
        ctx.fill();
        ctx.strokeStyle = radarCategoryColor(selected.t.category);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx, by - 1);
    }
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function renderVibeTracks(tracks) {
    const strip = document.getElementById('vibe-track-strip');
    if (!strip) return;
    strip.innerHTML = '';
    if (!tracks || tracks.length === 0) {
        strip.innerHTML = '<p style="color:var(--text-sub); padding:12px;">表示できる楽曲がありません。</p>';
        return;
    }

    tracks.slice(0, 30).forEach(t => {
        const f = t.features || {};
        const color = radarCategoryColor(t.category);
        const card = document.createElement('div');
        card.className = 'strip-card';
        card.style.borderLeftColor = color;
        if (radarSelectedId === t.youtube_id) card.classList.add('selected');

        const coverHtml = t.youtube_id
            ? `<img src="https://img.youtube.com/vi/${t.youtube_id}/mqdefault.jpg" alt="thumb">`
            : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:24px;">🎵</div>`;
        const tempo = (f.tempo && f.tempo > 0) ? `${Math.round(f.tempo)} BPM` : '—';
        const vibe = radarVibeLabel(f);
        const bpmLabel = radarBpmLabel(f);
        const engLabel = radarEngineLabel(f.engine);

        card.innerHTML = `
            <div class="strip-thumb">${coverHtml}<div class="card-hover-play"></div></div>
            <div class="strip-info">
                <div class="strip-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
                <div class="strip-artist">${escapeHtml(t.channel || 'Unknown Artist')}</div>
                <div class="strip-meta">${escapeHtml(t.category || 'Other')} · <b>tempo</b> ${tempo}${bpmLabel ? ' (' + bpmLabel + ')' : ''}${vibe ? ' · <b>' + escapeHtml(vibe) + '</b>' : ''} · <b>${escapeHtml(engLabel)}</b></div>
            </div>
        `;
        card.onclick = () => {
            radarSelectedId = t.youtube_id;
            drawRadarMap(vibeFiltered);
            playFromRadar(t);
        };
        strip.appendChild(card);
    });
}

function playFromRadar(t) {
    if (!t || !t.youtube_id) return;
    currentDetailTracks = [{ id: t.youtube_id, youtube_id: t.youtube_id, title: t.title, channel: t.channel, is_favorite: 0 }];
    playTrackFromQueue(0, currentDetailTracks);
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// キャンバスポインタ操作 (ホバー/タップ/ドラッグ/ピンチ/ホイール)
function bindRadarPointer() {
    const container = document.getElementById('radar-map-container');
    const canvas = document.getElementById('radar-map-canvas');
    const tooltip = document.getElementById('radar-map-tooltip');
    if (!container || !canvas) return;

    function currentPlot() {
        const W = Math.max(1, container.clientWidth);
        const H = Math.max(1, container.clientHeight);
        return vibeFiltered.map((t, i) => {
            const f = t.features || {};
            const hasXY = typeof f.x === 'number' && typeof f.y === 'number';
            let x, y;
            if (hasXY) {
                x = Math.max(0, Math.min(1, f.x));
                y = Math.max(0, Math.min(1, f.y));
            } else {
                const a = (Math.PI * 2 * i) / Math.max(1, vibeFiltered.length) - Math.PI / 2;
                x = 0.5 + 0.35 * Math.cos(a);
                y = 0.5 + 0.35 * Math.sin(a);
            }
            const px = W / 2 + (x - 0.5) * W * radarZoom + radarPan.x * W;
            const py = H / 2 + (y - 0.5) * H * radarZoom + radarPan.y * H;
            return { t, x, y, px, py, hasXY, i };
        });
    }

    function localPos(e) {
        const rect = canvas.getBoundingClientRect();
        return [e.clientX - rect.left, e.clientY - rect.top];
    }

    function findNearest(px, py, maxDist) {
        let best = null, bestD = maxDist;
        currentPlot().forEach(o => {
            const d = Math.hypot(o.px - px, o.py - py);
            if (d < bestD) { bestD = d; best = o; }
        });
        return best;
    }

    const pointers = new Map();
    let gesture = null;

    function beginGesture() {
        const points = [...pointers.values()];
        if (!points.length) { gesture = null; return; }
        const center = points.length > 1
            ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
            : points[0];
        gesture = {
            ...center, pan: { ...radarPan }, zoom: radarZoom,
            distance: points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0,
        };
    }

    canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const [x, y] = localPos(e);
        if (!pointers.size) radarMoved = false;
        pointers.set(e.pointerId, { x, y });
        if (pointers.size > 1) radarMoved = true;
        canvas.setPointerCapture(e.pointerId);
        radarDragging = true;
        tooltip.style.display = 'none';
        beginGesture();
    });

    canvas.addEventListener('pointermove', (e) => {
        const [mx, my] = localPos(e);
        if (pointers.has(e.pointerId) && gesture) {
            pointers.set(e.pointerId, { x: mx, y: my });
            const points = [...pointers.values()];
            const x = points.length > 1 ? (points[0].x + points[1].x) / 2 : mx;
            const y = points.length > 1 ? (points[0].y + points[1].y) / 2 : my;
            if (Math.hypot(x - gesture.x, y - gesture.y) > 5) radarMoved = true;
            if (!radarMoved) return;
            const W = Math.max(1, container.clientWidth);
            const H = Math.max(1, container.clientHeight);
            if (points.length > 1 && gesture.distance > 0) {
                const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
                radarZoom = Math.max(0.2, Math.min(8, gesture.zoom * distance / gesture.distance));
            }
            const ratio = radarZoom / gesture.zoom;
            radarPan = {
                x: (x / W - 0.5) - (gesture.x / W - 0.5 - gesture.pan.x) * ratio,
                y: (y / H - 0.5) - (gesture.y / H - 0.5 - gesture.pan.y) * ratio,
            };
            canvas.style.cursor = 'grabbing';
            drawRadarMap(vibeFiltered);
            return;
        }
        if (e.pointerType !== 'mouse') return;
        const o = findNearest(mx, my, 12);
        canvas.style.cursor = o ? 'pointer' : 'grab';
        if (!o) { tooltip.style.display = 'none'; return; }
        const f = o.t.features || {};
        const vibe = radarVibeLabel(f);
        const bpmLabel = radarBpmLabel(f);
        const engLabel = f.engine === 'gemini' ? 'AI' : (f.engine === 'rules' ? 'AI推定' : '');
        tooltip.style.display = 'block';
        tooltip.innerHTML = `<b>${escapeHtml(o.t.title)}</b><span>${escapeHtml(o.t.channel || '')}</span><span>${escapeHtml(o.t.category || 'Other')} · ${f.tempo ? Math.round(f.tempo) + ' BPM' : '—'}${bpmLabel ? ' ' + bpmLabel : ''}${vibe ? ' · ' + escapeHtml(vibe) : ''}${engLabel ? ' · ' + engLabel : ''}</span>`;
        tooltip.style.left = Math.max(0, Math.min(mx + 14, container.clientWidth - tooltip.offsetWidth)) + 'px';
        tooltip.style.top = Math.max(0, Math.min(my + 14, container.clientHeight - tooltip.offsetHeight)) + 'px';
    });

    function endGesture(e) {
        if (!pointers.has(e.pointerId)) return;
        const select = e.type === 'pointerup' && pointers.size === 1 && !radarMoved;
        pointers.delete(e.pointerId);
        if (e.type !== 'pointerup') radarMoved = true;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        radarDragging = pointers.size > 0;
        beginGesture();
        canvas.style.cursor = 'grab';
        if (!select) return;
        const [mx, my] = localPos(e);
        const o = findNearest(mx, my, e.pointerType === 'mouse' ? 14 : 24);
        radarSelectedId = o ? o.t.youtube_id : null;
        drawRadarMap(vibeFiltered);
        renderVibeTracks(vibeFiltered);
        if (o) playFromRadar(o.t);
    }
    canvas.addEventListener('pointerup', endGesture);
    canvas.addEventListener('pointercancel', endGesture);
    canvas.addEventListener('lostpointercapture', endGesture);
    canvas.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });

    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        radarZoom = Math.max(0.2, Math.min(8, radarZoom * (e.deltaY < 0 ? 1.1 : 0.9)));
        drawRadarMap(vibeFiltered);
    }, { passive: false });
}


// プレイリスト詳細を開く (URLハッシュを履歴に積む)
let pendingDetail = { name: '', cover: '' };
function openPlaylistDetail(playlistId, playlistName, coverId) {
    pendingDetail = { name: playlistName || '', cover: coverId || '' };
    navigateView('playlist-detail', playlistId);
    // ハッシュが変わらない場合のみ即時描画 (変更時は hashchange 経由)
    if (('#' + 'playlist/' + playlistId) === location.hash) {
        renderPlaylistDetail(playlistId, playlistName, coverId);
    }
}

// プレイリスト詳細の実データロード・表示
async function renderPlaylistDetail(playlistId, playlistName, coverId) {
    switchView('playlist-detail');
    const effName = playlistName || pendingDetail.name;
    const effCover = coverId || pendingDetail.cover;
    if (effName) document.getElementById('detail-title').innerText = effName;
    const coverEl = document.getElementById('detail-cover');
    if (effCover) coverEl.innerHTML = `<img src="https://img.youtube.com/vi/${effCover}/hqdefault.jpg">`;
    else coverEl.innerHTML = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:40px;">🎵</div>`;

    const response = await tunedropFetch(`api.php?action=get_my_bookmarks&playlist_id=${playlistId}`);
    const tracks = await response.json();
    currentDetailTracks = tracks;
    if (!effName) {
        const titleFromList = allPlaylists.find(p => p.id == playlistId)
            || allRadarPlaylists.find(p => p.id == playlistId)
            || allRadarRecentPlaylists.find(p => p.id == playlistId)
            || sharePlaylists.find(p => p.id == playlistId);
        if (titleFromList) {
            document.getElementById('detail-title').innerText = titleFromList.name;
            if (titleFromList.cover_id) {
                document.getElementById('detail-cover').innerHTML = `<img src="https://img.youtube.com/vi/${titleFromList.cover_id}/hqdefault.jpg">`;
            }
        }
    }
    document.getElementById('detail-meta').innerText = `${tracks.length} 曲`;

    const favBtn = document.getElementById('btn-fav-playlist');
    if (favBtn) {
        const favIcon = document.getElementById('btn-fav-playlist-icon');
        let listData = allPlaylists.find(p => p.id === playlistId) || allRadarPlaylists.find(p => p.id === playlistId) || allRadarRecentPlaylists.find(p => p.id === playlistId) || sharePlaylists.find(p => p.id === playlistId);
        if (!listData) {
            const listsResponse = await tunedropFetch('api.php?action=get_public_playlists');
            const lists = await listsResponse.json();
            listData = lists.find(p => p.id === playlistId);
        }
        if (listData) {
            document.getElementById('detail-title').textContent = listData.name;
            if (listData.cover_id) {
                coverEl.innerHTML = `<img src="https://img.youtube.com/vi/${encodeURIComponent(listData.cover_id)}/hqdefault.jpg" alt="プレイリストのカバー">`;
            }
        }
        if (listData) {
            const setFav = (isFav) => {
                if (favIcon) { favIcon.textContent = 'favorite'; favIcon.classList.toggle('is-filled', isFav); favIcon.style.color = isFav ? 'var(--accent-color)' : '#fff'; }
                document.getElementById('playlist-favorite-label').textContent = isFav ? 'お気に入り解除' : 'お気に入り追加';
            };
            setFav(listData.is_favorite == 1);
            favBtn.onclick = async (e) => {
                favBtn.disabled = true;
                const result = await togglePlaylistFavorite(playlistId, e);
                if (result?.success) {
                    listData.is_favorite = result.is_favorite;
                    setFav(listData.is_favorite == 1);
                }
                favBtn.disabled = false;
                closeTrackMenus();
            };
        }
    }

    const shareBtn = document.getElementById('btn-share');
    if (shareBtn) {
        shareBtn.onclick = async () => {
            const shareData = {
                title: `Tune drop: ${document.getElementById('detail-title').textContent}`,
                text: `プレイリスト「${document.getElementById('detail-title').textContent}」をチェック！`,
                url: window.location.href
            };
            try {
                if (navigator.share) {
                    await navigator.share(shareData);
                } else {
                    alert("お使いのブラウザは共有機能に対応していません。URL抽出機能をご利用ください。");
                }
            } catch (err) {
                console.log("共有がキャンセルされたかエラーが発生しました:", err);
            }
        };
    }

    const exportBtn = document.getElementById('btn-export-urls');
    if (exportBtn) {
        exportBtn.onclick = () => exportPlaylistUrls(playlistName, currentDetailTracks);
    }

    renderDetailTracks(currentDetailTracks);
}

function renderDetailTracks(tracks) {
    const listContainer = document.getElementById('detail-track-list');
    listContainer.innerHTML = '';
    if (tracks.length === 0) return listContainer.innerHTML = '<p style="padding:20px; color:var(--text-sub);">このプレイリストは空です。</p>';

    // ソート適用 (カスタム順 = sort_order 順)
    const displayTracks = sortTracks(tracks, trackSortMode);

    displayTracks.forEach((track, index) => {
        const item = document.createElement('div');
        item.className = 'track-list-item draggable-track';
        item.draggable = true;
        item.dataset.trackId = track.id;
        if (currentQueue === displayTracks && currentTrackIndex === index) item.classList.add('playing');

        item.onclick = () => {
            if (item._dragged || item._pointerDragged) return;
            playTrackFromQueue(index, displayTracks);
            document.querySelectorAll('.track-list-item').forEach(el => el.classList.remove('playing'));
            item.classList.add('playing');
        };

        item.innerHTML = `
            <div class="drag-handle drag-handle-inline" title="ドラッグで並び替え"><span class="material-symbols-rounded">drag_indicator</span></div>
            <div class="track-index">${index + 1}</div>
            <div class="track-thumb"><img src="https://img.youtube.com/vi/${track.youtube_id}/mqdefault.jpg" alt="thumb"></div>
            <div class="track-info"><div class="title">${track.title}</div><div class="artist">${track.channel}</div></div>
            <div class="track-actions detail-menu" onclick="event.stopPropagation()">
                <button type="button" class="track-menu-btn" onclick="toggleTrackMenu(event, this)" aria-label="曲のメニュー" aria-expanded="false"><span class="material-symbols-rounded">more_vert</span></button>
                <div class="track-dropdown-menu">
                    <button type="button" onclick="toggleTrackFavorite(${track.id}, event)"><span class="material-symbols-rounded">${track.is_favorite == 1 ? 'heart_broken' : 'favorite'}</span>${track.is_favorite == 1 ? 'お気に入り解除' : 'お気に入り追加'}</button>
                </div>
            </div>
        `;

        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            item.classList.add('dragging');
            item._dragged = true;
            e.dataTransfer.setData('text/plain', String(track.id));
        });
        item.addEventListener('dragend', () => {
            lastPointerDragEndedAt = Date.now();
            item.classList.remove('dragging');
            document.querySelectorAll('#detail-track-list .track-list-item').forEach(el => el.classList.remove('drag-over'));
            setTimeout(() => { item._dragged = false; }, 0);
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!item.classList.contains('drag-over')) item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const draggedId = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (!draggedId || draggedId === track.id) return;
            const dragIdx = currentDetailTracks.findIndex(t => t.id === draggedId);
            const targetIdx = currentDetailTracks.findIndex(t => t.id === track.id);
            if (dragIdx === -1 || targetIdx === -1) return;
            // カスタム順へ切替し、並びを確定
            trackSortMode = 'custom';
            const sel = document.getElementById('track-sort-select');
            if (sel) sel.value = 'custom';
            currentDetailTracks.splice(targetIdx, 0, currentDetailTracks.splice(dragIdx, 1)[0]);
            // sort_order を並び順に合わせて更新 (以降の再描画で正しく保たれる)
            currentDetailTracks.forEach((t, i) => { t.sort_order = i; });
            renderDetailTracks(currentDetailTracks);
            reorderBookmarks(currentDetailTracks.map(t => t.id));
        });

        // タッチ端末ではつまみ (drag-handle) を Pointer Events で並び替える
        enablePointerReorder({
            handle: item.querySelector('.drag-handle'),
            item,
            container: listContainer,
            itemSelector: '.track-list-item',
            onDrop: persistDetailTrackOrderFromDom
        });

        listContainer.appendChild(item);
    });
}

function playAllRadarTracks() {
    if (currentDetailTracks.length > 0) playTrackFromQueue(0, currentDetailTracks);
    else alert("再生できる曲がありません。");
}

function exportPlaylistUrls(playlistName, tracks) {
    if (!tracks || tracks.length === 0) return alert("曲が登録されていません。");

    let textData = `🎵 Tune drop プレイリスト: ${playlistName}\n\n`;
    const videoIds = tracks.map((track, index) => {
        textData += `${index + 1}. ${track.title}\n   https://youtu.be/${track.youtube_id}\n\n`;
        return track.youtube_id;
    });

    // 一括再生用URLの生成
    const bulkUrl = `https://www.youtube.com/watch_videos?video_ids=${videoIds.join(',')}`;
    textData += `▶ YouTubeで一括再生する:\n${bulkUrl}\n`;

    document.getElementById('export-textarea').value = textData;
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく
    document.getElementById('export-preview-modal').style.display = 'flex';

    // 左下の一括再生ボタンにクリックイベントを設定
    const bulkBtn = document.getElementById('btn-open-youtube-bulk');
    if (bulkBtn) {
        bulkBtn.onclick = () => window.open(bulkUrl, '_blank');
    }

    // コピーボタンの状態リセット
    const copyBtn = document.getElementById('btn-copy-export');
    if (copyBtn) {
        copyBtn.innerText = 'Copy to clipboard';
        copyBtn.style.background = 'var(--accent-color)';
        copyBtn.style.color = '#000';
    }
}

function closeExportModal() { document.getElementById('export-preview-modal').style.display = 'none'; }
function copyExportText() {
    const textarea = document.getElementById('export-textarea');
    textarea.select();
    navigator.clipboard.writeText(textarea.value).then(() => {
        const copyBtn = document.getElementById('btn-copy-export');
        copyBtn.innerText = '✅ Copied!';
        copyBtn.style.background = '#444';
        copyBtn.style.color = '#fff';
        setTimeout(() => {
            copyBtn.innerText = 'Copy to clipboard';
            copyBtn.style.background = 'var(--accent-color)';
            copyBtn.style.color = '#000';
        }, 2000);
    }).catch(err => { alert("クリップボードへのコピーに失敗しました。"); });
}

function playRadarRandomThree() {
    // Draw from the current Radar results, without repeating the same video.
    const candidates = [...new Map(vibeFiltered
        .filter(track => track.youtube_id)
        .map(track => [track.youtube_id, track])).values()];
    if (!candidates.length) {
        alert('再生できる曲がありません。Radarの読み込み後、検索条件を確認してください。');
        return;
    }
    for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const queue = candidates.slice(0, 3).map(track => ({
        ...track, id: track.youtube_id, is_favorite: track.is_favorite || 0,
        fromRadar: true,
    }));
    // 再生が始まったらメニューを閉じてマップ/コンテンツを見せる
    closeMobileMenu();
    playTrackFromQueue(0, queue);
}

// ==========================================================
// Share: みんなの公開プレイリスト一覧
// ==========================================================
async function loadSharePlaylists() {
    const grid = document.getElementById('share-playlists-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="share-loading"><span class="share-spinner"></span>みんなのプレイリストを探しています…</div>';
    try {
        const res = await tunedropFetch('api.php?action=get_public_playlists');
        sharePlaylists = await res.json();
        renderSharePlaylists();
    } catch (err) {
        grid.innerHTML = '<p style="color:var(--text-sub); grid-column: 1 / -1;">読み込みに失敗しました。</p>';
        console.error(err);
    }
}

function renderSharePlaylists() {
    const grid = document.getElementById('share-playlists-grid');
    if (!grid) return;
    const query = (document.getElementById('share-search')?.value || '').toLowerCase();
    const category = document.getElementById('share-category')?.value || '';
    const filtered = (sharePlaylists || []).filter(p => {
        const name = (p.name || '').toLowerCase();
        const author = ((p.author || p.author_name || p.username || '')).toLowerCase();
        const okText = !query || name.includes(query) || author.includes(query);
        const okCat = !category || (p.category || 'Other') === category;
        return okText && okCat;
    });

    if (filtered.length === 0) {
        grid.innerHTML = '<div class="share-empty"><div class="share-empty-icon">🎉</div><p>まだ公開されたプレイリストがありません。</p><p class="share-empty-sub">「編集・公開」から最初の1つを公開してみよう！</p></div>';
        return;
    }

    grid.innerHTML = '';
    filtered.forEach((list, index) => {
        const card = document.createElement('div');
        card.className = 'card share-card';
        card.style.animationDelay = `${Math.min(index * 40, 480)}ms`;
        card.onclick = () => openPlaylistDetail(list.id, list.name, list.cover_id);

        const coverHtml = list.cover_id
            ? `<img src="https://img.youtube.com/vi/${list.cover_id}/hqdefault.jpg" alt="cover">`
            : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:40px;">🎵</div>`;
        const catBadge = list.category ? `<span class="cat-badge" style="position:absolute; top:10px; left:10px; z-index:10; margin:0;">${escapeHtml(list.category)}</span>` : '';
        const authorName = escapeHtml(list.author || list.author_name || list.username || 'User');
        const trackCount = (typeof list.track_count === 'number') ? list.track_count : '—';

        card.innerHTML = `
            ${catBadge}
            <div class="card-img-wrapper">${coverHtml}<div class="card-hover-play"></div></div>
            <div class="info">
                <div class="title" title="${escapeHtml(list.name)}">${escapeHtml(list.name)}</div>
                <div class="artist"><span class="material-symbols-rounded share-author-icon">person</span>${authorName}<span class="share-track-count">🎵 ${trackCount}曲</span></div>
            </div>
        `;
        grid.appendChild(card);
    });
}

// Share画面の「おまかせ」: 公開プレイリストからランダムに1つ開く
function openRandomSharePlaylist() {
    const lists = (sharePlaylists || []).filter(p => p && p.id);
    if (lists.length === 0) {
        alert('まだ公開されたプレイリストがありません。');
        return;
    }
    const pick = lists[Math.floor(Math.random() * lists.length)];
    openPlaylistDetail(pick.id, pick.name, pick.cover_id);
}

function playTrackFromQueue(index, queue) {
    closeMobileMenu();   // 再生 (他操作) でメニューが残らないようにする
    currentQueue = queue;
    currentTrackIndex = index;
    const track = currentQueue[index];
    if (track.fromRadar) {
        radarSelectedId = track.youtube_id;
        if (document.getElementById('view-radar').classList.contains('active')) {
            drawRadarMap(vibeFiltered);
            renderVibeTracks(vibeFiltered);
        }
    }

    document.getElementById('player-thumb').style.display = 'block';
    document.getElementById('player-thumb').src = `https://img.youtube.com/vi/${track.youtube_id}/mqdefault.jpg`;
    document.getElementById('player-title').innerText = track.title;
    document.getElementById('player-artist').innerText = track.channel || 'Unknown Artist';
    document.getElementById('youtube-popup').classList.add('is-active');

    updatePlayerFavButton(track.is_favorite);
    syncPlayerFavorite(track);
    if (playerReady && player && player.loadVideoById) {
        const loadedVideoId = player.getVideoData?.().video_id;
        if (loadedVideoId !== track.youtube_id) {
            player.destroy();
            player = null;
            playerReady = false;
            createYouTubePlayer(track.youtube_id);
        } else {
            player.playVideo();
        }
    }
}

function skipTrack(direction) {
    if (currentQueue.length === 0 || currentTrackIndex === -1) return;
    const nextIndex = currentTrackIndex + direction;
    if (nextIndex >= 0 && nextIndex < currentQueue.length) playTrackFromQueue(nextIndex, currentQueue);
}

function onYouTubeIframeAPIReady() {
    if (player) return;
    const initialVideoId = currentQueue[currentTrackIndex]?.youtube_id || '';
    createYouTubePlayer(initialVideoId);
}

function createYouTubePlayer(videoId) {
    document.getElementById('youtube-player')?.remove();
    document.getElementById('youtube-player-frame')?.remove();
    const playerContainer = document.createElement('div');
    playerContainer.id = 'youtube-player-frame';
    document.getElementById('youtube-popup').appendChild(playerContainer);
    player = new YT.Player('youtube-player-frame', {
        height: '200', width: '355', videoId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
            'autoplay': 1,
            'cc_load_policy': 0,
            'controls': 1,
            'enablejsapi': 1,
            'origin': window.location.origin,
            'playsinline': 1,
            'rel': 0
        },
        events: {
            'onReady': onYouTubePlayerReady,
            'onStateChange': onPlayerStateChange,
            'onError': onYouTubePlayerError
        }
    });
}

/* 自動字幕をオフにする (プレイヤー初期化時のみ。ユーザーが後からCCをオンにした場合は尊重) */
function disableCaptions() {
    if (!player || typeof player.setOption !== 'function') return;
    try {
        player.setOption('captions', 'track', {});
        player.unloadModule?.('captions');
    } catch (e) {
        /* captions モジュールが未ロードのケースは無視 */
    }
}

function onYouTubePlayerReady() {
    playerReady = true;
    disableCaptions();
    if (currentQueue.length > 0 && currentTrackIndex >= 0) {
        const currentVideoId = currentQueue[currentTrackIndex].youtube_id;
        if (player.getVideoData?.().video_id !== currentVideoId) {
            player.loadVideoById(currentVideoId);
        }
        player.playVideo();
    }
}

function onYouTubePlayerError(event) {
    console.error('YouTube player error:', event.data);
}

function onPlayerStateChange(event) {
    const playBtn = document.getElementById('play-pause-btn');
    if (event.data === YT.PlayerState.PLAYING) {
        isPlaying = true;
        playBtn.classList.add('is-playing');
        progressInterval = setInterval(updateProgressBar, 500);
    } else {
        isPlaying = false;
        playBtn.classList.remove('is-playing');
        clearInterval(progressInterval);
    }
    if (event.data === YT.PlayerState.ENDED) skipTrack(1);
}

function togglePlay() {
    if (!player) return;
    isPlaying ? player.pauseVideo() : player.playVideo();
}

function updateProgressBar() {
    if (!player || !isPlaying) return;
    const currentTime = player.getCurrentTime();
    const duration = player.getDuration();
    if (duration > 0) {
        document.getElementById('progress-bar').style.width = `${(currentTime / duration) * 100}%`;
        document.getElementById('time-display').innerText = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    }
}

function seekTrack(event) {
    if (!player || player.getDuration() === 0) return;
    const container = document.getElementById('progress-container');
    const clickX = event.clientX - container.getBoundingClientRect().left;
    player.seekTo((clickX / container.offsetWidth) * player.getDuration(), true);
}

function formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
}

document.addEventListener("DOMContentLoaded", () => {
    if (window.YT?.Player && !player) onYouTubeIframeAPIReady();
    checkLoginStatus();
    initGoogleAuth();
    bindRadarControls();
    bindRadarPointer();
    // Keep the canvas aligned while the mobile workspace slides below the player.
    const radarContainer = document.getElementById('radar-map-container');
    if (radarContainer) {
        const radarResizeObserver = new ResizeObserver(() => {
            if (radarContainer.clientWidth && radarContainer.clientHeight) {
                drawRadarMap(vibeFiltered);
            }
        });
        radarResizeObserver.observe(radarContainer);
    }
    window.addEventListener('resize', () => {
        if (document.getElementById('view-radar').classList.contains('active')) drawRadarMap(vibeFiltered);
    });

    // ルーティング: ハッシュ変更 (ブラウザ戻る/進む/直接URL) をビューへ反映
    window.addEventListener('hashchange', applyHashView);
    window.addEventListener('popstate', applyHashView);

    // 初期表示 (ハッシュがあればそれを復元、なければ manager)
    const { view, id } = currentHashView();
    if (view === 'playlist-detail' && id) {
        renderPlaylistDetail(parseInt(id, 10), '', '');
    } else {
        switchView(view);
        // ハッシュが無い場合は URL を揃える (履歴置換)
        if (!location.hash) history.replaceState(null, '', '#/manager');
    }
});
