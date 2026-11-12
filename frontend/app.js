// ===== api-client (旧 frontend/api-client.js を統合: API接続先の自動検出) =====
// Live Serverは静的配信専用。PHPが実行される接続先を確認してからAPIを呼ぶ。
let tunedropApiPromise;
let tunedropGuestPromise;
let tunedropGuestRefreshAt = 0;

export async function resolveTunedropApi() {
    const config = window.TUNEDROP_CONFIG || {};
    // 画面を静的配信 (VS Code Live Server 等) から開くと、同じoriginにはPHPが無い
    // (Live Server はPHPを実行できない)。./start.sh の Webサーバーは 8888 が使用中だと
    // 8000/8001… へ自動で移るため、候補を並べて health が一致するものだけを採用する。
    const ports = Array.isArray(config.fallbackApiPorts) ? config.fallbackApiPorts : [8888];
    const fallbackUrls = ports.flatMap(port => [
        `http://localhost:${port}/api.php`,
        `http://127.0.0.1:${port}/api.php`
    ]);
    const candidates = config.apiUrl ? [config.apiUrl] : [
        new URL('api.php', window.location.href).href,
        config.fallbackApiUrl || 'http://localhost:8888/api.php',
        // 画面だけ別サーバー (Live Server / Vite開発サーバー等) から開いている場合の候補。
        // (古いコピーを向いている場合は health の features 判定で弾かれる)
        ...fallbackUrls
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
            // features.auth_guest: 認証ゲスト (api.php?action=auth&endpoint=guest) を持つビルドの目印。
            // 別フォルダに残った古い api.php も health には同じ service 名で応答するため、
            // これが無い接続先は採用しない (古いAPIに繋がって認証が全滅する事故を防ぐ)。
            const supportsGuestAuth = Array.isArray(data.features) && data.features.includes('auth_guest');
            if (data.service === 'TuneDrop PHP API' && data.status === 'ok' && supportsGuestAuth) {
                url.search = '';
                return url;
            }
        } catch (_) {
            // Live ServerのPHPソース・404・停止中のサーバーは候補から除外。
        } finally {
            clearTimeout(timer);
        }
    }
    // サーバー停止中・メンテナンス中は画面全体で案内する
    // (各画面のトーストだけだと、何が起きたのか分かりにくい)
    showMaintenanceScreen();
    throw new Error('APIに接続できません。./start.sh (PHPビルトインサーバー) を実行し、接続先 (既定: http://localhost:8888/api.php) と公開フォルダを確認してください。');
}

export async function tunedropFetch(path, options) {
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
    const accountToken = localStorage.getItem('tunedrop_token');
    const isAuthRequest = new URL(path, window.location.href).searchParams.get('action') === 'auth';
    const token = accountToken || (isAuthRequest ? null : await ensureTunedropGuest(url));
    if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
    let response;
    try {
        response = await fetch(url, Object.assign({}, options, { headers }));
    } catch (error) {
        showMaintenanceScreen();
        throw error;
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
        tunedropApiPromise = null;
        throw new Error('APIからJSONが返りません。PHPサーバー (./start.sh) の状態と config.js を確認してください。');
    }
    // メンテナンス中は API が 503 + { maintenance: true } を返す。
    // (DBロック等の一時的な503は maintenance フラグが無いので表示しない)
    if (response.status === 503) {
        response.clone().json()
            .then(data => { if (data && data.maintenance === true) showMaintenanceScreen(data.error); })
            .catch(() => { });
    }
    // ログイン中に 401 が返ったらトークンが期限切れ・無効。
    // 何もしないと一覧が空のまま「プレイリストがありません」に見えてしまうため、
    // セッションを捨ててログインし直してもらう (ゲスト利用時の401とは区別する)。
    if (response.status === 401 && accountToken && !isAuthRequest) handleExpiredSession();
    return response;
}

// ==========================================================
// メンテナンス / サーバー停止中の案内
// ----------------------------------------------------------
// API が 503 (maintenance: true) を返す、または接続できないときに
// 画面全体を覆う案内を出す。15秒ごとに復旧を確認し、復旧したら
// 自動で再読み込みする。静的ページ (maintenance.html) と同じ見た目。
// ==========================================================
let maintenanceTimer = null;
let maintenanceChecking = false;

export function showMaintenanceScreen(message) {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const overlay = document.getElementById('maintenance-overlay');
    if (!overlay) return;
    const alreadyVisible = !overlay.hidden;
    const messageEl = document.getElementById('maintenance-message');
    // すでに表示中ならメッセージを勝手に戻さない (503の詳細を上書きしない)
    if (messageEl && (message || !alreadyVisible)) {
        messageEl.textContent = message || 'ただいまメンテナンス中です。時間をおいて再試行してください。';
    }
    const note = document.getElementById('maintenance-note');
    if (note) note.textContent = '復旧すると自動で再読み込みします。';
    overlay.hidden = false;
    if (document.body && document.body.classList) document.body.classList.add('maintenance-open');
    if (!maintenanceTimer && typeof setInterval === 'function') {
        maintenanceTimer = setInterval(checkMaintenanceRecovery, 15000);
    }
}

export function hideMaintenanceScreen() {
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
        const overlay = document.getElementById('maintenance-overlay');
        if (overlay) overlay.hidden = true;
        if (document.body && document.body.classList) document.body.classList.remove('maintenance-open');
    }
    if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
    }
}

async function checkMaintenanceRecovery() {
    if (maintenanceChecking) return;
    maintenanceChecking = true;
    try {
        // 接続先を再探索する (サーバー再起動でポートが変わった場合にも追従)
        tunedropApiPromise = null;
        const api = await resolveTunedropApi();
        const response = await fetch(new URL('api.php?action=health', api.href), { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (data && data.status === 'ok') {
            hideMaintenanceScreen();
            window.location.reload();
        }
    } catch (_) {
        // まだ停止中
    } finally {
        maintenanceChecking = false;
    }
}

export async function retryMaintenance() {
    const note = typeof document !== 'undefined' ? document.getElementById('maintenance-note') : null;
    if (note) note.textContent = '接続を確認しています…';
    try {
        tunedropApiPromise = null;
        const api = await resolveTunedropApi();
        const response = await fetch(new URL('api.php?action=health', api.href), { cache: 'no-store' });
        const data = response.ok ? await response.json() : null;
        if (data && data.status === 'ok') {
            hideMaintenanceScreen();
            window.location.reload();
            return;
        }
    } catch (_) {
        // 停止中
    }
    if (note) note.textContent = 'まだ接続できません。時間をおいてもう一度お試しください。';
}

// セッション切れの案内は1回だけ出す (並行リクエストで連続表示しない)
let sessionExpiredNoticeAt = 0;

export function handleExpiredSession() {
    if (!localStorage.getItem('tunedrop_token')) return;
    clearSession();   // 無効なトークンを捨てる
    // ログイン専用のため、期限切れ後は初期ビュー (デモ) へ戻す
    showWelcomeView();
    if (Date.now() - sessionExpiredNoticeAt < 10000) return;
    sessionExpiredNoticeAt = Date.now();
    showToast('ログインの有効期限が切れました。もう一度ログインしてください。', 'error');
    showLoginModal();
}

// ゲスト取得 (POST) の上限時間。API や proxy が応答を返さない場合に
// 画面が「読み込み中」のまま固まらないよう、エラーとして表面化させる。
const GUEST_REQUEST_TIMEOUT_MS = 10000;

export async function ensureTunedropGuest(apiUrl) {
    if (tunedropGuestRefreshAt && Date.now() >= tunedropGuestRefreshAt) tunedropGuestPromise = null;
    if (!tunedropGuestPromise) {
        tunedropGuestPromise = (async () => {
            const url = new URL(apiUrl.href);
            url.search = '?action=auth&endpoint=guest';
            const requestGuest = credential => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), GUEST_REQUEST_TIMEOUT_MS);
                return fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ credential }),
                    signal: controller.signal
                }).catch(error => {
                    if (error && error.name === 'AbortError') {
                        throw new Error('認証サーバーの応答がありません。./start.sh が起動しているか確認してください。');
                    }
                    throw error;
                }).finally(() => clearTimeout(timer));
            };
            const readGuest = async response => {
                // 古い app.py が動いていると /auth/guest が無く、HTML の 404 が返る
                // (api.php が JSON の Content-Type を付けているため content-type だけでは防げない)。
                // そのまま response.json() を呼ぶと「<!doctype ... is not valid JSON」という
                // 原因の分からないエラーになるため、対処法の分かるエラーへ置き換える。
                if (!response.headers.get('content-type')?.includes('application/json')) {
                    throw new Error('認証サーバーの応答が不正です (古い app.py が動いている可能性があります)。./start.sh でサーバーを再起動してください。');
                }
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'ゲスト情報を読み込めませんでした。');
                localStorage.setItem('tunedrop_guest_credential', data.credential);
                tunedropGuestRefreshAt = Date.now() + 23 * 60 * 60 * 1000;
                return data.token;
            };

            const stored = localStorage.getItem('tunedrop_guest_credential') || '';
            let response = await requestGuest(stored);
            // 保存済みのゲスト認証情報が無効 (ゲストのDB行が消えた等) なら作り直す。
            // これが無いと 401 のまま何も表示できなくなる。
            if (response.status === 401 && stored) {
                localStorage.removeItem('tunedrop_guest_credential');
                response = await requestGuest('');
            }
            return readGuest(response);
        })().catch(error => {
            tunedropGuestPromise = null;
            throw error;
        });
    }
    return tunedropGuestPromise;
}

// ==========================================================
// 共通UI: トースト通知
// ----------------------------------------------------------
// alert() は再生中の音を止め、閉じるまで画面を操作できない。
// 「追加した」「コピーした」等の結果は画面右上に一時表示して流れを止めない。
// エラーは読み上げにも乗る role="alert" で、成功より長く表示する。
// ==========================================================
const TOAST_DURATION = { success: 2800, info: 3600, error: 5200 };
// 同時に3件まで。連打で同じ通知が積み上がって画面を覆わないようにする。
const MAX_TOASTS = 3;

export function showToast(message, kind = 'success') {
    const text = String(message == null ? '' : message).trim();
    if (!text || typeof document === 'undefined' || !document.body) return null;
    const type = kind === 'error' ? 'error' : (kind === 'info' ? 'info' : 'success');
    let host = document.getElementById('toast-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toast-host';
        host.className = 'toast-host';
        document.body.appendChild(host);
    }
    // 同じ内容が連続したら積まない (二重クリックやポーリングの連通知対策)
    const currentToasts = host.children ? [...host.children] : [];
    const duplicate = currentToasts.find(
        element => element.classList && element.classList.contains(`toast-${type}`) && element.textContent === text
    );
    if (duplicate) return duplicate;
    while (host.children && host.children.length >= MAX_TOASTS) {
        const oldest = host.firstElementChild || host.children[0];
        if (!oldest) break;
        oldest.remove();
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = text;
    host.appendChild(toast);
    // 追加直後に is-visible を付けてスライドインさせる。
    // requestAnimationFrame は非表示タブや再描画が止まった環境で発火しないことがあるため、
    // 1回 reflow を挟んで初期状態を確定させてからクラスを付ける。
    void toast.offsetWidth;
    toast.classList.add('is-visible');
    setTimeout(() => {
        toast.classList.remove('is-visible');
        setTimeout(() => toast.remove(), 260);
    }, TOAST_DURATION[type] || TOAST_DURATION.success);
    return toast;
}

// ==========================================================
// 共通UI: モーダルを Esc / 背景クリックで閉じる
// ----------------------------------------------------------
// index.html の並び = 重なったときの手前順 (z-index が同じなので後のものが上)。
// 末尾から探して、開いている一番手前の1枚だけ閉じる。
// 背景クリックは index.html 側で「モーダル自身が押されたとき」だけ閉じる。
// ==========================================================
const MODAL_CLOSERS = [
    // モバイルのRadar絞り込みシート (アプリのモーダルより下に重なるので最初に確認する)
    { id: 'radar-subcontrols', close: () => closeRadarFilters(), isOpen: () => isRadarFiltersSheetOpen() },
    { id: 'create-playlist-modal', close: () => closeCreatePlaylistModal() },
    { id: 'edit-playlist-modal', close: () => closeEditPlaylistModal() },
    { id: 'move-track-modal', close: () => closeMoveModal() },
    { id: 'radar-save-modal', close: () => closeRadarSaveModal() },
    { id: 'export-preview-modal', close: () => closeExportModal() },
    { id: 'login-modal', close: () => closeLoginModal() },
    // 確認ダイアログは最後 (最前面) に閉じる。キャンセル扱い。
    { id: 'confirm-modal', close: () => closeConfirmModal(false) },
];

export function isModalVisible(id) {
    const modal = document.getElementById(id);
    return Boolean(modal) && modal.style.display !== 'none';
}

// Keep keyboard navigation in the frontmost dialog, including confirmation dialogs
// stacked above sign-in. The existing auth handler covers Google's embedded button.
export function trapModalFocus(event) {
    if (!event || event.key !== 'Tab' || event.defaultPrevented) return;
    if (document.body?.classList.contains('maintenance-open')) return;
    const top = [...MODAL_CLOSERS].reverse().find(item =>
        typeof item.isOpen === 'function' ? item.isOpen() : isModalVisible(item.id));
    if (!top) return;
    if (top.id === 'login-modal') return trapAuthModalFocus(event);
    const modal = document.getElementById(top.id);
    if (!modal || typeof modal.querySelectorAll !== 'function') return;
    const controls = [...modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
        'select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )].filter(el => !el.hidden && (!el.getClientRects || el.getClientRects().length > 0));
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (!modal.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    }
}

export function closeTopmostModal() {
    for (let i = MODAL_CLOSERS.length - 1; i >= 0; i--) {
        const target = MODAL_CLOSERS[i];
        const open = typeof target.isOpen === 'function' ? target.isOpen() : isModalVisible(target.id);
        if (open) {
            target.close();
            return true;
        }
    }
    return false;
}

// ==========================================================
// 共通UI: 確認ダイアログ (window.confirm の置き換え)
// ----------------------------------------------------------
// window.confirm は再生中の音を止め、閉じるまで画面全体をブロックする。
// 見た目もブラウザ依存なので、アプリ内のモーダルで確認する。
//   const ok = await showConfirm({ title, message, confirmLabel, danger });
// ==========================================================
let confirmResolver = null;
let confirmReturnFocus = null;

export function showConfirm(options = {}) {
    const modal = document.getElementById('confirm-modal');
    const message = String(options.message || '').trim();
    // index.html が無いテスト環境では従来の confirm にフォールバックする
    if (!modal) {
        return Promise.resolve(typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(message)
            : false);
    }
    if (confirmResolver) {
        const previous = confirmResolver;
        confirmResolver = null;
        previous(false);
    }
    confirmReturnFocus = typeof document !== 'undefined' ? document.activeElement : null;
    document.getElementById('confirm-modal-title').textContent = options.title || '確認';
    document.getElementById('confirm-modal-message').textContent = message;
    const okButton = document.getElementById('confirm-modal-ok');
    const cancelButton = document.getElementById('confirm-modal-cancel');
    if (okButton) {
        okButton.textContent = options.confirmLabel || 'OK';
        okButton.classList.toggle('danger', Boolean(options.danger));
    }
    if (cancelButton) cancelButton.textContent = options.cancelLabel || 'キャンセル';
    modal.style.display = 'flex';
    // 破壊的な操作は「キャンセル」にフォーカスして、Enter の誤確定を防ぐ
    const focusTarget = options.danger ? cancelButton : okButton;
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
    return new Promise(resolve => { confirmResolver = resolve; });
}

export function closeConfirmModal(result) {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.style.display = 'none';
    const resolve = confirmResolver;
    confirmResolver = null;
    if (resolve) resolve(Boolean(result));
    if (confirmReturnFocus && confirmReturnFocus.isConnected !== false
        && typeof confirmReturnFocus.focus === 'function') {
        confirmReturnFocus.focus();
    }
    confirmReturnFocus = null;
}

// クリップボードへコピーする。HTTPS でない環境や古いブラウザでも動くよう
// Clipboard API → execCommand の順に試す。
export async function copyTextToClipboard(text) {
    const value = String(text == null ? '' : text);
    if (!value) return false;
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch (_) { /* 権限や非セキュアコンテキストでは execCommand を試す */ }
    try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
        textarea.remove();
        return Boolean(copied);
    } catch (_) {
        return false;
    }
}

// 送信ボタンの二重クリックを防ぐ (処理中は文言を変えて無効化する)。
function setActionBusy(button, busy, busyLabel) {
    if (!button) return false;
    if (busy) {
        if (button.disabled) return false;
        button.dataset.idleLabel = button.textContent;
        button.textContent = busyLabel;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        return true;
    }
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    return true;
}

// ==========================================================
// 共通UI: YouTube URL から動画IDを取り出す
// ----------------------------------------------------------
// 1つの入力欄に複数URLをまとめて貼り付けられるように、
// youtu.be / watch?v= / music.youtube.com / shorts などの書式から
// 動画IDをすべて拾い、同じ動画は1つにまとめる。
// ==========================================================
const YOUTUBE_URL_PATTERN = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|watch\?v=|watch\?.+&v=))([\w-]{11})/g;

