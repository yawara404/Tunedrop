// ===== api-client (旧 frontend/api-client.js を統合: API接続先の自動検出) =====
// Live Serverは静的配信専用。PHPが実行される接続先を確認してからAPIを呼ぶ。
let tunedropApiPromise;

async function resolveTunedropApi() {
    const config = window.TUNEDROP_CONFIG || {};
    const candidates = config.apiUrl ? [config.apiUrl] : [
        new URL('api.php', window.location.href).href,
        config.mampApiUrl || 'http://localhost:8888/Tunedrop/api.php',
        'http://localhost:8888/api.php'
    ];
    for (const candidate of [...new Set(candidates)]) {
        const url = new URL(candidate, window.location.href);
        url.search = '?action=health';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try {
            const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) continue;
            const data = await response.json();
            if (data.service === 'TuneDrop PHP API' && data.status === 'ok') {
                url.search = '';
                return url;
            }
        } catch (_) {
            // Live ServerのPHPソース・404・停止中のサーバーは候補から除外。
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error('APIに接続できません。MAMPを起動し、config.jsのmampApiUrlと公開フォルダを確認してください。');
}

async function tunedropFetch(path, options) {
    if (!tunedropApiPromise) {
        tunedropApiPromise = resolveTunedropApi().catch(error => {
            tunedropApiPromise = null;
            throw error;
        });
    }
    const url = new URL((await tunedropApiPromise).href);
    url.search = new URL(path, window.location.href).search;
    // JWT (app.py が発行) を自動付与する。api.php はこれでユーザーごとのデータ分離を行う。
    const headers = new Headers(options && options.headers ? options.headers : undefined);
    const token = localStorage.getItem('tunedrop_token');
    if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
    const response = await fetch(url, Object.assign({}, options, { headers }));
    if (!response.headers.get('content-type')?.includes('application/json')) {
        tunedropApiPromise = null;
        throw new Error('APIからJSONが返りません。MAMPのPHP設定とconfig.jsを確認してください。');
    }
    return response;
}

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
let shareRecommended = [];
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
    // GSI スクリプト未ロード時は初期化を待機する (ログインモーダルを開いたときに再試行)。
    // 未登録 origin では Google 側が [GSI_LOGGER] エラーを出すため、コンソールを汚さないよう
    // 初期化はユーザーがログインモーダルを開いたタイミングに限定する。
    if (!(window.google && google.accounts && google.accounts.id)) return;
    if (googleAuthInitialized) return;

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

// サイドバー・カード一覧の描画 (バニラJS: Vue依存を排除して軽量化)。
function renderManagerLists(filtered) {
    renderPlaylistNav(filtered);
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

// ドラッグ終了の抑止用ブリッジ (タッチ並び替え直後の誤クリック防止)。
window.markDragEnded = () => { lastPointerDragEndedAt = Date.now(); };

// 並び替えたユーザーリスト順を状態とDBへ反映する (再描画はしない)。
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
            const videoId = data.youtube_id;
            const newStatus = data.is_favorite;
            // 同じ曲の別リストのカードや再生キューにも反映する。
            for (const track of [...currentTracks, ...currentDetailTracks, ...currentQueue]) {
                if (track.youtube_id === videoId) track.is_favorite = newStatus;
            }
            if (currentQueue[currentTrackIndex]?.youtube_id === videoId) {
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
// リスト (created_at / name) と曲 (added_at / title) で使うキーだけが違うため共通化。
// 'custom' は DB が返した並び (sort_order → id 昇順) を尊重する。
function sortByMode(items, mode, dateKey, nameKey) {
    const arr = [...items];
    switch (mode) {
        case 'newest':
            // 新規順: id 降順 (新しいほど id 大)
            return arr.sort((a, b) => (b.id ?? 0) - (a.id ?? 0) || (b[dateKey] || '').localeCompare(a[dateKey] || ''));
        case 'oldest':
            // 古い順: id 昇順
            return arr.sort((a, b) => (a.id ?? 0) - (b.id ?? 0) || (a[dateKey] || '').localeCompare(b[dateKey] || ''));
        case 'name':
            // 名前順 (localeCompare で自然な並び)
            return arr.sort((a, b) => (a[nameKey] || '').localeCompare(b[nameKey] || '', 'ja'));
        case 'custom':
        default:
            return arr.sort((a, b) => ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || ((a.id ?? 0) - (b.id ?? 0)));
    }
}

function sortPlaylists(playlists, mode) {
    return sortByMode(playlists, mode, 'created_at', 'name');
}

function sortTracks(tracks, mode) {
    return sortByMode(tracks, mode, 'added_at', 'title');
}

function onPlaylistSortChange() {
    const sel = document.getElementById('playlist-sort-select');
    playlistSortMode = sel ? sel.value : 'custom';
    // ソート順の変更を反映 (再描画する)
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
let radarNeighborIds = null;   // 周辺9曲ボタンで下の一覧を絞り込んだときの youtube_id 群 (解除するまで維持)
let radarPlotCache = null;   // 直近 drawRadarMap の当たり判定用プロット (mousemove毎の再計算を避ける)
let radarDrawQueued = false; // ドラッグ/ホイール中の再描画まとめ用

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
    if (['essentia', 'audio', 'librosa', 'clap'].includes(src)) {
        // オクターブ (半速/倍速) を補正した曲は、その根拠も表示する
        if (f.bpm_method === 'octave') return 'BPM実測(オクターブ補正)';
        if (f.bpm_method === 'reference') return 'BPM実測(参照BPM補正)';
        return 'BPM実測';
    }
    if (f.tempo && f.tempo > 0) return 'BPM推定';
    return '';
}

// 雰囲気タグ (vibe_tags) の表示ラベル。無ければ mood を返す
function radarVibeLabel(features) {
    const f = features || {};
    if (f.vibe_tags && f.vibe_tags.length) return f.vibe_tags.slice(0, 3).join('・');
    return f.mood || '';
}

// マップの点・曲カード・ツールチップで共通に使う表示ラベル一式
function radarTrackLabels(track) {
    const f = (track && track.features) || {};
    return {
        category: (track && track.category) || 'Other',
        tempo: (f.tempo > 0) ? `${Math.round(f.tempo)} BPM` : '—',
        bpmSource: radarBpmLabel(f),
        vibe: radarVibeLabel(f),
        engine: radarEngineLabel(f.engine),
    };
}

// 楽曲をマップ上のピクセル座標へ射影する (パン + ズーム適用済み)。
// 座標 (features.x / features.y) が無い曲は円配置へフォールバックする。
// 描画 (drawRadarMap) と当たり判定 (bindRadarPointer) が同じ式を使うため共通化している。
function radarPlotPoints(tracks, W, H) {
    const list = tracks || [];
    return list.map((track, index) => {
        const f = track.features || {};
        let x, y;
        if (typeof f.x === 'number' && typeof f.y === 'number') {
            x = Math.max(0, Math.min(1, f.x));
            y = Math.max(0, Math.min(1, f.y));
        } else {
            const angle = (Math.PI * 2 * index) / Math.max(1, list.length) - Math.PI / 2;
            x = 0.5 + 0.35 * Math.cos(angle);
            y = 0.5 + 0.35 * Math.sin(angle);
        }
        return {
            t: track,
            px: W / 2 + (x - 0.5) * W * radarZoom + radarPan.x * W,
            py: H / 2 + (y - 0.5) * H * radarZoom + radarPan.y * H,
        };
    });
}

// マップ上の吹き出し (マウスホバー時のツールチップ) の中身
function radarTooltipHtml(track) {
    const { category, tempo, bpmSource, vibe, engine } = radarTrackLabels(track);
    return `<b>${escapeHtml(track.title)}</b><span>${escapeHtml(track.channel || '')}</span>`
        + `<span>${escapeHtml(category)} · ${tempo}${bpmSource ? ' ' + escapeHtml(bpmSource) : ''}`
        + `${vibe ? ' · ' + escapeHtml(vibe) : ''}${engine ? ' · ' + escapeHtml(engine) : ''}</span>`;
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
        const pendingCount = (data.pending && data.pending.length) || 0;
        const pendingLabel = pendingCount ? ` · ${pendingCount} 曲は解析待ち` : '';
        if (hud) hud.textContent = data.method === 'umap'
            ? `${data.count} 曲を AI×UMAP で表示${engLabel ? ' · ' + engLabel : ''}${pendingLabel}`
            : `${data.count} 曲を表示${pendingLabel}`;
        radarPendingCount = pendingCount;
        radarLastTotal = vibeMapData.length;
        radarStripLimit = 30;
        buildRadarVibeOptions();
        buildRadarTempoOptions();
        radarOptionsSig = radarDataSig();
        updateRadarAnalyzeButton();
        applyRadarFilter(false);
    } catch (err) {
        console.error('Radar map error:', err);
        if (hud) hud.textContent = 'Flaskサーバー (app.py) に接続できません。';
        drawRadarMap([]);
    } finally {
        updateRadarAnalyzeButton();
    }
}

// 未解析曲数に応じてサイドバーの解析ボタンの表示を変える (0件なら押せない)
function updateRadarAnalyzeButton() {
    const statusBtn = document.getElementById('btn-vibe-radar');
    if (!statusBtn || statusBtn.disabled) return;
    if (radarPendingCount > 0) {
        statusBtn.innerText = `🔍 未解析${radarPendingCount}曲を解析`;
    } else if (vibeMapData.length > 0) {
        statusBtn.innerText = '✓ 解析済み';
    } else {
        statusBtn.innerText = '🔍 雰囲気検索';
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
        let started = null;
        try {
            const res = await tunedropFetch('api.php?action=radar_analyze_all&force=0&audio=1');
            started = await res.json();
        } catch (_) { started = null; }
        if (!started || started.success === false) {
            await loadRadarData();
            return;
        }
        // 未解析曲なし (かつ実行中バッチなし) はポーリングせずそのまま再読込する。
        // 実行中バッチがある場合はポーリングして完了を待つ。
        if ((!started.queued || started.queued.length === 0) && !started.running) {
            await loadRadarData();
            return;
        }
        await pollAnalyzeStatus(statusBtn);
        await loadRadarData();
    } catch (_) {
        await loadRadarData();
    } finally {
        if (statusBtn) { statusBtn.disabled = false; }
        updateRadarAnalyzeButton();
    }
}

let radarFilterTimer = null;
let radarStripLimit = 30;
let radarLastTotal = 0;
let radarPendingCount = 0;
let radarVibeOptions = [];
let radarOptionsSig = '';

function radarDataSig() {
    return `${vibeMapData.length}:${vibeMapData.length ? vibeMapData[0].youtube_id : ''}`;
}

// 絞り込み選択肢の欠落を自己修復する (古いJSキャッシュや取得順序の入れ違いで空のまま残った場合用)。
// データ署名が変わったか、選択肢が空のときだけ作り直す (入力中の再構築で開いている選択肢を閉じないため)
function ensureRadarFilterOptions() {
    if (!vibeMapData.length) return;
    const vibeSel = document.getElementById('radar-vibe-filter');
    const tempoSel = document.getElementById('radar-tempo-filter');
    const empty = (sel) => !sel || !sel.options || sel.options.length <= 1;
    if (radarOptionsSig !== radarDataSig() || empty(vibeSel) || empty(tempoSel)) {
        radarOptionsSig = radarDataSig();
        buildRadarVibeOptions();
        buildRadarTempoOptions();
    }
}

function queueRadarFilter() {
    //  typing every keystroke resets view previously; now debounce + preserve view
    if (radarFilterTimer) clearTimeout(radarFilterTimer);
    radarFilterTimer = setTimeout(() => { radarFilterTimer = null; applyRadarFilter(true); }, 150);
}

function clearRadarSearch() {
    const input = document.getElementById('radar-title-search');
    if (input) input.value = '';
    radarStripLimit = 30;
    applyRadarFilter(true);
    if (input) input.focus();
}

// 検索欄の Enter=先頭結果を再生、Escape=クリア
function onRadarSearchKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        applyRadarFilter(true);
        const first = vibeFiltered[0];
        if (first) selectRadarTrack(first.youtube_id, { play: true });
    } else if (e.key === 'Escape') {
        e.preventDefault();
        clearRadarSearch();
    }
}

