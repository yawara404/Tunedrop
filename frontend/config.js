// 公開環境: ./start.sh (PHPビルトインサーバー, port 8888) + Cloudflare Tunnel
//   (https://music.wawa-app.me/tunedrop)
// APIは同じoriginの api.php で配信される。こちらを第一候補として自動検出するため、
// 通常この設定を変更する必要はない。
// fallbackApiUrl は「画面だけ別サーバー (Vite開発サーバー・Live Server等) から開き、
// APIは ./start.sh のPHPが動いている」場合の予備候補。
// ※ localhost:8888/api.php が別アプリを指している場合は、health の features 判定で
//   弾かれる (古いコピーに接続して認証が全滅する事故を防ぐ)。
window.TUNEDROP_CONFIG = {
    fallbackApiUrl: 'http://localhost:8888/api.php',
    // Googleログイン用 (Google Cloud Console で発行した OAuth 2.0 クライアントID)
    // ※ 現在このクライアントIDは未設定/未有効のため、Googleログインは未対応。
    //    設定するときは GCS の当該クライアントの「承認済み JavaScript 生成元」に
    //    現在ページを開いている origin を登録する:
    //   - http://localhost:8888 / http://127.0.0.1:8888 (./start.sh の既定ポート)
    //     8888が使用中の場合は 8000/8001/8002/8003/8010/8080 の順で空きポートに
    //     自動で切り替わる (起動時に表示されるURLを開く)。その origin も登録する。
    //   - http://localhost:5500 / http://127.0.0.1:5500 (VS Code Live Server)
    //   - http://localhost:5173 / http://127.0.0.1:5173 (npm run dev の Vite開発サーバー)
    //   - https://music.wawa-app.me/tunedrop (Cloudflare Tunnel)
    // ※ localhost と 127.0.0.1、ポート違いは「別 origin」として扱われるため個別登録が必要。
    // ※ クライアントIDは APIキー (AQ./AIzaで始まる値) とは別物。ログインモーダルに現在の origin が表示される。
    // 空文字にするとログインモーダルのGoogleボタンが非表示になります。
    googleClientId: '364600828471-9lpjnroalet19l55jqa555h6dsvnhtl0.apps.googleusercontent.com'
};
