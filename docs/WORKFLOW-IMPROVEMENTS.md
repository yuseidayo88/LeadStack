# LeadStack 5項目改善・公開前レビュー（2026-10-04 UTC）

> 2026-10-05更新: 以下は開発時点の記録です。現在の反映状況は [本番公開記録](PRODUCTION-RELEASE-2026-10-05.md) を参照してください。

既存V1 `2b0706b` を引き継いだ変更。ローカルブランチ `feature/workflow-improvements`。この変更のGitHub push、Vercel公開、本番マイグレーション適用、Auth設定変更は未実施。

## 実装結果

| 項目       | 結果・仕様                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 架電       | 結果が「折返し」なら再架電タスクを自動選択し日時を必須化。APIとDB RPCでも拒否。活動・通話詳細・タスクは同じトランザクション。「保存して次の企業へ」は組織内の会社名・ID順。末尾ではボタンを表示しない。                                                                                     |
| 日次行動   | 自分の前日までの未完了タスクを期限超過として表示。自分の担当企業で未完了タスクがない企業を表示（終了・対象外を除く）。各先頭30件、企業からタスクを追加可能。最終接触はメール・打合せ・接続/折返し/アポイントの架電のみ。メモ・状態変更・不通で更新しない。                                  |
| CSV        | 600KB・500件。UTF-8/BOM/Shift_JIS、日本語ヘッダー、引用符・カンマ・セル内改行・先頭ゼロを扱う。プレビューでエラー・既存の会社名/電話/法人番号一致候補・ファイル内重複候補を表示。無効行・重複候補は初期選択から除外。選択行の明示確認で新規登録し、統合・更新しない。自分を担当営業に設定。 |
| 提案下書き | 登録済み業務・課題・ツールを選択し、ヒアリングで確認済みと明示してから編集画面を開く。業務/課題からbuild・automate、ツールからkeep。根拠・仮説・要確認事項を分け、数値効果や実現性を断定しない。保存前の編集可能、生成元ruleを保存。外部AI/API不要。                                        |
| 認証復旧   | ログイン画面にパスワード再設定と確認メール再送。PKCE callback→保護された再設定画面→12文字以上・二重入力→現在のユーザーだけ更新。アカウント有無の通常応答を統一、429/サービス障害/配信設定エラーを区別。callbackの外部URL拒否・no-store。                                                    |

CSVの電話番号が表計算ソフトで数値化され既にゼロを失っている場合、復元はしない。会社名順の次企業は企業一覧の検索・選択行に限定したキューではない。下書きの根拠選択肢は各直近100件。プレビューの重複判断は正規化した名前・電話番号または法人番号一致であり、類似社名の推測統合はしない。

## DB変更：必要、既存データは非破壊

追加ファイル：`supabase/migrations/20261004161946_workflow_improvements.sql`。

- 既存4マイグレーションは変更なし。既存CRM行の削除・更新・移行なし。
- `company_overview` を `security_invoker=true` のまま置換。列構成は維持。
- `record_activity` を置換して折返し日時を検証。権限・原子的保存を維持。
- `next_company` を追加、invoker/RLSで組織内取得。
- `private.company_import_previews` を追加。非公開schema＋RLS、作成者と書込み権限の両方を確認。public CRMは引き続き16テーブル。
- CSVプレビュー/確定RPCはinvoker。anonには実行権限なし。サーバーのAPIにも所属・viewer制限とOrigin検証。
- プレビューは30分間。確定は一括トランザクション。確定済みID・選択行を保持して同一再送の二重登録を防ぐ。確認時に候補が変わった場合409で再プレビュー。
- 確定時は企業テーブルへの書込みを短時間ロックし、重複確認と登録の間の競合を防止（最大500件）。大規模運用ではこの待機時間の測定が必要。
- 期限切れプレビューはその作成者が次にプレビューすると削除。スケジュール・新サービスは追加しない。

Supabase CLI 2.119.0は実行時に読取り専用のホームへ書こうとして起動できず、公式CLI 2.78.1の `migration new workflow_improvements` でファイル作成。SQLはPGliteと隔離した実Postgresに適用して確認。本番には適用していない。CLI advisorsは実行しておらず、RLS・invoker・公開実行権限はSQLテストで確認した。

公開手順は承認後に、対象が新プロジェクト `nzptxhoakuzcfmpswovz` であることを確認してこの1件を適用→アプリ公開。アプリが追加ビュー/RPCを使うためDB先行。旧プロジェクトには触れない。