// 検索・カテゴリ・雰囲気・BPM・並び順をすべて初期化
function clearRadarFilters() {
    const q = document.getElementById('radar-title-search');
    const cat = document.getElementById('radar-category-filter');
    const vibe = document.getElementById('radar-vibe-filter');
    const tempo = document.getElementById('radar-tempo-filter');
    const sort = document.getElementById('radar-sort');
    if (q) q.value = '';
    if (cat) cat.value = '';
    if (vibe) vibe.value = '';
    if (tempo) tempo.value = '';
    if (sort) sort.value = 'default';
    radarStripLimit = 30;
    radarSelectedId = null;
    radarNeighborIds = null;   // 周辺絞り込みも解除
    hideRadarOverlap();
    applyRadarFilter(true);
    resetRadarView();
}

function radarTempoValue(t) {
    const v = Number(t?.features?.tempo);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

// 大まかな3区分の固定選択肢 (細かい10刻みではなく「ゆったり/ふつう/速め」で選ぶ)
const RADAR_TEMPO_BANDS = [
    { key: 'slow', label: 'ゆったり (~100)', lo: 0, hi: 100 },
    { key: 'mid', label: 'ふつう (100〜140)', lo: 100, hi: 140 },
    { key: 'fast', label: '速め (140〜)', lo: 140, hi: Infinity },
];
let radarTempoBands = [];

function buildRadarTempoOptions() {
    const vals = (vibeMapData || []).map(radarTempoValue).filter(v => v > 0);
    const sel = document.getElementById('radar-tempo-filter');
    radarTempoBands = RADAR_TEMPO_BANDS.map(b => ({
        ...b, count: vals.filter(v => v >= b.lo && v < b.hi).length,
    }));
    if (!sel) return;
    if (!vals.length) {
        sel.innerHTML = '<option value="">BPM: All</option>';
        sel.title = 'BPM取得済みの曲がありません';
        return;
    }
    const prev = sel.value || '';
    sel.innerHTML = '<option value="">BPM: All</option>' + radarTempoBands.map(b =>
        `<option value="${b.key}"${b.count ? '' : ' disabled'}>BPM ${b.label} (${b.count}曲)</option>`).join('');
    if (prev && radarTempoBands.some(b => b.key === prev && b.count)) sel.value = prev;
    const lo = Math.floor(Math.min(...vals));
    const hi = Math.ceil(Math.max(...vals));
    sel.title = `BPMで絞り込み (取得済 ${lo}〜${hi}・${vals.length}曲)`;
}

function radarTempoMatch(t, key) {
    if (!key) return true;
    const band = RADAR_TEMPO_BANDS.find(b => b.key === key);
    if (!band) return true;
    const bpm = radarTempoValue(t);
    if (!bpm) return false;   // BPM未取得の曲はBPM指定がある場合のみ対象外
    return bpm >= band.lo && bpm < band.hi;
}

function radarVibeMatch(t, key) {
    if (!key) return true;
    const f = t?.features || {};
    if (Array.isArray(f.vibe_tags) && f.vibe_tags.includes(key)) return true;
    return (f.mood || '') === key;
}

// 全曲から雰囲気タグ候補を作る (件数が多い順・最大12件)
function buildRadarVibeOptions() {
    const counts = new Map();
    (vibeMapData || []).forEach(t => {
        const f = t?.features || {};
        (f.vibe_tags || []).forEach(tag => {
            if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
        });
        if ((!f.vibe_tags || !f.vibe_tags.length) && f.mood) {
            counts.set(f.mood, (counts.get(f.mood) || 0) + 1);
        }
    });
    radarVibeOptions = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([tag]) => tag);
    const sel = document.getElementById('radar-vibe-filter');
    if (!sel) return;
    const prev = sel.value || '';
    sel.innerHTML = '<option value="">雰囲気: All</option>' + radarVibeOptions.map(tag =>
        `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
    if (prev && radarVibeOptions.includes(prev)) sel.value = prev;
}

function resetRadarView() {
    radarZoom = 1.0;
    radarPan = { x: 0, y: 0 };
    drawRadarMap(vibeFiltered);
}

function applyRadarFilter(preserveView) {
    ensureRadarFilterOptions();
    radarNeighborIds = null;   // 条件を変えたら周辺絞り込みは解除
    const query = (document.getElementById('radar-title-search')?.value || '').toLowerCase();
    const category = document.getElementById('radar-category-filter')?.value || '';
    const vibe = document.getElementById('radar-vibe-filter')?.value || '';
    const tempo = document.getElementById('radar-tempo-filter')?.value || '';
    const sort = document.getElementById('radar-sort')?.value || 'default';
    vibeFiltered = vibeMapData.filter(t => {
        const text = `${t.title} ${t.channel} ${t.author} ${t.playlist_name}`.toLowerCase();
        const okText = !query || text.includes(query);
        const okCat = !category || (t.category || 'Other') === category;
        return okText && okCat && radarVibeMatch(t, vibe) && radarTempoMatch(t, tempo);
    });
    if (sort === 'title') {
        vibeFiltered.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ja'));
    } else if (sort === 'bpm-asc') {
        vibeFiltered.sort((a, b) => (radarTempoValue(a) || 9999) - (radarTempoValue(b) || 9999));
    } else if (sort === 'bpm-desc') {
        vibeFiltered.sort((a, b) => radarTempoValue(b) - radarTempoValue(a));
    }
    if (!preserveView) {
        radarZoom = 1.0;
        radarPan = { x: 0, y: 0 };
        radarSelectedId = null;
    } else if (radarSelectedId && !vibeFiltered.some(t => t.youtube_id === radarSelectedId)) {
        radarSelectedId = null;
    }
    // reset strip paging only when filter text/category changed via explicit call chain;
    // queueRadarFilter/clear keep it simple: reset to first page on new filter
    if (!preserveView) radarStripLimit = 30;
    else if (['radar-title-search', 'radar-category-filter', 'radar-vibe-filter', 'radar-tempo-filter'].includes(document.activeElement?.id)) radarStripLimit = 30;
    drawRadarMap(vibeFiltered);
    renderVibeTracks(vibeFiltered);
    renderRadarLegend();
    updateRadarCount();
    updateRadarClearButton();
    updateRadarSelectedPanel();
}

function updateRadarCount() {
    const el = document.getElementById('radar-result-count');
    if (!el) return;
    const total = vibeMapData.length;
    const shown = vibeFiltered.length;
    el.textContent = total ? `${shown} / ${total}曲` : '';
}

function updateRadarClearButton() {
    const btn = document.getElementById('btn-radar-search-clear');
    const input = document.getElementById('radar-title-search');
    if (!btn || !input) return;
    btn.style.display = input.value ? 'block' : 'none';
}

// マップ右上の選択中カード (再生・周辺再生・中央寄せを1か所に集約)
function updateRadarSelectedPanel() {
    const panel = document.getElementById('radar-selected-panel');
    if (!panel) return;
    const t = (vibeFiltered.find(t => t.youtube_id === radarSelectedId)
        || vibeMapData.find(t => t.youtube_id === radarSelectedId));
    if (!t) { panel.hidden = true; panel.innerHTML = ''; return; }
    const { category, tempo, vibe } = radarTrackLabels(t);
    const near = radarNeighbors(t.youtube_id, 8);
    panel.hidden = false;
    panel.innerHTML = '';
    const thumb = document.createElement('div');
    thumb.className = 'radar-panel-thumb';
    thumb.innerHTML = t.youtube_id
        ? `<img src="https://img.youtube.com/vi/${t.youtube_id}/mqdefault.jpg" alt="">`
        : '🎵';
    const info = document.createElement('div');
    info.className = 'radar-panel-info';
    const title = document.createElement('div');
    title.className = 'radar-panel-title';
    title.textContent = t.title || t.youtube_id;
    title.title = t.title || '';
    const meta = document.createElement('div');
    meta.className = 'radar-panel-meta';
    meta.textContent = `${category} · ${tempo}${vibe ? ' · ' + vibe : ''}`;
    const row = document.createElement('div');
    row.className = 'radar-panel-row';
    const mkBtn = (label, hint, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'radar-panel-btn';
        b.textContent = label;
        b.title = hint;
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
    };
    row.appendChild(mkBtn('▶ 再生', 'この曲を再生', () => playFromRadar(t)));
    row.appendChild(mkBtn(`周辺${near.length + 1}曲`, '近い雰囲気の曲と連続再生', () => playRadarNeighbors(t.youtube_id, 8)));
    row.appendChild(mkBtn('◎ 中央へ', 'マップの中央に寄せる', () => focusRadarTrack(t.youtube_id)));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'radar-panel-close';
    close.textContent = '×';
    close.title = '選択を解除 (Esc)';
    close.setAttribute('aria-label', '選択を解除');
    close.onclick = (e) => { e.stopPropagation(); selectRadarTrack(null); };
    info.appendChild(title);
    info.appendChild(meta);
    info.appendChild(row);
    panel.appendChild(thumb);
    panel.appendChild(info);
    panel.appendChild(close);
}

// 点が重なったときの候補選択ポップアップ
function hideRadarOverlap() {
    const pop = document.getElementById('radar-overlap-popup');
    if (!pop) return;
    pop.hidden = true;
    pop.innerHTML = '';
}

function showRadarOverlap(candidates, x, y) {
    const pop = document.getElementById('radar-overlap-popup');
    const container = document.getElementById('radar-map-container');
    if (!pop || !container || !candidates || candidates.length < 2) return;
    pop.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'radar-overlap-head';
    head.textContent = `重なった ${candidates.length} 曲から選択`;
    pop.appendChild(head);
    candidates.slice(0, 8).forEach(o => {
        const t = o.t;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'radar-overlap-item';
        const dot = document.createElement('span');
        dot.className = 'legend-dot';
        dot.style.background = radarCategoryColor(t.category);
        b.appendChild(dot);
        const label = document.createElement('span');
        label.className = 'radar-overlap-label';
        label.textContent = t.title || t.youtube_id;
        b.appendChild(label);
        b.title = `${t.title || ''} を選択・再生`;
        b.onclick = (e) => { e.stopPropagation(); selectRadarTrack(t.youtube_id, { play: true }); };
        pop.appendChild(b);
    });
    pop.hidden = false;
    const pw = 240;
    const ph = Math.min(280, 36 + candidates.length * 34);
    pop.style.left = Math.max(8, Math.min(x + 12, container.clientWidth - pw - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(y + 12, container.clientHeight - ph - 8)) + 'px';
}

function bindRadarControls() {
    const zoomIn = document.getElementById('btn-radar-zoom-in');
    const zoomOut = document.getElementById('btn-radar-zoom-out');
    const zoomReset = document.getElementById('btn-radar-zoom-reset');
    const analyzeAll = document.getElementById('btn-radar-analyze-all');
    if (zoomIn) zoomIn.onclick = () => { radarZoomAtCenter(1.25); };
    if (zoomOut) zoomOut.onclick = () => { radarZoomAtCenter(0.8); };
    if (zoomReset) zoomReset.onclick = () => resetRadarView();
    const zoomFit = document.getElementById('btn-radar-zoom-fit');
    if (zoomFit) zoomFit.onclick = () => fitRadarToFiltered();
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
    const activeCat = document.getElementById('radar-category-filter')?.value || '';
    const cats = [...new Set(vibeMapData.map(t => t.category || 'Other'))];
    if (!cats.length) { legend.innerHTML = ''; return; }
    legend.innerHTML = '';
    cats.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'legend-item legend-btn' + (activeCat === c ? ' is-active' : '');
        btn.title = `${c}で絞り込み` + (activeCat === c ? ' (解除するにはもう一度クリック)' : '');
        btn.setAttribute('aria-pressed', String(activeCat === c));
        const dot = document.createElement('span');
        dot.className = 'legend-dot';
        dot.style.background = radarCategoryColor(c);
        btn.appendChild(dot);
        btn.appendChild(document.createTextNode(c));
        btn.onclick = () => {
            const sel = document.getElementById('radar-category-filter');
            if (!sel) return;
            sel.value = (sel.value === c) ? '' : c;
            radarStripLimit = 30;
            applyRadarFilter(true);
        };
        legend.appendChild(btn);
    });
}

function radarZoomAtCenter(factor) {
    radarZoom = Math.max(0.2, Math.min(8, radarZoom * factor));
    drawRadarMap(vibeFiltered);
}

// 選択曲が画面中央に来るようパンする (一覧→マップ連携用)
function focusRadarTrack(youtubeId) {
    const track = vibeFiltered.find(t => t.youtube_id === youtubeId);
    if (!track || !track.features) return;
    const f = track.features;
    if (typeof f.x !== 'number' || typeof f.y !== 'number') return;
    const x = Math.max(0, Math.min(1, f.x));
    const y = Math.max(0, Math.min(1, f.y));
    radarPan.x = -(x - 0.5) * radarZoom;
    radarPan.y = -(y - 0.5) * radarZoom;
    drawRadarMap(vibeFiltered);
}

// 表示中の曲全体が収まるようズーム・パンを調整 (件数が少ない絞り込み後に便利)
function fitRadarToFiltered() {
    const pts = (vibeFiltered || []).map(t => t?.features).filter(f => f && typeof f.x === 'number' && typeof f.y === 'number');
    if (!pts.length) { resetRadarView(); return; }
    if (pts.length === 1) {
        radarZoom = Math.max(radarZoom, 2.5);
        const t = vibeFiltered.find(t => typeof t?.features?.x === 'number');
        if (t) { focusRadarTrack(t.youtube_id); return; }
    }
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    pts.forEach(f => {
        const x = Math.max(0, Math.min(1, f.x));
        const y = Math.max(0, Math.min(1, f.y));
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    });
    const pad = 0.12;
    const spanX = Math.max(0.05, (maxX - minX) + pad * 2);
    const spanY = Math.max(0.05, (maxY - minY) + pad * 2);
    radarZoom = Math.max(0.2, Math.min(8, Math.min(1 / spanX, 1 / spanY)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    radarPan.x = -(cx - 0.5) * radarZoom;
    radarPan.y = -(cy - 0.5) * radarZoom;
    drawRadarMap(vibeFiltered);
}

function radarNormPos(t) {
    const f = t?.features || {};
    if (typeof f.x !== 'number' || typeof f.y !== 'number') return null;
    return { x: Math.max(0, Math.min(1, f.x)), y: Math.max(0, Math.min(1, f.y)) };
}

// マップ上で近い曲＝雰囲気が近い曲。選択曲の周辺 n 曲を返す
function radarNeighbors(youtubeId, n) {
    const base = (vibeFiltered.find(t => t.youtube_id === youtubeId)
        || vibeMapData.find(t => t.youtube_id === youtubeId));
    const bp = base && radarNormPos(base);
    if (!bp) return [];
    return vibeFiltered
        .filter(t => t.youtube_id !== youtubeId && radarNormPos(t))
        .map(t => {
            const p = radarNormPos(t);
            return { t, d: Math.hypot(p.x - bp.x, p.y - bp.y) };
        })
        .sort((a, b) => a.d - b.d)
        .slice(0, Math.max(0, n || 8))
        .map(o => o.t);
}

function radarQueueFromTracks(tracks, startId) {
    const list = (tracks || []).filter(t => t && t.youtube_id).map(t => ({
        ...t, id: t.youtube_id, is_favorite: t.is_favorite || 0, fromRadar: true,
    }));
    if (!list.length) return { queue: [], index: 0 };
    const idx = startId ? list.findIndex(t => t.youtube_id === startId) : 0;
    return { queue: list, index: idx >= 0 ? idx : 0 };
}

// 下の一覧に表示する曲 (周辺絞り込み中はその9曲だけ)。
function vibeDisplayTracks() {
    if (!radarNeighborIds) return vibeFiltered;
    const ids = new Set(radarNeighborIds);
    return vibeFiltered.filter(t => ids.has(t.youtube_id));
}

// 選択曲＋周辺の近い曲を連続再生 (下の一覧もその曲だけに絞り込む)
function playRadarNeighbors(youtubeId, count) {
    const base = vibeFiltered.find(t => t.youtube_id === youtubeId)
        || vibeMapData.find(t => t.youtube_id === youtubeId);
    if (!base) return;
    const near = radarNeighbors(youtubeId, Math.max(0, count || 8));
    const { queue } = radarQueueFromTracks([base, ...near], base.youtube_id);
    radarNeighborIds = [base, ...near].map(t => t.youtube_id);
    renderVibeTracks(vibeDisplayTracks(), false);
    closeMobileMenu();
    playTrackFromQueue(0, queue);
}

// 選択状態の一元更新: マップ・一覧・パネルを同期する
function selectRadarTrack(youtubeId, opts) {
    const o = opts || {};
    radarSelectedId = youtubeId || null;
    radarNeighborIds = null;   // 別の曲を選び直したら周辺絞り込みを解除
    hideRadarOverlap();
    drawRadarMap(vibeFiltered);
    renderVibeTracks(vibeFiltered);
    updateRadarSelectedPanel();
    if (youtubeId && o.center) focusRadarTrack(youtubeId);
    if (youtubeId && o.play) {
        const t = vibeFiltered.find(t => t.youtube_id === youtubeId)
            || vibeMapData.find(t => t.youtube_id === youtubeId);
        if (t) playFromRadar(t);
    }
}


// ドラッグ/ホイール中の連続再描画を rAF で1フレームにまとめる (CPU/GPU負荷の軽減)。
// クリック選択・ズームボタン・絞り込みなどの単発更新は drawRadarMap を直接呼ぶ。
function queueRadarDraw() {
    if (typeof requestAnimationFrame !== 'function') { drawRadarMap(vibeFiltered); return; }
    if (radarDrawQueued) return;
    radarDrawQueued = true;
    requestAnimationFrame(() => { radarDrawQueued = false; drawRadarMap(vibeFiltered); });
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
        const emptyMsg = (vibeMapData && vibeMapData.length)
            ? '条件に合う曲がありません。検索・絞り込みを見直してください。'
            : '解析済みの楽曲がありません。「⟳ 全曲解析」で解析を実行してください。';
        ctx.fillText(emptyMsg, W / 2, H / 2);
        if (tracks === vibeFiltered) radarPlotCache = [];
        return;
    }

    // 射影変換: 正規化座標(0..1) → キャンバス座標 (パン+ズーム)。座標なしは円配置
    const plot = radarPlotPoints(tracks, W, H);
    // 当たり判定 (ホバー/タップ) はこのキャッシュを使い、mousemove毎の再計算を避ける
    radarPlotCache = (tracks === vibeFiltered) ? plot : null;

    // 選択中の楽曲をハイライト (選択時は他を減光)
    const selected = plot.find(o => o.t.youtube_id === radarSelectedId);
    const hasSelection = Boolean(selected);
    const baseR = 5 * Math.max(0.85, Math.min(1.5, Math.sqrt(radarZoom)));

    // 各点を描画 (画面外はスキップ)
    plot.forEach((o) => {
        if (o.px < -20 || o.py < -20 || o.px > W + 20 || o.py > H + 20) return;
        const isSel = radarSelectedId === o.t.youtube_id;
        const color = radarCategoryColor(o.t.category);
        const r = isSel ? baseR + 2 : baseR;
        const glow = isSel ? 14 : 0;

        if (glow) {
            const g = ctx.createRadialGradient(o.px, o.py, 0, o.px, o.py, glow);
            g.addColorStop(0, color + '99');
            g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(o.px, o.py, glow, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = hasSelection && !isSel ? 0.45 : 1;
        ctx.beginPath();
        ctx.arc(o.px, o.py, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = isSel ? 2 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
    });

    // 選択曲と雰囲気が近い曲を細線で結ぶ (周辺発見の手がかり用)
    if (selected) {
        const nearIds = new Set(radarNeighbors(selected.t.youtube_id, 6).map(t => t.youtube_id));
        if (nearIds.size) {
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            plot.forEach(o => {
                if (!nearIds.has(o.t.youtube_id)) return;
                ctx.beginPath();
                ctx.moveTo(selected.px, selected.py);
                ctx.lineTo(o.px, o.py);
                ctx.stroke();
            });
            ctx.setLineDash([]);
        }
    }

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

function renderVibeTracks(tracks, scrollToSelected) {
    const strip = document.getElementById('vibe-track-strip');
    if (!strip) return;
    strip.innerHTML = '';
    if (!tracks || tracks.length === 0) {
        const hasFilter = (document.getElementById('radar-title-search')?.value || '')
            || (document.getElementById('radar-category-filter')?.value || '')
            || (document.getElementById('radar-vibe-filter')?.value || '')
            || (document.getElementById('radar-tempo-filter')?.value || '')
            || radarNeighborIds;
        const hint = hasFilter
            ? `条件に合う曲がありません。<button type="button" class="radar-strip-clear" onclick="clearRadarFilters()">条件をクリア</button>`
            : '表示できる楽曲がありません。';
        strip.innerHTML = `<p class="radar-strip-empty">🔍 ${hint}</p>`;
        return;
    }

    const visible = tracks.slice(0, radarStripLimit);
    visible.forEach(t => {
        const { category, tempo, bpmSource, vibe, engine } = radarTrackLabels(t);
        const color = radarCategoryColor(t.category);
        const card = document.createElement('div');
        card.className = 'strip-card';
        card.style.borderLeftColor = color;
        if (radarSelectedId === t.youtube_id) card.classList.add('selected');

        const coverHtml = t.youtube_id
            ? `<img src="https://img.youtube.com/vi/${t.youtube_id}/mqdefault.jpg" alt="thumb" loading="lazy" decoding="async">`
            : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:24px;">🎵</div>`;

        card.innerHTML = `
            <div class="strip-thumb">${coverHtml}<div class="card-hover-play"></div></div>
            <div class="strip-info">
                <div class="strip-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
                <div class="strip-artist">${escapeHtml(t.channel || 'Unknown Artist')}</div>
                <div class="strip-meta">${escapeHtml(category)} · <b>tempo</b> ${tempo}${bpmSource ? ' (' + bpmSource + ')' : ''}${vibe ? ' · <b>' + escapeHtml(vibe) + '</b>' : ''} · <b>${escapeHtml(engine)}</b></div>
            </div>
        `;
        card.onclick = () => {
            const wasSelected = radarSelectedId === t.youtube_id;
            const found = (radarPlotCache || []).find(o => o.t.youtube_id === t.youtube_id);
            const offscreen = !found || found.px < 0 || found.py < 0 || found.px > canvasWidth() || found.py > canvasHeight();
            selectRadarTrack(t.youtube_id, { play: true, center: !wasSelected && offscreen });
        };
        card.ondblclick = (e) => { e.stopPropagation(); focusRadarTrack(t.youtube_id); };
        strip.appendChild(card);
    });
    if (tracks.length > visible.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'radar-strip-more';
        more.textContent = `さらに表示 (${visible.length} / ${tracks.length}曲)`;
        more.onclick = () => { radarStripLimit += 30; renderVibeTracks(vibeFiltered); };
        strip.appendChild(more);
    }
    // 選択カードを可視範囲へ (曲送りでの再描画時はスクロールを奪わない)
    if (scrollToSelected !== false) {
        const sel = strip.querySelector('.strip-card.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
}

function canvasWidth() {
    return document.getElementById('radar-map-container')?.clientWidth || 0;
}
function canvasHeight() {
    return document.getElementById('radar-map-container')?.clientHeight || 0;
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
    // drawRadarMap のたびに呼ばれるため、ここで多重登録すると
    // 古いジェスチャー状態が残って競合し、操作中にチカつく。二度目以降は何もしない。
    if (canvas.dataset.radarPointerBound) return;
    canvas.dataset.radarPointerBound = '1';

    function currentPlot() {
        // 直近の描画結果を使い回す (同一データ・同一ビューの間は再計算しない)。
        // キャッシュが無い場合 (初回描画前など) のみ計算する。
        if (!radarPlotCache) {
            radarPlotCache = radarPlotPoints(vibeFiltered,
                Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
        }
        return radarPlotCache;
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

    // 重なり対応: 半径内の候補を距離順に全件返す
    function findAllNear(px, py, maxDist) {
        return currentPlot()
            .map(o => ({ o, d: Math.hypot(o.px - px, o.py - py) }))
            .filter(({ d }) => d < maxDist)
            .sort((a, b) => a.d - b.d)
            .map(({ o }) => o);
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
        hideRadarOverlap();
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
            queueRadarDraw();
            return;
        }
        if (e.pointerType !== 'mouse') return;
        const o = findNearest(mx, my, 14);
        canvas.style.cursor = o ? 'pointer' : 'grab';
        if (!o) { tooltip.style.display = 'none'; return; }
        tooltip.style.display = 'flex';
        tooltip.innerHTML = radarTooltipHtml(o.t);
        // 吹き出しが枠外にはみ出さないよう反対側へ折り返す
        const tw = tooltip.offsetWidth || 200;
        const th = tooltip.offsetHeight || 60;
        const flipX = mx + 14 + tw > container.clientWidth;
        const flipY = my + 14 + th > container.clientHeight;
        tooltip.style.left = (flipX ? Math.max(0, mx - tw - 12) : mx + 14) + 'px';
        tooltip.style.top = (flipY ? Math.max(0, my - th - 12) : my + 14) + 'px';
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
        const radius = e.pointerType === 'mouse' ? 14 : 26;
        const near = findAllNear(mx, my, radius);
        if (near.length > 1) {
            // 重なっている場合は候補から選ぶ (誤タップ防止のため即再生しない)
            tooltip.style.display = 'none';
            selectRadarTrack(near[0].t.youtube_id, { play: false });
            showRadarOverlap(near, mx, my);
            return;
        }
        const o = near[0] || null;
        if (!o) { selectRadarTrack(null); return; }
        selectRadarTrack(o.t.youtube_id, { play: true });
        if (e.pointerType !== 'mouse') {
            // タッチではツールチップを残して確認しやすくする
            tooltip.style.display = 'flex';
            tooltip.innerHTML = radarTooltipHtml(o.t);
            tooltip.style.left = Math.max(0, Math.min(mx + 14, container.clientWidth - (tooltip.offsetWidth || 200))) + 'px';
            tooltip.style.top = Math.max(0, Math.min(my + 14, container.clientHeight - (tooltip.offsetHeight || 60))) + 'px';
            setTimeout(() => { tooltip.style.display = 'none'; }, 2500);
        }
    }
    canvas.addEventListener('pointerup', endGesture);
    canvas.addEventListener('pointercancel', endGesture);
    canvas.addEventListener('lostpointercapture', endGesture);
    canvas.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });

    // ダブルクリック/ダブルタップでズームイン (Shift+はズームアウト)
    canvas.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const [mx, my] = localPos(e);
        radarZoomToPoint(mx, my, e.shiftKey ? 0.7 : 1.4);
    });

    // キーボード操作: +/-/0/矢印/Escape/Enter
    canvas.addEventListener('keydown', (e) => {
        const W = Math.max(1, container.clientWidth);
        const H = Math.max(1, container.clientHeight);
        const step = 0.08;
        if (e.key === '+' || e.key === '=') { radarZoomAtCenter(1.2); e.preventDefault(); }
        else if (e.key === '-' || e.key === '_') { radarZoomAtCenter(0.85); e.preventDefault(); }
        else if (e.key === '0') { resetRadarView(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { radarPan.x += step / radarZoom; queueRadarDraw(); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { radarPan.x -= step / radarZoom; queueRadarDraw(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { radarPan.y += step / radarZoom; queueRadarDraw(); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { radarPan.y -= step / radarZoom; queueRadarDraw(); e.preventDefault(); }
        else if (e.key === 'Escape') {
            hideRadarOverlap();
            selectRadarTrack(null);
            tooltip.style.display = 'none';
            e.preventDefault();
        } else if (e.key === 'Enter') {
            const t = vibeFiltered.find(t => t.youtube_id === radarSelectedId);
            if (t) playFromRadar(t);
            e.preventDefault();
        }
    });

    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        hideRadarOverlap();
        const rect = canvas.getBoundingClientRect();
        radarZoomToPoint(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });
}

// カーソル位置を基準にズーム (ホイール/ダブルクリック用)。ズーム後も指先の点が追従する
function radarZoomToPoint(mx, my, factor) {
    const container = document.getElementById('radar-map-container');
    if (!container) return;
    const W = Math.max(1, container.clientWidth);
    const H = Math.max(1, container.clientHeight);
    const oldZoom = radarZoom;
    const newZoom = Math.max(0.2, Math.min(8, oldZoom * factor));
    if (newZoom === oldZoom) return;
    const ratio = newZoom / oldZoom;
    // (mx/W-0.5-pan) を ratio で拡縮し、カーソル下の地物が動かないようパンを補正
    const nx = mx / W - 0.5;
    const ny = my / H - 0.5;
    radarPan.x = nx - (nx - radarPan.x) * ratio;
    radarPan.y = ny - (ny - radarPan.y) * ratio;
    radarZoom = newZoom;
    queueRadarDraw();
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
            const favCount = document.getElementById('playlist-favorite-count');
            const setFav = (isFav, count) => {
                if (favIcon) { favIcon.textContent = 'favorite'; favIcon.classList.toggle('is-filled', isFav); favIcon.style.color = isFav ? 'var(--accent-color)' : '#fff'; }
                favBtn.classList.toggle('is-fav', isFav);
                const label = isFav ? 'お気に入り解除' : 'お気に入り追加';
                favBtn.title = label;
                favBtn.setAttribute('aria-label', label);
                favBtn.setAttribute('aria-pressed', String(isFav));
                // Shareカードのお気に入りボタンと同じく件数を併記する
                if (favCount) favCount.textContent = shareFavCount({ favorite_count: count });
            };
            setFav(listData.is_favorite == 1, listData.favorite_count);
            favBtn.onclick = async (e) => {
                favBtn.disabled = true;
                const result = await togglePlaylistFavorite(playlistId, e);
                if (result?.success) {
                    listData.is_favorite = result.is_favorite;
                    listData.favorite_count = result.favorite_count;
                    setFav(listData.is_favorite == 1, listData.favorite_count);
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
    radarNeighborIds = queue.map(t => t.youtube_id);
    renderVibeTracks(vibeDisplayTracks(), false);
    playTrackFromQueue(0, queue);
    // 1曲目の位置が分かるようマップを寄せる (ズームは維持)
    if (queue[0]) focusRadarTrack(queue[0].youtube_id);
}

// ==========================================================
// Share: みんなの公開プレイリスト一覧
// ==========================================================
async function loadSharePlaylists() {
    const grid = document.getElementById('share-playlists-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="share-loading"><span class="share-spinner"></span>みんなのプレイリストを探しています…</div>';
    try {
        const [pubRes, recRes] = await Promise.all([
            tunedropFetch('api.php?action=get_public_playlists'),
            tunedropFetch('api.php?action=get_recommended_playlists&limit=6').catch(() => null),
        ]);
        sharePlaylists = await pubRes.json();
        try {
            shareRecommended = recRes && recRes.ok ? await recRes.json() : [];
        } catch (_) { shareRecommended = []; }
        renderSharePlaylists();
    } catch (err) {
        grid.innerHTML = '<p style="color:var(--text-sub); grid-column: 1 / -1;">読み込みに失敗しました。</p>';
        console.error(err);
    }
}

function shareFavCount(p) {
    const n = Number(p?.favorite_count);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function shareTrackCount(p) {
    const n = Number(p?.track_count);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

// 人気順の順位表 (id -> 1-based rank)。同点は track_count → 新着(id降順) で決める。
function sharePopularRanks(lists) {
    const sorted = [...(lists || [])].sort((a, b) =>
        shareFavCount(b) - shareFavCount(a)
        || shareTrackCount(b) - shareTrackCount(a)
        || (b.id ?? 0) - (a.id ?? 0));
    const ranks = new Map();
    sorted.forEach((p, i) => ranks.set(p.id, i + 1));
    return { sorted, ranks };
}

function matchShareQuery(p, query, category) {
    const name = (p?.name || '').toLowerCase();
    const author = ((p?.author || p?.author_name || p?.username || '')).toLowerCase();
    const okText = !query || name.includes(query) || author.includes(query);
    const okCat = !category || (p?.category || 'Other') === category;
    return okText && okCat;
}

// 検索・カテゴリ・並び順を適用した一覧を返す (描画とEnterジャンプで共有)
function getShareFiltered() {
    const query = (document.getElementById('share-search')?.value || '').toLowerCase();
    const category = document.getElementById('share-category')?.value || '';
    const sortMode = document.getElementById('share-sort')?.value || 'newest';
    const all = sharePlaylists || [];
    const filtered = all.filter(p => matchShareQuery(p, query, category));
    const sorted = [...filtered].sort((a, b) => {
        if (sortMode === 'tracks') return shareTrackCount(b) - shareTrackCount(a) || shareFavCount(b) - shareFavCount(a) || (b.id ?? 0) - (a.id ?? 0);
        if (sortMode === 'newest') return (b.id ?? 0) - (a.id ?? 0);
        return shareFavCount(b) - shareFavCount(a) || shareTrackCount(b) - shareTrackCount(a) || (b.id ?? 0) - (a.id ?? 0);
    });
    return { query, category, sortMode, filtered, sorted };
}

function onShareSearchInput() {
    updateShareClearButton();
    renderSharePlaylists();
}

function clearShareSearch() {
    const input = document.getElementById('share-search');
    if (input) input.value = '';
    renderSharePlaylists();
    if (input) input.focus();
}

// 検索欄の Enter=先頭結果を開く、Escape=クリア
function onShareSearchKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const { sorted } = getShareFiltered();
        if (sorted[0]) openPlaylistDetail(sorted[0].id, sorted[0].name, sorted[0].cover_id);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        clearShareSearch();
    }
}

function updateShareClearButton() {
    const btn = document.getElementById('btn-share-search-clear');
    const input = document.getElementById('share-search');
    if (!btn || !input) return;
    btn.style.display = input.value ? 'block' : 'none';
}

function renderSharePlaylists() {
    const grid = document.getElementById('share-playlists-grid');
    if (!grid) return;
    updateShareClearButton();
    const { query, category, sortMode, filtered, sorted } = getShareFiltered();
    const all = sharePlaylists || [];

    const { sorted: popularSorted } = sharePopularRanks(all);
    renderShareRanking(popularSorted);
    renderShareRecommend();

    const badge = document.getElementById('share-count-badge');
    if (badge) badge.textContent = filtered.length ? `${filtered.length}件` : '';
    const gridTitle = document.getElementById('share-grid-title');
    if (gridTitle) {
        gridTitle.textContent = sortMode === 'popular' ? '人気順'
            : sortMode === 'tracks' ? '曲数順' : '新着順';
    }

    if (sorted.length === 0) {
        const searching = query || category;
        grid.innerHTML = searching
            ? '<div class="share-empty"><span class="material-symbols-rounded share-empty-icon">radar</span><p>条件に合うプレイリストがありません。</p><p class="share-empty-sub">検索やカテゴリを変えてみてください。</p></div>'
            : '<div class="share-empty"><span class="material-symbols-rounded share-empty-icon">public</span><p>まだ公開されたプレイリストがありません。</p><p class="share-empty-sub">「編集・公開」から最初の1つを公開してみよう！</p></div>';
        return;
    }

    grid.innerHTML = '';
    sorted.forEach((list, index) => {
        const card = document.createElement('div');
        card.className = 'card share-card';
        card.style.animationDelay = `${Math.min(index * 40, 480)}ms`;
        card.onclick = () => openPlaylistDetail(list.id, list.name, list.cover_id);

        const coverHtml = list.cover_id
            ? `<img src="https://img.youtube.com/vi/${list.cover_id}/hqdefault.jpg" alt="cover" loading="lazy">`
            : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center;"><span class="material-symbols-rounded" style="font-size:40px; color:var(--text-sub);">music_note</span></div>`;
        const catBadge = list.category ? `<span class="cat-badge share-cat-badge">${escapeHtml(list.category)}</span>` : '';
        const favs = shareFavCount(list);
        const isFav = list.is_favorite == 1;
        const authorName = escapeHtml(list.author || list.author_name || list.username || 'User');
        const trackCount = (typeof list.track_count === 'number' || typeof list.track_count === 'string') ? list.track_count : '—';

        card.innerHTML = `
            <div class="card-img-wrapper">${coverHtml}<div class="card-hover-play"></div>
                ${catBadge}
                <button type="button" class="share-fav-btn${isFav ? ' is-fav' : ''}" title="${isFav ? 'お気に入り解除' : 'お気に入り追加'}" aria-label="${isFav ? 'お気に入り解除' : 'お気に入り追加'}" aria-pressed="${isFav ? 'true' : 'false'}"><span class="material-symbols-rounded share-fav-icon is-filled">favorite</span><span class="share-fav-count">${favs}</span></button>
            </div>
            <div class="info">
                <div class="title" title="${escapeHtml(list.name)}">${escapeHtml(list.name)}</div>
                <div class="artist"><span class="material-symbols-rounded share-author-icon">person</span><span class="share-author-name">${authorName}</span></div>
                <div class="share-card-stats"><span class="material-symbols-rounded share-meta-icon">music_note</span>${trackCount}曲<span class="share-card-stats-dot">·</span><span class="material-symbols-rounded share-meta-icon">favorite</span>${favs}</div>
            </div>
        `;
        card.querySelector('.share-fav-btn')?.addEventListener('click', (e) => toggleShareFavorite(list.id, e));
        grid.appendChild(card);
    });
}

function renderShareRecommend() {
    const box = document.getElementById('share-recommend');
    if (!box) return;
    const rawQuery = (document.getElementById('share-search')?.value || '').trim().toLowerCase();
    const category = document.getElementById('share-category')?.value || '';
    const filtering = Boolean(rawQuery || category);
    let lists = (shareRecommended || []).filter(p => p && p.id);
    // API失敗・空応答時のフォールバック: 公開一覧の人気順で必ず何か出す
    let isFallback = false;
    if (lists.length === 0 && (sharePlaylists || []).length > 0) {
        isFallback = true;
        const { sorted } = sharePopularRanks(sharePlaylists);
        lists = sorted.slice(0, 6).map(p => ({ ...p, recommend_reason: '今人気' }));
    }
    // 検索・絞り込み中はおすすめ内も同じ条件で絞る (一致があれば表示し続ける)
    if (filtering) lists = lists.filter(p => matchShareQuery(p, rawQuery, category));
    if (lists.length === 0) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }
    box.hidden = false;
    const subText = filtering ? `検索に一致 ${lists.length}件`
        : isFallback ? '今人気のリストをピックアップ' : '保存曲・好みからピックアップ';
    box.innerHTML = `
        <div class="share-recommend-title"><span class="material-symbols-rounded share-section-icon">radar</span>あなたへのおすすめ <span class="share-recommend-sub">${subText}</span>
            <button type="button" class="share-recommend-reload" id="btn-share-recommend-reload" title="おすすめを更新">⟳ 更新</button>
        </div>
        <div class="share-recommend-row">
            ${lists.map(p => {
                const cover = p.cover_id
                    ? `<img src="https://img.youtube.com/vi/${p.cover_id}/mqdefault.jpg" alt="" loading="lazy">`
                    : `<div class="share-recommend-noimg"><span class="material-symbols-rounded">music_note</span></div>`;
                const isFav = p.is_favorite == 1;
                const reason = escapeHtml(p.recommend_reason || 'おすすめ');
                return `<div class="share-recommend-card" data-id="${p.id}" role="button" tabindex="0" title="${escapeHtml(p.name || '')}">
                    <span class="share-recommend-cover">${cover}</span>
                    <span class="share-recommend-info">
                        <span class="share-recommend-reason">${reason}</span>
                        <span class="share-recommend-name">${escapeHtml(p.name || '')}</span>
                        <span class="share-recommend-meta"><span class="material-symbols-rounded share-meta-icon">favorite</span>${shareFavCount(p)} · <span class="material-symbols-rounded share-meta-icon">music_note</span>${shareTrackCount(p)}曲</span>
                    </span>
                    <button type="button" class="share-fav-btn share-recommend-fav${isFav ? ' is-fav' : ''}" title="${isFav ? 'お気に入り解除' : 'お気に入り追加'}" aria-label="${isFav ? 'お気に入り解除' : 'お気に入り追加'}" aria-pressed="${isFav ? 'true' : 'false'}"><span class="material-symbols-rounded share-fav-icon is-filled">favorite</span><span class="share-fav-count">${shareFavCount(p)}</span></button>
                </div>`;
            }).join('')}
        </div>`;
    document.getElementById('btn-share-recommend-reload')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            const res = await tunedropFetch('api.php?action=get_recommended_playlists&limit=6');
            if (res.ok) shareRecommended = await res.json();
        } catch (_) { /* 失敗時は現在の表示を維持 */ }
        renderShareRecommend();
    });
    box.querySelectorAll('.share-recommend-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = Number(card.dataset.id);
            const found = (shareRecommended || []).find(p => p.id == id)
                || (sharePlaylists || []).find(p => p.id == id);
            if (found) openPlaylistDetail(found.id, found.name, found.cover_id);
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
        });
    });
    box.querySelectorAll('.share-recommend-fav').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const card = e.currentTarget.closest('.share-recommend-card');
            toggleShareFavorite(Number(card?.dataset.id), e);
        });
    });
}

