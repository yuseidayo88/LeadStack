# 回収・検証記録（2026-10-04 UTC）

## 回収

GitHub/保存チェックアウトが空だったため、既存Vercel本番デプロイ `dpl_J1tfkXT92c1USS4GfMg3idRq5xMx` の source tree を正規Vercel REST APIで取得した。環境に既存の認証があり、追加権限なしでHTTP 200。connectorの深さ/文字数省略に依存せず、全82ファイル655,251 bytesを取得し、取得時のSHA-1を全件検証した。原本は `/workspace/handoff/original-source` に保存。manifestはこのディレクトリに同梱。

Supabaseの新プロジェクト `nzptxhoakuzcfmpswovz` に限定し、適用済みmigration履歴をread_onlyクエリで読み、4件のstatementsをSQLファイルとして復元した。元ファイルの改行/区切りの完全一致ではなく、DBに保存された適用内容の回収である。既存migrationの内容変更・本番への再適用はしていない。

旧クラウドプロジェクト/旧DBの調査、削除、移行は行っていない。クラウド作成・課金・公開・GitHub push・アクセス権変更なし。

## 要件との照合

| V1範囲 | 回収済みの実装 | 今回の確認 |
|---|---|---|
| 企業・連絡先 | 一覧/詳細、検索/フィルタ/ソート/列表示/行選択、CRUD | 型/build、DB作成/権限 |
| 手動架電・活動 | Activity UI/API、record_activity RPC | 架電/折返し一括保存・失敗時rollback |
| 折返しタスク | 期間/担当/種別フィルタ、完了/戻す | DB完了操作 |
| 商談 | 一覧・ステージ変更・価格等のフォーム | DB作成/成約変更 |
| 業務ヒアリング | 業務・ツール・課題UI/API | SQL適用、業務情報保存 |
| build/automate/keep | 提案フォーム、テンプレート/推奨API | 3種のDB保存、外部API不要 |
| 複数組織・メンバー | 組織選択、招待、roles、RLS | 越境防止/viewer/管理操作/最終owner保護/再割当 |
| 日本語・デスクトップUI | 既存UIを維持 | ログイン画面を1440px幅で目視確認 |

認証後のCRM画面全体をブラウザで通したE2Eは未実施。Mobbin調査の過去成果物も回収できていない。実装済み欄を全項目のE2E合格と解釈しないこと。

## 修正

- `src/app/api/auth/[action]/route.ts`: メール前後の空白を正規化。パスワードは保持。
- `src/lib/auth-errors.ts`: 未確認メール、429、接続障害/5xx、通常の認証失敗を分ける。上流のメッセージは外に返さない。
- `src/app/login/login-form.tsx`: callbackが返す `error=confirmation` を画面に表示。
- 回収後の検証用テスト、README、`.env.example`、`.gitignore`、manifestを追加。再実装はしていない。

報告されたログイン失敗の根本原因は未特定。新本番に認証済み・ログイン履歴ありユーザーが1件あることのみ集計で確認し、本人のログイン再現やパスワード変更は行っていない。

## 確認結果

- `npm ci --ignore-scripts --no-audit --no-fund --cache /workspace/.cache/npm`: 成功。lockfileは回収時のまま。
- lint / typecheck / production build: 成功（修正後）。
- 追加の認証/API回帰: 12件成功。認証サービス呼び出しはmock。
- 追加のDB検証: 18件成功。PGliteのローカルPostgres、最小authスキーマ代替と回収SQL4件を使用。実Supabase Auth/PostgRESTの完全な代替ではない。
- 実新Supabaseの読み取り: 16 publicテーブルすべてRLS有効。これはポリシーの全動作保証ではない。
- Playwright: ログイン画面、確認失敗案内、疑似503表示と再試行可能化、登録フォーム、保護ページのlogin遷移、未認証API 401、入力不正422、異なるOrigin 403、health 200（databaseVerified=false）、pageerrorなし。
- SMTP/確認メールの実送信、本番アカウントの成功ログイン、認証済みCRMブラウザE2E: 未実施。

## 残る欠損・最小解決

元の単体/DB/HTTP/Playwrightテスト（既報15/37は未回収）、`scripts/local-supabase.mjs`、`scripts/database-types.mjs`、`vitest.integration.config.ts`、`tests/http/api.test.mjs`、元Playwright設定、`supabase/config.toml` 等。前担当の残る成果物からこれらだけ回収するのが最小。回収できなければ、別作業としてローカル環境とテスト群を再整備する必要がある。

認証済みE2Eにはテスト用アカウントと隔離されたテスト環境が必要。実際の失敗原因の絞り込みには、失敗したURL・時刻・画面エラー文またはAPIのstatus/error.codeが必要。パスワードやトークンのチャット共有は不要。

## 実行環境上の制約

初回npmは既定キャッシュ `/home/agent/.npm` が書き込めず失敗したため、許可済みworkspaceキャッシュで成功。Supabase CLIは起動時に `/home/agent/.supabase` 作成を試みread-onlyエラーとなったため反復せず、既存認証の管理APIのread_onlyクエリとローカルPGliteで作業した。sandboxの自動承認拒否ではない。既存ローカルDocker DBは回収/検証に使用していない。
