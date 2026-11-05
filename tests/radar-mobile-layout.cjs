// ==========================================================
// モバイル Radar: マップ枠の大きさとスクロール操作 (実ブラウザ) E2E テスト
// ----------------------------------------------------------
// Chrome (headless) + DevTools Protocol で実機相当のモバイル幅を再現し、
// - マップが画面の一部に収まり、下の曲リスト/スクロール領域が残ること
// - 動画プレイヤー表示中でもマップが潰れず、枠の下端が画面内に収まること
// - マップ上でも1本指の縦スワイプでページがスクロールできること
// - 「拡大」ボタンでマップを大きくできること
// を検証する。
//
// 背景:
//   動画プレイヤーは YouTube の規約上サイズを変えられない。以前はマップが
//   残りの高さいっぱい (flex: 1) を占有し、しかも touch-action: none だったため、
//   マップ上でスクロールできず操作感が悪かった。現在は高さを画面の約1/3に抑え、
//   1本指の縦スワイプはページスクロール、2本指で移動・ズームにしている。
//
// 使い方:
//   0) 画面をビルドしておく (プロジェクト直下の index.html と assets/ に出力される):
//      npm run build
//   1) サーバー起動 (プロジェクト直下で): php -S 127.0.0.1:8199 -t .
//   2) Chrome 起動:
//      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//        --headless=new --remote-debugging-port=9222 \
//        --user-data-dir=/tmp/tunedrop-chrome-e2e about:blank
//   3) node tests/radar-mobile-layout.cjs
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
    await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    // 実機相当 (iPhone 14 相当の 390x844)。枠の下端が画面内に収まるかも見る。
    await call('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
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
        ready = await evaluate("typeof navigateView === 'function' && !!document.querySelector('.radar-map-container')");
        if (!ready) await sleep(200);
    }
    assert.ok(ready, 'ページが読み込まれませんでした');

    const results = [];
    function check(name, ok, detail) {
        results.push({ name, ok });
        console.log(`${ok ? 'OK  ' : 'NG  '} ${name}${detail ? ' :: ' + detail : ''}`);
    }

    // Radar 画面を開き、キャンバスが枠の大きさに合わせて描かれるまで待つ
    // (app.js の drawRadarMap は canvas.style.height を実サイズへ書き換える。
    //  開発サーバー (npm run dev) は初回コンパイルに時間がかかるため長めに待つ)
    await evaluate("navigateView('radar')");
    for (let i = 0; i < 60; i++) {
        const sized = await evaluate("!!document.getElementById('radar-map-canvas')?.style.height");
        if (sized) break;
        await sleep(200);
    }
    await sleep(600);

    // マップ枠・キャンバス・ズームボタンの実測値
    const measure = () => evaluate(`(() => {
        const box = document.querySelector('.radar-map-container');
        const canvas = document.getElementById('radar-map-canvas');
        const zoom = document.querySelector('.radar-map-zoom');
        const bar = document.querySelector('.bottom-player');
        const area = document.querySelector('.radar-content-area');
        const guide = document.querySelector('.radar-touch-guide');
        const expand = document.getElementById('btn-radar-map-expand');
        const r = box.getBoundingClientRect();
        const z = zoom.getBoundingClientRect();
        return {
            width: Math.round(r.width),
            height: Math.round(r.height),
            aspect: Number((r.width / r.height).toFixed(2)),
            boxBottom: Math.round(r.bottom),
            // 描画に使われているビットマップの縦横比 (枠の比とズレていれば絵が歪む)
            bitmapAspect: canvas.width && canvas.height ? Number((canvas.width / canvas.height).toFixed(2)) : 0,
            canvasHeight: Math.round(canvas.getBoundingClientRect().height),
            // ズームボタン (モバイル唯一のズーム手段) が枠の中に収まっているか
            zoomInsideBox: z.top >= r.top - 1 && z.bottom <= r.bottom + 1 && z.right <= r.right + 1,
            viewportH: window.innerHeight,
            playerBarHeight: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
            // マップ上での1本指スクロール (pan-y) と、スマホ用UIの表示
            touchAction: getComputedStyle(canvas).touchAction,
            guideVisible: !!guide && getComputedStyle(guide).display !== 'none',
            expandVisible: !!expand && getComputedStyle(expand).display !== 'none',
            mapHeightRatio: Number((r.height / window.innerHeight).toFixed(2)),
            areaScrollable: !!area && area.scrollHeight > area.clientHeight,
        };
    })()`);

    // 1) 動画を出す前: マップは画面の一部 (約1/3) に収まり、下にスクロール領域が残る
    const before = await measure();
    console.log('プレイヤーなし:', JSON.stringify(before));
    check('マップが表示されている (高さ240px以上)',
        before.height >= 240 && before.canvasHeight > 0, JSON.stringify(before));
    check('マップの高さは画面の半分以下 (リスト/スクロール領域を確保)',
        before.mapHeightRatio <= 0.5, `ratio=${before.mapHeightRatio} height=${before.height}/${before.viewportH}`);
    check('マップ枠の下端が画面内に収まる',
        before.boxBottom <= before.viewportH - before.playerBarHeight, JSON.stringify(before));
    check('スマホではマップ上で1本指の縦スクロールができる (touch-action: pan-y)',
        before.touchAction === 'pan-y', before.touchAction);
    check('スマホ用の操作ガイドが表示される',
        before.guideVisible, String(before.guideVisible));
    check('スマホ用の拡大ボタンが表示される',
        before.expandVisible, String(before.expandVisible));

    // 2) 曲を選んで動画を出した状態 (app.js の playTrackFromQueue と同じ状態) を作る
    await evaluate(`(() => {
        document.body.classList.add('player-in-sidebar');
        document.querySelector('.youtube-popup')?.classList.add('is-active');
        return true;
    })()`);
    // content-area の margin-top は 280ms のトランジション + ResizeObserver で再描画される
    await sleep(1200);
    const playing = await measure();
    console.log('プレイヤー表示中:', JSON.stringify(playing));

    check('動画プレイヤー表示中もマップが潰れない (高さ240px以上)',
        playing.height >= 240, `height=${playing.height}`);
    check('動画プレイヤー表示中もマップは画面の半分以下 (スクロール領域を確保)',
        playing.mapHeightRatio <= 0.5, `ratio=${playing.mapHeightRatio}`);
    check('動画プレイヤー表示中もマップ枠が縦長になりすぎない',
        playing.aspect >= 0.8 && playing.aspect <= 2.0, `aspect=${playing.aspect} (${playing.width}x${playing.height})`);
    check('再描画されたビットマップも枠と同じ縦横比 (レーダーが歪まない)',
        playing.bitmapAspect > 0 && Math.abs(playing.bitmapAspect - playing.aspect) <= 0.05,
        `bitmap=${playing.bitmapAspect} box=${playing.aspect}`);
    check('ズームボタン (モバイル唯一のズーム手段) が枠の中にある',
        playing.zoomInsideBox, JSON.stringify(playing));
    check('マップ枠の下端が画面内 (プレイヤーバーより上) に収まる',
        playing.boxBottom <= playing.viewportH - playing.playerBarHeight,
        `boxBottom=${playing.boxBottom} limit=${playing.viewportH - playing.playerBarHeight}`);
    check('動画プレイヤー表示中もマップ上で縦スクロールできる',
        playing.touchAction === 'pan-y', playing.touchAction);

    // 3) 拡大ボタン: マップを大きく見たいときだけ高さを広げる
    await evaluate(`toggleRadarMapExpanded()`);
    await sleep(700);
    const expanded = await measure();
    console.log('拡大中:', JSON.stringify(expanded));
    check('拡大ボタンでマップが高くなる',
        expanded.height > playing.height, `${playing.height} -> ${expanded.height}`);
    check('拡大中はマップ操作を優先する (touch-action: none)',
        expanded.touchAction === 'none', expanded.touchAction);
    await evaluate(`toggleRadarMapExpanded()`);
    await sleep(700);

    // 4) マップ上で1本指スワイプ → ページがスクロールする
    const scrollStart = await evaluate(`(() => {
        const area = document.querySelector('.radar-content-area');
        const filler = document.createElement('div');
        filler.id = 'e2e-radar-filler';
        // .radar-content-area は flex コンテナなので、height だけだと flex-shrink で
        // 縮んでスクロール可能にならない。flex-basis で固定する。
        filler.style.flex = '0 0 2400px';
        area.appendChild(filler);
        area.scrollTop = 0;
        const box = document.querySelector('.radar-map-container').getBoundingClientRect();
        return {
            x: Math.round(box.left + box.width / 2),
            y: Math.round(box.top + box.height / 2),
            top: area.scrollTop,
            scrollable: area.scrollHeight > area.clientHeight,
        };
    })()`);
    const touch = (type, x, y) => call('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 0 }],
    });
    await touch('touchStart', scrollStart.x, scrollStart.y);
    for (let i = 1; i <= 8; i++) {
        await touch('touchMove', scrollStart.x, scrollStart.y - i * 14);
        await sleep(20);
    }
    await touch('touchEnd', scrollStart.x, scrollStart.y);
    await sleep(600);
    let scrolledTop = await evaluate(`document.querySelector('.radar-content-area').scrollTop`);
    if (!(scrolledTop > 0)) {
        // CDP のタッチイベントでスクロールしない環境向け: 合成スクロールジェスチャーで再試行
        await call('Input.synthesizeScrollGesture', {
            x: scrollStart.x, y: scrollStart.y,
            xDistance: 0, yDistance: -180,
            gestureSourceType: 'touch', speed: 800,
        });
        await sleep(600);
        scrolledTop = await evaluate(`document.querySelector('.radar-content-area').scrollTop`);
    }
    check('マップ上で1本指スワイプするとページがスクロールする',
        scrollStart.scrollable && scrolledTop > 0, `scrollTop=${scrolledTop} / start=${scrollStart.top}`);
    await evaluate(`(() => {
        document.getElementById('e2e-radar-filler')?.remove();
        document.querySelector('.radar-content-area').scrollTop = 0;
    })()`);

    // 5) 動画を閉じたらマップの高さが戻る
    await evaluate(`(() => {
        document.body.classList.remove('player-in-sidebar');
        document.querySelector('.youtube-popup')?.classList.remove('is-active');
        return true;
    })()`);
    await sleep(1200);
    const closed = await measure();
    console.log('プレイヤーなし (閉じた後):', JSON.stringify(closed));
    check('動画を閉じるとマップの高さが戻る',
        closed.height >= playing.height && closed.canvasHeight > 0,
        `${playing.height} -> ${closed.height}`);
    check('動画を閉じてもマップは画面の半分以下',
        closed.mapHeightRatio <= 0.5, `ratio=${closed.mapHeightRatio}`);

    console.log('\n--- ページ内の JS 例外 ---');
    console.log(pageExceptions.length ? pageExceptions.join('\n') : '(なし)');
    console.log('--- console.error ---');
    console.log(consoleErrors.length ? consoleErrors.join('\n') : '(なし)');

    const failed = results.filter(result => !result.ok);
    await send('Target.closeTarget', { targetId });
    ws.close();
    assert.equal(failed.length, 0, `失敗: ${failed.map(result => result.name).join(' / ')}`);
    console.log(`\nE2E PASS: ${results.length} 件 (モバイル Radar マップ枠)`);
})().catch(error => {
    console.error('E2E FAILED:', error);
    process.exit(1);
});
