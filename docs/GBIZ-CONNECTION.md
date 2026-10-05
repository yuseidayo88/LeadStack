# Gビズインフォ接続の準備

> 2026-10-05更新: 以下は開発時点の記録です。現在の反映状況は [本番公開記録](PRODUCTION-RELEASE-2026-10-05.md) を参照してください。

2026-10-05の接続クライアント準備時点の記録。サーバー専用の検索・法人詳細取得クライアントと接続確認コマンドを追加した。その後の画面・検索用DB・取込・公式サイト補完の実装は[外部企業検索の実装記録](EXTERNAL-COMPANY-DISCOVERY.md)を参照する。本番への公開・DB反映はまだ行っていない。

## 設定

環境変数名は `GBIZ_API_TOKEN`。`NEXT_PUBLIC_` を付けず、実値をコミット・ログ出力しない。ローカルで使う場合は、既存の `.env.local` の他の設定を保ったままこの1項目だけ設定する。Vercelの環境変数を一括取得してローカルのSupabase接続設定を上書きしない。

Vercelプロジェクト `leadstack` で、Production対象の同名変数がSecret（API上は `sensitive`）として登録されていることを確認した。値は取得できず、実API接続の成功はまだ確認していない。ローカル検証に利用できるDevelopment用の設定を依頼中。Productionの設定は変更していない。

Secretは保存後に値を読み戻せないため、登録の確認と接続成功の確認は別である。[Vercel公式仕様](https://vercel.com/docs/environment-variables/sensitive-environment-variables)

## 接続確認

Node.js 24環境で、ローカルの環境変数が設定済みなら次を実行する。

```sh
npm run check:gbiz
```

経済産業省の公開法人番号 `4000012090001` の詳細を1回だけ取得し、成功可否・法人番号・項目の有無をJSONで出力する。CRMやDBへの書込み、企業サイトの巡回は行わない。トークン、HTTPヘッダー、外部の生のエラー文は表示しない。未設定・接続エラー・法人情報なしは非ゼロ終了。

これはAPIの疎通確認であり、営業対象のデータ充足率や県別・業種別検索の完成を示す検証ではない。

## APIで確認できた範囲

- 固定の接続先 `https://api.info.gbiz.go.jp/hojin` と `X-hojinInfo-api-token` ヘッダーを使用。
- `/v2/hojin` の都道府県・名称・法人番号検索と、`/v2/hojin/{corporate_number}` の詳細取得。
- 検索はページ1〜10、1回20〜50件に制限する。自動で全ページを走査しない。
- Webサイト、従業員数、業種は詳細取得で確認する。欠損は不明として保持する。
- 業種によるAPI検索と電話番号フィールドはない。これらの補完方法は別途検証が必要。
- タイムアウト、認証失敗、429、上流エラーを区別する。任意URLやリダイレクト先にはトークンを送らない。

[公式OpenAPI v2](https://api.info.gbiz.go.jp/hojin/v3/api-docs/v2)、[外部企業検索の要件案](EXTERNAL-COMPANY-DISCOVERY-REQUIREMENTS.md)

## 検証結果

- Gビズインフォ向け43件を含む全94単体テスト成功。API応答はモックで検証。
- lint・型検査・本番ビルド成功。
- トークン未設定で `npm run check:gbiz` を実行し、`not_configured` と終了コード1を確認。秘密情報を出力せず、外部へのリクエストも行わない。
- DB・RLS・既存画面の変更はなく、この追加に対するDB/ブラウザ試験は実施していない。
- 実APIの接続テストは開発用トークンの利用待ち。

検証ログ: `/workspace/handoff/gbiz-{tests,lint,typecheck,build}.log`。