export function extractYouTubeIds(text) {
    const ids = [];
    for (const match of String(text == null ? '' : text).matchAll(YOUTUBE_URL_PATTERN)) {
        if (!ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
}

let player;
// プレイヤーを閉じた直後に YouTube が ENDED を返しても次曲へ進まないための期限
let ignorePlayerEndedUntil = 0;
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
let currentDetailIsMine = false;   // 表示中のリストが自分のものか (移動・削除の可否)
let detailReturnView = 'share';    // 詳細画面の「戻る」先 (share / manager)
let selectedTrackIdForMove = null;
let bulkMoveTrackIds = [];          // 複数選択から移動する bookmarks.id
let managerSelectMode = false;      // Manager の曲カードを複数選択中か
let managerSelectedTrackIds = new Set();  // 選択中の bookmarks.id
let managerSelectionAnchorId = null;      // Shift+クリックの起点
let managerSummary = null;          // Managerホームの集計 (get_manager_summary)
let managerSummaryPromise = null;   // 同時リクエストの重複防止
let managerSummaryError = false;    // 集計の取得に失敗したか (再試行の案内に使う)
let playlistSortMode = 'custom';   // custom | newest | oldest | name
let trackSortMode = 'custom';      // custom | newest | oldest | name

// ==========================================================
// 固定タブ (未整理 / 公開用お気に入り)
// 全ユーザー共通でサイドバーに常時表示し、並び替え・削除・タグ変更ができない。
// サムネイルは api.php が「最後に保存した曲」を返す。
// ==========================================================
const SYSTEM_PLAYLIST_ORDER = { inbox: 0, public_favorites: 1 };

export function isSystemPlaylist(list) {
    if (!list) return false;
    return Boolean(list.system_key) || list.is_default == 1;
}

export function compareSystemPlaylists(a, b) {
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
export function isMobileMenuOpen() {
    return document.body.classList.contains('mobile-menu-open');
}

// ハンバーガーボタンの見た目以外の状態 (スクリーンリーダー向け) を揃える
export function syncMobileMenuButton(open) {
    const button = document.getElementById('menu-toggle-btn');
    if (!button) return;
    const label = open ? 'メニューを閉じる' : 'メニューを開く';
    button.setAttribute('aria-expanded', String(Boolean(open)));
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
}

// メニューを閉じる (開いていた場合のみ true)
export function closeMobileMenu() {
    const wasOpen = isMobileMenuOpen();
    document.querySelectorAll('.sidebar, .radar-sidebar, .top-nav nav')
        .forEach(el => el.classList.remove('show-mobile'));
    document.body.classList.remove('mobile-menu-open');
    if (wasOpen) syncMobileMenuButton(false);
    return wasOpen;
}

// メニューを開く (モバイル幅でのみ見た目に反映される)
export function openMobileMenu() {
    document.querySelector('.top-nav nav')?.classList.add('show-mobile');
    if (document.getElementById('view-manager')?.classList.contains('active')) {
        document.querySelector('.sidebar')?.classList.add('show-mobile');
    } else if (document.getElementById('view-radar')?.classList.contains('active')) {
        document.querySelector('.radar-sidebar')?.classList.add('show-mobile');
    }
    document.body.classList.add('mobile-menu-open');
    syncMobileMenuButton(true);
}

export function toggleSidebar() {
    if (isMobileMenuOpen()) {
        closeMobileMenu();
        return false;
    }
    openMobileMenu();
    return true;
}

// メニュー本体 (ドロワー・ナビ) の中かどうか。スクロール判定にも使う。
export function isInsideMobileMenu(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('.sidebar, .radar-sidebar, .top-nav nav'));
}

// メニューを開いたままにする操作かどうか
// - ハンバーガーボタン: onclick="toggleSidebar()" が開閉を担当する
// - メニュー内の項目 (リスト選択・絞り込みなど) のタップ
//   ただしメニュー自身の余白 (背景) をタップしたときは閉じる対象にする
export function keepsMobileMenuOpen(target) {
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
export function isMobileMenuViewport() {
    return typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 600px)').matches
        : window.innerWidth <= 600;
}

window.addEventListener('resize', () => {
    if (isMobileMenuOpen() && !isMobileMenuViewport()) closeMobileMenu();
});

export function closeYoutubePlayer() {
    const popup = document.getElementById('youtube-popup');
    if (!popup) return;
    // stopVideo() は YouTube 側で ENDED を発火し、自動次曲に進むことがある。
    // 閉じる操作では自動送りを抑止し、pause で音だけ止める。
    ignorePlayerEndedUntil = Date.now() + 1000;
    popup.classList.remove('is-active');
    if (player) {
        if (typeof player.pauseVideo === 'function') player.pauseVideo();
        else if (typeof player.stopVideo === 'function') player.stopVideo();
    }
    isPlaying = false;
    const playBtn = document.getElementById('play-pause-btn');
    if (playBtn) playBtn.classList.remove('is-playing');
    clearInterval(progressInterval);
}

// ==========================================================
// ログイン専用モード / 未ログインのデモ初期ビュー
// ----------------------------------------------------------
// Tune drop はログイン専用のアプリ。未ログインのときは
// #view-welcome (デモ) だけを表示し、Manager / Radar / Share /
// Profile は開けない (navigateView / applyPathView でガードする)。
// デモは静的なサンプルで、APIは一切呼ばない。
// ==========================================================
export function hasAccountSession() {
    try {
        return Boolean(localStorage.getItem('tunedrop_token'));
    } catch (_) {
        return false;
    }
}

// デモの「新規登録 / ログイン」ボタンから開く。モードに応じて案内文を変える。
export function openAuthModal(mode) {
    showLoginModal(mode === 'register' ? 'register' : 'login');
}

// 未ログインでアプリの操作をしようとしたときの共通案内
export function promptLogin(message) {
    showToast(message || 'デモ表示です。ログインすると使えます。', 'info');
    showLoginModal();
}

export function prefersReducedMotion() {
    return typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function scrollToWelcomeDemo() {
    const target = document.getElementById('welcome-demo');
    if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
}

export function scrollToWelcomeGuide() {
    const target = document.getElementById('welcome-howto');
    if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
}

export function showWelcomeView() {
    renderWelcomeDemo();
    const view = document.getElementById('view-welcome');
    const wasActive = Boolean(view && view.classList.contains('active'));
    switchView('welcome');
    // ロゴクリックやログアウトで戻ったときに、前回のスクロール位置に残らないようにする
    if (!view) return;
    if (typeof view.scrollTo === 'function') {
        view.scrollTo({ top: 0, behavior: wasActive && !prefersReducedMotion() ? 'smooth' : 'auto' });
    } else {
        view.scrollTop = 0;
    }
}

// ----------------------------------------------------------
// 未ログインのデモ: Radar Radio
// ----------------------------------------------------------
// 公開RadarのデモAPI (api.php?action=demo_tracks) からランダムに5曲を選び、
// YouTube公式プレイヤーで再生する。APIに接続できない場合も、同じ画面構成の
// サンプル5曲で再生できるようにしておく。
const WELCOME_DEMO_COUNT = 5;
const WELCOME_DEMO_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const WELCOME_DEMO_PLAYER_STATE = { ENDED: 0, PLAYING: 1 };
const WELCOME_DEMO_MAP_PADDING = 8;
const WELCOME_DEMO_MAP_SPAN = 84;
const WELCOME_DEMO_MAP_BASE = `
    <line class="demo-radar-grid" x1="0" y1="50" x2="100" y2="50"></line>
    <line class="demo-radar-grid" x1="50" y1="0" x2="50" y2="100"></line>
    <circle class="demo-radar-ring" cx="50" cy="50" r="36"></circle>
    <circle class="demo-radar-ring" cx="50" cy="50" r="22"></circle>
    <circle class="demo-radar-ring" cx="50" cy="50" r="8"></circle>`;

const WELCOME_DEMO_FALLBACK_TRACKS = [
    { youtube_id: 'bPI0_YzOiEw', title: 'i wanna be your world', channel: 'kz (livetune)', category: 'J-POP', features: { x: 0.801, y: 0.4205, mood: 'calm', tempo: 149.7 } },
    { youtube_id: 'uSijY6BEMRE', title: 'Yellow', channel: 'kz (livetune)', category: 'J-POP', features: { x: 0.4529, y: 0.5842, mood: 'energetic', tempo: 127.4 } },
    { youtube_id: 'cZYYwtnUarU', title: '東京真中 - レムニスケート feat. 初音ミク', channel: '東京真中', category: 'Vocaloid', features: { x: 0.6969, y: 0.6383, mood: 'energetic', tempo: 104.9 } },
    { youtube_id: '4cArp-fgrOU', title: '笹川真生 - サニーサイドへようこそ', channel: '笹川真生 - Mao Sasagawa', category: 'J-POP', features: { x: 0.3001, y: 0.74, mood: 'energetic', tempo: 110.7 } },
    { youtube_id: '_UyCmkC64zk', title: 'KAIRUI & higma - ネバーエンド(feat.初音ミク)', channel: 'KAIRUI', category: 'Vocaloid', features: { x: 0.95, y: 0.3215, mood: 'energetic', tempo: 127.9 } },
];

function demoToneFor(track) {
    const category = String(track && track.category || '').toLowerCase();
    if (category.includes('lo-fi') || category.includes('lofi')) return 'lofi';
    if (category.includes('anime') || category.includes('vocaloid')) return 'anime';
    if (category.includes('j-pop') || category.includes('jpop')) return 'jpop';
    return 'other';
}

function normalizeDemoTrack(point) {
    const source = point && typeof point === 'object' ? point : {};
    const features = source.features && typeof source.features === 'object' ? source.features : {};
    const x = Number(source.x !== undefined ? source.x : features.x);
    const y = Number(source.y !== undefined ? source.y : features.y);
    const mood = source.mood !== undefined ? source.mood : features.mood;
    const tempo = Number(source.tempo !== undefined ? source.tempo : features.tempo);
    return {
        youtube_id: String(source.youtube_id || ''),
        title: String(source.title || '').trim() || 'タイトル不明',
        channel: String(source.channel || '').trim() || 'Unknown Artist',
        category: String(source.category || 'Other').trim() || 'Other',
        mood: String(mood || '').trim(),
        tempo: Number.isFinite(tempo) ? tempo : 0,
        x: Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5,
        y: Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0.5,
    };
}

function normalizeDemoList(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
        .map(normalizeDemoTrack)
        .filter(track => {
            if (!WELCOME_DEMO_VIDEO_ID_RE.test(track.youtube_id) || seen.has(track.youtube_id)) return false;
            seen.add(track.youtube_id);
            return true;
        });
}

function spreadDemoCoordinates(items, reference = items) {
    if (!items.length || !reference.length) return items;
    const axisRange = (axis) => {
        const values = reference.map(item => item[axis]).filter(Number.isFinite);
        if (!values.length) return null;
        const min = Math.min(...values);
        const max = Math.max(...values);
        return max - min > 1e-6 ? { min, span: max - min } : null;
    };
    const xr = axisRange('x');
    const yr = axisRange('y');
    // 解析値は中央付近に固まりやすい。デモでは5曲の位置関係が読めるよう、
    // 極端に狭い場合だけ 0.08〜0.92 に引き伸ばす (本物のRadarの座標は変えない)。
    if (xr && xr.span < 0.45) {
        items.forEach(item => { item.x = 0.08 + ((item.x - xr.min) / xr.span) * 0.84; });
    }
    if (yr && yr.span < 0.45) {
        items.forEach(item => { item.y = 0.08 + ((item.y - yr.min) / yr.span) * 0.84; });
    }
    return items;
}

function separateDemoDots(tracks) {
    const clamp = (value) => Math.min(0.92, Math.max(0.08, value));
    const placed = [];
    tracks.forEach((track, index) => {
        const originX = track.x;
        const originY = track.y;
        let x = originX;
        let y = originY;
        let attempt = 0;
        while (placed.some(p => Math.hypot(p.x - x, p.y - y) < 0.14) && attempt < 24) {
            const angle = index * 1.7 + attempt * 2.4;
            const radius = 0.08 + Math.floor(attempt / 6) * 0.05;
            x = clamp(originX + Math.cos(angle) * radius);
            y = clamp(originY + Math.sin(angle) * radius);
            attempt += 1;
        }
        track.x = x;
        track.y = y;
        placed.push(track);
    });
    return tracks;
}

function pickWelcomeDemoTracks(points, count = WELCOME_DEMO_COUNT) {
    const unique = normalizeDemoList(points);
    for (let i = unique.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [unique[i], unique[j]] = [unique[j], unique[i]];
    }
    return unique.slice(0, count);
}

function fillWelcomeDemoTracks(tracks, count = WELCOME_DEMO_COUNT) {
    const result = [...tracks];
    const seen = new Set(result.map(track => track.youtube_id));
    for (const fallback of WELCOME_DEMO_FALLBACK_TRACKS) {
        if (result.length >= count) break;
        const track = normalizeDemoTrack(fallback);
        if (seen.has(track.youtube_id)) continue;
        seen.add(track.youtube_id);
        result.push(track);
    }
    return result.slice(0, count);
}

function prepareWelcomeDemoTracks(points, count = WELCOME_DEMO_COUNT) {
    return separateDemoDots(fillWelcomeDemoTracks(pickWelcomeDemoTracks(points, count), count));
}

function welcomeDemoMapPercent(value, invert = false) {
    const percent = WELCOME_DEMO_MAP_PADDING + value * WELCOME_DEMO_MAP_SPAN;
    return invert ? 100 - percent : percent;
}



// デモ画面の状態・描画・プレイヤー操作を1か所にまとめる。
// 以前は12個のモジュール変数と関数が散在し、非同期取得の結果が
// 別の画面状態を上書きすることがあった。ここでは state を this に集約し、
// API取得には世代番号を付けて古い応答を無視する。
class WelcomeDemoController {
    constructor() {
        this.resetState();
    }

    resetState() {
        this.els = Object.create(null);
        this.rendered = false;
        this.pool = [];
        this.tracks = [];
        this.index = 0;
        this.player = null;
        this.playerReady = false;
        this.started = false;
        this.playing = false;
        this.creating = false;
        this.progressTimer = null;
        this.errorStreak = 0;
        this.apiRequest = 0;
        this.bootTimer = null;
        this.sourceIsPublic = false;
        this.ignoreEndedUntil = 0;
    }

    get track() {
        return this.tracks[this.index] || null;
    }

    el(id) {
        if (this.els[id]) return this.els[id];
        const node = document.getElementById(id);
        if (node) this.els[id] = node;
        return node;
    }

    setText(id, text) {
        const node = this.el(id);
        if (node) node.textContent = text;
    }

    setNote(message) {
        this.setText('demo-queue-note', message);
    }

    setSource(text) {
        this.setText('demo-source', text);
    }

    setLoading(loading) {
        const box = this.el('demo-screen-loading');
        if (box) box.hidden = !loading;
    }

    render(force = false) {
        if (this.rendered && !force) return;
        if (!this.el('demo-queue') || !this.el('demo-radar')) return;
        if (force) {
            this.destroyPlayer();
            this.els = Object.create(null);
            this.apiRequest += 1;
        }
        this.sourceIsPublic = false;
        this.pool = [...WELCOME_DEMO_FALLBACK_TRACKS];
        this.tracks = prepareWelcomeDemoTracks(this.pool);
        this.index = 0;
        this.renderAll();
        this.setSource('RADAR / SAMPLE');
        this.setNote('公開Radarから5曲を選んでいます…');
        this.rendered = true;
        void this.loadTracks();
    }

    renderAll() {
        this.renderQueue();
        this.drawRadar();
        this.updateUI();
    }

    renderQueue() {
        const host = this.el('demo-queue');
        if (!host) return;
        this.setText('demo-queue-count', String(this.tracks.length));
        host.innerHTML = this.tracks.map((track, index) => {
            const isCurrent = index === this.index;
            const active = isCurrent ? ' is-active' : '';
            const tone = demoToneFor(track);
            const thumb = `https://i.ytimg.com/vi/${track.youtube_id}/mqdefault.jpg`;
            return `
                <li class="demo-queue-item${active}">
                    <button type="button" class="demo-queue-btn${active}" data-demo-track="${index}"
                        onclick="playWelcomeTrack(${index})" aria-label="${escapeHtml(track.title)} を再生">
                        <span class="demo-queue-no">${String(index + 1).padStart(2, '0')}</span>
                        <span class="demo-queue-thumb">
                            <img src="${thumb}" alt="" loading="lazy">
                            <span class="demo-queue-play"><span class="material-symbols-rounded">${isCurrent && this.playing ? 'pause' : 'play_arrow'}</span></span>
                        </span>
                        <span class="demo-queue-main">
                            <strong>${escapeHtml(track.title)}</strong>
                            <small>${escapeHtml(track.channel)}</small>
                        </span>
                        <span class="demo-queue-meta">
                            <span class="tone-${tone}">${escapeHtml(track.category)}</span>
                            <small>${track.tempo ? Math.round(track.tempo) + ' BPM' : '—'}</small>
                        </span>
                    </button>
                </li>`;
        }).join('');
    }

    drawRadar() {
        const svg = this.el('demo-radar');
        const dots = this.el('demo-radar-dots');
        if (!svg || !dots) return;
        const pool = this.pool.length ? this.pool : this.tracks;
        const backgroundDots = pool.slice(0, 120).map(point => {
            const track = normalizeDemoTrack(point);
            const x = welcomeDemoMapPercent(track.x);
            const y = welcomeDemoMapPercent(track.y, true);
            return `<circle class="demo-radar-bg tone-${demoToneFor(track)}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="0.9"></circle>`;
        }).join('');
        svg.innerHTML = WELCOME_DEMO_MAP_BASE + backgroundDots;
        dots.innerHTML = this.tracks.map((track, index) => {
            const left = welcomeDemoMapPercent(track.x);
            const top = welcomeDemoMapPercent(track.y, true);
            const active = index === this.index ? ' is-active' : '';
            return `<button type="button" class="demo-radar-dot tone-${demoToneFor(track)}${active}"
                data-demo-point="${index}" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%"
                onclick="playWelcomeTrack(${index})" aria-label="${escapeHtml(track.title)} を再生">${index + 1}</button>`;
        }).join('');
    }

    updateUI() {
        const track = this.track;
        if (!track) return;
        const label = `${String(this.index + 1).padStart(2, '0')} / ${String(this.tracks.length).padStart(2, '0')}`;
        this.setText('demo-screen-index', label);
        this.setText('demo-now-index', label);
        this.setText('demo-title', track.title);
        this.setText('demo-artist', track.channel);

        const poster = this.el('demo-poster');
        if (poster) {
            poster.src = `https://i.ytimg.com/vi/${track.youtube_id}/hq720.jpg`;
            poster.onerror = () => {
                poster.onerror = null;
                poster.src = `https://i.ytimg.com/vi/${track.youtube_id}/mqdefault.jpg`;
            };
            poster.alt = `${track.title} のサムネイル`;
        }
        const link = this.el('demo-youtube-link');
        if (link) link.href = `https://www.youtube.com/watch?v=${track.youtube_id}`;

        const tags = [
            track.category ? { label: track.category, tone: demoToneFor(track) } : null,
            track.mood ? { label: track.mood } : null,
            track.tempo ? { label: `${Math.round(track.tempo)} BPM` } : null,
        ].filter(Boolean);
        const tagHost = this.el('demo-tags');
        if (tagHost) {
            tagHost.innerHTML = tags.map(tag => {
                const tone = tag.tone ? ` class="tone-${tag.tone}"` : '';
                return `<span${tone}>${escapeHtml(tag.label)}</span>`;
            }).join('');
        }

        const playIcon = this.el('demo-play-icon');
        if (playIcon) playIcon.textContent = this.playing ? 'pause' : 'play_arrow';
        const playBtn = this.el('demo-play-btn');
        if (playBtn) {
            playBtn.classList.toggle('is-playing', this.playing);
            playBtn.setAttribute('aria-label', this.playing ? '一時停止' : '再生');
        }
        const screen = this.el('demo-screen');
        if (screen) screen.classList.toggle('is-started', this.started);

        const queue = this.el('demo-queue');
        if (queue) {
            queue.querySelectorAll('[data-demo-track]').forEach(button => {
                const isActive = Number(button.dataset.demoTrack) === this.index;
                button.classList.toggle('is-active', isActive);
                const item = button.closest('.demo-queue-item');
                if (item) item.classList.toggle('is-active', isActive);
                const queueIcon = button.querySelector('.demo-queue-play .material-symbols-rounded');
                if (queueIcon) queueIcon.textContent = isActive && this.playing ? 'pause' : 'play_arrow';
            });
        }
        const dots = this.el('demo-radar-dots');
        if (dots) {
            dots.querySelectorAll('[data-demo-point]').forEach(button => {
                button.classList.toggle('is-active', Number(button.dataset.demoPoint) === this.index);
            });
        }
    }

    parseTrackPayload(data) {
        const points = normalizeDemoList(data && data.points);
        const picksSource = Array.isArray(data && data.picks) && data.picks.length
            ? data.picks
            : points;
        const picks = normalizeDemoList(picksSource);
        if (!points.length || !picks.length) {
            throw new Error('demo_tracks returned no playable tracks');
        }
        return { points, picks };
    }

    async loadTracks() {
        if (hasAccountSession()) return;
        const request = ++this.apiRequest;
        try {
            const api = await resolveTunedropApi();
            const url = new URL(api.href);
            url.search = '?action=demo_tracks';
            const response = await fetch(url, {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });
            if (request !== this.apiRequest) return;
            if (!response.ok) throw new Error(`demo_tracks ${response.status}`);
            const { points, picks } = this.parseTrackPayload(await response.json());
            if (request !== this.apiRequest) return;
            this.pool = spreadDemoCoordinates(points.map(track => ({ ...track })), points);
            const spreadPicks = spreadDemoCoordinates(picks.map(track => ({ ...track })), points);
            this.setText('demo-radar-caption', `${points.length}曲の公開Radar`);
            this.setSource('RADAR / PUBLIC');
            this.sourceIsPublic = true;
            this.setNote(`${points.length}曲の公開Radarからランダムに5曲。曲が終わると次へ進みます。`);
            // ユーザーがサンプル曲を再生し始めた後は、キューを勝手に差し替えない。
            if (!this.started) {
                this.tracks = prepareWelcomeDemoTracks(spreadPicks);
                this.index = 0;
                this.renderQueue();
                this.updateUI();
            }
            this.drawRadar();
        } catch (error) {
            if (request !== this.apiRequest) return;
            console.warn('Radarデモの取得に失敗しました:', error);
            this.setSource('RADAR / SAMPLE');
            this.sourceIsPublic = false;
            this.setNote('公開Radarに接続できないため、サンプル5曲を表示しています。');
        } finally {
        }
    }

    reroll() {
        const pool = this.pool.length ? this.pool : WELCOME_DEMO_FALLBACK_TRACKS;
        const picked = prepareWelcomeDemoTracks(pool);
        if (!picked.length) return;
        this.destroyPlayer();
        this.tracks = picked;
        this.index = 0;
        this.renderAll();
        this.setNote('別の5曲を選びました。曲を選ぶと再生が始まります。');
        this.setSource(this.sourceIsPublic ? 'RADAR / PUBLIC' : 'RADAR / SAMPLE');
    }


    clearBootTimer() {
        if (this.bootTimer) {
            clearTimeout(this.bootTimer);
            this.bootTimer = null;
        }
    }

    destroyPlayer() {
        this.stopProgress();
        this.clearBootTimer();
        if (this.player && typeof this.player.destroy === 'function') {
            try { this.player.destroy(); } catch (_) { /* iframe already gone */ }
        }
        this.player = null;
        this.playerReady = false;
        this.started = false;
        this.playing = false;
        this.creating = false;
        this.errorStreak = 0;
        this.ignoreEndedUntil = 0;
        const host = this.el('demo-player-mount');
        if (host) host.innerHTML = '';
        const screen = this.el('demo-screen');
        if (screen) screen.classList.remove('is-started');
        this.setLoading(false);
        this.resetProgress();
    }

    resetProgress() {
        const fill = this.el('demo-progress-fill');
        if (fill) fill.style.width = '0%';
        this.setText('demo-time', '0:00 / 0:00');
        const bar = this.el('demo-progress');
        if (bar) bar.setAttribute('aria-valuenow', '0');
    }

    createPlayer(track) {
        if (this.creating || this.player) return;
        this.creating = true;
        this.setLoading(true);
        let attempts = 0;
        const boot = () => {
            if (!this.creating) return;
            if (!(window.YT && window.YT.Player)) {
                attempts += 1;
                if (attempts <= 40) {
                    this.bootTimer = setTimeout(boot, 250);
                    return;
                }
                this.creating = false;
                this.setLoading(false);
                showToast('YouTubeプレイヤーを読み込めませんでした。通信環境を確認してください。', 'error');
                return;
            }
            this.bootTimer = null;
            const host = this.el('demo-player-mount');
            if (!host) {
                this.creating = false;
                this.setLoading(false);
                return;
            }
            host.innerHTML = '<div id="demo-player-frame"></div>';
            try {
                this.player = new window.YT.Player('demo-player-frame', {
                    videoId: track.youtube_id,
                    playerVars: {
                        autoplay: 1,
                        cc_load_policy: 0,
                        controls: 0,
                        disablekb: 1,
                        enablejsapi: 1,
                        fs: 1,
                        modestbranding: 1,
                        origin: window.location.origin,
                        playsinline: 1,
                        rel: 0,
                    },
                    events: {
                        onReady: event => this.onPlayerReady(event),
                        onStateChange: event => this.onPlayerState(event),
                        onError: event => this.onPlayerError(event),
                    },
                });
            } catch (error) {
                console.warn('YouTubeプレイヤーの作成に失敗しました:', error);
                this.creating = false;
                this.setLoading(false);
                showToast('YouTubeプレイヤーを開始できませんでした。', 'error');
            }
        };
        boot();
    }

    onPlayerReady(event) {
        if (this.player !== event.target) return;
        this.playerReady = true;
        this.creating = false;
        this.started = true;
        this.setLoading(false);
        const track = this.track;
        try {
            const loaded = event.target.getVideoData?.().video_id;
            if (track && loaded && loaded !== track.youtube_id) {
                event.target.loadVideoById(track.youtube_id);
            } else {
                event.target.playVideo();
            }
        } catch (_) {
            // playVideo はユーザー操作後のため、失敗しても次回のクリックで再試行できる
        }
        this.updateUI();
    }

    onPlayerState(event) {
        if (this.player !== event.target) return;
        this.playing = event.data === WELCOME_DEMO_PLAYER_STATE.PLAYING;
        if (this.playing) {
            this.errorStreak = 0;
            this.startProgress();
        } else {
            this.stopProgress();
        }
        this.updateUI();
        if (event.data === WELCOME_DEMO_PLAYER_STATE.ENDED) {
            // 曲の切り替え直後に前の動画の ENDED が届いても、勝手に次へ進めない。
            if (Date.now() < this.ignoreEndedUntil) return;
            this.next();
        }
    }

    onPlayerError(event) {
        if (this.player !== event.target) return;
        console.warn('YouTubeデモ再生エラー:', event.data);
        this.errorStreak += 1;
        if (this.errorStreak > this.tracks.length) {
            this.playing = false;
            this.stopProgress();
            this.updateUI();
            showToast('この5曲は再生できませんでした。別の5曲を試してください。', 'error');
            return;
        }
        this.next();
    }


    play(index = this.index) {
        const nextIndex = Number(index);
        if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= this.tracks.length) return;
        this.index = nextIndex;
        this.errorStreak = 0;
        this.ignoreEndedUntil = Date.now() + 1500;
        const track = this.track;
        if (!track) return;
        if (this.player || this.creating) this.started = true;
        this.updateUI();
        if (this.player && this.playerReady) {
            try {
                const loaded = this.player.getVideoData?.().video_id;
                if (loaded === track.youtube_id) this.player.playVideo();
                else this.player.loadVideoById(track.youtube_id);
            } catch (error) {
                console.warn('デモ曲の切り替えに失敗しました:', error);
            }
            return;
        }
        if (this.creating) return;   // onReady で最新の曲を読み込む
        if (this.player) return;      // 作成直後で onReady 待ち
        this.createPlayer(track);
    }

    stopProgress() {
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    updateProgress() {
        if (!this.player || typeof this.player.getCurrentTime !== 'function') return;
        const current = Number(this.player.getCurrentTime()) || 0;
        const duration = Number(this.player.getDuration()) || 0;
        const percent = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;
        const fill = this.el('demo-progress-fill');
        if (fill) fill.style.width = `${percent}%`;
        this.setText('demo-time', `${formatTime(current)} / ${formatTime(duration)}`);
        const bar = this.el('demo-progress');
        if (bar) bar.setAttribute('aria-valuenow', String(Math.round(percent)));
    }

    startProgress() {
        this.stopProgress();
        this.updateProgress();
        this.progressTimer = setInterval(() => this.updateProgress(), 500);
    }

    pause() {
        this.stopProgress();
        if (this.player && typeof this.player.pauseVideo === 'function') {
            try { this.player.pauseVideo(); } catch (_) { /* noop */ }
        }
        this.playing = false;
        this.updateUI();
    }

    seek(event) {
        if (!this.player || !this.playerReady) return;
        const bar = this.el('demo-progress');
        if (!bar || typeof bar.getBoundingClientRect !== 'function') return;
        const rect = bar.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const duration = Number(this.player.getDuration()) || 0;
        if (duration > 0) this.player.seekTo(ratio * duration, true);
    }

    seekByKey(event) {
        if (!this.player || !this.playerReady) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const duration = Number(this.player.getDuration()) || 0;
        if (!duration) return;
        const delta = event.key === 'ArrowRight' ? 5 : -5;
        const next = Math.min(duration, Math.max(0, (Number(this.player.getCurrentTime()) || 0) + delta));
        this.player.seekTo(next, true);
    }

    next() {
        if (!this.tracks.length) return;
        this.play((this.index + 1) % this.tracks.length);
    }

    prev() {
        if (!this.tracks.length) return;
        this.play((this.index - 1 + this.tracks.length) % this.tracks.length);
    }

    toggle() {
        if (!this.player || !this.playerReady) {
            this.play();
            return;
        }
        if (this.playing) {
            this.pause();
            return;
        }
        this.started = true;
        this.playing = true;
        this.updateUI();
        this.player.playVideo();
    }
}

const welcomeDemo = new WelcomeDemoController();

// HTML の onclick / app.js 内部から使う公開API。
// 状態は welcomeDemo に集約し、ここでは名前だけを安定させておく。
export function renderWelcomeDemo(force = false) { welcomeDemo.render(force); }
export function playWelcomeTrack(index = welcomeDemo.index) { welcomeDemo.play(index); }
export function startWelcomeDemo() { welcomeDemo.play(welcomeDemo.index); }
export function toggleWelcomeDemo() { welcomeDemo.toggle(); }
export function nextWelcomeTrack() { welcomeDemo.next(); }
export function prevWelcomeTrack() { welcomeDemo.prev(); }
export function rerollWelcomeDemo() { welcomeDemo.reroll(); }
export function pauseWelcomeDemo() { welcomeDemo.pause(); }
export function seekWelcomeDemo(event) { welcomeDemo.seek(event); }
export function onWelcomeDemoProgressKey(event) { welcomeDemo.seekByKey(event); }



export function goToHome() {
    // 未ログイン時は初期ビュー (デモ) へ。アプリのデータは読み込まない。
    if (!hasAccountSession()) {
        const { basePath } = parseLocationPath();
        if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
            history.replaceState(null, '', basePath);
        }
        showWelcomeView();
        return;
    }
    navigateView('manager');
    selectPlaylist('home');
}

// ==========================================================
// ルーティング (History API: 標準的なパスでブラウザ戻る/進む対応)
// ----------------------------------------------------------
//   /             … Manager ホーム (サイトURLそのまま)
//   /radar        … Radar
//   /share        … Share
//   /profile      … Profile
//   /help         … ヘルプ
//   /playlist/12  … プレイリスト詳細
//   /user/12      … ユーザープロフィール
// 本番は /tunedrop/ 配下で配信されるため、そのプレフィックスは basePath として保持する。
// 旧ハッシュ (#manager / #/manager) は起動時にパスへ移行する。
// ==========================================================
const ROUTE_VIEW = {
    manager: 'manager',
    radar: 'radar',
    share: 'share',
    profile: 'profile',
    help: 'help',
    user: 'user-profile',
    playlist: 'playlist-detail',
};
const SITE_BASE_PATTERN = /^\/(tunedrop)(?=\/|$)/i;

// 現在のURLを { basePath, route, view, id, normalizedPath } に分解する。
// /index.html はディレクトリ (トップ) と同じ扱いにし、末尾の / も吸収する。
export function parseLocationPath() {
    const rawPath = String((window.location && window.location.pathname) || '/');
    const cleanPath = rawPath.replace(/\/index\.html?$/i, '/');
    const baseMatch = cleanPath.match(SITE_BASE_PATTERN);
    const basePath = baseMatch ? '/' + baseMatch[1] + '/' : '/';
    const rest = baseMatch ? cleanPath.slice(baseMatch[0].length) : cleanPath.replace(/^\//, '');
    const segments = rest.split('/').filter(Boolean);
    const route = segments[0] && ROUTE_VIEW[segments[0]] ? segments[0] : 'manager';
    const rawId = segments[1];
    const id = rawId && /^\d+$/.test(rawId) ? rawId : null;
    const normalizedPath = basePath + (route === 'manager' ? '' : route + (id ? '/' + id : ''));
    return { basePath, route, view: ROUTE_VIEW[route], id, normalizedPath };
}

export function currentPathView() {
    const { view, id } = parseLocationPath();
    return { view, id };
}

// ブラウザ履歴にパスを積む (History API が無いテスト環境では pathname を直接更新)
function pushLocationPath(path) {
    if (typeof history !== 'undefined' && typeof history.pushState === 'function') {
        history.pushState(null, '', path);
        return;
    }
    if (typeof location !== 'undefined' && location) {
        try { location.pathname = path; } catch (error) { /* 読み取り専用なら何もしない */ }
    }
}

// 未ログインで開こうとした画面 (ログイン成功後に復帰する)
let postLoginView = null;

// ビューをURLに記録しつつ遷移する (戻る履歴へ積む)
export function navigateView(viewName, id) {
    // ログイン専用: 未ログインではデモ (welcome) とヘルプだけを表示する。
    // 直接 navigateView() を呼ばれてもアプリ画面へ入れないよう、ここでも止める。
    if (!hasAccountSession() && viewName !== 'help' && viewName !== 'welcome') {
        postLoginView = { view: viewName, id: id || null };
        showToast('ログインすると使えます。', 'info');
        showWelcomeView();
        showLoginModal();
        return;
    }
    const route = viewName === 'playlist-detail' ? 'playlist' : (viewName === 'user-profile' ? 'user' : viewName);
    const { basePath } = parseLocationPath();
    const path = basePath + (route === 'manager' ? '' : route + (id ? '/' + id : ''));
    if (path !== location.pathname + (location.search || '')) {
        pushLocationPath(path);
    }
    // パスが同じ場合でも直接表示する (pushState はイベントを発火しないため)
    applyPathView();
}

// 旧ハッシュ (#manager / #/radar など) を標準パスへ移行する。
// ページ内アンカー (#help-manager) はルートではないので触らない。
export function migrateLegacyHash() {
    const hash = String((window.location && window.location.hash) || '').replace(/^#\/?/, '');
    if (!hash) return false;
    const parts = hash.split('/');
    const route = parts[0];
    if (!ROUTE_VIEW[route]) return false;
    const id = parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : '';
    const { basePath } = parseLocationPath();
    const path = basePath + (route === 'manager' ? '' : route + (id ? '/' + id : ''));
    if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
        history.replaceState(null, '', path);
    } else if (typeof location !== 'undefined' && location) {
        try { location.pathname = path; location.hash = ''; } catch (error) { /* noop */ }
    }
    return true;
}

// ハッシュからビューを復元して表示する
// ==========================================================
// スクロール位置の復元 (ブラウザの戻る/進む)
// ----------------------------------------------------------
// 本アプリのスクロールは .content-area 等の内側要素で起きるため、
// ブラウザ標準のスクロール復元が効かない。ハッシュごとに位置を覚えて戻す。
// ==========================================================
const scrollPositions = new Map();   // パス -> スクロール位置
// モジュール読み込み時に評価されるため、ブラウザ/テストどちらでも安全な形で取る
let lastScrollKey = (window.location && (window.location.pathname || '/')) || '/';

/** 現在のビューのスクロール領域 (無ければ null)。 */
export function activeScrollContainer() {
    const view = document.querySelector('.view-section.active');
    if (!view) return null;
    const inner = view.querySelector('.content-area');
    if (inner) return inner;
    return view;
}

// スクロール位置は「切替直前」ではなく、スクロールのたびに現在のキーで保存する。
// (画面遷移は navigateView → switchView が先に走ることがあり、
//  切替時に取ると切替後の位置=0 を保存してしまうため)
let scrollSaveQueued = false;
let scrollRestoreToken = 0;
let scrollRestoring = false;
export function scheduleScrollSave(el) {
    // 復元中は再描画で一時的に 0 になることがあるため保存しない
    if (scrollSaveQueued || scrollRestoring) return;
    // 保存が遅れると、ビューが display:none になって scrollTop が 0 に戻った後の
    // 値を拾ってしまう。イベント時点の値とキーを控えてから書く。
    const key = lastScrollKey;
    const position = el.scrollTop;
    scrollSaveQueued = true;
    const save = () => {
        scrollSaveQueued = false;
        if (scrollRestoring) return;
        scrollPositions.set(key, position);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(save);
    else save();
}

document.addEventListener('scroll', (event) => {
    const el = event.target;
    if (!el || el.nodeType !== 1 || typeof el.scrollTop !== 'number') return;
    if (!el.closest || !el.closest('.view-section')) return;
    // ビューが display:none になると scrollTop が 0 に戻り、その 0 がスクロール
    // イベントとして飛んでくる。非表示の要素は保存しない。
    if (!el.getClientRects || el.getClientRects().length === 0) return;
    scheduleScrollSave(el);
}, true);

// 戻る/進むでビューを戻したあと、内容の読み込みを待って位置を復元する。
// 一覧は取得後に描き直されるため、スクロールがリセットされることがある。
// 目標位置に落ち着くまで短い間隔で数回だけ追従する。
export function applyScrollRestoration(key) {
    const target = scrollPositions.get(key) || 0;
    const token = ++scrollRestoreToken;
    scrollRestoring = true;
    let tries = 0;
    const attempt = () => {
        if (token !== scrollRestoreToken) return;   // 次の遷移が始まったら中断
        tries += 1;
        const el = activeScrollContainer();
        if (el) el.scrollTop = target;
        // 一覧の再描画でスクロールが戻るため、落ち着くまで追従する
        const settled = el && Math.abs(el.scrollTop - target) < 1;
        if (!settled && tries < 20 && typeof setTimeout === 'function') {
            setTimeout(attempt, 150);
            return;
        }
        scrollRestoring = false;
    };
    attempt();
}

export function applyPathView() {
    const { view, id, normalizedPath } = parseLocationPath();
    // /index.html やクエリ付きURLなどは標準パスへ正規化する
    // (トップ「/」は Manager ホームとしてURLをそのまま使う)。
    const currentUrl = location.pathname + (location.search || '');
    if (normalizedPath !== currentUrl) {
        if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
            history.replaceState(null, '', normalizedPath);
        } else if (typeof location !== 'undefined' && location) {
            try { location.pathname = normalizedPath; } catch (error) { /* noop */ }
        }
    }
    // 未ログイン時は初期ビュー (デモ) だけを表示する。
    // URLはそのまま残すので、ログイン成功後に applyPathView() で
    // 元のURL (/radar や /playlist/12 など) の画面へ復帰できる。
    if (!hasAccountSession() && view !== 'help' && view !== 'welcome') {
        showWelcomeView();
        lastScrollKey = location.pathname;
        return;
    }
    // 表示名は pendingDetail / pendingUserProfile が同じIDのときだけ使う
    // (renderPlaylistDetail / renderUserProfile 側で判定するため、ここでは消さない)
    if (view === 'playlist-detail' && id) {
        renderPlaylistDetail(parseInt(id, 10));
    } else if (view === 'user-profile' && id) {
        renderUserProfile(parseInt(id, 10));
    } else if (view === 'playlist-detail' || view === 'user-profile') {
        switchView('manager');   // ID の無い詳細URLはトップとして扱う
    } else {
        switchView(view);
    }
    // 切替えが済んでから現在のキーを更新し、その位置を復元する
    // (切替え前に更新すると、離れる側のスクロール位置を新しいキーへ保存してしまう)
    lastScrollKey = location.pathname;
    applyScrollRestoration(lastScrollKey);
}

// 旧名 (hashchange 時代) の互換。外部から呼ばれてもパス方式で動作する。
export const applyHashView = applyPathView;

export function switchView(viewName) {
    // ログイン専用: 低レベル呼び出し (コンソール等) でもアプリ画面を表示しない。
    // 通常の遷移は navigateView / applyPathView が先にガードしている。
    if (!hasAccountSession() && viewName !== 'welcome' && viewName !== 'help') {
        showWelcomeView();
        return;
    }
    // デモ画面を離れるときは、YouTubeの音が裏で流れ続けないように止める。
    if (viewName !== 'welcome') pauseWelcomeDemo();
    // 切り替える前に、表示中のビューのスクロール位置を控える。
    // (切替後は display:none になり scrollTop が 0 に戻るため、ここで取る必要がある)
    // 同じビューへの再適用 (二重呼び出し) では控えない。
    const currentActive = document.querySelector('.view-section.active');
    const nextActive = document.getElementById(`view-${viewName}`);
    if (currentActive && currentActive !== nextActive) {
        const outgoing = activeScrollContainer();
        if (outgoing) scrollPositions.set(lastScrollKey, outgoing.scrollTop);
    }

    document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.add('active');

    // Radar画面では動画プレイヤーを左サイドバー上に固定配置する
    document.body.classList.toggle('player-in-sidebar', viewName === 'radar');

    // ナビのアクティブ表示を一度すべて解除してから、対象だけ点灯する。
    // (プロフィール / ヘルプは .user-menu 側にあるため、nav 内だけを対象にすると
    //  一度点いた黄色が戻らなくなる)
    document.querySelectorAll('.top-nav button').forEach(btn => {
        btn.classList.remove('active');
        btn.removeAttribute?.('aria-current');
        btn.style.color = '';
    });

    const navBtn = document.getElementById(`nav-${viewName}`);
    if (navBtn) {
        navBtn.classList.add('active');
        navBtn.setAttribute?.('aria-current', 'page');
        navBtn.style.color = 'var(--accent-color)';
    }

    // 画面遷移したらモバイルメニューは必ず閉じる
    closeMobileMenu();
    // プロフィールの簡易ログは別画面へ移ったら閉じる (戻ったときに古い内容を見せない)
    if (viewName !== 'profile') closeProfilePanel();
    if (viewName !== 'manager') resetManagerSelection();

    if (viewName === 'manager') loadPlaylists().catch(err => showToast(err.message, 'error'));
    else if (viewName === 'radar') {
        if (vibeMapData.length) {
            drawRadarMap(vibeFiltered.length ? vibeFiltered : vibeMapData);
        }
        loadRadarData();
        // 保存済み (自分のブックマーク) の曲を✓表示にする。60秒キャッシュなので連続遷移でも重くならない。
        loadRadarSavedTracks();
    }
    else if (viewName === 'share') loadSharePlaylists();
    else if (viewName === 'profile') loadProfile();
}

export function currentUsername() {
    let username = '';
    try {
        username = (localStorage.getItem('tunedrop_username') || '').trim();
    } catch (_) {}
    if (!username) {
        try {
            const token = localStorage.getItem('tunedrop_token') || '';
            const payload = token.split('.')[1];
            if (payload) {
                const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
                const json = JSON.parse(decodeURIComponent(escape(atob(base64))));
                username = String(json.username || '').trim();
            }
        } catch (_) {}
    }
    return username;
}

export function isAdminUser() {
    return currentUsername().toLowerCase() === 'rarugu';
}

export function updateAdminUI() {
    const isAdmin = isAdminUser();
    const wrap = document.getElementById('radar-analyze-all-wrap');
    if (wrap) {
        wrap.style.display = isAdmin ? '' : 'none';
    }
    const btn = document.getElementById('btn-radar-analyze-all');
    if (btn) {
        btn.style.display = isAdmin ? '' : 'none';
    }
}

export function checkLoginStatus() {
    const token = localStorage.getItem('tunedrop_token');
    const username = localStorage.getItem('tunedrop_username');
    const loggedIn = Boolean(token && username);
    updateAdminUI();
    // 未ログイン時のデモ表示を CSS 側にも伝える (プレイヤー等を隠す)
    if (document.body && document.body.classList) {
        document.body.classList.toggle('is-guest', !loggedIn);
    }
    // 初期表示のちらつき防止用クラスは、判定できた時点で外す
    if (document.documentElement && document.documentElement.classList) {
        document.documentElement.classList.remove('is-guest-boot');
    }
    const guestBadge = document.getElementById('guest-badge');
    if (guestBadge) guestBadge.hidden = loggedIn;
    if (loggedIn) {
        // ログイン後はデモの音を止める (モーダルを閉じても裏で鳴り続けないように)
        pauseWelcomeDemo();
        // display は CSS 側 (inline-flex) に任せる。'inline-block' を直接入れると
        // アイコンとラベルの並び (flex) が崩れて高さが揃わなくなる。
        document.getElementById('nav-login').style.display = 'none';
        document.getElementById('nav-profile').style.display = '';
        document.getElementById('profile-name').innerText = username;
        document.getElementById('profile-avatar').innerText = username.charAt(0).toUpperCase();
        renderProfileLoginId(localStorage.getItem('tunedrop_login_id'));
    } else {
        document.getElementById('nav-login').style.display = '';
        document.getElementById('nav-profile').style.display = 'none';
        renderProfileLoginId('');
    }
}

// ログインセッションを破棄し、ヘッダー等を未ログイン表示へ戻す
export function clearSession() {
    localStorage.removeItem('tunedrop_token');
    localStorage.removeItem('tunedrop_username');
    localStorage.removeItem('tunedrop_login_id');
    updateAdminUI();
    // アカウントが変わると集計も変わるため、ダッシュボードのキャッシュを捨てる
    managerSummary = null;
    managerSummaryError = false;
    favoriteTrackSummary = null;
    favoriteTrackSummaryError = false;
    favoriteTrackSummaryRequest = null;
    profileFollowOverview = null;
    closeProfilePanel();
    checkLoginStatus();
}

// 画面に出るのは表示名 (display_name) なので、ログイン時に何を入力するかを
// プロフィールへ明示する (表示名でログインしようとして入れなくなるのを防ぐ)。
export function renderProfileLoginId(loginId) {
    const value = String(loginId || '').trim();
    const line = document.getElementById('profile-login-id');
    if (line) {
        line.textContent = value ? `ログインID: ${value}（ログインで使うID。表示名とは別です）` : '';
        line.hidden = !value;
    }
    const help = document.getElementById('profile-name-help');
    if (help) {
        help.textContent = value
            ? `3〜30文字。変更してもログインID（${value}）は変わりません。`
            : '3〜30文字。変更してもログインIDは変わりません。';
    }
}

// プロフィール画面を開いているときだけ再読み込みする (ログイン直後の反映用)
export function refreshProfileIfVisible() {
    const view = document.getElementById('view-profile');
    if (view && view.classList.contains('active')) loadProfile();
}

// プロフィール画面のログイン時 / 未ログイン時の表示を切り替える
export function setProfileVisibility(loggedIn) {
    document.getElementById('profile-header').hidden = !loggedIn;
    document.getElementById('profile-stats').hidden = !loggedIn;
    document.getElementById('profile-form').hidden = !loggedIn;
    document.getElementById('profile-guest-notice').hidden = loggedIn;
    if (!loggedIn) closeProfilePanel();
}

// 登録日をプロフィールカードのサブタイトルに表示する (created_at: YYYY-MM-DD HH:MM:SS)
export function renderProfileMeta(user) {
    const meta = document.getElementById('profile-meta');
    if (!meta) return;
    const created = String((user && user.created_at) || '').slice(0, 10).replace(/-/g, '/');
    meta.textContent = created ? `登録日 ${created}` : 'プロフィール';
}

export async function loadProfile() {
    const status = document.getElementById('profile-status');
    const input = document.getElementById('profile-username');
    const button = document.getElementById('profile-save');
    const loggedIn = Boolean(localStorage.getItem('tunedrop_token'));
    setProfileVisibility(loggedIn);
    if (!loggedIn) {
        // 未ログイン時は実データが無いため、ダミー表示ではなく初期ビュー (デモ) を出す
        status.textContent = '';
        showWelcomeView();
        return;
    }
    input.value = localStorage.getItem('tunedrop_username') || '';
    button.disabled = true;
    status.textContent = '読み込み中…';
    try {
        const response = await tunedropFetch('api.php?action=auth&endpoint=me');
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
            // トークン期限切れ: セッションを破棄して初期ビュー (デモ) へ戻す
            clearSession();
            setProfileVisibility(false);
            status.textContent = '';
            showWelcomeView();
            showLoginModal();
            return;
        }
        if (!response.ok || !data.user) throw new Error(data.error || 'プロフィールを取得できませんでした。');
        localStorage.setItem('tunedrop_username', data.user.username);
        if (data.user.login_id) localStorage.setItem('tunedrop_login_id', data.user.login_id);
        checkLoginStatus();
        input.value = data.user.username;
        renderProfileLoginId(data.user.login_id || localStorage.getItem('tunedrop_login_id'));
        renderProfileMeta(data.user);
        document.getElementById('profile-track-count').textContent = data.user.stats.bookmarks_count;
        document.getElementById('profile-list-count').textContent = data.user.stats.playlists_count;
        document.getElementById('profile-favorite-count').textContent = data.user.stats.favorites_count;
        document.getElementById('profile-following-count').textContent = '—';
        document.getElementById('profile-followers-count').textContent = '—';
        loadProfileFollowCounts();
        status.textContent = '';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
}

// ==========================================================
// プロフィールの統計カード → 簡易ログ / フォロー一覧
// ----------------------------------------------------------
// 保存曲・プレイリスト・お気に入り・フォロー中・フォロワーのカードを
// クリックすると、同じパネルの中身を切り替える (再クリックで閉じる)。
// ==========================================================
let activeProfilePanel = null;
let profilePanelRequest = 0;
let profileFollowOverview = null;
let profilePanelTracks = [];
let profilePanelPlaylists = [];
let currentUserProfileId = null;

const PROFILE_PANELS = {
    tracks: { title: '保存曲の簡易ログ', note: '最近保存した曲を新しい順に表示します（同じ曲は1件）。' },
    playlists: { title: 'プレイリストの簡易ログ', note: '最近作成したプレイリストを新しい順に表示します（未整理・公開用お気に入りを除く）。' },
    favorites: { title: 'お気に入りの簡易ログ', note: 'お気に入りにした曲とリストを表示します。' },
    following: { title: 'フォロー中のユーザー', note: 'あなたがフォローしているユーザーです。' },
    followers: { title: 'フォロワー', note: 'あなたをフォローしているユーザーです。' },
};

export function closeProfilePanel() {
    activeProfilePanel = null;
    profilePanelRequest += 1;
    const panel = document.getElementById('profile-panel');
    if (panel) panel.hidden = true;
    document.querySelectorAll('[data-profile-panel]').forEach(btn => {
        btn.classList.remove('is-active');
        btn.setAttribute('aria-expanded', 'false');
    });
}

export function selectProfilePanel(type) {
    const panel = document.getElementById('profile-panel');
    if (!panel || !PROFILE_PANELS[type]) return;
    if (activeProfilePanel === type) { closeProfilePanel(); return; }
    activeProfilePanel = type;
    document.querySelectorAll('[data-profile-panel]').forEach(btn => {
        const on = btn.dataset.profilePanel === type;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    document.getElementById('profile-panel-title').textContent = PROFILE_PANELS[type].title;
    document.getElementById('profile-panel-note').textContent = PROFILE_PANELS[type].note;
    panel.hidden = false;
    // スマホでカードの下にパネルが隠れる場合だけ、見える位置までスクロールする
    if (typeof panel.scrollIntoView === 'function') {
        panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    const body = document.getElementById('profile-panel-body');
    body.innerHTML = '<div class="activity-empty is-loading">読み込み中…</div>';
    const requestId = ++profilePanelRequest;
    loadProfilePanel(type).then(html => {
        if (requestId !== profilePanelRequest || activeProfilePanel !== type) return;
        body.innerHTML = html;
        bindProfilePanelActions(type);
    }).catch(error => {
        if (requestId !== profilePanelRequest) return;
        body.innerHTML = `<div class="activity-empty">${escapeHtml(error.message || '読み込みに失敗しました。')}</div>`;
    });
}

async function loadProfilePanel(type) {
    if (type === 'following' || type === 'followers') {
        const res = await tunedropFetch('api.php?action=get_follow_overview');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'フォロー一覧を取得できませんでした。');
        profileFollowOverview = data;
        applyFollowCounts(data.counts);
        return renderFollowList(data[type] || [], type);
    }
    const res = await tunedropFetch(`api.php?action=get_profile_activity&type=${type}&limit=20`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'ログを取得できませんでした。');
    if (type === 'tracks') {
        profilePanelTracks = data.tracks || [];
        return renderTrackLog(profilePanelTracks);
    }
    if (type === 'playlists') {
        profilePanelPlaylists = data.playlists || [];
        return renderPlaylistLog(profilePanelPlaylists);
    }
    profilePanelTracks = data.tracks || [];
    profilePanelPlaylists = data.playlists || [];
    return renderFavoriteLog(profilePanelTracks, profilePanelPlaylists);
}

async function loadProfileFollowCounts() {
    try {
        const res = await tunedropFetch('api.php?action=get_follow_overview&summary=1');
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (data.counts) {
            profileFollowOverview = data;
            applyFollowCounts(data.counts);
        }
    } catch (_) { /* フォロー件数は補助情報。失敗してもプロフィールは表示する */ }
}

function applyFollowCounts(counts) {
    if (!counts) return;
    const following = document.getElementById('profile-following-count');
    const followers = document.getElementById('profile-followers-count');
    if (following) following.textContent = Number(counts.following) || 0;
    if (followers) followers.textContent = Number(counts.followers) || 0;
}

// ----------------------------------------------------------
// 簡易ログの描画
// ----------------------------------------------------------
function activityCover(coverId, fallbackIcon) {
    if (coverId) {
        return `<img class="activity-thumb" src="https://img.youtube.com/vi/${encodeURIComponent(coverId)}/mqdefault.jpg" alt="" loading="lazy">`;
    }
    return `<span class="activity-thumb activity-thumb-empty material-symbols-rounded">${fallbackIcon}</span>`;
}

function renderTrackLog(tracks) {
    if (!tracks.length) return '<div class="activity-empty">まだ保存した曲がありません。</div>';
    return `<div class="activity-list">${tracks.map((track, index) => `
        <button class="activity-row" type="button" data-activity-track="${index}" title="${escapeHtml(track.title || '')} を再生">
            ${activityCover(track.youtube_id, 'music_note')}
            <span class="activity-main">
                <span class="activity-title">${escapeHtml(track.title || 'Unknown Title')}</span>
                <span class="activity-meta">${escapeHtml(track.channel || 'Unknown Artist')}${track.playlist_name ? ' ・ ' + escapeHtml(track.playlist_name) : ''}</span>
            </span>
            <span class="activity-time">${formatRelativeTime(track.added_at)}</span>
            <span class="material-symbols-rounded activity-play-icon">play_arrow</span>
        </button>`).join('')}</div>`;
}

function renderPlaylistLog(playlists) {
    if (!playlists.length) return '<div class="activity-empty">まだプレイリストがありません。</div>';
    return `<div class="activity-list">${playlists.map((playlist, index) => `
        <button class="activity-row" type="button" data-activity-playlist="${index}" title="${escapeHtml(playlist.name || '')} を開く">
            ${activityCover(playlist.cover_id, 'queue_music')}
            <span class="activity-main">
                <span class="activity-title">${escapeHtml(playlist.name || '無題のプレイリスト')}</span>
                <span class="activity-meta">${Number(playlist.track_count) || 0}曲 ・ ${escapeHtml(playlist.category || 'Other')} ・ ${Number(playlist.is_public) ? '公開' : '非公開'}</span>
            </span>
            <span class="activity-time">${formatRelativeTime(playlist.created_at)}</span>
            <span class="material-symbols-rounded activity-play-icon">chevron_right</span>
        </button>`).join('')}</div>`;
}

function renderFavoriteLog(tracks, playlists) {
    if (!tracks.length && !playlists.length) return '<div class="activity-empty">まだお気に入りがありません。</div>';
    let html = '';
    if (tracks.length) html += `<h4 class="activity-section-title">お気に入り曲</h4>${renderTrackLog(tracks)}`;
    if (playlists.length) html += `<h4 class="activity-section-title">お気に入りリスト</h4>${renderPlaylistLog(playlists)}`;
    return html;
}

function renderFollowList(users, kind) {
    if (!users.length) {
        return `<div class="activity-empty">${kind === 'following' ? 'まだ誰もフォローしていません。' : 'まだフォロワーがいません。'}</div>`;
    }
    return `<div class="activity-list">${users.map(user => `
        <div class="activity-row follow-row" data-follow-user="${Number(user.id)}" role="button" tabindex="0"
             title="${escapeHtml(user.name || 'User')} のプロフィールを開く">
            <span class="avatar-sm">${escapeHtml((user.name || 'U').slice(0, 1).toUpperCase())}</span>
            <span class="activity-main">
                <span class="activity-title">${escapeHtml(user.name || 'User')}</span>
                <span class="activity-meta">${user.followed_at ? formatRelativeTime(user.followed_at) + ' から' : ''}</span>
            </span>
            <button class="follow-action${Number(user.is_following) ? ' is-following' : ''}" type="button"
                    data-follow-toggle="${Number(user.id)}" data-following="${Number(user.is_following) ? '1' : '0'}">
                ${Number(user.is_following) ? 'フォロー中' : 'フォロー'}
            </button>
        </div>`).join('')}</div>`;
}

// パネル内の行クリック (再生 / プレイリストを開く / プロフィール / フォロー)
function bindProfilePanelActions(type) {
    const body = document.getElementById('profile-panel-body');
    if (!body) return;
    body.querySelectorAll('[data-activity-track]').forEach(el => {
        el.onclick = () => playTrackFromQueue(Number(el.dataset.activityTrack), profilePanelTracks);
    });
    body.querySelectorAll('[data-activity-playlist]').forEach(el => {
        const playlist = profilePanelPlaylists[Number(el.dataset.activityPlaylist)];
        if (playlist) el.onclick = () => openPlaylistDetail(playlist.id, playlist.name, playlist.cover_id || '');
    });
    if (type !== 'following' && type !== 'followers') return;
    const users = [...(profileFollowOverview?.following || []), ...(profileFollowOverview?.followers || [])];
    body.querySelectorAll('[data-follow-user]').forEach(el => {
        const userId = Number(el.dataset.followUser);
        const user = users.find(item => Number(item.id) === userId);
        el.onclick = (event) => {
            if (event.target.closest('[data-follow-toggle]')) return;
            openUserProfile(userId, user?.name || '');
        };
        el.onkeydown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                el.click();
            }
        };
    });
    body.querySelectorAll('[data-follow-toggle]').forEach(button => {
        button.onclick = async (event) => {
            event.stopPropagation();
            await toggleFollowButton(button);
        };
    });
}

// ----------------------------------------------------------
// フォロー / 解除
// ----------------------------------------------------------
async function requestFollow(userId, shouldFollow) {
    const response = await tunedropFetch(`api.php?action=${shouldFollow ? 'follow_user' : 'unfollow_user'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: Number(userId) }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
        showLoginModal();
        throw new Error(data.error || 'フォローにはログインが必要です。');
    }
    if (!response.ok || !data.success) throw new Error(data.error || 'フォローを更新できませんでした。');
    return data;
}

async function toggleFollowButton(button) {
    const userId = Number(button.dataset.followToggle);
    const following = button.dataset.following === '1';
    button.disabled = true;
    try {
        const data = await requestFollow(userId, !following);
        const nowFollowing = Boolean(data.is_following);
        button.dataset.following = nowFollowing ? '1' : '0';
        button.classList.toggle('is-following', nowFollowing);
        button.textContent = nowFollowing ? 'フォロー中' : 'フォロー';

        const followingCount = document.getElementById('profile-following-count');
        if (followingCount) followingCount.textContent = Number(data.following) || 0;
        if (profileFollowOverview) {
            profileFollowOverview.counts = {
                following: Number(data.following) || 0,
                followers: Number(profileFollowOverview.counts?.followers) || 0,
            };
            (profileFollowOverview[activeProfilePanel] || []).forEach(user => {
                if (Number(user.id) === userId) user.is_following = nowFollowing ? 1 : 0;
            });
        }
        // 「フォロー中」一覧から解除した行はその場で消す
        if (!nowFollowing && activeProfilePanel === 'following') {
            button.closest('.follow-row')?.remove();
        }
        showToast(nowFollowing ? 'フォローしました。' : 'フォローを解除しました。', 'info');
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

// 他ユーザーのプロフィールのフォローボタン
export async function toggleUserProfileFollow() {
    const button = document.getElementById('user-profile-follow');
    if (!button || button.disabled || !currentUserProfileId) return;
    const following = button.dataset.following === '1';
    button.disabled = true;
    try {
        const data = await requestFollow(currentUserProfileId, !following);
        applyUserProfileFollowState(Boolean(data.is_following));
        const followers = document.getElementById('user-profile-followers-count');
        if (followers) followers.textContent = Number(data.followers) || 0;
        const followingCount = document.getElementById('profile-following-count');
        if (followingCount) followingCount.textContent = Number(data.following) || 0;
        showToast(data.is_following ? 'フォローしました。' : 'フォローを解除しました。', 'info');
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

function applyUserProfileFollowState(following) {
    const button = document.getElementById('user-profile-follow');
    if (!button) return;
    button.dataset.following = following ? '1' : '0';
    button.classList.toggle('is-following', following);
    button.title = following ? 'フォローを解除' : 'フォローする';
    const icon = document.getElementById('user-profile-follow-icon');
    if (icon) icon.textContent = following ? 'check' : 'person_add';
    const label = document.getElementById('user-profile-follow-label');
    if (label) label.textContent = following ? 'フォロー中' : 'フォロー';
}

// ==========================================================
// 他ユーザーのプロフィール (Shareの作成者名から開く)
// ==========================================================
let pendingUserProfile = { id: null, name: '' };

export function openUserProfile(userId, name) {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) return;
    pendingUserProfile = { id, name: name || '' };
    // クリック直後に前のユーザー名が見えないよう、名前だけ先に反映しておく
    if (name) {
        const nameEl = document.getElementById('user-profile-name');
        const avatarEl = document.getElementById('user-profile-avatar');
        if (nameEl) nameEl.textContent = name;
        if (avatarEl) avatarEl.textContent = name.slice(0, 1).toUpperCase();
    }
    navigateView('user-profile', id);
}

// 戻る: 直前の画面へ (履歴が無ければ Share へ)
export function backFromUserProfile() {
    if (history.length > 1) history.back();
    else navigateView('share');
}

/** 公開リストのカードを組み立てる (Share画面と同じ見た目)。 */
export function renderUserProfileCards(playlists) {
    const grid = document.getElementById('user-profile-grid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!playlists || playlists.length === 0) {
        grid.innerHTML = '<div class="share-empty"><span class="material-symbols-rounded share-empty-icon">public</span><p>まだ公開されたプレイリストがありません。</p></div>';
        return;
    }
    playlists.forEach(list => {
        const card = document.createElement('div');
        card.className = 'card share-card';
        card.onclick = () => openPlaylistDetail(list.id, list.name, list.cover_id);
        const coverHtml = list.cover_id
            ? `<img src="https://img.youtube.com/vi/${list.cover_id}/hqdefault.jpg" alt="cover" loading="lazy">`
            : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center;"><span class="material-symbols-rounded" style="font-size:40px; color:var(--text-sub);">music_note</span></div>`;
        const catBadge = list.category ? `<span class="cat-badge share-cat-badge">${escapeHtml(list.category)}</span>` : '';
        card.innerHTML = `
            <div class="card-img-wrapper">${coverHtml}<div class="card-hover-play"></div>${catBadge}</div>
            <div class="info">
                <div class="title">${escapeHtml(list.name || '')}</div>
                <div class="artist"><span class="material-symbols-rounded share-author-icon">music_note</span><span class="share-author-name">${shareTrackCount(list)}曲</span></div>
                <div class="share-card-stats"><span class="material-symbols-rounded share-meta-icon">favorite</span>${shareFavCount(list)}</div>
            </div>`;
        grid.appendChild(card);
    });
}

/** 他ユーザーのプロフィールを読み込んで表示する。 */
export async function renderUserProfile(userId) {
    switchView('user-profile');
    const id = Number(userId);
    const nameEl = document.getElementById('user-profile-name');
    const metaEl = document.getElementById('user-profile-meta');
    const avatarEl = document.getElementById('user-profile-avatar');
    const grid = document.getElementById('user-profile-grid');
    const titleEl = document.getElementById('user-profile-lists-title');
    // 直前に見ていた別ユーザーの名前を持ち越さない (IDが一致するときだけ使う)
    const pendingName = pendingUserProfile.id === id ? pendingUserProfile.name : '';
    if (pendingName && nameEl) nameEl.textContent = pendingName;
    if (metaEl) metaEl.textContent = '読み込み中…';
    if (avatarEl && pendingName) avatarEl.textContent = pendingName.slice(0, 1).toUpperCase();
    if (grid) grid.innerHTML = '<div class="share-loading"><span class="share-spinner"></span>プロフィールを読み込んでいます…</div>';
    for (const elId of ['user-profile-public-count', 'user-profile-track-count', 'user-profile-favorite-count',
                        'user-profile-following-count', 'user-profile-followers-count']) {
        document.getElementById(elId).textContent = '—';
    }
    const followButton = document.getElementById('user-profile-follow');
    if (followButton) {
        followButton.hidden = true;
        followButton.disabled = false;
        followButton.dataset.following = '0';
        followButton.classList.remove('is-following');
    }
    currentUserProfileId = id;
    try {
        const res = await tunedropFetch(`api.php?action=get_user_profile&user_id=${id}`);
        const data = await res.json();
        if (!res.ok || !data.user) throw new Error(data.error || 'プロフィールを取得できませんでした。');
        const user = data.user;
        const name = user.name || '';
        if (nameEl) nameEl.textContent = name;
        if (avatarEl) avatarEl.textContent = name.slice(0, 1).toUpperCase() || 'U';
        if (metaEl) {
            const joined = user.created_at ? String(user.created_at).slice(0, 10) : '';
            metaEl.textContent = joined ? `${joined} から利用` : 'Tune drop ユーザー';
        }
        const stats = user.stats || {};
        document.getElementById('user-profile-public-count').textContent = stats.public_playlists ?? 0;
        document.getElementById('user-profile-track-count').textContent = stats.public_tracks ?? 0;
        document.getElementById('user-profile-favorite-count').textContent = stats.favorites ?? 0;
        document.getElementById('user-profile-following-count').textContent = stats.following ?? 0;
        document.getElementById('user-profile-followers-count').textContent = stats.followers ?? 0;
        if (followButton) {
            followButton.hidden = Boolean(user.is_self || user.is_guest);
            applyUserProfileFollowState(Boolean(user.is_following));
        }
        if (titleEl) titleEl.textContent = `${name} がShareで公開中のプレイリスト`;
        renderUserProfileCards(data.playlists);
    } catch (error) {
        if (metaEl) metaEl.textContent = error.message;
        if (followButton) followButton.hidden = true;
        if (grid) grid.innerHTML = '<div class="share-empty"><p>プロフィールを読み込めませんでした。</p></div>';
    }
}

export async function saveProfile(event) {
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
            showWelcomeView();
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

// ==========================================================
// ログイン / 新規登録モーダル
// ----------------------------------------------------------
// 「ログイン」と「新規登録」をタブで切り替え、入力エラーは
// モーダル内にその場で表示する (トーストだけだと見落としやすい)。
// パスワードの表示切り替え・フォーカス移動・最後に使ったIDの
// 復元もここで扱う。
// ==========================================================
let authMode = 'login';
let authReturnFocus = null;
const AUTH_MODE_CONFIG = {
    login: {
        hint: '登録済みのアカウントでログインします。',
        idHint: 'ログインIDは登録時に指定したメールアドレスなどです。プロフィールの「表示名」とは別です。',
        passwordAutocomplete: 'current-password',
    },
    register: {
        hint: '初めての方は、ログインIDとパスワードを決めて登録します。',
        idHint: 'ログインIDは3〜30文字、パスワードは4文字以上。表示名は登録後にプロフィールで変更できます。',
        passwordAutocomplete: 'new-password',
    },
};

function authElement(id) {
    return typeof document !== 'undefined' && typeof document.getElementById === 'function'
        ? document.getElementById(id)
        : null;
}

export function clearAuthError() {
    const box = authElement('auth-error');
    if (box) {
        box.textContent = '';
        box.hidden = true;
    }
    for (const id of ['auth-username', 'auth-password']) {
        const input = authElement(id);
        if (input && input.removeAttribute) input.removeAttribute('aria-invalid');
    }
}

function showAuthError(message, fieldId = '') {
    const text = String(message || '').trim();
    if (!text) return;
    const box = authElement('auth-error');
    if (box) {
        box.textContent = text;
        box.hidden = false;
    }
    if (fieldId) {
        const input = authElement(fieldId);
        if (input && input.setAttribute) input.setAttribute('aria-invalid', 'true');
    }
    // モーダルが閉じている環境では、従来どおりトーストでも知らせる
    if (!isModalVisible('login-modal')) showToast(text, 'error');
}

function focusAuthField(fieldId) {
    const input = authElement(fieldId);
    if (input && typeof input.focus === 'function') input.focus();
}

// 次回のログインで入力し直さなくて済むよう、最後に使ったログインIDだけを保存する
// (パスワードは保存しない)。ログアウトしても残す。
function rememberLoginId(value) {
    const id = String(value || '').trim();
    if (!id) return;
    try {
        localStorage.setItem('tunedrop_last_login_id', id);
    } catch (_) { /* localStorage が使えない環境では何もしない */ }
}

export function setAuthMode(mode, options = {}) {
    authMode = mode === 'register' ? 'register' : 'login';
    const config = AUTH_MODE_CONFIG[authMode];
    const loginTab = authElement('auth-mode-login');
    const registerTab = authElement('auth-mode-register');
    for (const [tab, active] of [[loginTab, authMode === 'login'], [registerTab, authMode === 'register']]) {
        if (!tab) continue;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-pressed', String(active));
    }
    const loginButton = authElement('login-submit');
    const registerButton = authElement('register-submit');
    if (loginButton) loginButton.hidden = authMode !== 'login';
    if (registerButton) registerButton.hidden = authMode !== 'register';
    const password = authElement('auth-password');
    if (password && password.setAttribute) {
        password.setAttribute('autocomplete', config.passwordAutocomplete);
    }
    const hint = authElement('login-mode-hint');
    if (hint) {
        hint.textContent = config.hint;
        hint.hidden = false;
    }
    const idHint = authElement('login-id-hint');
    if (idHint) idHint.textContent = config.idHint;
    clearAuthError();
    setAuthBusy(authRequestInFlight, authMode);
    // タブを切り替えたら、そのまま入力できるよう先頭欄へフォーカスする。
    // (スマホではキーボードが画面を覆うため自動フォーカスしない)
    if (!options.keepFocus && !authRequestInFlight && !isCoarsePointer()) {
        focusAuthField('auth-username');
    }
}

export function isCoarsePointer() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;
}

export function toggleAuthPassword() {
    const input = authElement('auth-password');
    const button = authElement('auth-password-toggle');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    if (button) {
        button.textContent = show ? '隠す' : '表示';
        button.setAttribute('aria-pressed', String(show));
        button.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    }
    focusAuthField('auth-password');
}

// モーダル内で Tab を押したときに、背景のボタンへ抜けないようにする
export function trapAuthModalFocus(event) {
    if (!event || event.key !== 'Tab' || !isModalVisible('login-modal')) return;
    // メンテナンス画面が出ているときは、そちらの再試行ボタンを操作できるようにする
    if (typeof document !== 'undefined' && document.body
        && document.body.classList && document.body.classList.contains('maintenance-open')) return;
    const modal = authElement('login-modal');
    const dialog = modal && typeof modal.querySelector === 'function'
        ? (modal.querySelector('.login-dialog') || modal)
        : modal;
    if (!dialog || typeof dialog.querySelectorAll !== 'function') return;
    const focusables = [...dialog.querySelectorAll(
        'button:not([disabled]):not([hidden]), input:not([disabled]):not([type="hidden"]), a[href], iframe, ' +
        '[role="button"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])'
    )].filter(el => !el.hidden && (!el.getClientRects || el.getClientRects().length > 0));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    // フォーカスがモーダルの外にある (背景クリック直後など) 場合は中へ戻す
    if (!active || !dialog.contains || !dialog.contains(active)) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof first.focus === 'function') first.focus();
        return;
    }
    // Googleボタンの内部要素はフォーカス可能でも一覧に載らないことがある。
    // 最後の操作要素なので、次のTabはモーダル先頭へ戻す。
    const inGoogle = active && typeof active.closest === 'function' && active.closest('#g_id_signin');
    if (!event.shiftKey && inGoogle) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof first.focus === 'function') first.focus();
        return;
    }
    if (event.shiftKey && active === first) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof last.focus === 'function') last.focus();
    } else if (!event.shiftKey && active === last) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof first.focus === 'function') first.focus();
    }
}

