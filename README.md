# LeadStack V1（既存デプロイから回収）

Next.js / TypeScript / Supabase Auth・RLS の日本語CRMです。新規実装ではなく、既存V1を回収して引き継いでいます。Zoom Phone・OpenAI・n8nのAPI設定は基本操作に不要です。

## 回収元と完全性

- ソース・lockfile: Vercel `dpl_J1tfkXT92c1USS4GfMg3idRq5xMx` の source tree、82ファイル。取得時に全ファイルのSHA-1をVercelのUIDと照合。
- SQL: 新Supabase `nzptxhoakuzcfmpswovz` の適用済みmigration履歴から4件のstatementsを読み取り回収。元ファイルそのものではなく、適用されたSQLです。本番への再適用は不要です。
- 元の単体・DB・HTTP・ブラウザテスト、補助スクリプト、Supabaseローカル設定は未回収です。
- `tests/recovery/` と `vitest.config.ts` は回収後に新しく追加した検証です。前担当の「15単体/37DBテスト」を復元したものではありません。

## 起動

Node.js 22以上。`npm ci` を実行し、`.env.example` を `.env.local` にコピーして、新環境のURL・publishable keyを設定します。サービスロールキーをフロントエンドに設定しないでください。

```sh
npm ci
npm run dev
```

本番ビルドのローカル実行は `npm run build` → `npm start`。`NEXT_PUBLIC_SITE_URL` はローカルの場合 `http://localhost:3000`。ローカルURLで実際のメール確認を試す場合はSupabase側の許可URL設定が別途必要です。

## 今回実行できる検証

```sh
npm run lint
npm run typecheck
npm run build
npm run test:recovery
# npm start を別ターミナルで起動し、Playwright Chromiumを利用可能にして実行
npm run test:recovery:browser
```

`npm test` は新しく追加した認証/API回帰テスト12件。`test:recovery` はそれにPGliteによる回収SQLの検証18件を加えます。DB検証ではauthスキーマの最小限の代替をローカルに作り、4件のSQLは変更せず適用します。実Supabase Auth・PostgREST・本番全体のE2Eを代替するものではありません。

ブラウザ検証はログイン表示、確認リンク失敗の案内、疑似503の表示、未ログインの保護を確認します。メール送信・本番データ作成・実ユーザーの成功ログインは行いません。

## 未回収のため使えない元のコマンド

- `db:start` / `db:stop`: `scripts/local-supabase.mjs` 不足
- `db:types`: `scripts/database-types.mjs` 不足
- `db:reset`: `supabase/config.toml` など元のローカル設定不足。接続先を確認せず実行しないこと
- `test:integration`: `vitest.integration.config.ts` および元テスト不足
- `test:http`: `tests/http/api.test.mjs` 不足
- `test:browser`: 元のPlaywright設定とテスト不足

元のコマンドは回収package.jsonの履歴を保つため残しています。欠損のテストを成功扱いにはしていません。

## 認証後の追加E2E

隔離したローカルの実Auth/PostgRESTで、主要業務フロー・viewer/別組織境界・iPhone相当のセッション維持と再ログインを確認しました。詳しくは [公開前検証記録](docs/RELEASE-VALIDATION.md) を参照してください。実機Safariと本人の本番ログインは未確認です。

## 今回の修正

- メールアドレス前後の空白を除去（パスワードはそのまま保持）。
- ログイン時の未確認メール、429制限、接続障害を区別した日本語エラー。
- `/login?error=confirmation` の失敗案内を表示。

報告されているユーザー本人のログイン失敗原因は未特定です。次は、秘密情報を含めず、失敗時のURL、時刻、画面のエラー文/APIのstatus・error.codeを確認する必要があります。


## 未公開：5項目の業務改善

`feature/workflow-improvements` に架電の次行動、日次画面、CSV確認取込、ヒアリングからの提案下書き、認証復旧を追加。上記12/18件は回収時点の記録です。現在の `test:recovery` は単体/API等33件＋DB28件です。追加SQL1件が必要で、本番適用・push・公開は未実施です。

[変更仕様・検証・マイグレーションとメール設定](docs/WORKFLOW-IMPROVEMENTS.md) を参照してください。一般ユーザー向けのメール配信には既存SMTPの利用可否確認と再設定callback URLの許可が必要です。

## 最新の未公開開発状況（2026-10-05）

ブランチ `fix/auth-and-crm-quality` に企業/担当者の電話検索、法人番号/メール検索、同名候補のページ送りと補足表示、企業一覧からの架電記録を追加しました。最新の検証は単体/API51件・DB/RLS34件と実ローカルAPI/ブラウザ、lint/typecheck/buildが成功。未公開SQLは計4本です。

[検索・架電の変更と検証](docs/SEARCH-CALL-WORKFLOW.md) を参照してください。上記の旧件数・旧ブランチ名は各回収/検証時点の記録です。
