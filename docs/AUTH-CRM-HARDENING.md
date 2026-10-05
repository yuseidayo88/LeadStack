# 認証・CRM修正の公開前レビュー

対象: `fix/auth-and-crm-quality`。既存V1と未公開の改善5件を引き継いだ修正。再実装ではない。
本番は `2b0706b` のまま。`460cd82`（改善5件）、`ebc2e58`（監査）、今回の変更は未公開。
旧Supabaseへの操作、新サービス、課金、実ユーザー変更、実メール送信なし。

## 修正内容

- Auth/PKCE CookieをHttpOnly・SameSite=Lax、本番HTTPSではSecureに統一。未使用のブラウザSupabaseクライアントを削除。
- アプリのパスワード再設定はgetUserと署名検証済みgetClaimsで確認し、AMRのrecoveryから15分以内だけ許可。通常ログイン、未来日時、期限切れ、検証失敗では拒否。変更後はglobal signOut。失効処理が失敗した場合に完了と誤表示しない。
- 新規パスワードは12文字以上に加えて単純繰返しと小さな既知弱パスワード集合を拒否。ログイン時は既存パスワードをこの規則で拒否しない。
- アプリの認証申込みはメールを正規化・SHA256化してDBで回数制限。login 10回/5分、signup 5回/時、reset/resend合計3回/15分。DB異常時は許可しない。
- RLSにauth.sessionsの実在・user_id・not_afterを確認する制限を追加。失効済みのJWTでもDBを読めた問題を修正。既存の組織分離・役割制限とANDで適用。権限付き組織/招待関数にも同じ条件を適用。
- CSV確認の全企業テーブルロックを組織単位のadvisory lockに変更し、企業の通常書込みとも整合。待機3秒、成功操作のpreview/confirm各20回/分/利用者。空の選択を明示拒否。確認済み再送は元の結果を返す。
- 架電・活動はダイアログごとのrequest_idで同じ活動＋折返しタスクを一度だけ作成。内容を変えた再送は409。
- 汎用登録（企業、担当者、タスク、商談、業務、ツール、課題、提案）はIdempotency-Keyを保存先UUIDに使用し、競合時は認可済みの同一レコードと送信値を照合。同じ再送は元のレコードを返し、別内容や他組織のUUIDは409。既存レコードを上書きしない。日時・JSONキー順は正規化して比較。
- フォーム保存中の二重実行・閉じ操作を抑止。保存後の一覧更新失敗は「保存失敗」と扱わず、保存済みであることを伝える。通信中断時は入力と再送キーを維持。

## 本番変更が必要な事項（未実施）

1. migration `20261004161946_workflow_improvements.sql` と `20261005011109_session_and_operation_guards.sql` を順に適用し、今回コードを公開する。コードのみ先行すると認証回数制限RPCが存在せずログインできない。
2. Supabase Authの `security_update_password_require_current_password=true`。2026-10-05の読み取りで本番はfalse。ローカルGoTrue v2.197.0ではtrueにすると通常ログインJWTからの直接 `/user` パスワード変更が400 current_password_requiredとなり、実際の復旧リンクは引き続き成功した。
3. SMTPと認証メール送信先・送信制限の運用設定。現在本番はSMTPなし/メール送信2回毎時。実配送成功は未確認。
4. Redirect URLに再設定用クエリを含む `/auth/callback?next=%2Freset-password` を許可する（現在allow-listはクエリなしcallbackのみ）。全ドメインのワイルドカードは不要。
5. 公開後に承認された実テストアカウントで、確認メール・復旧・ログインを確認する。Safari実機も別途確認する。

## 制限と残る確認

- この変更は本番に未反映。本番ログイン不具合が解消したとはまだ報告できない。
- アプリ独自のメール単位回数制限、弱パスワード集合、復旧15分制限は直接Auth APIには適用されない。直接APIにはSupabaseのネイティブ制限が働く。現在パスワード要求設定は必須の別変更。復旧セッションの有効性は直接APIではプロバイダーの規則による。漏洩パスワード照合やCAPTCHAは追加していない。
- CSV制限は成功操作の回数。Postgresトランザクション失敗時のカウンタはロールバックする。全エンドポイントの分散攻撃対策を実装したわけではない。
- サーバーsession確認によりJWTだけで許可する標準構成よりDB読取りが増える。主キー検索、RLS内のselectとSTABLE関数を使用した。実負荷測定は未実施。
- 再送識別は同じダイアログ内の再試行用。別ダイアログを開き直して新しい入力を作ると別操作となる。更新の同時編集競合を解決する機能は追加していない。
- 公開環境の実メール/実アカウント、実機iOS Safariは未検証。スマホ確認はiPhoneサイズのChromiumエミュレーション。
- `database.types.ts` は既存CLI出力に今回の列/RPCを追記したもの。再生成済みとは扱わない。

