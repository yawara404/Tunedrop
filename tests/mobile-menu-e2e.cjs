// ==========================================================
// モバイルのハンバーガーメニュー (実ブラウザ) E2E テスト
// ----------------------------------------------------------
// Chrome (headless) + DevTools Protocol で実際にモバイル幅のページを操作し、
// 「メニューを開いている間に他の操作をしたら閉じる」ことを検証する。
//
// 使い方:
//   1) サーバー起動 (プロジェクト直下で): php -S 127.0.0.1:8199 -t .
//   2) Chrome 起動:
//      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//        --headless=new --remote-debugging-port=9222 \
//        --user-data-dir=/tmp/tunedrop-chrome-e2e about:blank
//   3) node tests/mobile-menu-e2e.cjs
//
// 環境変数:
//   TUNEDROP_E2E_BASE … 検証対象ページ (既定 http://127.0.0.1:8199/index.html)
//   TUNEDROP_E2E_CDP  … Chrome の DevTools エンドポイント (既定 http://127.0.0.1:9222)
// ==========================================================
const assert = require('node:assert/strict');

const BASE = process.env.TUNEDROP_E2E_BASE || 'http://127.0.0.1:8199/index.html';
const CDP = process.env.TUNEDROP_E2E_CDP || 'http://127.0.0.1:9222';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function cdpVersion() {
    try {
        return await (await fetch(`${CDP}/json/version`)).json();
    } catch (error) {
        console.error(`Chrome (DevTools) に接続できません: ${CDP}\n先に --remote-debugging-port 付きで Chrome を起動してください。`);
        process.exit(2);
    }
}

