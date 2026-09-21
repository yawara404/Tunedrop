# 検証用テストユーザー (AI作業用メモ)

SNS紹介動画の撮影などで実際に操作するためのテストアカウント。
本番DB上に実在する。検証後は残すこと (削除しない)。

## アカウント

- ログインID: `sns_demo`
- 表示名: `夜ドライブ好き`
- パスワード: リポジトリには書かない。
  ローカルの `.sns_demo_credentials` (Git管理外・HTTP配信外・600) を読むこと。
- テスト用プレイリスト: `夜ドライブ J-POP` (公開・J-POP・3曲:
  YOASOBI「夜に駆ける」/ 米津玄師 Lemon / King Gnu 白日)

## 使い方

```bash
cd /Users/<username>/Tunedrop
set -a; source .sns_demo_credentials; set +a
TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$TUNEDROP_SNS_DEMO_USER\",\"password\":\"$TUNEDROP_SNS_DEMO_PASS\"}" \
  'http://localhost:8888/tunedrop/api.php?action=auth&endpoint=login' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```

ブラウザ操作の自動撮影は `/tmp/sns_capture2.cjs` を参照
(Chrome CDP・縦画面・5シーン)。完成動画は `backups/tunedrop_sns.mp4`。

## 作り直し (アカウントを消した場合)

```bash
# 登録 → 表示名 → 公開プレイリスト → 3曲追加 (IDは下記)
# 曲: x8VYWazR5mE / SX_ViT4Ra7k / ony539T074w
```

詳細手順の実行例は対応する作業セッションのログを参照。
削除は管理者API (`admin.php?action=delete_user`) でのみ行うこと。
