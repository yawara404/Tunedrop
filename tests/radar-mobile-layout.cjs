// ==========================================================
// モバイル Radar: 動画プレイヤー表示中のマップ枠の大きさ (実ブラウザ) E2E テスト
// ----------------------------------------------------------
// Chrome (headless) + DevTools Protocol で実機相当のモバイル幅を再現し、
// 「動画を出している間もマップ枠が縦長に潰れず、正方形に近い」ことを検証する。
//
// 背景:
//   - 以前はこの状態でマップを 80px まで縮めており、狭すぎた。
//   - 残りの高さいっぱい (flex: 1) に伸ばす方式では、マップが幅と高さで
//     別々に正規化されて描かれるため、縦長の枠ではレーダーが縦に間延びして見えた。
//   - 現在は動画を出している間だけ「横幅と同じくらいの高さ (aspect-ratio: 1 / 1)」に
//     している。動画を出す前/閉じた後は従来どおり残りの高さいっぱいのまま。
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
    // 実機相当 (iPhone 14 相当の 390x844)。枠の下端が画面内に収まるかも見る。
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
        };
    })()`);

    // 1) 動画を出す前 (= 引っ込む前): 従来どおり「残りの高さいっぱい」で、正方形には固定しない
    const before = await measure();
    console.log('プレイヤーなし:', JSON.stringify(before));
    check('動画を出す前もマップが表示されている (高さ200px以上)',
        before.height >= 200 && before.canvasHeight > 0, JSON.stringify(before));
    check('動画を出す前は正方形に固定されない (従来どおり縦長のまま = 引っ込む前は前のまま)',
        before.aspect < 0.95, `aspect=${before.aspect} (${before.width}x${before.height})`);

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

    check('動画プレイヤー表示中もマップが潰れない (旧: 80px まで縮んでいた)',
        playing.height >= 240, `height=${playing.height}`);
    check('動画プレイヤー表示中はマップ枠が正方形に近い (縦長に伸ばさない)',
        playing.aspect >= 0.95 && playing.aspect <= 1.05, `aspect=${playing.aspect} (${playing.width}x${playing.height})`);
    check('再描画されたビットマップも枠と同じ縦横比 (レーダーが歪まない)',
        playing.bitmapAspect > 0 && Math.abs(playing.bitmapAspect - playing.aspect) <= 0.05,
        `bitmap=${playing.bitmapAspect} box=${playing.aspect}`);
    check('ズームボタン (モバイル唯一のズーム手段) が枠の中にある',
        playing.zoomInsideBox, JSON.stringify(playing));
    check('マップ枠の下端が画面内 (プレイヤーバーより上) に収まる',
        playing.boxBottom <= playing.viewportH - playing.playerBarHeight,
        `boxBottom=${playing.boxBottom} limit=${playing.viewportH - playing.playerBarHeight}`);

    // 3) 動画を閉じたら元の大きさに戻る (= 引っ込む前は前のまま)
    await evaluate(`(() => {
        document.body.classList.remove('player-in-sidebar');
        document.querySelector('.youtube-popup')?.classList.remove('is-active');
        return true;
    })()`);
    await sleep(1200);
    const closed = await measure();
    check('動画を閉じると従来どおり画面の高さいっぱいに戻る (正方形指定は解除される)',
        closed.height > playing.height && closed.aspect < 0.95 && closed.canvasHeight > 0,
        JSON.stringify(closed));

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