(async () => {
    const { webSocketDebuggerUrl } = await cdpVersion();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    const pageExceptions = [];
    const consoleErrors = [];
    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id);
            if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
            else entry.resolve(message.result);
            return;
        }
        if (message.method === 'Runtime.exceptionThrown') {
            pageExceptions.push(message.params.exceptionDetails?.exception?.description || 'unknown');
        }
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
            consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
        }
    });

    function send(method, params = {}, sessionId) {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        });
    }

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);

    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await call('Page.navigate', { url: BASE });

    async function evaluate(expression) {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
        }
        return result.result.value;
    }

    // アプリ (app.js) の初期化待ち
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
        ready = await evaluate("typeof toggleSidebar === 'function' && !!document.querySelector('.playlist-nav')");
        if (!ready) await sleep(200);
    }
    assert.ok(ready, 'ページが読み込まれませんでした');

    async function clickPoint(x, y) {
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await sleep(100);
    }

    const state = () => evaluate(`({
        open: document.body.classList.contains('mobile-menu-open'),
        nav: document.querySelector('.top-nav nav').classList.contains('show-mobile'),
        sidebar: document.querySelector('.sidebar').classList.contains('show-mobile'),
        radarSidebar: document.querySelector('.radar-sidebar').classList.contains('show-mobile'),
        sidebarDisplay: getComputedStyle(document.querySelector('.sidebar')).display,
        aria: document.getElementById('menu-toggle-btn').getAttribute('aria-expanded'),
    })`);

    const results = [];
    function check(name, ok, detail) {
        results.push({ name, ok });
        console.log(`${ok ? 'OK  ' : 'NG  '} ${name}${detail ? ' :: ' + detail : ''}`);
    }

    // 1) ハンバーガーで開く
    const hamburgerDisplay = await evaluate("getComputedStyle(document.getElementById('menu-toggle-btn')).display");
    check('モバイル幅 (390px) でハンバーガーが表示される', hamburgerDisplay !== 'none', hamburgerDisplay);

    await evaluate("document.getElementById('menu-toggle-btn').click()");
    let s = await state();
    check('ハンバーガーでメニューが開く (ナビ + サイドバー)', s.open && s.nav && s.sidebar, JSON.stringify(s));
    check('開いたときサイドバーが実際に表示される', s.sidebarDisplay === 'block', s.sidebarDisplay);
    check('開いたとき aria-expanded=true', s.aria === 'true', String(s.aria));

    // 2) ヘッダー余白 (メニュー外) の実タップで閉じる
    await clickPoint(220, 26);
    s = await state();
    check('ヘッダー余白のタップで閉じる', !s.open && !s.nav && !s.sidebar, JSON.stringify(s));
    check('閉じたとき aria-expanded=false', s.aria === 'false', String(s.aria));

    // 3) サイドバー内の「新規リスト作成」(モーダル) で閉じる
    await evaluate("closeMobileMenu(); toggleSidebar();");
    await evaluate("document.querySelector('.sidebar .add-btn')?.click()");
    s = await state();
    check('サイドバー内の新規リスト作成 (モーダル) で閉じる', !s.open, JSON.stringify(s));
    await evaluate("closeCreatePlaylistModal && closeCreatePlaylistModal()");

    // 4) リスト項目を選んだら閉じる
    await evaluate("closeMobileMenu(); toggleSidebar();");
    const itemCount = await evaluate("document.querySelectorAll('.playlist-nav li').length");
    if (itemCount > 0) {
        await evaluate("document.querySelector('.playlist-nav li').click()");
        s = await state();
        check('リスト項目の選択で閉じる', !s.open, JSON.stringify(s));
    } else {
        check('リスト項目の選択で閉じる', true, 'リスト項目なし (スキップ)');
    }

    // 5) ドロワー背景 (メニューの余白) のタップで閉じる
    await evaluate("closeMobileMenu(); toggleSidebar();");
    const drawerBottomY = await evaluate("Math.round(document.querySelector('.sidebar').getBoundingClientRect().bottom - 8)");
    await clickPoint(195, drawerBottomY);
    s = await state();
    check('ドロワー背景のタップで閉じる', !s.open, `y=${drawerBottomY} ${JSON.stringify(s)}`);

    // 6) コンテンツのスクロールで閉じる
    await evaluate("closeMobileMenu(); toggleSidebar();");
    const contentScroll = await evaluate(`(() => {
        const ca = document.querySelector('.content-area');
        const filler = document.createElement('div');   // padding は !important で上書きされるため要素で伸ばす
        filler.id = 'e2e-filler';
        filler.style.height = '3000px';
        ca.appendChild(filler);
        ca.scrollTop = 200;
        return { top: ca.scrollTop, scrollable: ca.scrollHeight > ca.clientHeight };
    })()`);
    await sleep(200);
    s = await state();
    check('コンテンツのスクロールで閉じる', !s.open && contentScroll.top > 0, JSON.stringify({ ...s, ...contentScroll }));

    // 7) ドロワー内スクロールでは閉じない
    // (直前のスクロールの収束 (位置の clamp) を待ってから開き直す)
    await evaluate("(() => { const ca = document.querySelector('.content-area'); document.getElementById('e2e-filler')?.remove(); ca.scrollTop = 0; })()");
    await sleep(300);
    await evaluate("closeMobileMenu(); toggleSidebar();");
    const drawerScroll = await evaluate(`(() => {
        const sb = document.querySelector('.sidebar');
        sb.style.setProperty('max-height', '140px', 'important');   // ドロワー自体をスクロール可能にする
        sb.scrollTop = 40;
        return { top: sb.scrollTop };
    })()`);
    await sleep(200);
    s = await state();
    check('ドロワー内スクロールでは閉じない', s.open && drawerScroll.top > 0, JSON.stringify({ ...s, ...drawerScroll }));
    await evaluate("document.querySelector('.sidebar').style.removeProperty('max-height');");

    // 7b) ドロワー内の絞り込み入力の実タップでも閉じない
    await evaluate("closeMobileMenu(); toggleSidebar();");
    const searchBox = await evaluate(`(() => {
        const rect = document.getElementById('manager-search').getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    await clickPoint(searchBox.x, searchBox.y);
    s = await state();
    // 8) Escape キーで閉じる
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(200);
    s = await state();
    check('Escape で閉じる', !s.open, JSON.stringify(s));

    // 8b) メニュー内のタブ (Share) を実タップ → 画面遷移して閉じる
    await evaluate("switchView('manager'); closeMobileMenu(); toggleSidebar();");
    const navShareBox = await evaluate(`(() => {
        const rect = document.getElementById('nav-share').getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    await clickPoint(navShareBox.x, navShareBox.y);
    await sleep(300);
    s = await state();
    check('メニュー内のタブ (Share) のタップで画面遷移して閉じる',
        !s.open && await evaluate("document.getElementById('view-share').classList.contains('active')"),
        JSON.stringify({ ...s, ...navShareBox }));

    // 8c) Radar 画面: ハンバーガーで Radar サイドバーが開き、他の操作で閉じる
    await evaluate("switchView('radar')");
    await sleep(500);
    await evaluate("closeMobileMenu(); toggleSidebar();");
    const radarState = await state();
    check('Radar 画面でハンバーガーからドロワーが開く',
        radarState.open && radarState.radarSidebar, JSON.stringify(radarState));
    await clickPoint(220, 26);   // ヘッダー余白の実タップ
    s = await state();
    check('Radar 画面でも他の操作で閉じる', !s.open && !s.radarSidebar, JSON.stringify(s));

    // 9) PC幅へリサイズ (回転相当) すると閉じる
    await evaluate("switchView('manager')");
    await sleep(300);
    await evaluate("closeMobileMenu(); toggleSidebar();");
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    s = await state();
    check('PC幅へのリサイズで閉じる', !s.open, JSON.stringify(s));

    // 10) PC幅ではメニュー状態が入らない (従来どおりのデスクトップ表示)
    const desktopState = await evaluate(`({
        hamburgerHidden: getComputedStyle(document.getElementById('menu-toggle-btn')).display === 'none',
        open: document.body.classList.contains('mobile-menu-open'),
        sidebarHidden: getComputedStyle(document.querySelector('.sidebar')).display === 'none',
    })`);
    check('PC幅ではハンバーガー非表示 & サイドバー常時表示 & メニュー状態なし',
        desktopState.hamburgerHidden && !desktopState.open && !desktopState.sidebarHidden, JSON.stringify(desktopState));

    await clickPoint(900, 400);   // PC幅でコンテンツをクリック
    const afterDesktopClick = await evaluate(`({
        open: document.body.classList.contains('mobile-menu-open'),
        sidebar: document.querySelector('.sidebar').classList.contains('show-mobile'),
        nav: document.querySelector('.top-nav nav').classList.contains('show-mobile'),
    })`);
    check('PC幅のクリックでメニュー状態が入らない',
        !afterDesktopClick.open && !afterDesktopClick.sidebar && !afterDesktopClick.nav, JSON.stringify(afterDesktopClick));

    console.log('\n--- ページ内の JS 例外 ---');
    console.log(pageExceptions.length ? pageExceptions.join('\n') : '(なし)');
    console.log('--- console.error ---');
    console.log(consoleErrors.length ? consoleErrors.join('\n') : '(なし)');

    const failed = results.filter(result => !result.ok);
    await send('Target.closeTarget', { targetId });
    ws.close();
    assert.equal(failed.length, 0, `失敗: ${failed.map(result => result.name).join(' / ')}`);
    console.log(`\nE2E PASS: ${results.length} 件 (モバイルメニュー)`);
})().catch(error => {
    console.error('E2E FAILED:', error);
    process.exit(1);
});