## メール設定：読取り確認済みの状態と必要な作業

2026-10-04、新プロジェクトのManagement APIをGETのみ実施。秘密値は保存・表示せず必要な項目だけ確認。

| 設定                          | 現状                                                    |
| ----------------------------- | ------------------------------------------------------- |
| Site URL                      | `https://leadstack-amber.vercel.app`：適切              |
| Redirect URLs                 | `https://leadstack-amber.vercel.app/auth/callback` のみ |
| メール確認                    | 有効（autoconfirm=false）                               |
| Email provider                | 有効                                                    |
| 確認/再設定メールテンプレート | ともに `ConfirmationURL` を使用                         |
| カスタムSMTP                  | 未設定                                                  |
| メール送信上限                | 2通/時                                                  |

公開前に追加が必要なRedirect URL：
`https://leadstack-amber.vercel.app/auth/callback?next=%2Freset-password`
既存のcallback URLは残す。アプリ側 `NEXT_PUBLIC_SITE_URL` は同じ本番originを維持。リンクは申込み時のブラウザで開くPKCEフロー。

標準SMTPはプロジェクト組織メンバー宛の試用に限定され、任意ユーザーへの確認/再設定メールを本番提供する設定ではない。一般ユーザー向けには、既存の利用可能なSMTPがあるか確認が必要。設定項目はhost、port、ユーザー名、パスワード、Fromアドレス、送信者名、送信元ドメインの認証と送信上限。資格情報はチャットやGitへ記載しない。契約・課金・新SMTPサービス・OAuth追加はしていない。メール確認を無効化する回避策も実施しない。

根拠：[Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)、[メールテンプレート](https://supabase.com/docs/guides/auth/auth-email-templates)、[標準SMTPの制約と設定項目](https://supabase.com/docs/guides/auth/auth-smtp)。

**本番のメール配信は設定待ち。** 実メール送信、実ユーザーのパスワード更新、本番での登録・ログインは行っていない。元のユーザー本人のログイン失敗原因を解決済みとは扱わない。

## 確認結果

- `npm run lint` / `npm run typecheck` / `npm run build`：成功。
- `npm run test:recovery`：認証/API/CSV/提案等33件＋PGlite DB28件、成功。
- DB：全publicテーブルと非公開プレビューのRLS、tenant/viewer/anon拒否、CSVの無登録プレビュー・原子性・再送・重複競合・有効期限・法人番号競合、実接触日時、架電日時必須、次企業の組織境界。
- 隔離した実Postgres/Auth/PostgREST＋production buildで既存E2E成功：ログイン、組織、企業/連絡先、架電/タスク、商談成約、ヒアリング/提案、viewer・別組織、セッションrefresh、モバイル再読込・戻る・ログアウト・誤パスワード・再ログイン。
- 追加ブラウザE2E成功：CSV→プレビュー→確認→登録→再試行、折返し必須と次企業へ、日次アクション、3種類のルール下書き保存、viewer取込拒否、モバイル幅内ダイアログ。
- 認証復旧のSDK/APIテストはモック。ブラウザでは送信と更新のリクエストを差し替え、429→再試行、再送、更新完了UIを確認。実配信・メール経由の実コード交換を証明するテストではない。
- ブラウザpageerror：0。モバイルはiPhoneサイズChromium。実機iOS Safariは未検証。
- agent-browserでログイン画面と復旧導線も確認。

最終の配信設定エラー2種類の追加はAPI単体で確認。ブラウザE2E後の変更はこのエラー分類のみで、正常系UIに変更なし。

## 成果物・再実行

- `tests/recovery/improvements.test.ts`、`database.mjs`、`improvements-e2e.mjs`。
- `/workspace/handoff/improvement-tests.log`, `improvement-lint.log`, `improvement-typecheck.log`, `improvement-build.log`。
- `/workspace/handoff/improvement-e2e-baseline.log`, `improvement-e2e.log`。
- `/workspace/handoff/improvement-evidence/`：CSVデスクトップ/モバイル、日次画面、認証復旧ほか。
- `/workspace/handoff/improvement-auth-config-review.json`：秘密を除いた読取り結果。

追加E2Eは既存のローカルE2E fixture作成後にbaseline→improvementsの順で実行（本番接続禁止）。`E2E_BASE_URL`, `E2E_USERS_FILE`, `E2E_OUTPUT`, `PLAYWRIGHT_BROWSERS_PATH` を指定。fixtureには隔離した3ユーザーが必要。元の欠損テスト/補助スクリプトが回収できたことにはしていない。