// フォームの submit は現在のタブ (ログイン / 新規登録) に応じて振り分ける。
// これにより、新規登録タブで Enter を押してもログイン扱いにならない。
export function submitAuth(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (authRequestInFlight) return;
    return authMode === 'register' ? registerWithEmail(event) : loginWithEmail(event);
}

export function showLoginModal(mode = '') {
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく
    const modal = authElement('login-modal');
    const wasOpen = isModalVisible('login-modal');
    // 閉じていたら、開く前のフォーカス位置を覚えておく (閉じたときに戻す)
    if (!wasOpen && typeof document !== 'undefined') authReturnFocus = document.activeElement;
    if (modal) {
        modal.style.display = 'flex';
        const dialog = typeof modal.querySelector === 'function'
            ? (modal.querySelector('.login-dialog') || modal)
            : modal;
        if (dialog) {
            if (typeof dialog.scrollTo === 'function') dialog.scrollTo({ top: 0 });
            else dialog.scrollTop = 0;
        }
    }
    // 前回のエラーは持ち越さない
    clearAuthError();
    // 最後に使ったログインIDを復元する (毎回入力し直さない)
    const username = authElement('auth-username');
    if (username && !String(username.value || '').trim()) {
        let remembered = '';
        try {
            remembered = localStorage.getItem('tunedrop_last_login_id') || '';
        } catch (_) { /* localStorage が使えない環境では何もしない */ }
        if (remembered) username.value = remembered;
    }
    setAuthMode(mode === 'register' ? 'register' : 'login');
    if (!authRequestInFlight) setAuthBusy(false, authMode);
    initGoogleAuth();
    // スマホでは自動フォーカスでキーボードが入力欄を隠すため、PCだけフォーカスする
    if (!isCoarsePointer()) focusAuthField('auth-username');
}

export function closeLoginModal() {
    const modal = authElement('login-modal');
    if (modal) modal.style.display = 'none';
    // パスワードは閉じるたびに破棄する (共有端末での見落とし対策)
    const password = authElement('auth-password');
    if (password) {
        password.value = '';
        password.type = 'password';
    }
    const toggle = authElement('auth-password-toggle');
    if (toggle) {
        toggle.textContent = '表示';
        toggle.setAttribute('aria-pressed', 'false');
        toggle.setAttribute('aria-label', 'パスワードを表示');
    }
    clearAuthError();
    const hint = authElement('login-mode-hint');
    if (hint) {
        hint.textContent = '';
        hint.hidden = true;
    }
    // ログイン成功時は画面が切り替わるので、元の要素へは戻さない
    const target = authReturnFocus;
    authReturnFocus = null;
    if (!hasAccountSession() && target
        && (typeof document.contains !== 'function' || document.contains(target))
        && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
    }
}

// ログイン成功後の共通処理。
// 未ログインのまま開こうとした画面 (postLoginView) があればそこへ、
// 無ければ現在のURLの画面へ復帰する (デモを閉じてアプリを表示する)。
function finishAuth(message, nextView = '') {
    closeLoginModal();
    checkLoginStatus();
    showToast(message);
    if (nextView) {
        postLoginView = null;
        navigateView(nextView);
        return;
    }
    const pending = postLoginView;
    postLoginView = null;
    if (pending) navigateView(pending.view, pending.id || undefined);
    else applyPathView();
}

// ログイン/新規登録の二重送信を防ぐ。処理中は両方のボタンを止めて文言を変える。
let authRequestInFlight = false;
function setAuthBusy(busy, mode = authMode) {
    const activeMode = mode === 'register' ? 'register' : 'login';
    for (const [button, buttonMode] of [
        [authElement('login-submit'), 'login'],
        [authElement('register-submit'), 'register'],
    ]) {
        if (!button) continue;
        button.disabled = busy;
        button.hidden = authMode !== buttonMode;
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
        const working = busy && activeMode === buttonMode;
        button.textContent = buttonMode === 'register'
            ? (working ? '登録中…' : '新規登録')
            : (working ? 'ログイン中…' : 'ログイン');
    }
    // 送信中にタブを切り替えると、どちらの結果か分からなくなるため止める
    for (const tab of [authElement('auth-mode-login'), authElement('auth-mode-register')]) {
        if (tab) tab.disabled = busy;
    }
}

// ログイン後にユーザー固有のプレイリストを再取得して反映する
// (アカウント切り替えでゲストの一覧が残らないようにホームへ戻して再読込する)
export function reloadPlaylistsAfterAuth() {
    currentPlaylistId = 'home';
    loadPlaylists();
}

