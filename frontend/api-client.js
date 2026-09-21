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
