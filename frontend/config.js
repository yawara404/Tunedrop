// 公開環境: ./start.sh (PHPビルトインサーバー) + Cloudflare Tunnel。
//   APIは同じoriginの api.php で配信される。こちらを第一候補として自動検出するため、
//   通常この設定を変更する必要はない。
//
// fallbackApiUrl / fallbackApiPorts は「画面だけ別サーバーから開き、APIは ./start.sh の
// PHPが動いている」場合の予備候補 (VS Code Live Server / Vite開発サーバー /
// index.html を直接開く等)。Live Server は静的配信のみでPHPを実行できないため、
// 同じoriginにはAPIが無い。そこで候補を順に health で確認し、正しいAPIだけを採用する
// (別アプリや古いコピーは features 判定で弾かれる)。
//   ./start.sh は 8888 が使用中だと 8000/8001/8002/8003/8010/8080 へ自動で切り替わるため、
//   その候補も入れておく (起動時に表示されたURLのポートを足してもよい)。
window.TUNEDROP_CONFIG = {
    fallbackApiUrl: 'http://localhost:8888/api.php',
    fallbackApiPorts: [8888, 8000, 8001, 8002, 8003, 8010, 8080],
    // Googleログイン用 (Google Cloud Console で発行した OAuth 2.0 クライアントID)。
    // クライアントIDは秘密情報ではなく、ブラウザへ配信される値。
    // 空文字にするとログインモーダルのGoogleボタンが非表示になります。
    // 利用時は GCS の「承認済み JavaScript 生成元」に、画面を開く origin を登録する
    // (origin はスキーム・ホスト・ポートの組。localhost と 127.0.0.1 は別扱い)。
    googleClientId: '364600828471-9lpjnroalet19l55jqa555h6dsvnhtl0.apps.googleusercontent.com'
};