function renderShareRanking(popularSorted) {
    const box = document.getElementById('share-ranking');
    if (!box) return;
    const query = (document.getElementById('share-search')?.value || '').trim();
    const category = document.getElementById('share-category')?.value || '';
    // 検索・絞り込み中はランキングを隠して一覧に集中させる
    if (query || category || !popularSorted || popularSorted.length === 0) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }
    const top = popularSorted.slice(0, 3);
    box.hidden = false;
    box.innerHTML = `
        <div class="share-ranking-title"><span class="material-symbols-rounded share-section-icon">favorite</span>お気に入りランキング <span class="share-ranking-sub">みんなのお気に入りで決定！</span></div>
        <div class="share-podium">
            ${top.map((p, i) => {
                const cover = p.cover_id
                    ? `<img src="https://img.youtube.com/vi/${p.cover_id}/mqdefault.jpg" alt="" loading="lazy">`
                    : `<div class="share-podium-noimg"><span class="material-symbols-rounded">music_note</span></div>`;
                return `<button type="button" class="share-podium-card podium-${i + 1}" data-id="${p.id}" title="${escapeHtml(p.name || '')}">
                    <span class="share-podium-rank podium-rank-${i + 1}">${i + 1}</span>
                    <span class="share-podium-cover">${cover}</span>
                    <span class="share-podium-info">
                        <span class="share-podium-name">${escapeHtml(p.name || '')}</span>
                        <span class="share-podium-meta"><span class="material-symbols-rounded share-meta-icon">favorite</span>${shareFavCount(p)} · <span class="material-symbols-rounded share-meta-icon">music_note</span>${shareTrackCount(p)}曲</span>
                    </span>
                </button>`;
            }).join('')}
        </div>`;
    box.querySelectorAll('.share-podium-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = Number(btn.dataset.id);
            const found = (sharePlaylists || []).find(p => p.id == id);
            if (found) openPlaylistDetail(found.id, found.name, found.cover_id);
        });
    });
}

