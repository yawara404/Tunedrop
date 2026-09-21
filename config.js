// 公開環境: MAMP/Apache (port 8888) + ngrok (https://gainfully-macaroni-swivel.ngrok-free.dev)
// APIは localhost:8888/api.php (ドキュメントルート = Tunedrop/ 直下) で配信される。
window.TUNEDROP_CONFIG = {
    mampApiUrl: 'http://localhost:8888/api.php',
    // Googleログイン用 (Google Cloud Console で発行した OAuth 2.0 クライアントID)
    // 「no registered origin」エラーが出るときは、GCS の当該クライアントの
    // 「承認済み JavaScript 生成元」に、現在ページを開いている origin を登録する:
    //   - http://localhost:8888 (MAMP) / http://127.0.0.1:8888
    //   - http://localhost:8000 (start.sh の PHPビルトインサーバー)
    //   - http://localhost:5500 / http://127.0.0.1:5500 (VS Code Live Server)
    //   - https://gainfully-macaroni-swivel.ngrok-free.dev (ngrok)
    // ※ localhost と 127.0.0.1、ポート違いは「別 origin」として扱われるため個別登録が必要。
    // ※ クライアントIDは APIキー (AQ./AIzaで始まる値) とは別物。ログインモーダルに現在の origin が表示される。
    // 未設定の場合はログインモーダルのGoogleボタンが非表示になります。
    // ※ ngrok公開URLをGCSの「承認済みJavaScript生成元」に追加してください。
    googleClientId: '364600828471-9lpjnroalet19l55jqa555h6dsvnhtl0.apps.googleusercontent.com'
};