## 検証成果物

ローカル専用のAuth/PostgREST/Postgres、外部配送しないSMTP sinkで検証。秘密情報を含むfixtureはgit管理外。

- `tests/recovery/hardening.test.ts`、既存unit/API tests: 43件。
- `tests/recovery/database.mjs`: DB/RLS32件。
- `tests/audit/authorization.mjs`: 公開時/修正後の権限境界2件。
- `tests/recovery/authenticated-e2e.mjs`: 実Authでログイン→組織→企業/担当者→架電/折返し→商談→ヒアリング/提案、権限、モバイル、トークン更新。
- `tests/recovery/improvements-e2e.mjs`: CSV、次の企業、ダッシュボード、下書き、閲覧者、モバイル、メール申込みエラー再試行。配送部分はmock。
- `tests/recovery/hardening-e2e.mjs`: 実復旧リンク、通常セッション拒否、ネイティブ現在パスワード要求、Cookie、global logoutと旧JWTのRLS拒否、新パスワード再ログイン、使用済みリンク、回数制限。
- `tests/recovery/retry-e2e.mjs`: DB保存後にHTTP応答だけ切断→入力維持→再送で活動/折返し・担当者が各1件、同時登録1件、変更再送409、日時再送。

過去の `tests/audit/auth-security.mjs` は監査時の挙動を記録するためのスクリプトで、修正後の合否判定には使用しない。今回のhardening E2Eが回帰確認となる。

最終結果（2026-10-05）: lint/typecheck/production build成功。unit/API 43件、DB/RLS・権限34件が全通過。上記4本のブラウザE2Eも全通過。応答切断後の再送・同時登録・直接Auth/RLS拒否を実サービスで確認。既知の秘密値をソースと生成JS計152ファイルで照合し0件。これらはローカル結果であり、本番変更の確認ではない。

ログ: `/workspace/handoff/hardening-{lint,typecheck,build,unit,db-authorization,crm-e2e,improvements-e2e,retry-e2e,auth-e2e}.log`。
画面: `test-results/authenticated-e2e/`、`test-results/improvements/`（git管理外）。

## メール準備状態の追加対応（4c65e49の後続変更）

`AUTH_EMAIL_READY`（サーバー専用環境変数）を追加。**今回の本番は `false`**。未設定・true以外の値も停止扱い。

- ログイン画面に認証メール機能の準備中と、登録・再送・再設定不可／確認済みアカウントのログイン可を常時表示。新規登録ボタンを無効化し、メール申込みフォームは表示しない。
- アプリAPIはsignup/reset-password/resend-confirmationを503 `email_not_ready` で拒否。Auth呼出し・アカウント作成・メール申込みより前に停止する。
- 通常ログイン・ログアウト・CRMは継続。既に発行済みの有効なリンクの検証や、検証済み復旧セッションでのパスワード保存は停止しない（新たなメール配送が不要なため）。
- 将来、SMTPとURL設定・実配送を検証した後に `AUTH_EMAIL_READY=true` を設定して再デプロイすれば再開できる。UIにはサーバーが同じ設定の真偽を渡す。SMTP未設定を自動検出する機能ではない。
- これはLeadStack画面/APIの運用制御であり、Supabaseの直接Auth APIやプロバイダー側signup設定を変更するものではない。メール確認必須の設定を解除しない。
- `.env.example` にfalseを記載。認証メール有効フロー用の既存E2Eは、サーバーの `AUTH_EMAIL_READY=true` とローカルSMTP sinkを前提に実行する。

今回の公開承認対象にはVercel Productionの `AUTH_EMAIL_READY=false` を追加する。本番への実設定は未実施。

追加検証結果: unit/API 47件成功、lint/typecheck/production build成功。`mail-readiness-e2e.mjs` にてfalse時の画面/API拒否と既存ログイン継続、同一ビルドをtrueで再起動した場合の再開を、デスクトップ・iPhoneサイズChromium双方で確認。実メール配送なし。ログは `/workspace/handoff/mail-readiness-{unit,lint,typecheck,build,disabled-e2e,enabled-e2e}.log`。DB変更はなく、追加migrationは不要。