// Shareカード上の♥ボタン: 詳細を開かずにお気に入り切替＋件数を即時更新
async function toggleShareFavorite(id, event) {
    if (event) event.stopPropagation();
    const btn = event?.currentTarget;
    if (btn) btn.disabled = true;
    try {
        const res = await tunedropFetch('api.php?action=toggle_favorite_playlist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (!data.success) {
            if (data.error) alert(data.error);
            return data;
        }
        const target = (sharePlaylists || []).find(p => p.id == id);
        if (target) {
            target.is_favorite = data.is_favorite;
            if (typeof data.favorite_count === 'number') target.favorite_count = data.favorite_count;
            else target.favorite_count = shareFavCount(target) + (data.is_favorite ? 1 : -1);
            if (target.favorite_count < 0) target.favorite_count = 0;
        }
        const rec = (shareRecommended || []).find(p => p.id == id);
        if (rec) {
            rec.is_favorite = data.is_favorite;
            if (typeof data.favorite_count === 'number') rec.favorite_count = data.favorite_count;
            else rec.favorite_count = shareFavCount(rec) + (data.is_favorite ? 1 : -1);
            if (rec.favorite_count < 0) rec.favorite_count = 0;
        }
        renderSharePlaylists();
        return data;
    } catch (err) {
        console.error(err);
    } finally {
        if (btn) btn.disabled = false;
    }
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
            renderVibeTracks(vibeDisplayTracks(), false);
            updateRadarSelectedPanel();
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
    // YT スクリプト未ロード・プレイヤー作成済みの二重発火は何もしない
    if (player || !(window.YT && window.YT.Player)) return;
    const initialVideoId = currentQueue[currentTrackIndex]?.youtube_id || '';
    createYouTubePlayer(initialVideoId);
}

