# 2026-10-05 本番公開記録

企業検索・営業リスト取込と既存CRM/認証の改善を、ユーザーの「本番で使えるように」という指示に基づき公開した。

- 公開URL: https://leadstack-amber.vercel.app/discover
- アプリのソース: `4818cb405ad7b788bbd3ed36ca309be424a4da77`。GitHubの `main` にもfast-forwardで反映済み。
- Vercel deployment: `dpl_78oktM2bcTbAzvKVjuDYqK7DNY9c`、Production / READY、公開alias割当成功。
- Supabase: `nzptxhoakuzcfmpswovz`。旧プロジェクトへの操作なし。
- 以前の本番deployment: `dpl_EX16tWNAGkZjXsGaSMprRXQvzYAW`。アプリを戻す場合の参照先。旧アプリへ戻しても新機能で登録したデータは保持する。DBの破壊的な巻戻しは行っていない。

## 反映内容

未適用だった以下の5 migrationを順に適用。適用済みの4件と合わせて9件がリポジトリと一致することを確認した。

1. `20261004161946_workflow_improvements`
2. `20261005011109_session_and_operation_guards`
3. `20261005014821_record_edit_versions`
4. `20261005045823_company_contact_search`
5. `20261005071344_external_company_discovery`

Supabase Authの現在パスワード要求を有効化し、復旧用callbackの正確なURLを追加した。Vercel Productionに `AUTH_EMAIL_READY=false` を明示。既存のGビズ秘密トークンはProductionのまま利用し、取得・表示・再登録していない。

適用直前に業務15テーブル・44行の論理スナップショットをアクセス制限付きローカル領域へ保存した。認証資格情報、招待内容、automation_configは対象外。全DBバックアップとは異なる。適用後、既存列について全44行が同一であることを比較確認した。

## 本番での確認結果

2026-10-05 08:14–08:15 UTC、専用の「LeadStack 動作確認用」組織で実ブラウザー検証を実施。

| 確認                                    | 結果                                                            |
| --------------------------------------- | --------------------------------------------------------------- |
| 既存アカウントの本番ログイン            | 成功                                                            |
| 未ログインで候補APIへアクセス           | 401で拒否                                                       |
| 無関係な架空組織IDでアクセス            | 403/404で拒否                                                   |
| ProductionのGビズ設定                   | 有効                                                            |
| 実Gビズの法人番号検索・詳細取得         | トヨタ自動車1社を取得、詳細失敗0件                              |
| 項目の対応付け                          | 愛知県・製造業・Webサイト・従業員数を取得。電話は不明のまま保持 |
| 都道府県と業種のAND検索                 | 成功                                                            |
| デスクトップ・モバイルの選択欄          | 操作成功、モバイル画面内に収まることを確認                      |
| UIで取込内容確認→営業リスト取込         | 新規1社                                                         |
| 同じ取込の再送                          | 新規0社、同じ既存1社を返す                                      |
| 取込結果からCRM企業・架電記録画面へ遷移 | 成功。電話発信・活動保存は未実行                                |
| JavaScript実行エラー・想定外APIエラー   | 0件                                                             |
| 検証終了時のログアウト                  | 検証セッションだけを終了                                        |

08:19 UTCに、同じ候補のGビズ由来公式サイトに対する補完をUIから1回実行した。APIは200、結果は `blocked`（転送先の公開範囲を確認できないため停止）。画面表示・確認結果のDB保存・候補値およびCRMの非上書きが成功し、ブラウザー/APIエラーは0件。これは実サイトから電話番号を取得できたという結果ではない。

専用組織へ、候補1件・CRM企業1件・取込出典記録を残した。実顧客組織への書込みなし。全publicテーブル18件でRLSとactive_session制限が有効であることも本番DBで確認。

ローカルの単体/API271件、DB/RLS52件、並行処理4件、実Auth/PostgRESTの業務E2E、lint・typecheck・buildは公開前に成功。本番側のVercelビルドも成功した。

## 運用上の範囲

- 取得は1回20社。業種絞込みは保存済み候補に適用される。全国企業をあらかじめ網羅したデータベースではない。
- 電話番号はGビズAPIには含まれない。公式サイト補完の提案を人が確認して採用するか、手動で保存する。Webサイト・従業員数も元データにない企業では不明となる。
- 既存アカウントは利用可能。SMTPの実配送が未検証のため、新規登録・確認メール再送・パスワード再設定の申込みは停止中。メール確認必須を解除していない。
- 実Safari、継続的な大量処理、全企業の情報収録率は未検証。

Supabase Advisorsも確認した。privateの制限管理テーブルは直接アクセスを拒否する設計のため、[RLSポリシーなしの情報通知](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)がある。ログイン前の回数制限RPCと認可チェック付きの組織管理RPCは、意図した [SECURITY DEFINER権限](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)としてレビュー済み。[漏洩パスワード照合](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)は未設定。[外部キー索引](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)などの性能通知は記録し、大規模負荷の検証結果とは扱わない。課金や新サービス追加はしていない。

## 証跡

- 本番結果: `/workspace/handoff/production-discovery-smoke.log`、`/workspace/handoff/production-discovery-enrich.log`
- スクリーンショット: `test-results/production-discovery/`（git管理外）
- 秘密情報を含まない実行結果とビルドログ: `/workspace/handoff/production-release-private/`。同じ場所の業務バックアップ・認証設定控えは非公開で保持し、配布しない。
- 機能・制限の詳細: [外部企業検索](EXTERNAL-COMPANY-DISCOVERY.md)