export async function loginWithEmail(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (authRequestInFlight) return;
    const usernameInput = authElement('auth-username');
    const passwordInput = authElement('auth-password');
    const username = String((usernameInput && usernameInput.value) || '').trim();
    const password = String((passwordInput && passwordInput.value) || '').trim();
    clearAuthError();
    if (!username || !password) {
        showAuthError(
            'ログインIDとパスワードを入力してください。',
            !username ? 'auth-username' : 'auth-password'
        );
        focusAuthField(!username ? 'auth-username' : 'auth-password');
        return;
    }
    authRequestInFlight = true;
    setAuthBusy(true, 'login');
    try {
        const res = await tunedropFetch('api.php?action=auth&endpoint=login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));
        if (data.success && data.user) {
            localStorage.setItem('tunedrop_token', data.token);
            localStorage.setItem('tunedrop_username', data.user.username);
            localStorage.setItem('tunedrop_login_id', data.user.login_id || username);
            rememberLoginId(data.user.login_id || username);
            finishAuth('ログインしました。');
        } else {
            showAuthError(data.error || 'ログインに失敗しました。');
            focusAuthField('auth-password');
            if (passwordInput && typeof passwordInput.select === 'function') passwordInput.select();
        }
    } catch (err) {
        showAuthError('認証サーバーに接続できません。時間をおいてお試しください。');
    } finally {
        authRequestInFlight = false;
        setAuthBusy(false, 'login');
    }
}

export async function registerWithEmail(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (authRequestInFlight) return;
    const usernameInput = authElement('auth-username');
    const passwordInput = authElement('auth-password');
    const username = String((usernameInput && usernameInput.value) || '').trim();
    const password = String((passwordInput && passwordInput.value) || '').trim();
    clearAuthError();
    if (!username || !password) {
        showAuthError(
            'ログインIDとパスワードを入力してください。',
            !username ? 'auth-username' : 'auth-password'
        );
        focusAuthField(!username ? 'auth-username' : 'auth-password');
        return;
    }
    // サーバーへ送る前に同じ条件で確認し、往復の待ち時間を減らす
    if (username.length < 3 || username.length > 30) {
        showAuthError('ログインIDは3〜30文字で指定してください。', 'auth-username');
        focusAuthField('auth-username');
        return;
    }
    if (password.length < 4) {
        showAuthError('パスワードは4文字以上で指定してください。', 'auth-password');
        focusAuthField('auth-password');
        return;
    }
    authRequestInFlight = true;
    setAuthBusy(true, 'register');
    try {
        const res = await tunedropFetch('api.php?action=auth&endpoint=register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => ({}));
        if (data.success && data.user) {
            localStorage.setItem('tunedrop_token', data.token);
            localStorage.setItem('tunedrop_username', data.user.username);
            rememberLoginId(data.user.login_id || username);
            finishAuth('アカウントを作成しました。', 'profile');
        } else {
            showAuthError(data.error || '登録に失敗しました。');
            focusAuthField('auth-username');
            if (usernameInput && typeof usernameInput.select === 'function') usernameInput.select();
        }
    } catch (err) {
        showAuthError('認証サーバーに接続できません。時間をおいてお試しください。');
    } finally {
        authRequestInFlight = false;
        setAuthBusy(false, 'register');
    }
}

// ==========================================================
// Google ログイン (Google Identity Services)
// ==========================================================
let googleAuthInitialized = false;

export function googleClientId() {
    return (window.TUNEDROP_CONFIG && window.TUNEDROP_CONFIG.googleClientId) || '';
}

// OAuth 2.0 クライアントIDの形式チェック (APIキー等の誤設定を検知する)
export function isValidGoogleClientId(cid) {
    return /^[0-9a-z][0-9a-z-]*\.apps\.googleusercontent\.com$/i.test(String(cid || '').trim());
}

// ログインモーダル内の案内文を表示する
export function showGoogleAuthHint(message, isError) {
    const hint = document.getElementById('google-origin-hint');
    if (!hint) return;
    hint.textContent = message;
    hint.style.color = isError ? '#ff8a80' : 'var(--text-sub)';
    hint.style.display = 'block';
}

export function initGoogleAuth() {
    const cid = googleClientId();
    const origin = window.location.origin;
    // Googleボタンと区切り線は、実際に表示できる状態になるまで隠す。
    // (クライアントID未設定なのに区切り線だけ残る/読み込み中に空の枠が見えるのを防ぐ)
    const setGoogleAuthVisible = visible => {
        const box = document.getElementById('g_id_signin');
        if (box) box.style.display = visible ? 'flex' : 'none';
        const divider = document.getElementById('login-divider');
        if (divider) divider.style.display = visible ? '' : 'none';
    };
    if (!cid) {
        // クライアントID未設定なら枠を非表示
        setGoogleAuthVisible(false);
        return;
    }
    if (!isValidGoogleClientId(cid)) {
        // APIキー (AQ.やAIzaで始まる値) が誤って設定されているケース:
        // Googleボタンを描画せず、正しい設定方法を案内する
        setGoogleAuthVisible(true);
        const box = document.getElementById('g_id_signin');
        if (box) {
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
    if (!(window.google && google.accounts && google.accounts.id)) {
        setGoogleAuthVisible(false);
        return;
    }
    if (googleAuthInitialized) {
        setGoogleAuthVisible(true);
        return;
    }

    googleAuthInitialized = true;
    google.accounts.id.initialize({
        client_id: cid,
        callback: handleGoogleCredential,
        auto_select: false,
        cancel_on_tap_outside: false,
    });

    setGoogleAuthVisible(true);
    const btnBox = document.getElementById('g_id_signin');
    if (btnBox) {
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
    // 「no registered origin」対策の案内は、開発中 (localhost) だけ表示する。
    // 本番の利用者には技術的な説明を見せず、Googleボタンだけを出す。
    const localHost = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(String(window.location.hostname || ''));
    if (localHost) {
        showGoogleAuthHint(
            'Googleログインができない (no registered origin) 場合は、Google Cloud Console > 認証情報 > OAuthクライアント の「承認済み JavaScript 生成元」に「' + origin + '」を登録してください。'
        );
    }
}

export async function handleGoogleCredential(response) {
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
            localStorage.setItem('tunedrop_login_id', (data.user && data.user.login_id) || '');
            rememberLoginId((data.user && data.user.login_id) || '');
            finishAuth('Googleログインしました。');
        } else {
            showToast(data.error || 'Googleログインに失敗しました。', 'error');
        }
    } catch (err) {
        showToast('認証サーバーに接続できません。', 'error');
        console.error(err);
    }
}

export function logout() {
    clearSession();
    setProfileVisibility(false);
    postLoginView = null;
    showWelcomeView();
    // ログイン中に開いていたURLが残らないよう、トップへ戻す
    const { basePath } = parseLocationPath();
    if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
        history.replaceState(null, '', basePath);
    }
    showToast('ログアウトしました。', 'info');
}

export async function loadPlaylists() {
    // 未ログイン (デモ表示) ではAPIを呼ばない
    if (!hasAccountSession()) return;
    const response = await tunedropFetch('api.php?action=get_playlists');
    // 未ログイン (401) の場合は空配列で安全に描画する (アカウントごとのデータ分離)
    allPlaylists = response.ok ? await response.json() : [];
    // お気に入り曲の集計は曲の追加・お気に入り変更で変わるため、次に開いたときに取り直す
    favoriteTrackSummary = null;
    favoriteTrackSummaryError = false;
    favoriteTrackSummaryRequest = null;
    filterManagerPlaylists();
    // ダッシュボードの集計は Manager ホームが DOM にあるときだけ取得する
    // (他ビューの読み込みで無駄なリクエストを増やさない)。描画は並行して進める。
    if (document.getElementById('dash-stats')) loadManagerSummary();
}

// ==========================================================
// 検索サジェスト (リスト名・曲名・アーティスト名など)
// ----------------------------------------------------------
// 各検索欄の下に、入力中の文字に一致する候補をドロップダウン表示する。
// 候補はその画面がすでに読み込んでいるデータから作るため、入力のたびに
// API を呼び出すことはしない。
//   - ↑ / ↓ : 候補を選択
//   - Enter : 選択中の候補を決定 (未選択なら従来どおり先頭を再生/クリア)
//   - Esc   : 候補を閉じる (検索欄のクリアは従来どおり各画面の処理に任せる)
// ==========================================================
const SEARCH_SUGGEST_LIMIT = 8;

function suggestionText(value) {
    return String(value == null ? '' : value).trim();
}

function suggestionKey(value) {
    return suggestionText(value).toLowerCase();
}

// 同じ名前の候補 (曲名とアーティスト名が同じ等) は1つにまとめる
function uniqueSuggestionItems(items) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const key = suggestionKey(item.value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

// 前方一致を先に、次に部分一致。同順位は日本語の名前順で並べる。
function rankSuggestionItems(items, query) {
    const q = suggestionKey(query);
    const rank = (item) => {
        const label = suggestionKey(item.label);
        if (label === q) return 0;
        if (label.startsWith(q)) return 1;
        return 2;
    };
    return items
        .map((item, index) => ({ item, index, rank: rank(item) }))
        .sort((a, b) => a.rank - b.rank
            || String(a.item.label).localeCompare(String(b.item.label), 'ja')
            || a.index - b.index)
        .map(entry => entry.item);
}

function matchSuggestionItems(items, query) {
    const q = suggestionKey(query);
    if (!q) return [];
    const matched = uniqueSuggestionItems(items).filter(item => suggestionKey(item.label).includes(q));
    return rankSuggestionItems(matched, query).slice(0, SEARCH_SUGGEST_LIMIT);
}

function playlistSuggestionItems(playlists, metaLabel) {
    return (playlists || []).map(list => ({
        value: suggestionText(list?.name),
        label: suggestionText(list?.name),
        meta: suggestionText(list?.category) || metaLabel,
        icon: 'queue_music'
    })).filter(item => item.value);
}

function trackSuggestionItems(tracks) {
    const items = [];
    for (const track of tracks || []) {
        const title = suggestionText(track?.title);
        if (title) {
            items.push({
                value: title,
                label: title,
                meta: suggestionText(track?.channel),
                icon: 'music_note'
            });
        }
        const artist = suggestionText(track?.channel || track?.author);
        if (artist) {
            items.push({
                value: artist,
                label: artist,
                meta: 'アーティスト',
                icon: 'person'
            });
        }
    }
    return items;
}

function shareSuggestionItems(playlists) {
    const items = [];
    for (const list of playlists || []) {
        const name = suggestionText(list?.name);
        if (name) {
            items.push({ value: name, label: name, meta: 'プレイリスト', icon: 'queue_music' });
        }
        const author = suggestionText(list?.author || list?.author_name || list?.username);
        if (author) {
            items.push({ value: author, label: author, meta: 'ユーザー', icon: 'person' });
        }
    }
    return items;
}

// 1つの検索欄にサジェストのドロップダウンを取り付ける。
function attachSearchSuggestions(input, options) {
    if (!input || typeof document === 'undefined') return null;
    const wrapper = input.closest?.('.search-clear-wrap, .radar-search-wrap, .share-search-wrap')
        || input.parentElement;
    if (!wrapper) return null;

    const listId = `${input.id || 'search'}-suggestions`;
    const list = document.createElement('div');
    list.className = 'search-suggest';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', options.ariaLabel || '検索候補');
    wrapper.appendChild(list);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-expanded', 'false');
    if (!input.getAttribute('autocomplete')) input.setAttribute('autocomplete', 'off');

    let items = [];
    let activeIndex = -1;
    let suppressFocusRefresh = false;

    const isOpen = () => list.classList.contains('is-open');

    const close = () => {
        if (!isOpen()) return;
        list.classList.remove('is-open');
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        activeIndex = -1;
    };

    const setActive = (index) => {
        const option = list.children[index];
        if (!option) return;
        activeIndex = index;
        Array.from(list.children).forEach((child, childIndex) => {
            const selected = childIndex === index;
            child.classList.toggle('is-active', selected);
            child.setAttribute('aria-selected', String(selected));
        });
        input.setAttribute('aria-activedescendant', option.id);
        // キーボードで候補を移動したとき、長い一覧でも選択中が見えるようにする
        option.scrollIntoView?.({ block: 'nearest' });
    };

    const choose = (index) => {
        const item = items[index];
        if (!item) return;
        input.value = item.value;
        close();
        if (typeof options.onSelect === 'function') options.onSelect(item);
        // 選択直後の focus で候補を開き直さない (タッチ操作で blur してから
        // 選択した場合も、入力欄へ戻すだけで閉じたままにする)
        suppressFocusRefresh = true;
        input.focus?.();
        suppressFocusRefresh = false;
    };

    const render = () => {
        list.innerHTML = '';
        if (!items.length) {
            close();
            return;
        }
        items.forEach((item, index) => {
            const option = document.createElement('div');
            option.className = 'search-suggest-item';
            option.id = `${listId}-option-${index}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');

            const icon = document.createElement('span');
            icon.className = 'material-symbols-rounded search-suggest-icon';
            icon.textContent = item.icon || 'search';
            option.appendChild(icon);

            const label = document.createElement('span');
            label.className = 'search-suggest-label';
            label.textContent = item.label;
            option.appendChild(label);

            if (item.meta) {
                const meta = document.createElement('span');
                meta.className = 'search-suggest-meta';
                meta.textContent = item.meta;
                option.appendChild(meta);
            }

            // blur で閉じる前に選択できるよう、mousedown の既定動作を止める
            option.addEventListener('mousedown', (event) => {
                event.preventDefault();
                choose(index);
            });
            list.appendChild(option);
        });
        activeIndex = -1;
        list.classList.add('is-open');
        input.setAttribute('aria-expanded', 'true');
        input.removeAttribute('aria-activedescendant');
    };

    const refresh = () => {
        const query = suggestionText(input.value);
        items = matchSuggestionItems(options.getItems?.() || [], query);
        render();
    };

    // 日本語入力の変換中は候補を更新せず、確定後 (compositionend) にまとめて更新する
    input.addEventListener('input', (event) => {
        if (!event.isComposing) refresh();
    });
    input.addEventListener('compositionend', refresh);
    input.addEventListener('focus', () => {
        if (suppressFocusRefresh) return;
        if (suggestionText(input.value)) refresh();
        else close();
    });
    input.addEventListener('blur', () => setTimeout(close, 100));

    // 既存のインライン Enter 処理 (先頭を再生・検索実行) より先に判定するため capture で受ける。
    input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!items.length) refresh();
            if (!items.length) return;
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            const next = activeIndex < 0
                ? (delta > 0 ? 0 : items.length - 1)
                : (activeIndex + delta + items.length) % items.length;
            setActive(next);
            return;
        }
        if (event.key === 'Enter') {
            if (!isOpen() || activeIndex < 0) return;
            event.preventDefault();
            // インラインの onkeydown (先頭の曲を再生 / リストを開く) を止める
            event.stopImmediatePropagation?.();
            choose(activeIndex);
            return;
        }
        if (event.key === 'Escape' || event.key === 'Tab') close();
    }, true);

    // 検索欄の外をクリックしたら閉じる (フォーカスが移らない要素でも確実に閉じる)
    document.addEventListener('pointerdown', (event) => {
        if (!wrapper.contains(event.target)) close();
    });

    return { refresh, close };
}

// 各検索欄へサジェストを設定する (DOMContentLoaded で1回だけ呼ぶ)。
export function setupSearchSuggestions() {
    attachSearchSuggestions(document.getElementById('manager-search'), {
        ariaLabel: 'リスト名の検索候補',
        getItems: () => {
            // カテゴリ絞り込み中は、そのカテゴリのリストだけを候補にする
            const category = document.getElementById('manager-category')?.value || '';
            const lists = (allPlaylists || []).filter(list => !category || list.category === category);
            return playlistSuggestionItems(lists, 'リスト');
        },
        onSelect: () => filterManagerPlaylists()
    });
    attachSearchSuggestions(document.getElementById('track-search'), {
        ariaLabel: '曲名・アーティスト名の検索候補',
        getItems: () => trackSuggestionItems(currentTracks),
        onSelect: () => filterTracks()
    });
    attachSearchSuggestions(document.getElementById('radar-title-search'), {
        ariaLabel: '曲名・アーティスト名の検索候補',
        getItems: () => trackSuggestionItems(vibeMapData),
        onSelect: () => applyRadarFilter(true)
    });
    attachSearchSuggestions(document.getElementById('share-search'), {
        ariaLabel: 'プレイリスト名・ユーザー名の検索候補',
        getItems: () => {
            const category = document.getElementById('share-category')?.value || '';
            const lists = (sharePlaylists || []).filter(list => !category || (list.category || 'Other') === category);
            return shareSuggestionItems(lists);
        },
        onSelect: () => renderSharePlaylists()
    });
}

export function syncManagerSearchClear() {
    const input = document.getElementById('manager-search');
    const button = document.getElementById('btn-manager-search-clear');
    if (button) button.classList.toggle('is-visible', Boolean(input && input.value));
}

export function clearManagerSearch() {
    const input = document.getElementById('manager-search');
    if (!input) return;
    input.value = '';
    filterManagerPlaylists();
    if (typeof input.focus === 'function') input.focus();
}

export function filterManagerPlaylists() {
    syncManagerSearchClear();
    const query = document.getElementById('manager-search').value.toLowerCase();
    const category = document.getElementById('manager-category').value;
    const filtered = allPlaylists.filter(list => list.name.toLowerCase().includes(query) && (category === "" || list.category === category));
    renderManagerLists(filtered);
}

// サイドバー・カード一覧の描画 (バニラJS: Vue依存を排除して軽量化)。
export function renderManagerLists(filtered) {
    renderPlaylistNav(filtered);
}

export function renderPlaylistNav(playlists) {
    const nav = document.getElementById('playlist-nav');
    nav.innerHTML = `
        <li onclick="selectPlaylist('home')" class="${currentPlaylistId === 'home' ? 'active' : ''}"><span class="material-symbols-rounded nav-li-icon">home</span>ホーム (リスト一覧)</li>
        <li onclick="selectPlaylist(null)" class="${currentPlaylistId === null ? 'active' : ''}"><span class="material-symbols-rounded nav-li-icon">library_music</span>すべてのブックマーク</li>
        <li onclick="selectPlaylist('fav_playlists')" class="${currentPlaylistId === 'fav_playlists' ? 'active' : ''}"><span class="material-symbols-rounded nav-li-icon">favorite</span>お気に入り (リスト一覧)</li>
        <li onclick="selectPlaylist('fav_tracks')" class="${currentPlaylistId === 'fav_tracks' ? 'active' : ''}"><span class="material-symbols-rounded nav-li-icon">music_note</span>お気に入り曲</li>
    `;

    // 固定タブ (未整理 / 公開用お気に入り) は全ユーザー共通で「お気に入り曲」の直下に常に固定表示する。
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
                    <button onclick="openPlaylistShareView(${list.id})"><span class="material-symbols-rounded">public</span>Shareで見る</button>
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
export function orderedUserListIds() {
    return allPlaylists.filter(list => !isSystemPlaylist(list)).map(list => list.id);
}

// 表示中の(ドラッグされた)リストの並びを状態へ反映する。表示外のリストは元の位置に残す。
export function applyPlaylistOrderToState(orderedIds) {
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
export function reorderItemsById(selector, orderedIds) {
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
export function syncPlaylistOrderInDom() {
    const orderedIds = orderedUserListIds();
    reorderItemsById('#playlist-nav li.draggable-pl', orderedIds);
    reorderItemsById('#my-playlists-grid .card:not(.is-system)', orderedIds);
}

// 並び順をサーバーへ保存する (失敗時のみ再取得して整合を取る)
export async function savePlaylistOrder() {
    try {
        await tunedropFetch('api.php?action=reorder_playlists', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ordered_ids: orderedUserListIds() })
        });
    } catch (err) {
        showToast('並び替えの保存に失敗しました。', 'error');
        loadPlaylists();
    }
}

// ユーザープレイリストを並び替えて保存 (固定タブは対象外)
export async function reorderUserPlaylists(draggedId, targetId) {
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
export function isTouchPointer(event) {
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

export function enablePointerReorder({ handle, item, container, itemSelector, onDrop }) {
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
export async function persistPlaylistOrderFromDom(container, itemSelector) {
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

export async function persistBookmarkOrderFromDom(container) {
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
export function persistDetailTrackOrderFromDom(container) {
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
export function applyTrackOrderToState(orderedVisibleIds) {
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
export function syncTrackDomOrder() {
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

export function selectPlaylist(id, options = {}) {
    resetManagerSelection();
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
        // 呼び出し側が自分で loadMyBookmarks する場合は二重取得を避ける
        if (!options.skipLoad) loadMyBookmarks(id);
    }
    // リストを選んだらメニューを閉じて選択内容を見せる
    closeMobileMenu();
}

export async function togglePlaylistFavorite(id, event) {
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
            showToast(data.error, 'error');
        }
        return data;
    } catch (err) { console.error(err); }
}

export async function toggleTrackFavorite(id, event) {
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
            showToast(data.error || 'お気に入りを更新できませんでした。', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('お気に入りを更新できませんでした。もう一度お試しください。', 'error');
    }
}

let playerFavoriteVersion = 0;
export function playerFavoriteKey(track) {
    return Number.isInteger(Number(track.id)) && String(track.id) !== String(track.youtube_id)
        ? { id: track.id } : { youtube_id: track.youtube_id };
}

export async function syncPlayerFavorite(track) {
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

export async function togglePlayerFavorite() {
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

export function updatePlayerFavButton(isFav) {
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

export function toggleSidebarMenu(event, btn) {
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

export function openCreatePlaylistModal() {
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく
    const titleInput = document.getElementById('new-playlist-title');
    titleInput.value = '';
    document.getElementById('new-playlist-category').value = 'Other';
    document.getElementById('new-playlist-public').checked = false;
    document.getElementById('create-playlist-modal').style.display = 'flex';
    // 開いた直後に入力できるようにする (スマホでも1タップ減る)
    if (titleInput && typeof titleInput.focus === 'function') titleInput.focus();
}
export function closeCreatePlaylistModal() { document.getElementById('create-playlist-modal').style.display = 'none'; }

export async function submitNewPlaylist() {
    const button = document.getElementById('create-playlist-submit');
    if (button && button.disabled) return;
    const name = document.getElementById('new-playlist-title').value.trim();
    const category = document.getElementById('new-playlist-category').value;
    const isPublic = document.getElementById('new-playlist-public').checked ? 1 : 0;
    if (!name) {
        document.getElementById('new-playlist-title').focus();
        return showToast('リスト名を入力してください。', 'error');
    }
    setActionBusy(button, true, '作成中…');
    try {
        const response = await tunedropFetch('api.php?action=create_playlist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, category, is_public: isPublic })
        });
        const result = await response.json();
        if (result.success) { closeCreatePlaylistModal(); loadPlaylists(); showToast(`リスト「${name}」を作成しました。`); }
        else showToast('作成に失敗しました。' + (result.error ? ' ' + result.error : ''), 'error');
    } catch (err) { showToast('通信エラーが発生しました。', 'error'); }
    finally { setActionBusy(button, false); }
}

export async function openEditPlaylistModal(event, playlistId) {
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
    coverSelect.innerHTML = '<option value="">読み込み中…</option>';
    // 曲一覧の取得を待たずにモーダルを開く (クリック直後に何も起きない時間をなくす)
    document.getElementById('edit-playlist-modal').style.display = 'flex';
    const titleInput = document.getElementById('edit-playlist-title');
    if (titleInput && typeof titleInput.focus === 'function') {
        titleInput.focus();
        if (typeof titleInput.select === 'function') titleInput.select();
    }
    try {
        const response = await tunedropFetch(`api.php?action=get_my_bookmarks&playlist_id=${playlistId}`);
        const tracks = await response.json();
        coverSelect.innerHTML = '<option value="">設定しない / 今のまま</option>';
        tracks.forEach(track => {
            const option = document.createElement('option');
            option.value = track.youtube_id;
            option.innerText = track.title;
            if (list.cover_id === track.youtube_id) option.selected = true;
            coverSelect.appendChild(option);
        });
    } catch (err) {
        console.error(err);
        coverSelect.innerHTML = '<option value="">設定しない / 今のまま</option>';
    }
}
export function closeEditPlaylistModal() { document.getElementById('edit-playlist-modal').style.display = 'none'; }

export async function submitEditPlaylist() {
    const button = document.getElementById('edit-playlist-submit');
    if (button && button.disabled) return;
    const id = document.getElementById('edit-playlist-id').value;
    const name = document.getElementById('edit-playlist-title').value.trim();
    const category = document.getElementById('edit-playlist-category').value;
    const isPublic = document.getElementById('edit-playlist-public').checked ? 1 : 0;
    const coverId = document.getElementById('edit-playlist-cover').value;

    if (!name) {
        document.getElementById('edit-playlist-title').focus();
        return showToast('リスト名を入力してください。', 'error');
    }
    setActionBusy(button, true, '保存中…');
    try {
        const response = await tunedropFetch('api.php?action=edit_playlist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, name, category, is_public: isPublic, cover_id: coverId })
        });
        const result = await response.json();
        if (result.success) { closeEditPlaylistModal(); loadPlaylists(); showToast('リストを更新しました。'); }
        else showToast('更新に失敗しました。', 'error');
    } catch (err) { showToast('通信エラーが発生しました。', 'error'); }
    finally { setActionBusy(button, false); }
}

export async function deletePlaylistFromSidebar(event, playlistId) {
    event.stopPropagation();
    document.querySelectorAll('.sidebar-dropdown-menu').forEach(m => m.style.display = 'none');
    const confirmed = await showConfirm({
        title: 'プレイリストを削除',
        message: 'このプレイリストを削除しますか？\nリスト内の曲もすべて削除されます。',
        confirmLabel: '削除する',
        danger: true,
    });
    if (!confirmed) return;
    try {
        const response = await tunedropFetch('api.php?action=delete_playlist', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: playlistId })
        });
        const result = await response.json();
        if (result.success) {
            if (currentPlaylistId === playlistId) currentPlaylistId = 'home';
            loadPlaylists();
            showToast('プレイリストを削除しました。', 'info');
        } else showToast('削除に失敗しました。', 'error');
    } catch (err) { showToast('通信エラーが発生しました。', 'error'); }
}

export async function updatePlaylistCategory(playlistId, newCategory, event) {
    event.stopPropagation();
    try {
        const response = await tunedropFetch('api.php?action=update_category', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: playlistId, category: newCategory })
        });
        const result = await response.json();
        if (result.success) loadPlaylists(); else showToast('カテゴリの更新に失敗しました。', 'error');
    } catch (err) { showToast('通信エラーが発生しました。', 'error'); }
}

// ==========================================================
// Manager ホーム (ダッシュボード)
// ----------------------------------------------------------
// ヒーロー・KPI・最近追加した曲・ジャンル分布をまとめて描画する。
// 集計はサーバー側 (get_manager_summary) で1回だけ行い、リストや曲が
// 変わって loadPlaylists() が走るたびに取り直す。
// ==========================================================
export async function loadManagerSummary() {
    // 未ログイン (デモ表示) ではAPIを呼ばない
    if (!hasAccountSession()) return;
    if (!document.getElementById('dash-stats')) return;   // Manager 以外の画面では何もしない
    if (managerSummaryPromise) return managerSummaryPromise;

    renderManagerDashboard();          // 先に前回値 / 読み込み中の見た目を出す
    managerSummaryPromise = (async () => {
        try {
            const response = await tunedropFetch('api.php?action=get_manager_summary');
            managerSummary = response.ok ? await response.json() : null;
            managerSummaryError = !response.ok;
        } catch (error) {
            managerSummary = null;
            managerSummaryError = true;
        } finally {
            managerSummaryPromise = null;
            renderManagerDashboard();
        }
    })();
    return managerSummaryPromise;
}

export function dashboardGreeting() {
    const hour = new Date().getHours();
    const part = hour < 5 ? 'こんばんは' : hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'こんばんは';
    let name = '';
    try { name = localStorage.getItem('tunedrop_username') || ''; } catch (error) { name = ''; }
    return name ? `${part}、${name}さん` : part;
}

// 保存日時を「たった今 / 3分前 / 2日前 / 2026/1/5」のように表す
export function formatRelativeTime(value) {
    if (!value) return '';
    const time = new Date(String(value).replace(' ', 'T')).getTime();
    if (!Number.isFinite(time)) return '';
    const diff = Date.now() - time;
    if (diff < 60 * 1000) return 'たった今';
    const minutes = Math.floor(diff / (60 * 1000));
    if (minutes < 60) return `${minutes}分前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}時間前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}日前`;
    const date = new Date(time);
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function renderManagerDashboard() {
    const statsEl = document.getElementById('dash-stats');
    if (!statsEl) return;

    const greeting = document.getElementById('dash-greeting');
    if (greeting) greeting.textContent = dashboardGreeting();

    const stats = managerSummary && managerSummary.stats ? managerSummary.stats : null;
    const statValue = key => (stats ? Number(stats[key]) || 0 : '—');
    // アイコンは静的な <span> として持たせる (Material Symbols のサブセット検出にも乗る)
    const statCards = [
        { key: 'tracks', label: '保存した曲', hint: 'すべてのブックマーク', action: "selectPlaylist(null)", icon: '<span class="material-symbols-rounded">library_music</span>' },
        { key: 'playlists', label: 'マイリスト', hint: '固定タブを除く', action: "focusPlaylistGrid()", icon: '<span class="material-symbols-rounded">queue_music</span>' },
        { key: 'public_playlists', label: '公開中', hint: 'Shareに掲載', action: "navigateView('share')", icon: '<span class="material-symbols-rounded">public</span>' },
        { key: 'favorite_tracks', label: 'お気に入り曲', hint: '★ を付けた曲', action: "selectPlaylist('fav_tracks')", icon: '<span class="material-symbols-rounded">favorite</span>' },
    ];
    statsEl.innerHTML = statCards.map(card => `
        <button type="button" class="dash-stat${stats ? '' : ' is-loading'}" onclick="${card.action}">
            <span class="dash-stat-icon">${card.icon}</span>
            <span class="dash-stat-body">
                <span class="dash-stat-value">${statValue(card.key)}</span>
                <span class="dash-stat-label">${card.label}</span>
                <span class="dash-stat-hint">${card.hint}</span>
            </span>
        </button>`).join('');

    // 最近追加した曲 (クリックでそのまま再生)
    const recentEl = document.getElementById('dash-recent-tracks');
    if (recentEl) {
        if (!managerSummary) {
            recentEl.innerHTML = `<div class="dash-panel-empty${managerSummaryError ? '' : ' is-loading'}">
                ${managerSummaryError
                    ? '<p>集計を取得できませんでした。</p><button type="button" onclick="loadManagerSummary()">再試行</button>'
                    : '<p>読み込み中…</p>'}
            </div>`;
        } else {
            const tracks = managerSummary.recent_tracks || [];
            recentEl.innerHTML = '';
            if (tracks.length === 0) {
                recentEl.innerHTML = `<div class="dash-panel-empty">
                    <span class="material-symbols-rounded">music_note</span>
                    <p>まだ曲がありません。YouTubeのURLを貼って追加してみましょう。</p>
                    <button type="button" onclick="openInboxForAdd()">曲を追加する</button>
                </div>`;
            } else {
                tracks.forEach((track, index) => {
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'dash-track';
                    row.title = `${track.title} を再生`;
                    row.innerHTML = `
                        <span class="dash-track-index">${index + 1}</span>
                        <img class="dash-track-thumb" src="https://img.youtube.com/vi/${track.youtube_id}/mqdefault.jpg" alt="" loading="lazy">
                        <span class="dash-track-info">
                            <span class="dash-track-title">${escapeHtml(track.title)}</span>
                            <span class="dash-track-sub">${escapeHtml(track.channel || 'Unknown Artist')}</span>
                        </span>
                        ${Number(track.is_favorite) === 1 ? '<span class="material-symbols-rounded is-filled dash-track-fav">favorite</span>' : ''}
                        <span class="dash-track-time">${formatRelativeTime(track.added_at)}</span>`;
                    row.onclick = () => playTrackFromQueue(index, tracks);
                    recentEl.appendChild(row);
                });
            }
        }
    }

    // ジャンル (リストのカテゴリ) 分布。行をクリックすると一覧を絞り込む。
    const genresEl = document.getElementById('dash-genres');
    if (genresEl) {
        if (!managerSummary) {
            genresEl.innerHTML = `<div class="dash-panel-empty${managerSummaryError ? '' : ' is-loading'}">
                ${managerSummaryError ? '<p>集計を取得できませんでした。</p>' : '<p>読み込み中…</p>'}
            </div>`;
        } else {
            renderGenreRows(genresEl, managerSummary.categories || [], 'リストにカテゴリを設定すると、ここに分布が出ます。');
        }
    }
}

// カテゴリ分布のバーを描画する (通常ホーム / お気に入りホームで共通)
export function renderGenreRows(container, categories, emptyText) {
    if (!container) return;
    container.innerHTML = '';
    if (!categories.length) {
        container.innerHTML = `<div class="dash-panel-empty">
            <span class="material-symbols-rounded">donut_small</span>
            <p>${escapeHtml(emptyText || 'カテゴリの分布がありません。')}</p>
        </div>`;
        return;
    }
    const max = Math.max(...categories.map(category => Number(category.tracks) || 0), 1);
    categories.forEach(category => {
        const tracks = Number(category.tracks) || 0;
        const width = tracks > 0 ? Math.max(6, Math.round((tracks / max) * 100)) : 0;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'dash-genre-row';
        row.title = `${category.category} のリストだけを表示`;
        row.innerHTML = `
            <span class="dash-genre-name">${escapeHtml(category.category)}</span>
            <span class="dash-genre-bar"><span class="dash-genre-fill" style="width:${width}%"></span></span>
            <span class="dash-genre-count">${tracks}</span>`;
        row.onclick = () => applyDashboardCategory(category.category);
        container.appendChild(row);
    });
}

// ==========================================================
// お気に入りダッシュボード (お気に入りしたブックマーク中心)
// ----------------------------------------------------------
// サイドバーで「お気に入り」を選んでいる間だけ表示する。
// 曲は既存の get_my_bookmarks&playlist_id=fav_tracks から取得し、
// リストは get_playlists の track_count / is_favorite を使う (API追加なし)。
// ==========================================================
let favoriteDashboardLists = [];      // 直近の get_playlists 結果 (再描画用)
let favoriteTrackSummary = null;      // お気に入り曲の一覧 (null = 未取得)
let favoriteTrackSummaryError = false;
let favoriteTrackSummaryRequest = null;

export function renderFavoritesDashboard(lists) {
    const statsEl = document.getElementById('fav-stats');
    if (!statsEl) return;

    favoriteDashboardLists = lists || [];
    const favoriteLists = favoriteDashboardLists.filter(list => !isSystemPlaylist(list) && Number(list.is_favorite) === 1);
    const categoryMap = new Map();
    favoriteLists.forEach(list => {
        const category = String(list.category || 'Other').trim() || 'Other';
        categoryMap.set(category, (categoryMap.get(category) || 0) + (Number(list.track_count) || 0));
    });

    const tracks = favoriteTrackSummary;
    const trackCount = tracks ? tracks.length : '—';
    const artistCount = tracks ? new Set(tracks.map(track => track.channel || 'Unknown Artist')).size : '—';

    // アイコンは静的な <span> として持たせる (Material Symbols のサブセット検出にも乗る)
    const statCards = [
        { label: 'お気に入り曲', value: trackCount, hint: '★ を付けた曲', loading: !tracks && !favoriteTrackSummaryError, action: "selectPlaylist('fav_tracks')", icon: '<span class="material-symbols-rounded">favorite</span>' },
        { label: 'アーティスト', value: artistCount, hint: '重複を除く', loading: !tracks && !favoriteTrackSummaryError, action: "selectPlaylist('fav_tracks')", icon: '<span class="material-symbols-rounded">person</span>' },
        { label: 'お気に入りリスト', value: favoriteLists.length, hint: '固定タブを除く', loading: false, action: 'focusPlaylistGrid()', icon: '<span class="material-symbols-rounded">queue_music</span>' },
        { label: 'カテゴリ', value: categoryMap.size, hint: 'ジャンルの広がり', loading: false, action: 'focusCategoryFilter()', icon: '<span class="material-symbols-rounded">insights</span>' },
    ];
    statsEl.innerHTML = statCards.map(card => `
        <button type="button" class="dash-stat${card.loading ? ' is-loading' : ''}" onclick="${card.action}">
            <span class="dash-stat-icon">${card.icon}</span>
            <span class="dash-stat-body">
                <span class="dash-stat-value">${card.value}</span>
                <span class="dash-stat-label">${card.label}</span>
                <span class="dash-stat-hint">${card.hint}</span>
            </span>
        </button>`).join('');

    // 初回だけお気に入り曲を取得する (完了時にこの関数を呼び直して KPI を更新する)
    if (!favoriteTrackSummaryRequest) loadFavoriteTrackSummary();
    renderFavoriteTracksPanel();
}

// お気に入り曲を取得する (完了後にダッシュボードを再描画)
export function loadFavoriteTrackSummary() {
    if (favoriteTrackSummaryRequest) return favoriteTrackSummaryRequest;
    favoriteTrackSummaryRequest = (async () => {
        try {
            const response = await tunedropFetch('api.php?action=get_my_bookmarks&playlist_id=fav_tracks');
            const tracks = await response.json();
            if (!response.ok || !Array.isArray(tracks)) throw new Error('お気に入りを取得できませんでした。');
            favoriteTrackSummary = tracks;
            favoriteTrackSummaryError = false;
        } catch (error) {
            favoriteTrackSummary = null;
            favoriteTrackSummaryError = true;
        }
        renderFavoritesDashboard(favoriteDashboardLists);
        return favoriteTrackSummary;
    })();
    return favoriteTrackSummaryRequest;
}

export function retryFavoriteTrackSummary() {
    favoriteTrackSummaryRequest = null;
    favoriteTrackSummaryError = false;
    const request = loadFavoriteTrackSummary();
    renderFavoriteTracksPanel();
    return request;
}

// お気に入り曲のパネル (最近お気に入りにした曲 / アーティスト分布)
export function renderFavoriteTracksPanel() {
    const recentEl = document.getElementById('fav-recent-tracks');
    const artistsEl = document.getElementById('fav-artists');
    if (!recentEl && !artistsEl) return;

    const tracks = favoriteTrackSummary;
    if (!tracks) {
        const loading = favoriteTrackSummaryError
            ? '<div class="dash-panel-empty" role="status"><p>お気に入りを読み込めませんでした。</p><button type="button" onclick="retryFavoriteTrackSummary()">再試行</button></div>'
            : '<div class="dash-panel-empty is-loading"><p>お気に入り曲を読み込み中…</p></div>';
        if (recentEl) recentEl.innerHTML = loading;
        if (artistsEl) artistsEl.innerHTML = loading;
        return;
    }

    // 最近お気に入りにした曲 (保存日時の新しい順に最大6曲)
    if (recentEl) {
        const recent = [...tracks]
            .sort((a, b) => String(b.added_at || '').localeCompare(String(a.added_at || '')) || (Number(b.id) || 0) - (Number(a.id) || 0))
            .slice(0, 6);
        recentEl.innerHTML = '';
        if (recent.length === 0) {
            recentEl.innerHTML = `<div class="dash-panel-empty">
                <span class="material-symbols-rounded">favorite</span>
                <p>お気に入りの曲がまだありません。<br>曲カードの★を押すと、ここにたまります。</p>
                <button type="button" onclick="selectPlaylist(null)">曲を探す</button>
            </div>`;
        } else {
            recent.forEach((track, index) => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'dash-track';
                row.title = `${track.title} を再生`;
                row.innerHTML = `
                    <span class="dash-track-index">${index + 1}</span>
                    <img class="dash-track-thumb" src="https://img.youtube.com/vi/${track.youtube_id}/mqdefault.jpg" alt="" loading="lazy">
                    <span class="dash-track-info">
                        <span class="dash-track-title">${escapeHtml(track.title)}</span>
                        <span class="dash-track-sub">${escapeHtml(track.channel || 'Unknown Artist')}</span>
                    </span>
                    <span class="dash-track-time">${formatRelativeTime(track.added_at)}</span>`;
                row.onclick = () => playTrackFromQueue(index, recent);
                recentEl.appendChild(row);
            });
        }
    }

    // アーティスト分布 (曲数の多い順に最大6人)
    if (artistsEl) {
        const counts = new Map();
        tracks.forEach(track => {
            const artist = String(track.channel || 'Unknown Artist').trim() || 'Unknown Artist';
            counts.set(artist, (counts.get(artist) || 0) + 1);
        });
        artistsEl.innerHTML = '';
        if (counts.size === 0) {
            artistsEl.innerHTML = `<div class="dash-panel-empty">
                <span class="material-symbols-rounded">person</span>
                <p>アーティストの分布は、お気に入り曲が増えると表示されます。</p>
            </div>`;
        } else {
            const rows = [...counts.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
                .slice(0, 6);
            const max = Math.max(...rows.map(row => row[1]), 1);
            rows.forEach(([artist, count]) => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'dash-genre-row';
                row.title = `${artist} の曲を表示`;
                row.innerHTML = `
                    <span class="dash-genre-name">${escapeHtml(artist)}</span>
                    <span class="dash-genre-bar"><span class="dash-genre-fill" style="width:${Math.max(6, Math.round((count / max) * 100))}%"></span></span>
                    <span class="dash-genre-count">${count}</span>`;
                row.onclick = () => openFavoriteTracksByArtist(artist);
                artistsEl.appendChild(row);
            });
        }
    }
}

// アーティスト分布の行クリック: お気に入り曲画面でそのアーティストを検索する
export async function openFavoriteTracksByArtist(artist) {
    selectPlaylist('fav_tracks', { skipLoad: true });
    await loadMyBookmarks('fav_tracks');
    const input = document.getElementById('track-search');
    if (!input) return;
    input.value = artist;
    filterTracks();
}

// 未整理リストを開いて、すぐ YouTube URL を貼れる状態にする
export function openInboxForAdd() {
    const inbox = allPlaylists.find(list => list.system_key === 'inbox');
    if (!inbox) {
        showToast('未整理リストが見つかりません。', 'error');
        return;
    }
    selectPlaylist(inbox.id);
    // トラック画面へ切り替わってから入力欄へフォーカスする
    setTimeout(() => {
        const input = document.getElementById('youtube-url');
        if (input) input.focus();
    }, 80);
}

// ダッシュボードの「マイリスト」から一覧へスクロールする
export function focusPlaylistGrid() {
    const grid = document.getElementById('my-playlists-grid');
    if (!grid) return;
    if (typeof grid.scrollIntoView === 'function') grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ダッシュボードの「カテゴリ」からサイドバーの絞り込みへフォーカスする
export function focusCategoryFilter() {
    const select = document.getElementById('manager-category');
    if (select && typeof select.focus === 'function') select.focus();
}

// ジャンル分布の行クリック: サイドバーのカテゴリ絞り込みを合わせて一覧を更新する
export function applyDashboardCategory(category) {
    const select = document.getElementById('manager-category');
    if (!select) return;
    if (![...select.options].some(option => option.value === category)) {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        select.appendChild(option);
    }
    select.value = category;
    filterManagerPlaylists();
    focusPlaylistGrid();
    showToast(`「${category}」のリストを表示しています。`, 'info');
}

export function renderManagerHome(playlists) {
    const container = document.getElementById('my-playlists-grid');
    container.innerHTML = '';
    const query = document.getElementById('manager-search').value.toLowerCase();
    const categoryFilter = document.getElementById('manager-category').value;
    let filtered = playlists.filter(list => list.name.toLowerCase().includes(query) && (categoryFilter === "" || list.category === categoryFilter));

    // ソート適用 (カスタム順は sort_order、既定の並び)
    filtered = sortPlaylists(filtered, playlistSortMode);

    // お気に入りを開いているときは、お気に入り専用のダッシュボードへ切り替える
    // (通常ホームの集計は隠し、KPI / ピックアップ / カテゴリ分布を出す)。
    const favoritesView = currentPlaylistId === 'fav_playlists';
    const dashboard = document.getElementById('manager-dashboard');
    if (dashboard) dashboard.classList.toggle('is-favorites-view', favoritesView);

    // お気に入り専用ダッシュボード (KPI / ピックアップ / カテゴリ分布) を描画
    if (favoritesView) renderFavoritesDashboard(playlists);

    const sub = document.getElementById('dash-lists-sub');
    if (sub) {
        // お気に入り画面では「公開用お気に入り」(固定タブ) も一覧に並ぶため、
        // 合計曲数は KPI (固定タブを除く) と混在させず、表示中の件数だけを出す。
        sub.textContent = `${filtered.length}件のリストを表示中`;
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="dash-empty">
            <span class="material-symbols-rounded">library_music</span>
            <p>${favoritesView ? 'お気に入りのリストがまだありません。' : '条件に合うプレイリストがありません。'}</p>
            <button type="button" onclick="openCreatePlaylistModal()">新しいリストを作る</button>
        </div>`;
        return;
    }

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

        // 曲数と公開状態をカードに出す (一覧を見ただけで中身の規模が分かるように)
        const trackCount = Number(list.track_count) || 0;
        const isPublic = !isProtected && Number(list.is_public) === 1;
        card.innerHTML = `${catSelect}<div class="card-img-wrapper">${coverHtml}</div>
            <div class="info with-handle">
                <div class="info-text">
                    <div class="title">${escapeHtml(list.name)}</div>
                    <div class="artist card-meta-line">
                        <span class="material-symbols-rounded">music_note</span>
                        <span>${trackCount}曲</span>
                        ${isPublic ? '<span class="card-public-badge">公開中</span>' : ''}
                    </div>
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

export function closeTrackMenus() {
    document.querySelectorAll('.track-dropdown-menu').forEach(menu => {
        menu.style.display = 'none';
        menu.previousElementSibling?.setAttribute('aria-expanded', 'false');
    });
}

export function toggleTrackMenu(event, btn) {
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
    // 開いているモーダルがあれば閉じる (Escで画面が勝手に切り替わらないように)
    if (!closeTopmostModal()) {
        if (!closeProfilePanel() && managerSelectMode) {
            resetManagerSelection();
        }
    }
});

// ==========================================================
// グローバル再生ショートカット (Kiite 風)
// ----------------------------------------------------------
// Space = 再生/一時停止, N = 次の曲, P = 前の曲。
// 入力欄・ボタン・モーダル表示中はブラウザの操作を邪魔しないよう何もしない。
// (Radar で1曲だけのときに N を押すと「次の発掘」へ進む)
// ==========================================================
const SHORTCUT_IGNORE_TAGS = new Set(['input', 'textarea', 'select', 'button', 'a']);

export function isTypingTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = String(target.tagName || '').toLowerCase();
    return SHORTCUT_IGNORE_TAGS.has(tag);
}

export function hasOpenOverlay() {
    for (const target of MODAL_CLOSERS) {
        const open = typeof target.isOpen === 'function' ? target.isOpen() : isModalVisible(target.id);
        if (open) return true;
    }
    return false;
}

export function handlePlaybackShortcut(event) {
    if (!event || event.defaultPrevented) return false;
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
    if (isTypingTarget(event.target) || hasOpenOverlay()) return false;

    if (event.key === ' ' || event.key === 'Spacebar') {
        if (!currentQueue.length) return false;
        event.preventDefault();
        togglePlay();
        return true;
    }

    if (event.key === 'n' || event.key === 'N') {
        if (currentQueue.length > 1) {
            event.preventDefault();
            skipTrack(1);
            return true;
        }
        // 1曲だけのときは Radar の発掘を進める
        const radar = document.getElementById('view-radar');
        if (radar && radar.classList.contains('active')) {
            event.preventDefault();
            radarDigNext();
            return true;
        }
        return false;
    }

    if (event.key === 'p' || event.key === 'P') {
        if (currentQueue.length > 1) {
            event.preventDefault();
            skipTrack(-1);
            return true;
        }
        return false;
    }

    return false;
}

document.addEventListener('keydown', handlePlaybackShortcut);

// ==========================================================
// ソート機能
// ==========================================================
// リスト (created_at / name) と曲 (added_at / title) で使うキーだけが違うため共通化。
// 'custom' は DB が返した並び (sort_order → id 昇順) を尊重する。
export function sortByMode(items, mode, dateKey, nameKey) {
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
            // 固定タブ (未整理 / 公開用お気に入り) を常に先頭2件にし、その後にユーザー作成リストを
            // sort_order → id で並べる (サーバーの get_playlists と同じ規則)。
            return arr.sort((a, b) => {
                const aSystem = isSystemPlaylist(a);
                const bSystem = isSystemPlaylist(b);
                if (aSystem && bSystem) return compareSystemPlaylists(a, b);
                if (aSystem !== bSystem) return aSystem ? -1 : 1;
                return ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || ((a.id ?? 0) - (b.id ?? 0));
            });
    }
}

export function sortPlaylists(playlists, mode) {
    return sortByMode(playlists, mode, 'created_at', 'name');
}

export function sortTracks(tracks, mode) {
    return sortByMode(tracks, mode, 'added_at', 'title');
}

export function onPlaylistSortChange() {
    const sel = document.getElementById('playlist-sort-select');
    playlistSortMode = sel ? sel.value : 'custom';
    // ソート順の変更を反映 (再描画する)
    filterManagerPlaylists();
}

export function onTrackSortChange() {
    const sel = document.getElementById('track-sort-select');
    trackSortMode = sel ? sel.value : 'custom';
    renderDetailTracks(currentDetailTracks);
}

export function onManagerTrackSortChange() {
    const sel = document.getElementById('manager-track-sort-select');
    trackSortMode = sel ? sel.value : 'custom';
    renderTracks(currentTracks);
}

export function openMoveModalFromMenu(event, trackId) {
    event.stopPropagation();
    document.querySelectorAll('.track-dropdown-menu').forEach(m => m.style.display = 'none');
    openMoveModal(event, trackId);
}

export function deleteTrackFromMenu(event, trackId) {
    event.stopPropagation();
    document.querySelectorAll('.track-dropdown-menu').forEach(m => m.style.display = 'none');
    deleteTrack(event, trackId);
}

export async function addTrack() {
    const input = document.getElementById('youtube-url');
    const button = document.getElementById('add-track-btn');
    // ボタン連打・Enter 連打による二重登録を防ぐ
    if (button && button.disabled) return;
    // 複数URLのまとめ貼り付けに対応 (1件ずつ追加した結果をまとめて知らせる)
    const youtubeIds = extractYouTubeIds(input ? input.value : '');
    if (youtubeIds.length === 0) {
        if (input) input.focus();
        return showToast('YouTubeのURL（https://youtu.be/...）を貼り付けてください。', 'error');
    }

    // 追加先: リストを開いていればそのリスト、一覧/お気に入り表示中は自分の固定タブ「未整理」
    const inbox = allPlaylists.find(list => list.system_key === 'inbox')
        || allPlaylists.find(isSystemPlaylist)
        || null;
    const inboxId = inbox ? inbox.id : 0;
    const targetPlaylistId = (currentPlaylistId === 'home' || currentPlaylistId === 'fav_tracks' || currentPlaylistId === 'fav_playlists')
        ? inboxId
        : (Number.isInteger(currentPlaylistId) ? currentPlaylistId : inboxId);

    // ボタン連打による二重登録を防ぐ (追加中は押せなくする)
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
        let added = 0;
        let duplicated = 0;
        let firstError = '';
        for (const youtubeId of youtubeIds) {
            try {
                const response = await tunedropFetch('api.php?action=add_bookmark', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ youtube_id: youtubeId, playlist_id: targetPlaylistId })
                });
                const result = await response.json();
                if (result.success) added += 1;
                // 「この曲は既にこのリストに登録されています」は重複として件数だけ数える
                else if (`${result.error || ''}`.includes('既に')) duplicated += 1;
                else if (!firstError) firstError = result.error || '曲を追加できませんでした。';
            } catch (error) {
                console.error("通信エラー:", error);
                if (!firstError) firstError = '通信できませんでした。時間をおいてお試しください。';
            }
        }

        if (added > 0) {
            if (input) { input.value = ''; input.focus(); }
            loadMyBookmarks(currentPlaylistId);
            await loadPlaylists();

            const notes = [];
            if (duplicated) notes.push(`${duplicated}曲は登録済み`);
            if (firstError) notes.push(firstError);
            showToast(notes.length
                ? `${added}曲を追加しました（${notes.join(' / ')}）`
                : `${added}曲を追加しました。`);
        } else if (duplicated && !firstError) {
            showToast('すべて登録済みの曲でした。', 'error');
        } else {
            showToast(firstError || '曲を追加できませんでした。', 'error');
        }
    } finally {
        if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
}

export async function deleteTrack(event, trackId) {
    event.stopPropagation();
    const confirmed = await showConfirm({
        title: '曲を削除',
        message: 'この曲をリストから削除しますか？',
        confirmLabel: '削除する',
        danger: true,
    });
    if (!confirmed) return;
    try {
        const res = await tunedropFetch('api.php?action=delete_bookmark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: trackId })
        });
        const result = await res.json();
        if (result.success) {
            loadMyBookmarks(currentPlaylistId);
            await loadPlaylists();
            // 詳細画面から削除したときは、その場の一覧も更新する
            if (document.getElementById('view-playlist-detail')?.classList.contains('active')) {
                currentDetailTracks = currentDetailTracks.filter(t => t.id !== trackId);
                renderDetailTracks(currentDetailTracks);
            }
            showToast('リストから削除しました。', 'info');
        } else {
            showToast('削除に失敗しました。', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('削除できませんでした。時間をおいてお試しください。', 'error');
    }
}

function populateMoveTargetPlaylists() {
    const select = document.getElementById('move-target-playlist-select');
    if (!select) return;
    select.innerHTML = '';
    allPlaylists.forEach(list => {
        const option = document.createElement('option');
        option.value = list.id;
        // 固定タブはカテゴリ (タグ) を持たないため名前だけを表示する
        option.innerText = isSystemPlaylist(list) ? list.name : `${list.name} (${list.category})`;
        select.appendChild(option);
    });
}

export function openMoveModal(event, trackId) {
    event.stopPropagation();
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく
    selectedTrackIdForMove = trackId;
    bulkMoveTrackIds = [];
    populateMoveTargetPlaylists();
    const title = document.getElementById('move-track-modal-title');
    if (title) title.textContent = '曲を移動';
    document.getElementById('move-track-modal').style.display = 'flex';
    const select = document.getElementById('move-target-playlist-select');
    if (select && typeof select.focus === 'function') select.focus();
}
export function closeMoveModal() {
    document.getElementById('move-track-modal').style.display = 'none';
    selectedTrackIdForMove = null;
    bulkMoveTrackIds = [];
}

export async function submitMoveTrack() {
    const button = document.getElementById('move-track-submit');
    if (button && button.disabled) return;
    const targetPlaylistId = document.getElementById('move-target-playlist-select').value;
    if ((!selectedTrackIdForMove && !bulkMoveTrackIds.length) || !targetPlaylistId) return;
    const movedId = selectedTrackIdForMove;
    const bulkIds = bulkMoveTrackIds.slice();
    const isBulk = bulkIds.length > 0;
    setActionBusy(button, true, '移動中…');
    try {
        const response = isBulk
            ? await tunedropFetch('api.php?action=bulk_move_bookmarks', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: bulkIds, target_playlist_id: targetPlaylistId })
            })
            : await tunedropFetch('api.php?action=move_bookmark', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: selectedTrackIdForMove, target_playlist_id: targetPlaylistId })
            });
        const result = await response.json();
        if (result.success) {
            closeMoveModal();
            if (isBulk) {
                managerSelectedTrackIds.clear();
                managerSelectionAnchorId = null;
            }
            await loadMyBookmarks(currentPlaylistId);
            await loadPlaylists();
            if (isBulk) {
                const moved = Number(result.moved) || 0;
                const skipped = Number(result.skipped) || 0;
                if (moved === 0 && skipped > 0) {
                    showToast(`移動できる曲がありませんでした（${skipped}曲は移動先に同じ曲があります）。`, 'error');
                } else {
                    showToast(skipped
                        ? `${moved}曲を移動しました（${skipped}曲は移動先に同じ曲があるためスキップ）。`
                        : `${moved}曲を移動しました。`);
                }
                syncManagerSelectionUI();
            } else {
                // 詳細画面から移動したときは、その場の一覧からも取り除く
                const detailView = document.getElementById('view-playlist-detail');
                if (detailView && detailView.classList.contains('active')) {
                    currentDetailTracks = currentDetailTracks.filter(t => t.id !== movedId);
                    renderDetailTracks(currentDetailTracks);
                }
                showToast('移動しました。');
            }
        } else showToast(result.error || '移動に失敗しました。', 'error');
    } catch (err) { showToast('通信エラーが発生しました。', 'error'); }
    finally { setActionBusy(button, false); }
}

export async function loadMyBookmarks(playlistId = null) {
    let url = 'api.php?action=get_my_bookmarks';
    if (playlistId && playlistId !== 'home') url += `&playlist_id=${playlistId}`;
    const response = await tunedropFetch(url);
    // 未ログイン (401) の場合は空配列で安全に描画する (アカウントごとのデータ分離)
    currentTracks = response.ok ? await response.json() : [];
    const trackSearch = document.getElementById('track-search');
    if (trackSearch) trackSearch.value = '';
    syncTrackSearchClear();
    renderTracks(currentTracks);
}

// 現在の検索語で絞り込んだ曲 (renderTracks / Enter再生で同じ結果を使う)
export function filteredTracks() {
    const input = document.getElementById('track-search');
    const query = (input ? input.value : '').toLowerCase();
    if (!query) return currentTracks;
    return currentTracks.filter(track => (track.title && track.title.toLowerCase().includes(query)) || (track.channel && track.channel.toLowerCase().includes(query)));
}

export function syncTrackSearchClear() {
    const input = document.getElementById('track-search');
    const button = document.getElementById('btn-track-search-clear');
    if (button) button.classList.toggle('is-visible', Boolean(input && input.value));
}

export function clearTrackSearch() {
    const input = document.getElementById('track-search');
    if (!input) return;
    input.value = '';
    filterTracks();
    if (typeof input.focus === 'function') input.focus();
}

export function filterTracks() {
    syncTrackSearchClear();
    renderTracks(filteredTracks());
}

// Manager のリスト検索は Escape でクリア (曲・Radar検索と同じ操作感)
export function onManagerSearchKey(event) {
    if (!event || event.key !== 'Escape') return;
    const input = document.getElementById('manager-search');
    if (!input || !input.value) return;
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    input.value = '';
    filterManagerPlaylists();
    if (typeof input.focus === 'function') input.focus();
}

// 検索欄の Enter=先頭の曲を再生、Escape=クリア (Radar / Share と同じ操作感)
export function onTrackSearchKey(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        const displayTracks = sortTracks(filteredTracks(), trackSortMode);
        if (displayTracks.length === 0) return showToast('条件に合う曲がありません。', 'error');
        playTrackFromQueue(0, displayTracks);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        const input = document.getElementById('track-search');
        if (input) input.value = '';
        filterTracks();
        if (input) input.focus();
    }
}

// ==========================================================
// Manager: 曲カードの複数選択
// ----------------------------------------------------------
// 選択モード中はカードのクリックで選択/解除し、Shift+クリックで
// 表示中の並びに沿って範囲選択する。一括操作は api.php の
// bulk_* アクションでまとめて実行する。
// ==========================================================
export function isManagerSelectMode() {
    return managerSelectMode;
}

export function selectedManagerTrackIds() {
    return [...managerSelectedTrackIds];
}

export function selectedManagerTracks() {
    return currentTracks.filter(track => managerSelectedTrackIds.has(Number(track.id)));
}

function displayedManagerTracks() {
    return sortTracks(filteredTracks(), trackSortMode);
}

function managerBulkButtons() {
    return [...document.querySelectorAll('[data-manager-bulk-action]')];
}

// 選択状態を DOM (チェック・件数・ボタンの有効/無効) へ反映する。
// カードの作り直しはしないため、クリック直後でもスクロール位置が動かない。
export function syncManagerSelectionUI() {
    const grid = document.getElementById('my-bookmarks');
    if (grid && grid.classList) grid.classList.toggle('is-select-mode', managerSelectMode);

    const toggle = document.getElementById('btn-manager-select-mode');
    if (toggle) {
        toggle.classList.toggle('is-active', managerSelectMode);
        toggle.setAttribute('aria-pressed', String(managerSelectMode));
        const label = toggle.querySelector('.manager-select-label');
        if (label) label.textContent = managerSelectMode ? '選択中' : '選択';
    }

    const bar = document.getElementById('manager-bulk-bar');
    if (bar) bar.hidden = !managerSelectMode;

    const count = document.getElementById('manager-bulk-count');
    if (count) count.textContent = String(managerSelectedTrackIds.size);

    if (grid && typeof grid.querySelectorAll === 'function') {
        grid.querySelectorAll('.card').forEach(card => {
            const selected = managerSelectedTrackIds.has(Number(card.dataset.trackId));
            card.classList.toggle('is-selected', managerSelectMode && selected);
            card.setAttribute('aria-selected', String(managerSelectMode && selected));
            card.querySelectorAll('.card-select-box').forEach(box => {
                box.classList.toggle('is-checked', selected);
                box.setAttribute('aria-checked', String(selected));
            });
        });
    }

    const selectedTracks = selectedManagerTracks();
    const allFavorite = selectedTracks.length > 0
        && selectedTracks.every(track => Number(track.is_favorite) === 1);
    const favLabel = document.getElementById('manager-bulk-fav-label');
    if (favLabel) favLabel.textContent = allFavorite ? 'お気に入り解除' : 'お気に入り追加';
    const favIcon = document.getElementById('manager-bulk-fav-icon');
    if (favIcon) favIcon.textContent = allFavorite ? 'heart_broken' : 'favorite';

    managerBulkButtons().forEach(button => {
        button.disabled = managerBulkBusy || managerSelectedTrackIds.size === 0;
    });
}

let managerBulkBusy = false;

function setManagerBulkBusy(busy) {
    managerBulkBusy = Boolean(busy);
    syncManagerSelectionUI();
}

export function resetManagerSelection() {
    managerSelectMode = false;
    managerSelectedTrackIds.clear();
    managerSelectionAnchorId = null;
    managerBulkBusy = false;
    syncManagerSelectionUI();
}

export function toggleManagerSelectMode(force) {
    const next = typeof force === 'boolean' ? force : !managerSelectMode;
    managerSelectMode = next;
    if (!next) {
        managerSelectedTrackIds.clear();
        managerSelectionAnchorId = null;
    }
    // 選択モード中はドラッグ並び替えを止めるため、カードを作り直して
    // draggable / ハンドルの状態を揃える。
    renderTracks(filteredTracks());
}

export function clearManagerSelection() {
    managerSelectedTrackIds.clear();
    managerSelectionAnchorId = null;
    syncManagerSelectionUI();
}

export function selectManagerTrackRange(trackId, orderedTracks = null) {
    const ordered = orderedTracks || displayedManagerTracks();
    const ids = ordered.map(track => Number(track.id));
    const anchorIndex = ids.indexOf(Number(managerSelectionAnchorId));
    const targetIndex = ids.indexOf(Number(trackId));
    if (anchorIndex === -1 || targetIndex === -1) {
        toggleTrackSelection(trackId);
        return;
    }
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    for (let i = start; i <= end; i++) managerSelectedTrackIds.add(ids[i]);
    managerSelectionAnchorId = Number(trackId);
    syncManagerSelectionUI();
}

export function toggleTrackSelection(trackId, event = null) {
    const id = Number(trackId);
    if (!Number.isInteger(id) || id <= 0) return;
    if (!managerSelectMode) {
        managerSelectMode = true;
        managerSelectedTrackIds.add(id);
        managerSelectionAnchorId = id;
        renderTracks(filteredTracks());
        return;
    }
    if (event && event.shiftKey && managerSelectionAnchorId != null) {
        selectManagerTrackRange(id);
        return;
    }
    if (managerSelectedTrackIds.has(id)) managerSelectedTrackIds.delete(id);
    else managerSelectedTrackIds.add(id);
    managerSelectionAnchorId = id;
    syncManagerSelectionUI();
}

export function selectAllVisibleTracks() {
    const ordered = displayedManagerTracks();
    ordered.forEach(track => managerSelectedTrackIds.add(Number(track.id)));
    if (ordered.length) managerSelectionAnchorId = Number(ordered[ordered.length - 1].id);
    syncManagerSelectionUI();
}

export async function bulkToggleSelectedFavorite() {
    if (managerBulkBusy) return;
    const selected = selectedManagerTracks();
    if (!selected.length) return;
    const allFavorite = selected.every(track => Number(track.is_favorite) === 1);
    const nextState = allFavorite ? 0 : 1;
    setManagerBulkBusy(true);
    try {
        const response = await tunedropFetch('api.php?action=bulk_set_favorite_bookmarks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ids: selected.map(track => Number(track.id)),
                is_favorite: nextState,
            })
        });
        const data = await response.json();
        if (!data.success) {
            showToast(data.error || 'お気に入りを更新できませんでした。', 'error');
            return;
        }
        const youtubeIds = new Set((data.youtube_ids || []).map(String));
        if (!youtubeIds.size) selected.forEach(track => youtubeIds.add(String(track.youtube_id)));
        [...currentTracks, ...currentDetailTracks, ...currentQueue].forEach(track => {
            if (youtubeIds.has(String(track.youtube_id))) track.is_favorite = nextState;
        });
        const playing = currentQueue[currentTrackIndex];
        if (playing && youtubeIds.has(String(playing.youtube_id))) updatePlayerFavButton(nextState);
        filterTracks();
        showToast(nextState
            ? `${selected.length}曲をお気に入りに追加しました。`
            : `${selected.length}曲のお気に入りを解除しました。`);
    } catch (error) {
        console.error(error);
        showToast('お気に入りを更新できませんでした。もう一度お試しください。', 'error');
    } finally {
        setManagerBulkBusy(false);
    }
}

export async function bulkDeleteSelectedTracks() {
    if (managerBulkBusy) return;
    const ids = selectedManagerTrackIds();
    if (!ids.length) return;
    const confirmed = await showConfirm({
        title: '選択した曲を削除',
        message: `選択した${ids.length}曲をリストから削除しますか？`,
        confirmLabel: `${ids.length}曲を削除する`,
        danger: true,
    });
    if (!confirmed) return;
    setManagerBulkBusy(true);
    try {
        const response = await tunedropFetch('api.php?action=bulk_delete_bookmarks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await response.json();
        if (!data.success) {
            showToast(data.error || '削除に失敗しました。', 'error');
            return;
        }
        const deleted = Number(data.deleted) || 0;
        managerSelectedTrackIds.clear();
        managerSelectionAnchorId = null;
        await loadMyBookmarks(currentPlaylistId);
        await loadPlaylists();
        showToast(`${deleted}曲を削除しました。`, 'info');
    } catch (error) {
        console.error(error);
        showToast('削除できませんでした。時間をおいてお試しください。', 'error');
    } finally {
        setManagerBulkBusy(false);
    }
}

export function bulkOpenMoveModal() {
    const ids = selectedManagerTrackIds();
    if (!ids.length) return;
    closeMobileMenu();
    selectedTrackIdForMove = null;
    bulkMoveTrackIds = ids;
    populateMoveTargetPlaylists();
    const title = document.getElementById('move-track-modal-title');
    if (title) title.textContent = `${ids.length}曲を移動`;
    document.getElementById('move-track-modal').style.display = 'flex';
    const select = document.getElementById('move-target-playlist-select');
    if (select && typeof select.focus === 'function') select.focus();
}

export function playSelectedTracks() {
    const ordered = displayedManagerTracks()
        .filter(track => managerSelectedTrackIds.has(Number(track.id)));
    if (!ordered.length) {
        showToast('選択した曲が表示中の一覧にありません。', 'error');
        return;
    }
    playTrackFromQueue(0, ordered);
}

export function renderTracks(tracks) {
    const container = document.getElementById('my-bookmarks');
    if (!container) return;
    const validIds = new Set(currentTracks.map(track => Number(track.id)));
    for (const id of managerSelectedTrackIds) {
        if (!validIds.has(id)) managerSelectedTrackIds.delete(id);
    }
    container.innerHTML = '';
    if (tracks.length === 0) {
        container.innerHTML = '<p style="color:var(--text-sub);">曲が見つかりません。</p>';
        syncManagerSelectionUI();
        return;
    }

    const displayTracks = sortTracks(tracks, trackSortMode);

    displayTracks.forEach((track, index) => {
        const card = document.createElement('div');
        card.className = 'card draggable-track';
        card.draggable = !managerSelectMode;
        card.dataset.trackId = track.id;
        card.onclick = (event = {}) => {
            if (card._dragged || card._pointerDragged) return;
            if (managerSelectMode) {
                toggleTrackSelection(track.id, event);
                return;
            }
            // Ctrl/Cmd+クリックで選択モードに入る (デスクトップの定番操作)
            if (event.metaKey || event.ctrlKey) {
                managerSelectMode = true;
                managerSelectedTrackIds.add(Number(track.id));
                managerSelectionAnchorId = Number(track.id);
                renderTracks(filteredTracks());
                return;
            }
            playTrackFromQueue(index, displayTracks);
        };

        card.innerHTML = `
            <button type="button" class="card-select-box" role="checkbox" aria-checked="false"
                aria-label="この曲を選択" onclick="event.stopPropagation(); toggleTrackSelection(${track.id}, event)">
                <span class="material-symbols-rounded">check</span>
            </button>
            <button type="button" class="card-quick-fav${track.is_favorite == 1 ? ' is-active' : ''}"
                onclick="toggleTrackFavorite(${track.id}, event)"
                title="${track.is_favorite == 1 ? 'お気に入り解除' : 'お気に入りに追加'}"
                aria-label="${track.is_favorite == 1 ? 'お気に入り解除' : 'お気に入りに追加'}"
                aria-pressed="${track.is_favorite == 1 ? 'true' : 'false'}"><span class="material-symbols-rounded${track.is_favorite == 1 ? ' is-filled' : ''}">favorite</span></button>
            <div class="track-menu-container" onclick="event.stopPropagation()">
                <button class="track-menu-btn" onclick="toggleTrackMenu(event, this)"><span class="material-symbols-rounded">more_vert</span></button>
                <div class="track-dropdown-menu">
                    <button onclick="toggleTrackFavorite(${track.id}, event)"><span class="material-symbols-rounded">${track.is_favorite == 1 ? 'heart_broken' : 'favorite'}</span>${track.is_favorite == 1 ? 'お気に入り解除' : 'お気に入り追加'}</button>
                    <button onclick="openMoveModalFromMenu(event, ${track.id})"><span class="material-symbols-rounded">drive_file_move</span>移動</button>
                    <button onclick="openSaveTrackModalFor('${track.youtube_id}')"><span class="material-symbols-rounded">playlist_add</span>別のリストにも追加</button>
                    <button onclick="openInRadar('${track.youtube_id}')"><span class="material-symbols-rounded">radar</span>Radarで見る</button>
                    <button onclick="openYouTubeLink('${track.youtube_id}')"><span class="material-symbols-rounded">play_arrow</span>YouTubeで開く</button>
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
    syncManagerSelectionUI();
}

// ==========================================================
// プレイリスト内の表示切り替え
// ----------------------------------------------------------
// 「ブックマーク」= Manager のカード一覧
// 「プレイリスト」= Share と同じレイアウトの詳細画面 (view-playlist-detail)
// どちらの画面からでも同じ位置のスイッチで行き来できる。
// ==========================================================
export function updatePlaylistViewSwitch() {
    const inDetail = Boolean(document.getElementById('view-playlist-detail')?.classList.contains('active'));
    const bookmarksBtn = document.getElementById('btn-playlist-view-bookmarks');
    const detailBtn = document.getElementById('btn-playlist-view-detail');
    if (bookmarksBtn && detailBtn) {
        bookmarksBtn.classList.toggle('is-active', !inDetail);
        bookmarksBtn.setAttribute('aria-pressed', String(!inDetail));
        detailBtn.classList.toggle('is-active', inDetail);
        detailBtn.setAttribute('aria-pressed', String(inDetail));
    }
    // 詳細画面のスイッチは「自分のリスト」のときだけ出す
    // (他の人の公開リストには Manager 側のカード表示が無いため)
    const detailSwitch = document.getElementById('detail-view-switch');
    if (detailSwitch) detailSwitch.style.display = currentDetailIsMine ? 'inline-flex' : 'none';
    const detailBookmarksBtn = document.getElementById('btn-detail-view-bookmarks');
    const detailViewBtn = document.getElementById('btn-detail-view-detail');
    if (detailBookmarksBtn) detailBookmarksBtn.setAttribute('aria-pressed', 'false');
    if (detailViewBtn) detailViewBtn.setAttribute('aria-pressed', 'true');
}

// カード表示 (Manager のプレイリスト画面) へ戻る / 切り替える
export function showManagerPlaylistView() {
    const id = Number(pendingDetail.id) || Number(currentPlaylistId) || 0;
    navigateView('manager');
    if (id) selectPlaylist(id);
    updatePlaylistViewSwitch();
}

// ブックマークの並びを保存
export async function reorderBookmarks(orderedIds) {
    try {
        await tunedropFetch('api.php?action=reorder_bookmarks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ordered_ids: orderedIds })
        });
        // 画面は既に並び替え済み。DB保存のみ。
    } catch (err) { showToast('並び替えの保存に失敗しました。', 'error'); }
}

// ==========================================================
// 雰囲気 Radar: 音源実測特徴量 → UMAP で2次元マップ (kiite radar風)
// ==========================================================
let vibeMapData = [];    // APIから取得した全プロット
let vibeFiltered = [];   // 検索/カテゴリ絞り込み後
let radarRecommendOrder = null;  // おすすめ順 (Ollama 自動推薦) の youtube_id 配列
let radarRecommendTaste = '';    // おすすめの好み説明 (HUD 表示用)
let radarZoom = 1.0;
let radarPan = { x: 0, y: 0 };   // 正規化空間(0..1)でのパン量
let radarDragging = false;
let radarMoved = false;
let radarSelectedId = null;
let radarNeighborIds = null;   // 周辺9曲ボタンで下の一覧を絞り込んだときの youtube_id 群 (解除するまで維持)
let radarPlotCache = null;   // 直近 drawRadarMap の当たり判定用プロット (mousemove毎の再計算を避ける)
let radarDrawQueued = false; // ドラッグ/ホイール中の再描画まとめ用
// マップに描画する最大点数 (0 = すべて)。全体表示では間引き、拡大すると詳細を増やす。
const RADAR_DISPLAY_LIMITS = [0, 150, 250, 500];
const RADAR_DISPLAY_LIMIT_DEFAULT = 250;
let radarDisplayLimit = RADAR_DISPLAY_LIMIT_DEFAULT;
try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('tunedrop_radar_limit') : null;
    const saved = raw === null ? NaN : Number(raw);
    if (RADAR_DISPLAY_LIMITS.includes(saved)) radarDisplayLimit = saved;
} catch (_) { /* localStorage が無い環境では既定値 */ }
// 4軸ガイドの向きは全データの相関で決まり、描画中に変わらない。毎フレーム再計算しない。
let radarAxisCache = { source: null, value: null };
// 表示上限の間引き結果。パン中は同じ間引きを使い回し、ズーム/選択/データ変更時だけ再計算する。
let radarSelectionCache = { source: null, limit: null, zoom: null, required: '', ids: null };
// 選択中の曲の周辺6曲キャッシュ。パン/ズーム中は再ソートしない。
let radarNearCache = { source: null, selectedId: null, ids: new Set() };

// ==========================================================
// Radar → ブックマーク (保存)
// ----------------------------------------------------------
// Radarのマップは全ユーザーのブックマークをまとめたものなので、
// 見つけた曲はその場で自分のリストへ保存できるようにする。
//   - radarSavedIds  … 自分のブックマークにある youtube_id (保存済み表示用)
//   - radarSaveTarget … 保存モーダルで選択中の曲
// ==========================================================
let radarSavedIds = new Set();
let radarSavedLoadedAt = 0;          // 保存済み一覧の取得時刻 (ミリ秒)
let radarSavedRequest = null;        // 取得中のリクエスト (多重取得の防止)
let radarSaveTarget = null;          // { youtube_id, title, channel }

const CATEGORY_COLORS = {
    'Vocaloid': '#ff5c7a',
    'J-POP': '#ff9d3c',
    'Anime': '#7ad0ff',
    'Lo-Fi': '#b58cff',
    'Other': '#9aa0a6',
};

export function radarCategoryColor(cat) {
    return CATEGORY_COLORS[cat] || CATEGORY_COLORS['Other'];
}

// 特徴量を生成したエンジンの表示ラベル
export function radarEngineLabel(engine) {
    if (engine === 'gemini') return 'AI(Gemini)';
    if (engine === 'ollama') return 'AI(Ollama)';
    if (engine === 'rules') return 'AI推定(ルール)';
    return engine || '—';
}

// BPM が音源実測か AI 推定かの表示ラベル ('essentia' は旧エンジン行の互換値)
export function radarBpmLabel(features) {
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
export function radarVibeLabel(features) {
    const f = features || {};
    if (f.vibe_tags && f.vibe_tags.length) return f.vibe_tags.slice(0, 3).join('・');
    return f.mood || '';
}

// マップの点・曲カード・ツールチップで共通に使う表示ラベル一式
export function radarTrackLabels(track) {
    const f = (track && track.features) || {};
    return {
        category: (track && track.category) || 'Other',
        tempo: (f.tempo > 0) ? `${Math.round(f.tempo)} BPM` : '—',
        bpmSource: radarBpmLabel(f),
        vibe: radarVibeLabel(f),
        engine: radarEngineLabel(f.engine),
    };
}

// 4象限ガイド（エネルギー×明るさ）の向きを推定する。
// UMAP の軸はデータごとに回転するため、energy / valence と座標 (x, y) の
// 相関から「エネルギーが高い方向」「明るい方向」を求め、ガイドの向きにする。
// 相関が弱い・データ不足なら null（描画側は既定の向きへフォールバックする）。
export function radarAxisOrientation(tracks) {
    const xs = [], ys = [], es = [], vs = [];
    (tracks || []).forEach(t => {
        const f = t?.features || {};
        const e = Number(f.energy), v = Number(f.valence);
        const x = Number(f.x), y = Number(f.y);
        if (![e, v, x, y].every(Number.isFinite)) return;
        xs.push(x); ys.push(y); es.push(e); vs.push(v);
    });
    // 相関が安定しない少数ではガイドを出さない
    if (xs.length < 8) return null;
    const mean = a => a.reduce((s, n) => s + n, 0) / a.length;
    const corr = (a, b) => {
        const ma = mean(a), mb = mean(b);
        let cov = 0, sa = 0, sb = 0;
        for (let i = 0; i < a.length; i++) {
            const da = a[i] - ma, db = b[i] - mb;
            cov += da * db; sa += da * da; sb += db * db;
        }
        if (sa <= 0 || sb <= 0) return 0;
        return cov / Math.sqrt(sa * sb);
    };
    // 画面座標系そのまま: x は右が +、y は下が +（キャンバスと同じ向き）。
    // 正規化 y も下向きなので反転は不要で、相関の符号をそのまま方向に使える。
    const ex = corr(es, xs), ey = corr(es, ys);
    const vx = corr(vs, xs), vy = corr(vs, ys);
    const norm = (dx, dy) => {
        const len = Math.hypot(dx, dy);
        // ほぼ無相関なら向きを決めない
        if (!(len > 0.15)) return null;
        return { dx: dx / len, dy: dy / len, strength: Math.min(1, len) };
    };
    const energy = norm(ex, ey), valence = norm(vx, vy);
    if (!energy && !valence) return null;
    return { energy, valence, n: xs.length };
}

// 楽曲をマップ上のピクセル座標へ射影する (パン + ズーム適用済み)。
// 座標 (features.x / features.y) が無い曲は円配置へフォールバックする。
// 描画 (drawRadarMap) と当たり判定 (bindRadarPointer) が同じ式を使うため共通化している。
export function radarPlotPoints(tracks, W, H) {
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
            x,
            y,
            px: W / 2 + (x - 0.5) * W * radarZoom + radarPan.x * W,
            py: H / 2 + (y - 0.5) * H * radarZoom + radarPan.y * H,
        };
    });
}