function createYouTubePlayer(videoId) {
    if (!(window.YT && window.YT.Player)) return;
    document.getElementById('youtube-player')?.remove();
    document.getElementById('youtube-player-frame')?.remove();
    const popup = document.getElementById('youtube-popup');
    if (!popup) return;
    const playerContainer = document.createElement('div');
    playerContainer.id = 'youtube-player-frame';
    popup.appendChild(playerContainer);
    player = new YT.Player('youtube-player-frame', {
        height: '200', width: '355', videoId,
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

let ytErrorStreak = 0;   // 連続再生エラー数 (全滅時の無限ループ防止用)

function onYouTubePlayerError(event) {
    console.error('YouTube player error:', event.data);
    // 再生できない動画 (埋め込み不可・削除済み等) は飛ばして次の曲へ。
    // キュー全曲が再生不可のときは止める (無限に回さない)。
    ytErrorStreak += 1;
    if (ytErrorStreak > currentQueue.length) { ytErrorStreak = 0; return; }
    skipTrack(1);
}

function onPlayerStateChange(event) {
    const playBtn = document.getElementById('play-pause-btn');
    if (event.data === YT.PlayerState.PLAYING) {
        isPlaying = true;
        ytErrorStreak = 0;   // 正常再生できたらエラー連続数をリセット
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
    // head 内のスタブ経由で先行発火した外部スクリプトをここで回収する
    if (window.__ytApiReadyQueued) { window.__ytApiReadyQueued = false; onYouTubeIframeAPIReady(); }
    else if (window.YT?.Player && !player) onYouTubeIframeAPIReady();
    checkLoginStatus();
    // Google ボタンはログインモーダルを開いたときに初期化する。
    // ページ表示直後に initialize すると、未登録 origin の環境では
    // Google 側の [GSI_LOGGER] エラーがコンソールに出続けるため。
    if (window.__gsiReadyQueued) { window.__gsiReadyQueued = false; }
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

// ===== text-marquee (旧 frontend/text-marquee.js を統合: 長文の自動スクロール) =====
// Share a single set of observers across dynamic lists, Radar and the player.
(() => {
    // Node テスト (vm) などブラウザAPIが無い環境では何もしない。
    if (typeof matchMedia !== 'function' || typeof document === 'undefined'
        || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined'
        || typeof IntersectionObserver === 'undefined' || typeof requestAnimationFrame !== 'function') return;
    const selector = [
        '.card .info .title', '.card .info .artist',
        '.strip-title', '.strip-artist', '.strip-meta',
        '.track-info .title', '.track-info .artist',
        '.track-details .title', '.track-details .artist',
        '.playlist-nav .list-name', '[data-auto-scroll]',
    ].join(',');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const tracked = new Set();
    let pending = false;

    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(refresh);
    }

    const resize = new ResizeObserver(schedule);
    const visibility = new IntersectionObserver(entries => {
        changes.disconnect();
        for (const entry of entries) {
            entry.target.classList.toggle('is-marquee-visible', entry.isIntersecting);
        }
        observeChanges();
    });
    const changes = new MutationObserver(schedule);
    function observeChanges() {
        changes.observe(document.body, {
            subtree: true, childList: true, characterData: true,
            attributes: true, attributeFilter: ['class', 'style', 'hidden'],
        });
    }

    function unwrap(element) {
        const content = element.querySelector(':scope > .auto-marquee-text');
        if (content) content.replaceWith(...content.childNodes);
        element.classList.remove('auto-marquee');
        element.style.removeProperty('--text-slide-distance');
        element.style.removeProperty('--text-slide-duration');
    }

    function refresh() {
        pending = false;
        changes.disconnect();
        for (const element of tracked) {
            if (!element.isConnected) {
                resize.unobserve(element);
                visibility.unobserve(element);
                tracked.delete(element);
            }
        }
        for (const element of document.querySelectorAll(selector)) {
            if (!tracked.has(element)) {
                tracked.add(element);
                resize.observe(element);
                visibility.observe(element);
            }
            // Apply the same overflow loop to Radar and all other views at any width.
            const enabled = !reducedMotion.matches;
            if (!enabled) { unwrap(element); continue; }
            if (!element.clientWidth || !element.getClientRects().length) continue;
            let content = element.querySelector(':scope > .auto-marquee-text');
            const distance = (content ? content.scrollWidth : element.scrollWidth) - element.clientWidth;
            if (distance <= 2) { unwrap(element); continue; }
            if (!content) {
                content = document.createElement('span');
                content.className = 'auto-marquee-text';
                content.append(...element.childNodes);
                element.append(content);
            }
            element.classList.add('auto-marquee');
            element.style.setProperty('--text-slide-distance', `-${Math.ceil(distance)}px`);
            // Scroll left at about 28px/s, pause at the end, then reset on the next loop.
            element.style.setProperty('--text-slide-duration', `${Math.max(3, distance / (28 * 0.7))}s`);
        }
        observeChanges();
    }

    reducedMotion.addEventListener('change', schedule);
    document.fonts?.ready.then(schedule);
    schedule();
})();