/**
 * 表示上限に合わせてプロットを間引く (Kiite Radar 風の focus+context)。
 *
 * - 全体表示では上限まで点を減らし、拡大するほど予算を増やして詳細を出す
 * - 正規化座標のグリッドごとに代表点を均等に選ぶので、map の形が偏らない
 * - 選択中の曲と周辺曲は必ず残す (選択・周辺線が消えない)
 * - 同じデータ・同じズームなら常に同じ点が選ばれる (ちらつき防止)
 *
 * @param {Array} plot radarPlotPoints() の結果
 * @param {{limit?: number, zoom?: number, requiredIds?: Array<string|number>}} options
 */
export function radarSelectPlotPoints(plot, options = {}) {
    const points = Array.isArray(plot) ? plot : [];
    const limit = Number(options.limit || 0);
    if (!Number.isFinite(limit) || limit <= 0 || points.length <= limit) return points;

    // ズームアウト時は少なく、ズームイン時は多く (最大4倍まで)
    const zoom = Math.max(0.25, Number(options.zoom) || 1);
    const boost = Math.max(0.6, Math.min(4, Math.sqrt(zoom)));
    const target = Math.min(points.length, Math.max(1, Math.round(limit * boost)));
    if (target >= points.length) return points;

    const requiredIds = new Set((options.requiredIds || []).filter(Boolean));
    const required = points.filter(point => requiredIds.has(point?.t?.youtube_id));
    const rest = points.filter(point => !requiredIds.has(point?.t?.youtube_id));
    const budget = Math.max(0, target - required.length);
    if (!budget) return required;

    // 描画予算からセルサイズを決める。点が多いほど細かいセルになる。
    const cell = Math.sqrt(1 / Math.max(1, budget));
    const buckets = new Map();
    rest.forEach((point, index) => {
        const f = point?.t?.features || {};
        const px = Number(point?.x);
        const py = Number(point?.y);
        const fx = Number(f.x);
        const fy = Number(f.y);
        const x = Number.isFinite(px) ? px : (Number.isFinite(fx) ? fx : 0.5);
        const y = Number.isFinite(py) ? py : (Number.isFinite(fy) ? fy : 0.5);
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        const key = `${cx}:${cy}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ point, index, cx, cy });
    });
    // セル中心に近い点を優先すると、密集地の「にじみ」が減る
    for (const list of buckets.values()) {
        list.sort((a, b) => {
            const ax = (a.cx + 0.5) * cell, ay = (a.cy + 0.5) * cell;
            const bx = (b.cx + 0.5) * cell, by = (b.cy + 0.5) * cell;
            const af = a.point?.t?.features || {};
            const bf = b.point?.t?.features || {};
            const axv = Number.isFinite(Number(a.point?.x)) ? Number(a.point.x) : (Number.isFinite(Number(af.x)) ? Number(af.x) : 0.5);
            const ayv = Number.isFinite(Number(a.point?.y)) ? Number(a.point.y) : (Number.isFinite(Number(af.y)) ? Number(af.y) : 0.5);
            const bxv = Number.isFinite(Number(b.point?.x)) ? Number(b.point.x) : (Number.isFinite(Number(bf.x)) ? Number(bf.x) : 0.5);
            const byv = Number.isFinite(Number(b.point?.y)) ? Number(b.point.y) : (Number.isFinite(Number(bf.y)) ? Number(bf.y) : 0.5);
            const da = Math.hypot(axv - ax, ayv - ay);
            const db = Math.hypot(bxv - bx, byv - by);
            return (da - db) || (a.index - b.index);
        });
    }
    // セルを均等に巡回して1点ずつ選ぶ (特定のクラスタだけにならない)
    const keys = [...buckets.keys()].sort();
    const picked = [];
    let round = 0;
    while (picked.length < budget) {
        let added = false;
        for (const key of keys) {
            const list = buckets.get(key);
            if (round >= list.length) continue;
            picked.push(list[round].point);
            added = true;
            if (picked.length >= budget) break;
        }
        if (!added) break;
        round += 1;
    }
    return [...required, ...picked];
}

/** マップの表示上限を変更する (0 = すべて)。設定は次回以降も保持する。 */
export function setRadarDisplayLimit(value) {
    const next = Number(value);
    radarDisplayLimit = RADAR_DISPLAY_LIMITS.includes(next) ? next : RADAR_DISPLAY_LIMIT_DEFAULT;
    try { localStorage.setItem('tunedrop_radar_limit', String(radarDisplayLimit)); } catch (_) { /* noop */ }
    const select = document.getElementById('radar-display-limit');
    if (select) select.value = String(radarDisplayLimit);
    drawRadarMap(vibeFiltered);
    updateRadarCount();
}

/** 表示上限セレクトを現在値に合わせる (画面初期化時)。 */
export function syncRadarDisplayLimitControl() {
    const select = document.getElementById('radar-display-limit');
    if (select) select.value = String(radarDisplayLimit);
}

// マップ上の吹き出し (マウスホバー時のツールチップ) の中身
export function radarTooltipHtml(track) {
    const { category, tempo, bpmSource, vibe, engine } = radarTrackLabels(track);
    return `<b>${escapeHtml(track.title)}</b><span>${escapeHtml(track.channel || '')}</span>`
        + `<span>${escapeHtml(category)} · ${tempo}${bpmSource ? ' ' + escapeHtml(bpmSource) : ''}`
        + `${vibe ? ' · ' + escapeHtml(vibe) : ''}${engine ? ' · ' + escapeHtml(engine) : ''}</span>`;
}

// おすすめ順 (Ollama による自動推薦) を取得する。失敗時は null。
// バックエンドは 12時間キャッシュしているため、通常は即座に返る。
export async function fetchRadarRecommend() {
    try {
        const res = await tunedropFetch('api.php?action=radar_recommend');
        const rec = await res.json();
        if (rec && rec.success && Array.isArray(rec.order)) {
            return { order: rec.order, taste: rec.taste || '' };
        }
    } catch (_) { /* 取得失敗時は従来の並びのまま */ }
    return null;
}

// 取得済みのおすすめ順で vibeMapData を並べ替える (order が無効なら何もしない)。
export function applyRadarOrder(order, taste) {
    radarRecommendOrder = Array.isArray(order) ? order : null;
    radarRecommendTaste = taste || '';
    if (!Array.isArray(order) || !order.length) return;
    const rank = new Map(order.map((id, i) => [id, i]));
    vibeMapData.sort((a, b) => {
        const ai = rank.has(a.youtube_id) ? rank.get(a.youtube_id) : Number.MAX_SAFE_INTEGER;
        const bi = rank.has(b.youtube_id) ? rank.get(b.youtube_id) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
    });
}

// 旧サーバーの座標も、全体が狭い場合だけ拡大。局所的な密集や不規則な間隔は残す。
export function spreadLegacyRadarMap(data) {
    if (Number(data.layout_version) >= 3) return data;
    const points = (data.points || []).map(p => ({ ...p, features: { ...p.features } }));
    const valid = points.filter(p => Number.isFinite(p.features.x) && Number.isFinite(p.features.y));
    if (valid.length >= 3) {
        const lo = ['x', 'y'].map(key => Math.min(...valid.map(p => p.features[key])));
        const hi = ['x', 'y'].map(key => Math.max(...valid.map(p => p.features[key])));
        const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
        if (span > 1e-12 && span < 0.65) {
            const scale = 0.8 / span;
            valid.forEach(p => ['x', 'y'].forEach((key, axis) => {
                p.features[key] = 0.5 + (p.features[key] - (lo[axis] + hi[axis]) / 2) * scale;
            }));
        }
    }
    return { ...data, points, layout_version: 3 };
}

let radarLoadGeneration = 0;

export async function loadRadarData() {
    // 未ログイン (デモ表示) ではAPIを呼ばない
    if (!hasAccountSession()) return;
    const generation = ++radarLoadGeneration;
    const hud = document.getElementById('radar-map-hud');
    const statusBtn = document.getElementById('btn-vibe-radar');
    if (statusBtn) statusBtn.innerText = '読み込み中...';
    if (hud && !vibeMapData.length) hud.textContent = '楽曲マップを読み込み中…';
    try {
        // マップをおすすめと並列に取得する (おすすめは12時間キャッシュで即返る)。
        const mapPromise = tunedropFetch('api.php?action=radar_map').then(r => r.json());
        const recPromise = fetchRadarRecommend();
        const data = spreadLegacyRadarMap(await mapPromise);
        if (generation !== radarLoadGeneration) return;
        if (!data.success && data.error) {
            if (hud) hud.textContent = data.error;
            return;
        }
        vibeMapData = (data.points || []).map(p => ({
            youtube_id: p.youtube_id,
            title: p.title,
            channel: p.channel,
            category: p.category || 'Other',
            playlist_name: p.playlist_name,
            author: p.author,
            added_at: p.added_at,       // 新着順 (ブックマークへ追加した日時)
            features: p.features || {},
        }));
        // おすすめを待たず、取得できた座標を先に表示する。
        const eng = data.points && data.points.length && data.points[0].features
            ? data.points[0].features.engine : null;
        const engLabel = eng === 'gemini' ? 'Gemini AI'
            : (eng === 'ollama' ? 'Ollama AI' : (eng === 'rules' ? 'AI推定(ルール)' : ''));
        const pendingCount = (data.pending && data.pending.length) || 0;
        const pendingLabel = pendingCount ? ` · ${pendingCount} 曲は解析待ち` : '';
        // おすすめ順 (Ollama 自動推薦) の好み説明があれば末尾に添える
        const tasteLabel = radarRecommendTaste ? ` · おすすめ: ${radarRecommendTaste}` : '';
        if (hud) hud.textContent = data.method === 'umap'
            ? `${data.count} 曲を AI×UMAP で表示${engLabel ? ' · ' + engLabel : ''}${pendingLabel}${tasteLabel}`
            : `${data.count} 曲を表示${pendingLabel}${tasteLabel}`;
        radarPendingCount = pendingCount;
        radarLastTotal = vibeMapData.length;
        radarStripLimit = 30;
        buildRadarVibeOptions();
        buildRadarTempoOptions();
        radarOptionsSig = radarDataSig();
        updateRadarAnalyzeButton();
        applyRadarFilter(false);
        void recPromise.then(rec => {
            if (!rec || generation !== radarLoadGeneration) return;
            applyRadarOrder(rec.order, rec.taste);
            if (hud && hud.textContent.startsWith(`${data.count} 曲`)) {
                hud.textContent = hud.textContent.split(' · おすすめ:')[0]
                    + (rec.taste ? ` · おすすめ: ${rec.taste}` : '');
            }
            applyRadarFilter(true);
        }).catch(() => {});
    } catch (err) {
        if (generation !== radarLoadGeneration) return;
        console.error('Radar map error:', err);
        if (hud) hud.textContent = 'マップを読み込めませんでした。時間をおいて再度開いてください。';
    } finally {
        if (generation === radarLoadGeneration) updateRadarAnalyzeButton();
    }
}

// 未解析曲数に応じてサイドバーの解析ボタンの表示を変える (0件なら押せない)
export function updateRadarAnalyzeButton() {
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

export async function loadVibeRadar() {
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
            const skipped = (started.skipped_gemini || []).length;
            if (skipped && hud) {
                hud.textContent = `Gemini解析済みの ${skipped} 曲は対象外です（管理者ページから再解析できます）`;
            }
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

export function radarDataSig() {
    return `${vibeMapData.length}:${vibeMapData.length ? vibeMapData[0].youtube_id : ''}`;
}

// 絞り込み選択肢の欠落を自己修復する (古いJSキャッシュや取得順序の入れ違いで空のまま残った場合用)。
// データ署名が変わったか、選択肢が空のときだけ作り直す (入力中の再構築で開いている選択肢を閉じないため)
export function ensureRadarFilterOptions() {
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

export function queueRadarFilter() {
    //  typing every keystroke resets view previously; now debounce + preserve view
    if (radarFilterTimer) clearTimeout(radarFilterTimer);
    radarFilterTimer = setTimeout(() => { radarFilterTimer = null; applyRadarFilter(true); }, 150);
}

export function clearRadarSearch() {
    const input = document.getElementById('radar-title-search');
    if (input) input.value = '';
    radarStripLimit = 30;
    applyRadarFilter(true);
    if (input) input.focus();
}

// 検索欄の Enter=先頭結果を再生、Escape=クリア
export function onRadarSearchKey(e) {
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
export function clearRadarFilters() {
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

export function radarTempoValue(t) {
    const v = Number(t?.features?.tempo);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

// 新着順の比較用: 追加日時 (added_at: 'YYYY-MM-DD HH:MM:SS') を数値にする。
// 日時が無い曲は 0 (= 最後に回す) として扱う。
export function radarAddedTime(t) {
    const value = Date.parse(String(t?.added_at || '').replace(' ', 'T'));
    return Number.isFinite(value) ? value : 0;
}

// 並び順を適用する。'default' は API の返却順 (おすすめ順) のまま。
// 元の配列は変更せず、並べ替えた新しい配列を返す。
export function sortRadarTracks(tracks, sort) {
    if (sort === 'newest') {
        return tracks.slice().sort((a, b) => radarAddedTime(b) - radarAddedTime(a));
    }
    if (sort === 'title') {
        return tracks.slice().sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ja'));
    }
    if (sort === 'bpm-asc') {
        return tracks.slice().sort((a, b) => (radarTempoValue(a) || 9999) - (radarTempoValue(b) || 9999));
    }
    if (sort === 'bpm-desc') {
        return tracks.slice().sort((a, b) => radarTempoValue(b) - radarTempoValue(a));
    }
    return tracks;
}

// 大まかな3区分の固定選択肢 (細かい10刻みではなく「ゆったり/ふつう/速め」で選ぶ)
const RADAR_TEMPO_BANDS = [
    { key: 'slow', label: 'ゆったり (~100)', lo: 0, hi: 100 },
    { key: 'mid', label: 'ふつう (100〜140)', lo: 100, hi: 140 },
    { key: 'fast', label: '速め (140〜)', lo: 140, hi: Infinity },
];
let radarTempoBands = [];

export function buildRadarTempoOptions() {
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

export function radarTempoMatch(t, key) {
    if (!key) return true;
    const band = RADAR_TEMPO_BANDS.find(b => b.key === key);
    if (!band) return true;
    const bpm = radarTempoValue(t);
    if (!bpm) return false;   // BPM未取得の曲はBPM指定がある場合のみ対象外
    return bpm >= band.lo && bpm < band.hi;
}

export function radarVibeMatch(t, key) {
    if (!key) return true;
    const f = t?.features || {};
    if (Array.isArray(f.vibe_tags) && f.vibe_tags.includes(key)) return true;
    return (f.mood || '') === key;
}

// 全曲から雰囲気タグ候補を作る (件数が多い順・最大12件)
export function buildRadarVibeOptions() {
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

// モバイル: マップの高さを広げる / 元に戻す (PC では拡大ボタンを出さない)。
// 高さが変わるとキャンバスの実サイズも変わるため、レーダーを描き直す。
export function toggleRadarMapExpanded() {
    const expanded = document.body.classList.toggle('radar-map-expanded');
    const button = document.getElementById('btn-radar-map-expand');
    if (button) {
        const label = expanded ? 'マップを縮める' : 'マップを広げる';
        button.setAttribute('aria-pressed', String(expanded));
        button.title = label;
        button.setAttribute('aria-label', label);
        button.textContent = expanded ? '縮小' : '拡大';
    }
    queueRadarDraw();
}

// ズームと位置を初期表示 (全曲が収まる全体表示) に戻す。
export function resetRadarView() {
    const view = radarFitView(vibeMapData);
    if (view) { radarZoom = view.zoom; radarPan = view.pan; }
    else { radarZoom = 1.0; radarPan = { x: 0, y: 0 }; }
    drawRadarMap(vibeFiltered);
}

export function applyRadarFilter(preserveView) {
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
    vibeFiltered = sortRadarTracks(vibeFiltered, sort);
    if (!preserveView) {
        // 初期表示は「全体表示」ボタンと同じズーム率にする (全曲が収まるように)。
        const view = radarFitView(vibeFiltered);
        if (view) { radarZoom = view.zoom; radarPan = view.pan; }
        else { radarZoom = 1.0; radarPan = { x: 0, y: 0 }; }
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
    updateRadarFiltersToggle();
}

export function updateRadarCount() {
    const el = document.getElementById('radar-result-count');
    if (!el) return;
    const total = vibeMapData.length;
    const shown = vibeFiltered.length;
    el.textContent = total ? `${shown} / ${total}曲` : '';
    el.title = radarDisplayLimit > 0
        ? `地図の描画上限: ${radarDisplayLimit}点。拡大すると詳細が増えます。`
        : 'すべての曲を地図に描画します。';
    const note = document.getElementById('radar-display-note');
    if (note) {
        note.textContent = radarDisplayLimit > 0 && shown > radarDisplayLimit
            ? `地図は最大${radarDisplayLimit}点（拡大で詳細）`
            : '';
    }
}

export function updateRadarClearButton() {
    const btn = document.getElementById('btn-radar-search-clear');
    const input = document.getElementById('radar-title-search');
    if (!btn || !input) return;
    btn.style.display = input.value ? 'block' : 'none';
}

// ==========================================================
// モバイル Radar: 絞り込み (雰囲気 / BPM / 並び順 / 条件クリア) のモーダル
// ----------------------------------------------------------
// スマホでは絞り込みを常時並べるとマップの高さを奪ううえ文字も切れるため、
// 「絞り込み」ボタンで開く画面中央のモーダルにする。
// PCでは同じ要素をツールバー内へそのまま横並びで表示する
// (表示の切り替えは CSS だけ。JS は body のクラスを付け外しする)。
// ==========================================================
const RADAR_FILTER_IDS = ['radar-title-search', 'radar-category-filter', 'radar-vibe-filter', 'radar-tempo-filter', 'radar-sort'];
const RADAR_SUB_FILTER_IDS = ['radar-vibe-filter', 'radar-tempo-filter', 'radar-sort'];

export function activeRadarFilters(ids) {
    return ids.filter(id => {
        const el = document.getElementById(id);
        if (!el) return false;
        // 並び順は「おすすめ順(既定)」以外のときだけ適用中とみなす
        return id === 'radar-sort' ? Boolean(el.value) && el.value !== 'default' : Boolean(el.value);
    });
}

// シートを使う画面幅か (メニューと同じ 600px 以下)
export function isRadarFiltersSheetViewport() {
    return typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 600px)').matches
        : window.innerWidth <= 600;
}

export function isRadarFiltersOpen() {
    return document.body.classList.contains('radar-filters-open');
}

// スマホでシートとして開いているか (PCでは常に false = Escや背景タップの対象外)
export function isRadarFiltersSheetOpen() {
    return isRadarFiltersOpen() && isRadarFiltersSheetViewport();
}

export function openRadarFilters(options = {}) {
    const wasOpen = isRadarFiltersOpen();
    closeMobileMenu();   // モーダル表示中はメニューを畳んでおく (ログインモーダルと同じ)
    document.body.classList.add('radar-filters-open');
    const panel = document.getElementById('radar-subcontrols');
    if (panel) {
        // 開いている間だけモーダルとして読み上げる (PCの横並びでは通常のツールバー)
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        // 開いた直後だけフォーカスを移す (適用中の再表示で select から奪わないため)
        if (!wasOpen && options.focus !== false && typeof panel.focus === 'function') panel.focus();
    }
    const toggle = document.getElementById('btn-radar-filters-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
}

export function closeRadarFilters() {
    if (!isRadarFiltersOpen()) return;
    document.body.classList.remove('radar-filters-open');
    const panel = document.getElementById('radar-subcontrols');
    if (panel) {
        panel.removeAttribute('role');
        panel.removeAttribute('aria-modal');
    }
    const toggle = document.getElementById('btn-radar-filters-toggle');
    if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        // 閉じたあとに操作位置を見失わないよう、開いたボタンへ戻す
        if (isRadarFiltersSheetViewport() && typeof toggle.focus === 'function') toggle.focus();
    }
}

export function toggleRadarFilters() {
    if (isRadarFiltersOpen()) closeRadarFilters();
    else openRadarFilters();
}

// 開閉を一括で指定する (自動オープンでは focus を奪わない)
export function setRadarFiltersOpen(open, options) {
    if (open) openRadarFilters(options);
    else closeRadarFilters();
}

// 適用中の条件を、絞り込みボタン (件数表示) と「条件クリア」へ反映する
export function updateRadarFiltersToggle() {
    const count = activeRadarFilters(RADAR_FILTER_IDS).length;
    const toggle = document.getElementById('btn-radar-filters-toggle');
    if (toggle) {
        toggle.textContent = count ? `絞り込み(${count})` : '絞り込み';
        toggle.classList.toggle('is-active', count > 0);
        toggle.title = count ? `絞り込みを開く（${count}件適用中）` : '雰囲気・BPM・並び順の絞り込みを開く';
    }
    const clear = document.getElementById('btn-radar-clear');
    // モーダルの4つ目の枠に常に置く。条件が無いときは is-empty を付けて、
    // PCのツールバーでは CSS 側で隠す (スマホでは押せる状態のまま出す)
    if (clear) clear.classList.toggle('is-empty', count === 0);
    // 畳んだままだと変えられない条件 (雰囲気・BPM・並び順) はシートを開いて見せる
    if (activeRadarFilters(RADAR_SUB_FILTER_IDS).length && isRadarFiltersSheetViewport()) {
        setRadarFiltersOpen(true, { focus: false });
    }
}

// 画面幅が広がったら (端末の回転など) シートは畳む
window.addEventListener('resize', () => {
    if (isRadarFiltersOpen() && !isRadarFiltersSheetViewport()) closeRadarFilters();
});

// ==========================================================
// Radar → ブックマーク (保存) の操作
// ----------------------------------------------------------
// マップや一覧で選んだ曲を、その場で自分のリストへ保存する。
// 保存先は毎回モーダルで選べるが、既定は「未整理」(先頭に表示)。
// ==========================================================
export function currentRadarTrack() {
    if (!radarSelectedId) return null;
    return vibeFiltered.find(t => t.youtube_id === radarSelectedId)
        || vibeMapData.find(t => t.youtube_id === radarSelectedId)
        || null;
}

export function radarTrackSaved(youtubeId) {
    return Boolean(youtubeId) && radarSavedIds.has(String(youtubeId));
}

// 自分のブックマーク（全リスト）の youtube_id を取得して「保存済み」表示に使う。
// 解析中は loadRadarData が連続で走るため、60秒はキャッシュする。
export function loadRadarSavedTracks(force = false) {
    if (!force && radarSavedLoadedAt && Date.now() - radarSavedLoadedAt < 60000) {
        return Promise.resolve(radarSavedIds);
    }
    if (radarSavedRequest) return radarSavedRequest;
    radarSavedRequest = (async () => {
        try {
            const response = await tunedropFetch('api.php?action=get_my_bookmarks&playlist_id=null');
            const tracks = response.ok ? await response.json() : [];
            radarSavedIds = new Set((Array.isArray(tracks) ? tracks : [])
                .map(track => String((track && track.youtube_id) || ''))
                .filter(Boolean));
            radarSavedLoadedAt = Date.now();
        } catch (error) {
            // 保存状態が取れなくても保存自体はできるので、ここでは黙って諦める
            radarSavedLoadedAt = Date.now();
        } finally {
            radarSavedRequest = null;
        }
        refreshRadarSavedUi();
        return radarSavedIds;
    })();
    return radarSavedRequest;
}

// サイドバーの「ブックマークに保存」ボタンを選択中の曲に合わせる
export function updateRadarSaveButton() {
    const button = document.getElementById('btn-radar-save');
    if (!button) return;
    const track = currentRadarTrack();
    const saved = track ? radarTrackSaved(track.youtube_id) : false;
    button.disabled = !track;
    button.classList.toggle('is-saved', saved);
    button.textContent = !track
        ? '🔖 曲を選んで保存'
        : (saved ? '✓ 保存済み（別のリストにも保存）' : '🔖 ブックマークに保存');
    button.title = !track
        ? '曲を選ぶと押せます'
        : '選択中の曲を自分のリストに保存します';
}

// サイドバーのボタン: 選択中の曲を保存する
export function openRadarSaveForSelected() {
    const track = currentRadarTrack();
    if (!track) {
        showToast('先にマップか一覧から曲を選んでください。', 'info');
        return;
    }
    openRadarSaveModal(track.youtube_id);
}

// 保存先を選ぶモーダルを開く (Radar の曲 / 再生中の曲で共通)
export async function openSaveTrackModal(track) {
    if (!track || !track.youtube_id) return;
    radarSaveTarget = { youtube_id: track.youtube_id, title: track.title || '', channel: track.channel || '' };
    closeMobileMenu();   // モーダル表示中はドロワーを畳む
    const titleEl = document.getElementById('radar-save-track');
    if (titleEl) titleEl.textContent = track.title || track.youtube_id;
    const listEl = document.getElementById('radar-save-playlists');
    if (listEl) listEl.innerHTML = '<p class="radar-save-empty">リストを読み込み中…</p>';
    const modal = document.getElementById('radar-save-modal');
    if (modal) modal.style.display = 'flex';
    if (!allPlaylists.length) {
        try { await loadPlaylists(); } catch (error) { /* 開いたまま一覧を出す */ }
    }
    if (!radarSaveTarget) return;   // 読み込み中に閉じられた
    renderRadarSaveChoices();
}

// Radar の youtube_id から保存先モーダルを開く
export function openRadarSaveModal(youtubeId) {
    const track = vibeFiltered.find(t => t.youtube_id === youtubeId)
        || vibeMapData.find(t => t.youtube_id === youtubeId);
    if (!track) return;
    return openSaveTrackModal(track);
}

// youtube_id から曲情報を探して保存モーダルを開く (詳細・Managerの ⋮ メニュー用)
export function openSaveTrackModalFor(youtubeId) {
    if (!youtubeId) return;
    const track = currentDetailTracks.find(t => t.youtube_id === youtubeId)
        || currentTracks.find(t => t.youtube_id === youtubeId)
        || currentQueue.find(t => t.youtube_id === youtubeId)
        || vibeMapData.find(t => t.youtube_id === youtubeId)
        || vibeFiltered.find(t => t.youtube_id === youtubeId)
        || { youtube_id: youtubeId };
    closeTrackMenus();
    openSaveTrackModal(track);
}

// YouTube の動画ページを新しいタブで開く
export function openYouTubeLink(youtubeId) {
    if (!youtubeId) return;
    closeTrackMenus();
    window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`, '_blank', 'noopener');
}

// Radar でこの曲を表示する (解析済みの曲のみ)
export async function openInRadar(youtubeId) {
    if (!youtubeId) return;
    closeTrackMenus();
    navigateView('radar');
    const lookup = () => vibeFiltered.find(t => t.youtube_id === youtubeId)
        || vibeMapData.find(t => t.youtube_id === youtubeId);
    let track = lookup();
    for (let i = 0; i < 60 && !track; i++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        track = lookup();
    }
    if (!track) {
        showToast('この曲はまだRadarにありません。Radarで解析すると表示されます。', 'info');
        return;
    }
    // 検索・カテゴリで隠れている場合は解除して表示する
    if (!vibeFiltered.some(t => t.youtube_id === youtubeId)) {
        clearRadarFilters();
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    selectRadarTrack(youtubeId, { center: true });
    showToast('Radarで表示しました。', 'info');
}

// プレイヤーの「保存」ボタン: 今聴いている曲をそのまま保存する
export function saveCurrentTrackFromPlayer() {
    const track = currentQueue[currentTrackIndex];
    if (!track || !track.youtube_id) {
        showToast('再生中の曲がありません。', 'info');
        return;
    }
    openSaveTrackModal(track);
}

// 保存先リストの一覧を描画する (未整理を先頭に、押しやすい行ボタンで並べる)
export function renderRadarSaveChoices() {
    const container = document.getElementById('radar-save-playlists');
    if (!container || !radarSaveTarget) return;
    container.innerHTML = '';
    const rank = list => (list.system_key === 'inbox' ? 0 : (isSystemPlaylist(list) ? 1 : 2));
    const lists = [...allPlaylists].sort((a, b) => (rank(a) - rank(b))
        || ((Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)));
    if (!lists.length) {
        container.innerHTML = '<p class="radar-save-empty">保存先のリストがありません。Managerでリストを作成してください。</p>';
        return;
    }
    lists.forEach(list => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'radar-save-choice';
        button.dataset.playlistId = String(list.id);
        const isInbox = list.system_key === 'inbox';
        const count = Number(list.track_count) || 0;
        button.innerHTML = `
            <span class="material-symbols-rounded radar-save-choice-icon">${isInbox ? 'bookmark_add' : 'queue_music'}</span>
            <span class="radar-save-choice-text">
                <span class="radar-save-choice-name">${escapeHtml(list.name)}${isInbox ? '<span class="radar-save-choice-badge">おすすめ</span>' : ''}</span>
                <span class="radar-save-choice-meta">${count}曲${isSystemPlaylist(list) ? ' · 固定タブ' : ''}${Number(list.is_public) === 1 ? ' · 公開中' : ''}</span>
            </span>`;
        button.onclick = (event) => { event.stopPropagation(); saveRadarTrackTo(list.id, button); };
        container.appendChild(button);
    });
}

// 選んだリストへ保存する
export async function saveRadarTrackTo(playlistId, button) {
    const target = radarSaveTarget;
    if (!target || !target.youtube_id) return;
    const list = allPlaylists.find(item => String(item.id) === String(playlistId));
    if (button) { button.disabled = true; button.classList.add('is-saving'); }
    try {
        const response = await tunedropFetch('api.php?action=add_bookmark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                youtube_id: target.youtube_id,
                playlist_id: playlistId,
                title: target.title,
                channel: target.channel,
            })
        });
        const data = await response.json();
        if (data && data.success) {
            radarSavedIds.add(String(target.youtube_id));
            radarSavedLoadedAt = 0;   // 次回は最新の保存状態を取り直す
            closeRadarSaveModal();
            refreshRadarSavedUi();
            showToast(`「${list ? list.name : 'リスト'}」に保存しました。`);
            loadPlaylists().catch(() => {});   // サイドバーやカードの曲数を更新
        } else {
            const message = (data && data.error) || '保存できませんでした。';
            // 同じリストに既にある場合も「保存済み」として扱う
            if (message.includes('既に')) {
                radarSavedIds.add(String(target.youtube_id));
                refreshRadarSavedUi();
            }
            showToast(message, 'error');
            if (button) { button.disabled = false; button.classList.remove('is-saving'); }
        }
    } catch (error) {
        showToast('保存できませんでした。時間をおいてお試しください。', 'error');
        if (button) { button.disabled = false; button.classList.remove('is-saving'); }
    }
}

export function closeRadarSaveModal() {
    const modal = document.getElementById('radar-save-modal');
    if (modal) modal.style.display = 'none';
    radarSaveTarget = null;
}

// 保存状態の表示を更新する (一覧の横スクロール位置は保つ)
export function refreshRadarSavedUi() {
    const strip = document.getElementById('vibe-track-strip');
    const scrollLeft = strip ? strip.scrollLeft : 0;
    updateRadarSelectedPanel();
    renderVibeTracks(vibeFiltered, false);
    if (strip) strip.scrollLeft = scrollLeft;
    updateRadarSaveButton();
}

// 保存した曲 (すべてのブックマーク) を Manager で開く
export function openAllBookmarks() {
    navigateView('manager');
    selectPlaylist(null);
}

// ==========================================================
// ランダム発掘 (選択カードの「⏭ 次の発掘」/ N キー)
// ----------------------------------------------------------
// 表示中の曲からランダムに1曲を選んで再生し、選択カード
// (再生 / 保存 / 次の発掘) をその場に出す。連打で次々に聴ける。
// ==========================================================
export function radarDigNext() {
    const all = (vibeDisplayTracks() || []).filter(t => t && t.youtube_id);
    if (!all.length) {
        showToast('発掘できる曲がありません。絞り込みを変えてみてください。', 'info');
        return null;
    }
    // 直前の曲は避けて、次々に新しい曲へ進む (1曲しか無ければその曲)
    const pool = all.filter(t => t.youtube_id !== radarSelectedId);
    const picks = pool.length ? pool : all;
    const pick = picks[Math.floor(Math.random() * picks.length)];
    selectRadarTrack(pick.youtube_id, { play: true, center: true });
    return pick;
}

// マップ右上の選択中カード (再生・周辺再生・中央寄せを1か所に集約)
export function updateRadarSelectedPanel() {
    const panel = document.getElementById('radar-selected-panel');
    if (!panel) return;
    const t = (vibeFiltered.find(t => t.youtube_id === radarSelectedId)
        || vibeMapData.find(t => t.youtube_id === radarSelectedId));
    if (!t) { panel.hidden = true; panel.innerHTML = ''; updateRadarSaveButton(); return; }
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
    const saved = radarTrackSaved(t.youtube_id);
    row.appendChild(mkBtn(saved ? '🔖 保存済み' : '🔖 保存',
        saved ? '自分のリストに保存済み（別のリストにも保存できます）' : 'この曲を自分のリストに保存',
        () => openRadarSaveModal(t.youtube_id)));
    row.appendChild(mkBtn('⏭ 次の発掘', '別の曲をランダムに選んで再生（連打で発掘）', () => radarDigNext()));
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
    updateRadarSaveButton();
}

// 点が重なったときの候補選択ポップアップ
export function hideRadarOverlap() {
    const pop = document.getElementById('radar-overlap-popup');
    if (!pop) return;
    pop.hidden = true;
    pop.innerHTML = '';
}

export function showRadarOverlap(candidates, x, y) {
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

export function bindRadarControls() {
    updateAdminUI();
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
        if (!isAdminUser()) {
            showToast('全曲解析は管理者アカウント（rarugu）専用の機能です。', 'error');
            return;
        }
        const confirmed = await showConfirm({
            title: '全曲を再解析',
            message: '全曲を再解析します。\n\nGemini AI 推定に加えて、音源解析 (librosa/CLAP) で実測BPM・雰囲気を取得します。\nGemini で解析済みの曲は対象外です（上書きしません）。\n曲数が多いと数分〜数十分かかります。\n\n実行しますか？',
            confirmLabel: '解析する',
        });
        if (!confirmed) return;
        analyzeAll.disabled = true; analyzeAll.innerText = '再解析開始...';
        // 全曲を Gemini(AI) + 音源解析(librosa/CLAP) で再解析する
        // (Gemini解析済みの曲はサーバー側で対象外にされる)
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
            const hud = document.getElementById('radar-map-hud');
            const skipped = (started.skipped_gemini || []).length;
            if (hud && skipped) {
                hud.textContent = `Gemini解析済みの ${skipped} 曲は対象外です（管理者ページから再解析できます）`;
            }
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
export async function pollAnalyzeStatus(btn) {
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
    if (hud && (!state || state.running || state.interrupted)) {
        hud.textContent = !state ? '解析状況を取得できませんでした。時間をおいて確認してください。'
            : state.running ? '解析は継続中です。時間をおいて進捗を確認してください。'
            : '解析が中断されています。完了した曲の結果は保存されています。';
    } else if (state && hud) {
        const results = state.results || [];
        const measured = results.filter(r => r.measured).length;
        hud.textContent = `再解析完了: ${results.length} 曲中 ${measured} 曲で実測BPMを取得`
            + (results.length > measured ? '（残りはAI推定BPM）' : '');
    }
    return state;
}

export function renderRadarLegend() {
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

export function radarZoomAtCenter(factor) {
    radarZoom = Math.max(0.2, Math.min(8, radarZoom * factor));
    drawRadarMap(vibeFiltered);
}

// 選択曲が画面中央に来るようパンする (一覧→マップ連携用)
export function focusRadarTrack(youtubeId) {
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

// 曲全体が収まるズーム率とパンを求める (描画はしない)。座標が無ければ null。
// 初期表示 (applyRadarFilter) と「全体表示」ボタンと「リセット」で共通に使う。
// 1曲だけのときはその曲を中央に寄せ、適度に拡大する。
function radarFitView(tracks) {
    const pts = (tracks || [])
        .map(t => t?.features)
        .filter(f => f && typeof f.x === 'number' && typeof f.y === 'number');
    if (!pts.length) return null;
    if (pts.length === 1) {
        const x = Math.max(0, Math.min(1, pts[0].x));
        const y = Math.max(0, Math.min(1, pts[0].y));
        const zoom = 2.5;
        return { zoom, pan: { x: -(x - 0.5) * zoom, y: -(y - 0.5) * zoom } };
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
    const zoom = Math.max(0.2, Math.min(8, Math.min(1 / spanX, 1 / spanY)));
    return {
        zoom,
        pan: {
            x: -(((minX + maxX) / 2) - 0.5) * zoom,
            y: -(((minY + maxY) / 2) - 0.5) * zoom,
        },
    };
}

// 表示中の曲全体が収まるようズーム・パンを調整 (件数が少ない絞り込み後に便利)
export function fitRadarToFiltered() {
    const view = radarFitView(vibeFiltered);
    if (!view) { resetRadarView(); return; }
    radarZoom = view.zoom;
    radarPan = view.pan;
    drawRadarMap(vibeFiltered);
}

export function radarNormPos(t) {
    const f = t?.features || {};
    if (typeof f.x !== 'number' || typeof f.y !== 'number') return null;
    return { x: Math.max(0, Math.min(1, f.x)), y: Math.max(0, Math.min(1, f.y)) };
}

// マップ上で近い曲＝雰囲気が近い曲。選択曲の周辺 n 曲を返す
export function radarNeighbors(youtubeId, n) {
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

export function radarQueueFromTracks(tracks, startId) {
    const list = (tracks || []).filter(t => t && t.youtube_id).map(t => ({
        ...t, id: t.youtube_id, is_favorite: t.is_favorite || 0, fromRadar: true,
    }));
    if (!list.length) return { queue: [], index: 0 };
    const idx = startId ? list.findIndex(t => t.youtube_id === startId) : 0;
    return { queue: list, index: idx >= 0 ? idx : 0 };
}

// 下の一覧に表示する曲 (周辺絞り込み中はその9曲だけ)。
export function vibeDisplayTracks() {
    if (!radarNeighborIds) return vibeFiltered;
    const ids = new Set(radarNeighborIds);
    return vibeFiltered.filter(t => ids.has(t.youtube_id));
}

// 選択曲＋周辺の近い曲を連続再生 (下の一覧もその曲だけに絞り込む)
export function playRadarNeighbors(youtubeId, count) {
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
export function selectRadarTrack(youtubeId, opts) {
    const o = opts || {};
    radarSelectedId = youtubeId || null;
    radarNeighborIds = null;   // 別の曲を選び直したら周辺絞り込みを解除
    hideRadarOverlap();
    if (youtubeId && o.center) {
        const track = vibeFiltered.find(t => t.youtube_id === youtubeId);
        const f = track && track.features;
        if (f && typeof f.x === 'number' && typeof f.y === 'number') {
            const x = Math.max(0, Math.min(1, f.x));
            const y = Math.max(0, Math.min(1, f.y));
            radarPan.x = -(x - 0.5) * radarZoom;
            radarPan.y = -(y - 0.5) * radarZoom;
        }
    }
    drawRadarMap(vibeFiltered);
    renderVibeTracks(vibeFiltered);
    updateRadarSelectedPanel();
    if (youtubeId && o.play) {
        const t = vibeFiltered.find(t => t.youtube_id === youtubeId)
            || vibeMapData.find(t => t.youtube_id === youtubeId);
        if (t) playFromRadar(t);
    }
}


// ドラッグ/ホイール中の連続再描画を rAF で1フレームにまとめる (CPU/GPU負荷の軽減)。
// クリック選択・ズームボタン・絞り込みなどの単発更新は drawRadarMap を直接呼ぶ。
export function queueRadarDraw() {
    if (typeof requestAnimationFrame !== 'function') { drawRadarMap(vibeFiltered); return; }
    if (radarDrawQueued) return;
    radarDrawQueued = true;
    requestAnimationFrame(() => { radarDrawQueued = false; drawRadarMap(vibeFiltered); });
}

// UMAP座標をキャンバスに描画 (パン/ズーム/ホバー/クリック対応)
export function drawRadarMap(tracks) {
    const container = document.getElementById('radar-map-container');
    const canvas = document.getElementById('radar-map-canvas');
    const tooltip = document.getElementById('radar-map-tooltip');
    if (!canvas || !container) return;

    // コンテナサイズに Canvas 解像度を合わせる (Retina対応)。
    // DPR 3 のスマホで 3倍解像度にすると塗り面積が9倍になり重いため、2倍までに抑える。
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, container.clientWidth);
    const H = Math.max(1, container.clientHeight);
    if (canvas.width !== W * dpr || canvas.height !== H * dpr || !canvas.style.height) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
    }

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 背景 (淡いグラデーション)
    const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#141414');
    bg.addColorStop(1, '#080808');
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
    const allPlot = radarPlotPoints(tracks, W, H);
    // 選択中の曲と周辺曲は、表示上限で間引かれても必ず残す (パン/ズーム中は周辺6曲を再ソートしない)
    const selectedAll = allPlot.find(o => o.t.youtube_id === radarSelectedId) || null;
    if (!selectedAll) {
        radarNearCache = { source: tracks, selectedId: null, ids: new Set() };
    } else if (radarNearCache.source !== tracks || radarNearCache.selectedId !== selectedAll.t.youtube_id) {
        const nearTracks = radarNeighbors(selectedAll.t.youtube_id, 6)
            .filter(t => t.youtube_id !== selectedAll.t.youtube_id);
        radarNearCache = {
            source: tracks,
            selectedId: selectedAll.t.youtube_id,
            ids: new Set(nearTracks.map(t => t.youtube_id)),
        };
    }
    const nearIds = radarNearCache.ids;
    const requiredIds = selectedAll ? [selectedAll.t.youtube_id, ...nearIds] : [];

    // 全体表示では上限まで間引き、拡大すると予算を増やす (Kiite Radar 風の focus+context)
    // パン中は同じ間引き結果を使い回す (選択・ズーム・データ変更時だけ再計算)
    let plot;
    const displayLimit = radarDisplayLimit;
    if (displayLimit > 0 && allPlot.length > displayLimit) {
        const zoomKey = Math.round(radarZoom * 20);
        const requiredKey = [...requiredIds].sort().join(',');
        if (radarSelectionCache.source !== tracks
            || radarSelectionCache.limit !== displayLimit
            || radarSelectionCache.zoom !== zoomKey
            || radarSelectionCache.required !== requiredKey) {
            const picked = radarSelectPlotPoints(allPlot, {
                limit: displayLimit,
                zoom: radarZoom,
                requiredIds,
            });
            radarSelectionCache = {
                source: tracks, limit: displayLimit, zoom: zoomKey, required: requiredKey,
                ids: new Set(picked.map(o => o.t.youtube_id)),
            };
        }
        plot = allPlot.filter(o => radarSelectionCache.ids.has(o.t.youtube_id));
    } else {
        plot = allPlot;
        if (displayLimit <= 0) radarSelectionCache = { source: null, limit: null, zoom: null, required: '', ids: null };
    }
    // 画面外は描画も当たり判定もしない (パン中も一定のコストで済む)
    const visiblePlot = plot.filter(o => o.px >= -20 && o.py >= -20 && o.px <= W + 20 && o.py <= H + 20);
    radarPlotCache = (tracks === vibeFiltered) ? visiblePlot : null;

    // 選択中の楽曲をハイライト (選択時は他を減光)
    const selected = visiblePlot.find(o => o.t.youtube_id === radarSelectedId) || null;
    const hasSelection = Boolean(selected);
    const baseR = 5 * Math.max(0.85, Math.min(1.5, Math.sqrt(radarZoom)));

    // カテゴリごとにまとめて fill/stroke する。1点ずつ色を変えて描くより大幅に速い。
    const groups = new Map();
    visiblePlot.forEach((o) => {
        if (hasSelection && o.t.youtube_id === radarSelectedId) return;
        const color = radarCategoryColor(o.t.category);
        if (!groups.has(color)) groups.set(color, []);
        groups.get(color).push(o);
    });
    ctx.globalAlpha = hasSelection ? 0.45 : 1;
    groups.forEach((list, color) => {
        ctx.beginPath();
        list.forEach(o => {
            ctx.moveTo(o.px + baseR, o.py);
            ctx.arc(o.px, o.py, baseR, 0, Math.PI * 2);
        });
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // 選択点は減光せず、光と太い枠で目立たせる
    if (selected) {
        const color = radarCategoryColor(selected.t.category);
        const glow = 14;
        const g = ctx.createRadialGradient(selected.px, selected.py, 0, selected.px, selected.py, glow);
        g.addColorStop(0, color + '99');
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(selected.px, selected.py, glow, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath();
        ctx.arc(selected.px, selected.py, baseR + 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // 選択曲と雰囲気が近い曲を細線で結ぶ (周辺発見の手がかり用)
    if (selected && nearIds.size) {
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        visiblePlot.forEach(o => {
            if (!nearIds.has(o.t.youtube_id)) return;
            ctx.beginPath();
            ctx.moveTo(selected.px, selected.py);
            ctx.lineTo(o.px, o.py);
            ctx.stroke();
        });
        ctx.setLineDash([]);
    }

    // 4軸ガイド（エネルギー×明るさ）: 上下左右端に4ラベルだけ出す。
    // 向きは全データの相関から決める（絞り込みで回転しないよう vibeMapData 基準）。
    // 点の上に重ねて描き、点が重なっても読めるようにする（ズーム/パンには追従させない）。
    // 相関計算は描画ごとに変わらないため、データが変わるまでキャッシュする。
    if (radarAxisCache.source !== vibeMapData) {
        radarAxisCache = { source: vibeMapData, value: radarAxisOrientation(vibeMapData) };
    }
    drawRadarAxes(ctx, W, H, radarAxisCache.value);

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

// 4軸ガイド（energy × bright）を画面の上下左右端に4ラベルで示す。
// kiite radar に倣った白黒のシンプルな見た目にする（色・枠・矢印は使わない）。
// orientation は radarAxisOrientation の戻り（null なら既定の向き）。
// エネルギー軸の両端（energy/calm）と明るさ軸の両端（bright/dark）を、
// それぞれ向きが最も近い画面端（上/下/左/右）に割り当てて表示する。
// 軸線・象限ラベルは描かない（マップの点を邪魔しないため）。
export function drawRadarAxes(ctx, W, H, orientation) {
    if (!(W > 100 && H > 100)) return;
    // 既定の向き（相関が取れないとき）: 上=energy、下=calm、右=bright、左=dark
    const e = orientation?.energy || { dx: 0, dy: -1, strength: 0 };
    const v = orientation?.valence || { dx: 1, dy: 0, strength: 0 };
    const ends = [
        { dx: e.dx, dy: e.dy, label: 'energy' },
        { dx: -e.dx, dy: -e.dy, label: 'calm' },
        { dx: v.dx, dy: v.dy, label: 'bright' },
        { dx: -v.dx, dy: -v.dy, label: 'dark' },
    ];
    // 画面端の内側位置。上下は中央、左右は端に寄せる（x は描画時にテキスト幅で詰める）。
    const MARGIN = 10;
    const edges = [
        { dx: 0, dy: -1, x: W / 2, y: 16 },
        { dx: 0, dy: 1, x: W / 2, y: H - 16 },
        { dx: -1, dy: 0, x: MARGIN, y: H / 2 },
        { dx: 1, dy: 0, x: W - MARGIN, y: H / 2 },
    ];
    // 各端に最も向きが近いラベル端を貪欲に割り当てる（1端1ラベル）
    const used = new Set();
    const placed = [];
    edges.forEach(edge => {
        let best = -1, bestScore = -Infinity;
        ends.forEach((end, i) => {
            if (used.has(i)) return;
            const score = end.dx * edge.dx + end.dy * edge.dy;
            if (score > bestScore) { bestScore = score; best = i; }
        });
        if (best >= 0) { used.add(best); placed.push({ edge, end: ends[best] }); }
    });
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    ctx.save();
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 点の上に白文字で描く。色は使わず、濃い影で点と重なっても読めるようにする。
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur = 5;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    placed.forEach(({ edge, end }) => {
        const tw = ctx.measureText(end.label).width;
        const bx = clamp(edge.x, MARGIN + tw / 2, W - MARGIN - tw / 2);
        const by = clamp(edge.y, 12, H - 12);
        ctx.fillText(end.label, bx, by + 0.5);
    });
    ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

export function renderVibeTracks(tracks, scrollToSelected) {
    const strip = document.getElementById('vibe-track-strip');
    if (!strip) return;
    if (!tracks || tracks.length === 0) {
        strip.dataset.stripSig = '';
        strip.innerHTML = '';
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

    // 選択中の曲が一覧の表示範囲より後ろにあるときは、その曲が見える位置から表示する
    // (「次の発掘」で遠くの曲を選んでも、下の一覧に今の曲が並ぶ)
    let windowStart = 0;
    if (radarSelectedId) {
        const selectedIndex = tracks.findIndex(t => t.youtube_id === radarSelectedId);
        if (selectedIndex >= radarStripLimit) windowStart = Math.max(0, selectedIndex - 2);
    }
    const visible = tracks.slice(windowStart, windowStart + radarStripLimit);
    const nextSig = `${tracks.length}:${windowStart}:${visible.map(t => t.youtube_id).join(',')}`;

    // 表示する曲の並びが変わっていない場合は DOM を破棄せず、選択状態と保存状態だけ差分更新する
    if (strip.dataset && strip.dataset.stripSig === nextSig && typeof strip.querySelectorAll === 'function') {
        const cards = strip.querySelectorAll('.strip-card');
        if (cards.length === visible.length) {
            cards.forEach((card, idx) => {
                const t = visible[idx];
                const isSel = radarSelectedId === t.youtube_id;
                card.classList.toggle('selected', isSel);
                const saved = radarTrackSaved(t.youtube_id);
                const saveBtn = card.querySelector('.strip-save');
                if (saveBtn) {
                    saveBtn.classList.toggle('is-saved', saved);
                    saveBtn.title = saved ? '保存済み（別のリストにも保存）' : 'ブックマークに保存';
                    saveBtn.setAttribute('aria-label', saved ? '保存済み。別のリストにも保存' : 'ブックマークに保存');
                    saveBtn.setAttribute('aria-pressed', saved ? 'true' : 'false');
                    const icon = saveBtn.querySelector('.material-symbols-rounded');
                    if (icon) {
                        icon.classList.toggle('is-filled', saved);
                        icon.textContent = saved ? 'bookmark' : 'bookmark_add';
                    }
                }
            });
            if (scrollToSelected !== false) {
                const sel = strip.querySelector('.strip-card.selected');
                if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
            }
            return;
        }
    }

    if (strip.dataset) strip.dataset.stripSig = nextSig;
    strip.innerHTML = '';
    visible.forEach(t => {
        const { category, tempo, bpmSource, vibe, engine } = radarTrackLabels(t);
        const color = radarCategoryColor(t.category);
        const card = document.createElement('div');
        card.className = 'strip-card';
        card.dataset.ytid = t.youtube_id || '';
        card.style.borderLeftColor = color;
        if (radarSelectedId === t.youtube_id) card.classList.add('selected');

        const coverHtml = t.youtube_id
            ? `<img src="https://img.youtube.com/vi/${t.youtube_id}/mqdefault.jpg" alt="thumb" loading="lazy" decoding="async">`
            : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:24px;">🎵</div>`;

        const saved = radarTrackSaved(t.youtube_id);
        card.innerHTML = `
            <button type="button" class="strip-save${saved ? ' is-saved' : ''}" data-ytid="${escapeHtml(t.youtube_id)}"
                title="${saved ? '保存済み（別のリストにも保存）' : 'ブックマークに保存'}"
                aria-label="${saved ? '保存済み。別のリストにも保存' : 'ブックマークに保存'}"
                aria-pressed="${saved ? 'true' : 'false'}"><span class="material-symbols-rounded${saved ? ' is-filled' : ''}">${saved ? 'bookmark' : 'bookmark_add'}</span></button>
            <div class="strip-thumb">${coverHtml}<div class="card-hover-play"></div></div>
            <div class="strip-info">
                <div class="strip-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
                <div class="strip-artist">${escapeHtml(t.channel || 'Unknown Artist')}</div>
                <div class="strip-meta">${escapeHtml(category)} · <b>tempo</b> ${tempo}${bpmSource ? ' (' + bpmSource + ')' : ''}${vibe ? ' · <b>' + escapeHtml(vibe) + '</b>' : ''} · <b>${escapeHtml(engine)}</b></div>
            </div>
        `;
        const saveBtn = card.querySelector('.strip-save');
        if (saveBtn) {
            saveBtn.onclick = (event) => {
                event.stopPropagation();
                openRadarSaveModal(t.youtube_id);
            };
        }
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

// 横端でトラックパッドの慣性がページへ伝わり、ブラウザの戻る/進むになるのを防ぐ。
// 縦方向のジェスチャーは止めず、通常どおりページをスクロールできるようにする。
export function bindRadarStripScroll() {
    const strip = document.getElementById('vibe-track-strip');
    if (!strip || strip.dataset.radarStripScrollBound) return;
    strip.dataset.radarStripScrollBound = '1';

    strip.addEventListener('wheel', (event) => {
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey;
        const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
        if (!horizontal || maxScroll <= 0) return;

        const rawDelta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY;
        const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? strip.clientWidth : 1);
        strip.scrollLeft = Math.max(0, Math.min(maxScroll, strip.scrollLeft + rawDelta * unit));
        event.preventDefault();
        event.stopPropagation();
    }, { passive: false });

    strip.addEventListener('keydown', (event) => {
        // Cmd/Ctrl+矢印など、ブラウザやOSが持つショートカットは奪わない。
        if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
        const amount = Math.max(160, strip.clientWidth * 0.75);
        if (event.key === 'ArrowLeft') strip.scrollBy({ left: -amount, behavior: 'smooth' });
        else if (event.key === 'ArrowRight') strip.scrollBy({ left: amount, behavior: 'smooth' });
        else if (event.key === 'Home') strip.scrollTo({ left: 0, behavior: 'smooth' });
        else if (event.key === 'End') strip.scrollTo({ left: strip.scrollWidth, behavior: 'smooth' });
        else return;
        event.preventDefault();
        event.stopPropagation();
    });
}

export function canvasWidth() {
    return document.getElementById('radar-map-container')?.clientWidth || 0;
}
export function canvasHeight() {
    return document.getElementById('radar-map-container')?.clientHeight || 0;
}

export function playFromRadar(t) {
    if (!t || !t.youtube_id) return;
    currentDetailTracks = [{ id: t.youtube_id, youtube_id: t.youtube_id, title: t.title, channel: t.channel, is_favorite: 0 }];
    playTrackFromQueue(0, currentDetailTracks);
}

export function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// キャンバスポインタ操作 (ホバー/タップ/ドラッグ/ピンチ/ホイール)
export function bindRadarPointer() {
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
        // マップを操作した直後からキー操作を使えるようにする。
        // preventScroll でフォーカス時のページ位置の飛びを防ぐ。
        if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
        hideRadarOverlap();
        const [x, y] = localPos(e);
        if (!pointers.size) radarMoved = false;
        pointers.set(e.pointerId, { x, y });
        if (pointers.size > 1) radarMoved = true;
        canvas.setPointerCapture(e.pointerId);
        radarDragging = true;
        tooltip.style.display = 'none';
        tooltip.dataset.trackId = '';
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
        if (!o) { tooltip.style.display = 'none'; tooltip.dataset.trackId = ''; return; }
        tooltip.style.display = 'flex';
        // 同じ曲の上を動いている間は innerHTML を作り直さない (mousemove の負荷対策)
        if (tooltip.dataset.trackId !== o.t.youtube_id) {
            tooltip.dataset.trackId = o.t.youtube_id;
            tooltip.innerHTML = radarTooltipHtml(o.t);
        }
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
    canvas.addEventListener('pointerleave', () => {
        tooltip.style.display = 'none';
        tooltip.dataset.trackId = '';
    });

    // ダブルクリック/ダブルタップでズームイン (Shift+はズームアウト)
    canvas.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const [mx, my] = localPos(e);
        radarZoomToPoint(mx, my, e.shiftKey ? 0.7 : 1.4);
    });

    // キーボード操作: : ; (ズーム) / + - (同じ動作) / F / 0 / 矢印 / Escape / Enter
    canvas.addEventListener('keydown', (e) => {
        const action = radarKeyboardAction(e);
        if (!action) return;
        const step = 0.08;
        if (action === 'zoom-in') radarZoomAtCenter(1.2);
        else if (action === 'zoom-out') radarZoomAtCenter(0.85);
        else if (action === 'fit') fitRadarToFiltered();
        else if (action === 'reset') resetRadarView();
        else if (action === 'pan-left') { radarPan.x += step / radarZoom; queueRadarDraw(); }
        else if (action === 'pan-right') { radarPan.x -= step / radarZoom; queueRadarDraw(); }
        else if (action === 'pan-up') { radarPan.y += step / radarZoom; queueRadarDraw(); }
        else if (action === 'pan-down') { radarPan.y -= step / radarZoom; queueRadarDraw(); }
        else if (action === 'clear') {
            hideRadarOverlap();
            selectRadarTrack(null);
            tooltip.style.display = 'none';
        } else if (action === 'play') {
            const t = vibeFiltered.find(t => t.youtube_id === radarSelectedId);
            if (t) playFromRadar(t);
        }
        e.preventDefault();
    });

    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        hideRadarOverlap();
        const rect = canvas.getBoundingClientRect();
        radarZoomToPoint(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });
}

// Radarが受け取る単独キーだけを操作へ変換する。
// Cmd/Ctrl/Alt付きはブラウザのズーム、履歴移動、OS操作を優先する。
export function radarKeyboardAction(event) {
    if (!event || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return '';
    const key = String(event.key || '');
    const lower = key.toLowerCase();
    // ズームは JIS 配列で押しやすい ; / : を主に使い、+ / - も同じ動作で受け付ける
    if (key === ':' || key === '+') return 'zoom-in';
    if (key === ';' || key === '-') return 'zoom-out';
    if (lower === 'f') return 'fit';
    if (key === '0') return 'reset';
    if (key === 'ArrowLeft') return 'pan-left';
    if (key === 'ArrowRight') return 'pan-right';
    if (key === 'ArrowUp') return 'pan-up';
    if (key === 'ArrowDown') return 'pan-down';
    if (key === 'Escape') return 'clear';
    if (key === 'Enter') return 'play';
    return '';
}

// カーソル位置を基準にズーム (ホイール/ダブルクリック用)。ズーム後も指先の点が追従する
export function radarZoomToPoint(mx, my, factor) {
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


// プレイリスト詳細を開く (URLパスを履歴に積む)
let pendingDetail = { id: null, name: '', cover: '' };

// ログイン中ユーザーのID (JWTの payload / ゲスト資格情報から読む。UIの出し分け専用)
export function currentUserId() {
    try {
        const token = localStorage.getItem('tunedrop_token') || '';
        const payload = token.split('.')[1];
        if (payload) {
            const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
            const json = JSON.parse(decodeURIComponent(escape(atob(base64))));
            const id = Number(json.user_id) || 0;
            if (id > 0) return id;
        }
    } catch (_) { /* 壊れたトークンはゲスト判定へ */ }
    try {
        // ゲストの資格情報は "ユーザーID.シークレット" 形式 (backend/app.py)
        const guest = localStorage.getItem('tunedrop_guest_credential') || '';
        const id = Number(guest.split('.')[0]) || 0;
        if (id > 0) return id;
    } catch (_) { /* 未初期化 */ }
    return 0;
}

// 詳細画面の「戻る」ラベルを、開いた場所 (Share / Manager) に合わせる
export function renderDetailBackLabel() {
    const label = document.getElementById('detail-back-label');
    if (label) label.textContent = detailReturnView === 'manager' ? 'Managerへ戻る' : 'Shareへ戻る';
}

export function goBackFromDetail() {
    if (detailReturnView === 'manager') {
        const id = Number(pendingDetail.id) || 0;
        navigateView('manager');
        if (id) selectPlaylist(id);
        return;
    }
    navigateView('share');
}

export function openPlaylistDetail(playlistId, playlistName, coverId, options = {}) {
    pendingDetail = { id: Number(playlistId), name: playlistName || '', cover: coverId || '' };
    detailReturnView = options.from === 'manager' ? 'manager' : 'share';
    renderDetailBackLabel();
    // クリック直後に前のリスト名が見えないよう、名前だけ先に反映しておく
    // (描画本体は navigateView → applyPathView 側)
    if (playlistName) {
        const titleEl = document.getElementById('detail-title');
        if (titleEl) titleEl.innerText = playlistName;
    }
    navigateView('playlist-detail', playlistId);
}

// Manager から Share と同じレイアウトの詳細画面を開く
export function openPlaylistShareView(playlistId) {
    const id = Number(playlistId);
    if (!id) return;
    closeMobileMenu();
    const list = allPlaylists.find(p => p.id === id);
    openPlaylistDetail(id, list ? list.name : '', list ? list.cover_id : '', { from: 'manager' });
}

// Manager のプレイリスト画面 (開いているリスト) を詳細画面で開く
export function openCurrentListShareView() {
    const id = Number(currentPlaylistId);
    if (!id) {
        showToast('リストを開いてから使えます。', 'info');
        return;
    }
    openPlaylistShareView(id);
}

// プレイリスト詳細のメタ行: 「3曲 · 作成者名」。
// 作成者名はクリック/Enter でそのユーザーのプロフィールへ移動する。
export function renderDetailMeta(trackCount, listData) {
    const meta = document.getElementById('detail-meta');
    if (!meta) return;
    meta.textContent = `${trackCount} 曲`;
    const authorName = (listData && (listData.author || listData.author_name)) || '';
    const authorId = Number(listData && listData.user_id) || 0;
    if (!authorName || authorId <= 0) return;
    meta.appendChild(document.createTextNode(' · '));
    const link = document.createElement('span');
    link.className = 'detail-author-link';
    link.textContent = authorName;
    link.setAttribute('role', 'link');
    link.setAttribute('tabindex', '0');
    link.title = `${authorName}のプロフィールを開く`;
    const open = (e) => {
        e.stopPropagation();
        e.preventDefault();
        openUserProfile(authorId, authorName);
    };
    link.addEventListener('click', open);
    link.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
    });
    meta.appendChild(link);
}

// プレイリスト詳細の実データロード・表示
// ----------------------------------------------------------
// 共有URLは OGP カードを返す ogp.php を使う。
// SPA のハッシュURL (#/playlist/12) は SNS のクローラーに中身が見えず、
// 共有してもカードが出ないため。
// ----------------------------------------------------------
export function playlistShareUrl(playlistId) {
    try {
        // /playlist/12 から相対解決すると /playlist/ogp.php になってしまうため、
        // サイトの basePath (/tunedrop/ など) を基準にする。
        const { basePath } = parseLocationPath();
        const url = new URL('ogp.php', window.location.origin + basePath);
        url.searchParams.set('playlist', playlistId);
        return url.href;
    } catch (_) {
        return window.location.href;
    }
}

export async function renderPlaylistDetail(playlistId, playlistName, coverId) {
    switchView('playlist-detail');
    // 直前に開いた別リストの名前を持ち越さない (IDが一致するときだけ使う)
    const pending = pendingDetail.id === Number(playlistId) ? pendingDetail : { name: '', cover: '' };
    const effName = playlistName || pending.name;
    const effCover = coverId || pending.cover;
    const detailTitleEl = document.getElementById('detail-title');
    // 名前が未確定 (履歴復元など) のときは前のリスト名を残さない
    if (detailTitleEl) detailTitleEl.innerText = effName || '読み込み中…';
    const coverEl = document.getElementById('detail-cover');
    if (effCover) coverEl.innerHTML = `<img src="https://img.youtube.com/vi/${effCover}/hqdefault.jpg">`;
    else coverEl.innerHTML = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-size:40px;">🎵</div>`;

    let tracks;
    try {
        const response = await tunedropFetch(`api.php?action=get_my_bookmarks&playlist_id=${playlistId}`);
        tracks = await response.json();
    } catch (error) {
        // 直リンクやオフラインでも画面を壊さない (履歴復元で例外を投げない)
        tracks = [];
        const meta = document.getElementById('detail-meta');
        if (meta) meta.textContent = 'リストを読み込めませんでした。';
    }
    if (!Array.isArray(tracks)) tracks = [];
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
    // 詳細の元データ (タイトル・カバー・作成者・お気に入り) を1か所で解決する。
    // 一覧で見つからない場合 (直リンク等) は公開リストから探す。
    let listData = allPlaylists.find(p => p.id === playlistId)
        || allRadarPlaylists.find(p => p.id === playlistId)
        || allRadarRecentPlaylists.find(p => p.id === playlistId)
        || sharePlaylists.find(p => p.id === playlistId);
    if (!listData) {
        try {
            const listsResponse = await tunedropFetch('api.php?action=get_public_playlists');
            const lists = await listsResponse.json();
            listData = Array.isArray(lists) ? lists.find(p => p.id === playlistId) : null;
        } catch (_) {
            // 取得できないときは作成者名を出さずに曲数だけ表示する
        }
    }
    if (listData) {
        document.getElementById('detail-title').textContent = listData.name;
        if (listData.cover_id) {
            coverEl.innerHTML = `<img src="https://img.youtube.com/vi/${encodeURIComponent(listData.cover_id)}/hqdefault.jpg" alt="プレイリストのカバー">`;
        }
    }
    renderDetailMeta(tracks.length, listData);
    // 自分のリストかどうか (移動・削除を出すか) と、戻り先のラベルを反映する
    const myId = currentUserId();
    currentDetailIsMine = Boolean(listData && myId && Number(listData.user_id) === myId);
    renderDetailBackLabel();
    updatePlaylistViewSwitch();
    // 存在しないリスト (直リンク・古い履歴) は「読み込み中…」のままにしない
    if (!listData && tracks.length === 0 && detailTitleEl && !effName) {
        detailTitleEl.innerText = 'リストが見つかりません';
    }

    const favBtn = document.getElementById('btn-fav-playlist');
    if (favBtn && listData) {
        const favIcon = document.getElementById('btn-fav-playlist-icon');
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

    const shareBtn = document.getElementById('btn-share');
    if (shareBtn) {
        shareBtn.onclick = async () => {
            const listName = document.getElementById('detail-title').textContent;
            // OGPカード付きの共有URL (ogp.php?playlist=...) を使う
            const shareUrl = playlistShareUrl(playlistId);
            const shareData = {
                title: `Tune drop: ${listName}`,
                text: `プレイリスト「${listName}」をチェック！`,
                url: shareUrl
            };
            try {
                if (navigator.share) {
                    await navigator.share(shareData);
                } else if (await copyTextToClipboard(shareUrl)) {
                    showToast('共有URLをコピーしました。');
                } else {
                    showToast('共有URLをコピーできませんでした。ブラウザのURL欄からコピーしてください。', 'error');
                }
            } catch (err) {
                // ユーザーが共有シートを閉じただけなら何もしない。
                // それ以外の失敗はコピーへフォールバックする。
                if (!(err && err.name === 'AbortError')) {
                    if (await copyTextToClipboard(shareUrl)) showToast('共有URLをコピーしました。');
                    else showToast('共有に失敗しました。ブラウザのURL欄からコピーしてください。', 'error');
                }
            }
        };
    }

    const exportBtn = document.getElementById('btn-export-urls');
    if (exportBtn) {
        exportBtn.onclick = () => exportPlaylistUrls(playlistName, currentDetailTracks);
    }

    renderDetailTracks(currentDetailTracks);
}

// 曲を「プレイリスト風の行」で描画する (プレイリスト詳細 / Manager のプレイリストビュー共通)
// opts:
//   emptyText    … 0件のときの案内
//   list         … ドラッグで並び替える対象の配列 (既定: tracks)
//   sortSelectId … 並び替え時に「カスタム順」へ切り替える select
//   menu         … (track) => メニューHTML
//   rerender     … 並び替え後に再描画する関数
//   onReorder    … 並び替え後に呼ぶ保存処理 (ids)
//   pointerDrop  … タッチ並び替え後の保存処理
export function renderTrackRows(container, tracks, opts = {}) {
    if (!container) return;
    const list = Array.isArray(opts.list) ? opts.list : tracks;
    const menu = typeof opts.menu === 'function' ? opts.menu : detailTrackMenuHtml;
    const sortSelectId = opts.sortSelectId || 'manager-track-sort-select';
    container.innerHTML = '';
    if (tracks.length === 0) {
        container.innerHTML = `<p class="track-list-empty">${opts.emptyText || '曲が見つかりません。'}</p>`;
        return;
    }

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
            container.querySelectorAll('.track-list-item').forEach(el => el.classList.remove('playing'));
            item.classList.add('playing');
            if (typeof opts.onPlaying === 'function') opts.onPlaying(track, index, displayTracks);
        };

        item.innerHTML = `
            <div class="drag-handle drag-handle-inline" title="ドラッグで並び替え"><span class="material-symbols-rounded">drag_indicator</span></div>
            <div class="track-index">${index + 1}</div>
            <div class="track-thumb"><img src="https://img.youtube.com/vi/${track.youtube_id}/mqdefault.jpg" alt="thumb"></div>
            <div class="track-info"><div class="title">${escapeHtml(track.title)}</div><div class="artist">${escapeHtml(track.channel)}</div></div>
            <div class="track-actions detail-menu" onclick="event.stopPropagation()">
                <button type="button" class="track-menu-btn" onclick="toggleTrackMenu(event, this)" aria-label="曲のメニュー" aria-expanded="false"><span class="material-symbols-rounded">more_vert</span></button>
                <div class="track-dropdown-menu">${menu(track)}</div>
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
            container.querySelectorAll('.track-list-item').forEach(el => el.classList.remove('drag-over'));
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
            const dragIdx = list.findIndex(t => t.id === draggedId);
            const targetIdx = list.findIndex(t => t.id === track.id);
            if (dragIdx === -1 || targetIdx === -1) return;
            // カスタム順へ切り替えて並びを確定
            trackSortMode = 'custom';
            const sel = document.getElementById(sortSelectId);
            if (sel) sel.value = 'custom';
            list.splice(targetIdx, 0, list.splice(dragIdx, 1)[0]);
            list.forEach((t, i) => { t.sort_order = i; });
            if (typeof opts.rerender === 'function') opts.rerender();
            if (typeof opts.onReorder === 'function') opts.onReorder(list.map(t => t.id));
        });

        // タッチ端末ではつまみ (drag-handle) を Pointer Events で並び替える
        if (typeof opts.pointerDrop === 'function') {
            enablePointerReorder({
                handle: item.querySelector('.drag-handle'),
                item,
                container,
                itemSelector: '.track-list-item',
                onDrop: opts.pointerDrop
            });
        }

        container.appendChild(item);
    });
}

// プレイリスト詳細の行メニュー (自分のリストのときだけ移動・削除を出す)
export function detailTrackMenuHtml(track) {
    const mine = currentDetailIsMine;
    return `
        <button type="button" onclick="toggleTrackFavorite(${track.id}, event)"><span class="material-symbols-rounded">${track.is_favorite == 1 ? 'heart_broken' : 'favorite'}</span>${track.is_favorite == 1 ? 'お気に入り解除' : 'お気に入り追加'}</button>
        <button type="button" onclick="openSaveTrackModalFor('${track.youtube_id}')"><span class="material-symbols-rounded">playlist_add</span>自分のリストに追加</button>
        ${mine ? `<button type="button" onclick="openMoveModalFromMenu(event, ${track.id})"><span class="material-symbols-rounded">drive_file_move</span>別のリストへ移動</button>` : ''}
        <button type="button" onclick="openInRadar('${track.youtube_id}')"><span class="material-symbols-rounded">radar</span>Radarで見る</button>
        <button type="button" onclick="openYouTubeLink('${track.youtube_id}')"><span class="material-symbols-rounded">play_arrow</span>YouTubeで開く</button>
        ${mine ? `<button type="button" onclick="deleteTrackFromMenu(event, ${track.id})"><span class="material-symbols-rounded">close</span>削除</button>` : ''}
    `;
}

// プレイリスト詳細の曲一覧 (Share と同じ見た目)
export function renderDetailTracks(tracks) {
    renderTrackRows(document.getElementById('detail-track-list'), tracks, {
        emptyText: 'このプレイリストは空です。',
        list: currentDetailTracks,
        sortSelectId: 'track-sort-select',
        menu: detailTrackMenuHtml,
        rerender: () => renderDetailTracks(currentDetailTracks),
        onReorder: (ids) => reorderBookmarks(ids),
        pointerDrop: persistDetailTrackOrderFromDom,
    });
}

export function playAllRadarTracks() {
    if (currentDetailTracks.length > 0) playTrackFromQueue(0, currentDetailTracks);
    else showToast('再生できる曲がありません。', 'error');
}

export function exportPlaylistUrls(playlistName, tracks) {
    if (!tracks || tracks.length === 0) return showToast('曲が登録されていません。', 'error');

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

export function closeExportModal() { document.getElementById('export-preview-modal').style.display = 'none'; }
export async function copyExportText() {
    const textarea = document.getElementById('export-textarea');
    textarea.select();
    const copied = await copyTextToClipboard(textarea.value);
    if (!copied) {
        showToast('クリップボードへのコピーに失敗しました。テキストを選択してコピーしてください。', 'error');
        return;
    }
    const copyBtn = document.getElementById('btn-copy-export');
    if (!copyBtn) { showToast('コピーしました。'); return; }
    copyBtn.innerText = '✅ Copied!';
    copyBtn.style.background = '#444';
    copyBtn.style.color = '#fff';
    setTimeout(() => {
        copyBtn.innerText = 'Copy to clipboard';
        copyBtn.style.background = 'var(--accent-color)';
        copyBtn.style.color = '#000';
    }, 2000);
}

export function playRadarRandomThree() {
    // Draw from the current Radar results, without repeating the same video.
    const candidates = [...new Map(vibeFiltered
        .filter(track => track.youtube_id)
        .map(track => [track.youtube_id, track])).values()];
    if (!candidates.length) {
        showToast('再生できる曲がありません。Radarの読み込み後、検索条件を確認してください。', 'error');
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
export async function loadSharePlaylists() {
    // 未ログイン (デモ表示) ではAPIを呼ばない
    if (!hasAccountSession()) return;
    const grid = document.getElementById('share-playlists-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="share-loading"><span class="share-spinner"></span>みんなのプレイリストを探しています…</div>';
    try {
        const [pubRes, recRes] = await Promise.all([
            tunedropFetch('api.php?action=get_public_playlists'),
            tunedropFetch('api.php?action=get_recommended_playlists&limit=6').catch(() => null),
        ]);
        const publicLists = await pubRes.json();
        if (!pubRes.ok || !Array.isArray(publicLists)) throw new Error('公開リストを取得できませんでした。');
        sharePlaylists = publicLists;
        try {
            const recommended = recRes && recRes.ok ? await recRes.json() : [];
            shareRecommended = Array.isArray(recommended) ? recommended : [];
        } catch (_) { shareRecommended = []; }
        renderSharePlaylists();
    } catch (err) {
        grid.innerHTML = '<div class="ui-load-error" role="status"><strong>公開リストを読み込めませんでした</strong><p>接続を確認して、もう一度お試しください。</p><button type="button" onclick="loadSharePlaylists()">再試行</button></div>';
        console.error(err);
    }
}

export function shareFavCount(p) {
    const n = Number(p?.favorite_count);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function shareTrackCount(p) {
    const n = Number(p?.track_count);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

// 人気順の順位表 (id -> 1-based rank)。同点は track_count → 新着(id降順) で決める。
export function sharePopularRanks(lists) {
    const sorted = [...(lists || [])].sort((a, b) =>
        shareFavCount(b) - shareFavCount(a)
        || shareTrackCount(b) - shareTrackCount(a)
        || (b.id ?? 0) - (a.id ?? 0));
    const ranks = new Map();
    sorted.forEach((p, i) => ranks.set(p.id, i + 1));
    return { sorted, ranks };
}

export function matchShareQuery(p, query, category) {
    const name = (p?.name || '').toLowerCase();
    const author = ((p?.author || p?.author_name || p?.username || '')).toLowerCase();
    const okText = !query || name.includes(query) || author.includes(query);
    const okCat = !category || (p?.category || 'Other') === category;
    return okText && okCat;
}

// 検索・カテゴリ・並び順を適用した一覧を返す (描画とEnterジャンプで共有)
export function getShareFiltered() {
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

export function onShareSearchInput() {
    updateShareClearButton();
    renderSharePlaylists();
}

export function clearShareSearch() {
    const input = document.getElementById('share-search');
    if (input) input.value = '';
    renderSharePlaylists();
    if (input) input.focus();
}

// 検索欄の Enter=先頭結果を開く、Escape=クリア
export function onShareSearchKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const { sorted } = getShareFiltered();
        if (sorted[0]) openPlaylistDetail(sorted[0].id, sorted[0].name, sorted[0].cover_id);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        clearShareSearch();
    }
}

export function updateShareClearButton() {
    const btn = document.getElementById('btn-share-search-clear');
    const input = document.getElementById('share-search');
    if (!btn || !input) return;
    btn.style.display = input.value ? 'block' : 'none';
}

export function renderSharePlaylists() {
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
                <div class="artist"><span class="material-symbols-rounded share-author-icon">person</span><span class="share-author-name" role="link" tabindex="0" title="${escapeHtml(authorName)}のプロフィールを開く" data-author-id="${Number(list.user_id) || 0}">${authorName}</span></div>
                <div class="share-card-stats"><span class="material-symbols-rounded share-meta-icon">music_note</span>${trackCount}曲<span class="share-card-stats-dot">·</span><span class="material-symbols-rounded share-meta-icon">favorite</span>${favs}</div>
            </div>
        `;
        card.querySelector('.share-fav-btn')?.addEventListener('click', (e) => toggleShareFavorite(list.id, e));
        // 作成者名からその人のプロフィール (公開リスト一覧) を開く
        const authorEl = card.querySelector('.share-author-name');
        if (authorEl && Number(authorEl.dataset.authorId) > 0) {
            authorEl.classList.add('is-link');
            const open = (e) => {
                e.stopPropagation();
                e.preventDefault();
                openUserProfile(Number(authorEl.dataset.authorId), authorEl.textContent.trim());
            };
            authorEl.addEventListener('click', open);
            authorEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') open(e);
            });
        }
        grid.appendChild(card);
    });
}

export function renderShareRecommend() {
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

export function renderShareRanking(popularSorted) {
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
export async function toggleShareFavorite(id, event) {
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
            if (data.error) showToast(data.error, 'error');
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
        // Shareでお気に入りに追加した直後に「お気に入り」を開いても
        // 出遅れないよう、サイドバー/一覧のキャッシュ (allPlaylists) も更新する。
        // ここを忘れると、ハートは赤くなるのに一覧へ反映されず「壊れた」ように見える。
        try { await loadPlaylists(); } catch (error) { console.error(error); }
        return data;
    } catch (err) {
        console.error(err);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Share画面の「おまかせ」: 公開プレイリストからランダムに1つ開く
export function openRandomSharePlaylist() {
    const lists = (sharePlaylists || []).filter(p => p && p.id);
    if (lists.length === 0) {
        showToast('まだ公開されたプレイリストがありません。', 'error');
        return;
    }
    const pick = lists[Math.floor(Math.random() * lists.length)];
    openPlaylistDetail(pick.id, pick.name, pick.cover_id);
}

export function playTrackFromQueue(index, queue) {
    closeMobileMenu();   // 再生 (他操作) でメニューが残らないようにする
    // ユーザーが新しい曲を選んだら、閉じる操作の自動送り抑止は解除する
    ignorePlayerEndedUntil = 0;
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
    const playerSave = document.getElementById('btn-player-save');
    if (playerSave) playerSave.disabled = false;
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

export function skipTrack(direction) {
    if (currentQueue.length === 0 || currentTrackIndex === -1) return;
    const nextIndex = currentTrackIndex + direction;
    if (nextIndex >= 0 && nextIndex < currentQueue.length) playTrackFromQueue(nextIndex, currentQueue);
}

export function onYouTubeIframeAPIReady() {
    // YT スクリプト未ロード・プレイヤー作成済みの二重発火は何もしない
    if (player || !(window.YT && window.YT.Player)) return;
    const initialVideoId = currentQueue[currentTrackIndex]?.youtube_id || '';
    createYouTubePlayer(initialVideoId);
}

export function createYouTubePlayer(videoId) {
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
export function disableCaptions() {
    if (!player || typeof player.setOption !== 'function') return;
    try {
        player.setOption('captions', 'track', {});
        player.unloadModule?.('captions');
    } catch (e) {
        /* captions モジュールが未ロードのケースは無視 */
    }
}

export function onYouTubePlayerReady() {
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

export function onYouTubePlayerError(event) {
    if (Date.now() < ignorePlayerEndedUntil) return;
    console.error('YouTube player error:', event.data);
    // 再生できない動画 (埋め込み不可・削除済み等) は飛ばして次の曲へ。
    // キュー全曲が再生不可のときは止める (無限に回さない)。
    ytErrorStreak += 1;
    if (ytErrorStreak > currentQueue.length) { ytErrorStreak = 0; return; }
    skipTrack(1);
}

export function onPlayerStateChange(event) {
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
    if (event.data === YT.PlayerState.ENDED) {
        // 閉じるボタン経由の ENDED では次の曲へ進まない
        if (Date.now() < ignorePlayerEndedUntil) {
            ignorePlayerEndedUntil = 0;
            return;
        }
        skipTrack(1);
    }
}

export function togglePlay() {
    if (!player) return;
    if (isPlaying) {
        player.pauseVideo();
        return;
    }
    // 閉じたあとに下部プレイヤーから再生したら、動画も再表示する
    ignorePlayerEndedUntil = 0;
    const popup = document.getElementById('youtube-popup');
    if (popup && !popup.classList.contains('is-active')) popup.classList.add('is-active');
    player.playVideo();
}

export function updateProgressBar() {
    if (!player || !isPlaying) return;
    const currentTime = player.getCurrentTime();
    const duration = player.getDuration();
    if (duration > 0) {
        document.getElementById('progress-bar').style.width = `${(currentTime / duration) * 100}%`;
        document.getElementById('time-display').innerText = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    }
}

export function seekTrack(event) {
    if (!player || player.getDuration() === 0) return;
    const container = document.getElementById('progress-container');
    const clickX = event.clientX - container.getBoundingClientRect().left;
    player.seekTo((clickX / container.offsetWidth) * player.getDuration(), true);
}

export function formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ヘルプの目次: ハッシュを変えずにその場でスクロールする。
// href="#help-..." を素通しすると、ルーターが未知のハッシュを Manager と解釈して
// 別画面へ飛んでしまう。
document.addEventListener('click', (event) => {
    const link = event.target.closest('.help-toc a[href^="#"]');
    if (!link) return;
    event.preventDefault();
    const target = document.getElementById(link.getAttribute('href').slice(1));
    if (target) target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
});

// ==========================================================
// 更新通知
// ----------------------------------------------------------
// Vite のビルド成果物はファイル名に内容のハッシュが入る
// (/assets/index-XXXX.js / .css)。タブを開いたままの場合は SPA 内の
// 画面移動では JS/HTML を取り直さないため、古い画面が残り続ける。
// タブに戻ってきたときに index.html を取得し、参照している資産が
// 変わっていたら再読み込みを促す。
// ==========================================================
const APP_ASSET_PATTERN = /assets\/([A-Za-z0-9_-]+\.(?:js|css))|(?:app\.js|style\.css)\?v=([\w.-]+)/g;

export function loadedAssetVersions() {
    const versions = new Set();
    // 現在の構成: ハッシュ付きの /assets/index-XXXX.js|css
    document.querySelectorAll('script[src*="/assets/"], link[href*="/assets/"]').forEach(el => {
        const value = el.getAttribute('src') || el.getAttribute('href') || '';
        const match = value.match(/assets\/([A-Za-z0-9_-]+\.(?:js|css))/);
        if (match) versions.add(match[1]);
    });
    // 旧構成 (?v=) との互換
    document.querySelectorAll('script[src*="app.js"], link[href*="style.css"]').forEach(el => {
        const value = el.getAttribute('src') || el.getAttribute('href') || '';
        const match = value.match(/\?v=([\w.-]+)/);
        if (match) versions.add(match[1]);
    });
    return versions;
}

export async function checkForAppUpdate() {
    const banner = document.getElementById('update-banner');
    if (!banner || banner.hidden === false) return;
    try {
        const response = await fetch(new URL('index.html', window.location.href), { cache: 'no-store' });
        if (!response.ok) return;
        const html = await response.text();
        const latest = new Set([...html.matchAll(APP_ASSET_PATTERN)].map(m => m[1] || m[2]));
        const current = loadedAssetVersions();
        // 読み込み済みの版がすべて最新側に含まれていれば更新不要
        if (!latest.size || !current.size) return;
        if ([...current].every(version => latest.has(version))) return;
        banner.hidden = false;
    } catch (_) {
        // オフライン等では何もしない (次回の表示時に再確認する)
    }
}

let lastUpdateCheck = 0;
export function scheduleUpdateCheck() {
    const now = Date.now();
    if (now - lastUpdateCheck < 5 * 60 * 1000) return;   // 最短5分間隔
    lastUpdateCheck = now;
    checkForAppUpdate();
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleUpdateCheck();
});

document.addEventListener("DOMContentLoaded", () => {
    const reload = document.getElementById('update-reload');
    if (reload) reload.addEventListener('click', () => window.location.reload());
    // 開きっぱなしのタブでも気づけるよう、起動から少し待って1回確認する
    setTimeout(scheduleUpdateCheck, 30000);
    // head 内のスタブ経由で先行発火した外部スクリプトをここで回収する
    if (window.__ytApiReadyQueued) { window.__ytApiReadyQueued = false; onYouTubeIframeAPIReady(); }
    else if (window.YT?.Player && !player) onYouTubeIframeAPIReady();
    checkLoginStatus();
    // ログインモーダル: Tabのフォーカスをモーダル内に留め、
    // 入力し直したらエラー表示を消す (毎回同じエラーが残らないように)。
    const loginModal = document.getElementById('login-modal');
    if (loginModal) {
        // モーダル内だけでなく document で受ける: Googleボタン等から
        // フォーカスが外へ抜けた場合も、次のTabでモーダルへ戻せるようにする。
        document.addEventListener('keydown', trapModalFocus);
    }
    for (const id of ['auth-username', 'auth-password']) {
        const input = document.getElementById(id);
        if (input) input.addEventListener('input', clearAuthError);
    }
    const authUsernameInput = document.getElementById('auth-username');
    if (authUsernameInput) {
        authUsernameInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.isComposing) return;
            const passwordField = document.getElementById('auth-password');
            const usernameValue = String(authUsernameInput.value || '').trim();
            const passwordValue = String((passwordField && passwordField.value) || '').trim();
            // IDだけ入力した状態でEnterを押したら、パスワード欄へ移動する
            if (usernameValue && !passwordValue && passwordField) {
                event.preventDefault();
                if (typeof passwordField.focus === 'function') passwordField.focus();
            }
        });
    }
    // 検索欄の×ボタンは、入力があるときだけ表示する
    syncManagerSearchClear();
    syncTrackSearchClear();
    // リスト名・曲名などの検索サジェスト
    setupSearchSuggestions();
    // プロフィールの統計カード (保存曲 / プレイリスト / お気に入り / フォロー) を
    // クリックすると、下のパネルを簡易ログへ切り替える。
    const profileStats = document.getElementById('profile-stats');
    if (profileStats) {
        profileStats.addEventListener('click', (event) => {
            const button = event.target.closest('[data-profile-panel]');
            if (button) selectProfilePanel(button.dataset.profilePanel);
        });
    }

    // モーダル内の入力欄で Enter を押したら決定する (いちいちボタンへ移動しない)
    const enterSubmits = [
        ['new-playlist-title', () => submitNewPlaylist()],
        ['edit-playlist-title', () => submitEditPlaylist()],
        ['youtube-url', () => addTrack()],
    ];
    for (const [id, submit] of enterSubmits) {
        const input = document.getElementById(id);
        if (!input) continue;
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.isComposing) return;
            event.preventDefault();
            submit();
        });
    }
    // Google ボタンはログインモーダルを開いたときに初期化する。
    // ページ表示直後に initialize すると、未登録 origin の環境では
    // Google 側の [GSI_LOGGER] エラーがコンソールに出続けるため。
    if (window.__gsiReadyQueued) { window.__gsiReadyQueued = false; }
    bindRadarControls();
    bindRadarPointer();
    bindRadarStripScroll();
    syncRadarDisplayLimitControl();
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

    // ルーティング: 標準パスの変更 (ブラウザ戻る/進む/直接URL) をビューへ反映する。
    // pushState では popstate が発火しないため、履歴移動のときだけここで復元する。
    window.addEventListener('popstate', applyPathView);

    // 旧ハッシュ (#/manager など) はパスへ移行してから表示する。
    // 初期表示はパス (/ なら Manager ホーム) に一本化し、URLを勝手に書き換えない。
    migrateLegacyHash();
    applyPathView();
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

// ===== タッチ端末向けの表示調整 =====
// スマートフォンには Enter キーが無いため、検索欄の案内 (Enterで先頭を再生) は出さない。
(() => {
    if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) return;
    const input = document.getElementById('radar-title-search');
    if (input) input.placeholder = '🔍 曲名・アーティストで絞り込み...';
})();
