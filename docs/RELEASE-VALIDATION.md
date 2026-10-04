# 公開前の追加検証（2026-10-04 UTC）

この記録は初回回収時の `RECOVERY.md` にある「認証後のブラウザE2E未実施」を更新します。元のテストは未回収のままで、ここで使用したテストは回収後の追加です。

## 隔離環境

既存のローカル/クラウドDBは使用せず、`leadstack-e2e-*` という別名の一時コンテナでPostgreSQL 17.11、Supabase Auth、PostgRESTを起動しました。回収したmigration SQL4件を適用し、owner/別組織ユーザー/viewerの3件をローカルだけに作成。本番のユーザー・CRMデータ・SQL・Auth設定は変更していません。

アプリは同じソースを別ディレクトリでproduction buildし、localhost:3001で実行しました。ローカルAPIは127.0.0.1:55321に限定。別ディレクトリのテスト用環境変数・fixtureのパスワード・トークンはGitに含めていません。

## 認証付きブラウザE2E（成功）

`tests/recovery/authenticated-e2e.mjs` はPlaywright Chromiumで以下を実行します。API応答はmockせず、実際のローカルAuth/PostgRESTとPostgresを使用しています。

1. ログイン → 初回組織作成 → 企業・連絡先を画面から作成 → API読取で保存確認。
2. 架電結果/活動メモと折返しタスクを同時保存 → タスク画面から完了 → 保存確認。
3. 商談作成 → ステージを成約へ変更 → 保存確認。
4. 業務・利用ツール・課題のヒアリング記録を画面から保存。
5. build / automate / keep の提案を画面から保存。automateはトリガーと処理ステップも保存。
6. ownerがアプリAPIでviewerを招待し、viewerが受諾。viewer画面に架電操作がなく、書込みAPIは403。
7. 別ユーザーが別組織を作成し、最初の組織の企業APIへのアクセスが403。
8. iPhone 13相当の画面サイズ/UA/タッチ設定で、保存Cookieからのセッション復元・再読込・戻る操作。
9. 保存セッションのexpires_atを過去にした上で、実Authへのrefresh token交換、Cookie更新、認証画面維持。
10. ログアウト後は保護ページからログインへ戻る。誤ったパスワードは401と日本語案内、送信ボタンが再利用可能。正しい再ログインではnextの企業詳細へ戻る。

デスクトップのpageerrorは0件。スクリーンショットでもデスクトップ提案画面とモバイル企業詳細を確認しています。

## その他の確認

- lint / typecheck / production build: 成功。
- 追加認証/API回帰12件: 成功。
- 追加PGlite DB検証18件: 成功。
- ログイン画面の限定ブラウザ確認: 成功。
- agent-browserで隔離環境のログイン表示と入力欄・ボタンを確認。

## 実行

隔離したローカルAuth/PostgREST環境に、`{owner,other,viewer}` をキーとし各 `{email,password,id}` を持つJSON fixtureを用意します。初期状態では各ユーザーは組織に所属しないこと。fixturesとAPI設定を本番に向けないでください。

```sh
E2E_BASE_URL=http://localhost:3001 \
E2E_USERS_FILE=/path/to/private/local-users.json \
node tests/recovery/authenticated-e2e.mjs
```

このテストはlocalhost/127.0.0.1以外を拒否しますが、アプリ側も必ず隔離したローカルDBに接続させてください。テストはデータを作成するため、再実行にはテスト専用DB/ユーザーを初期状態へ戻します。今回の環境構築用スクリプトと資格情報は `/workspace/handoff/e2e-private` に分離しています。

## 未確認・残る制約

- iOS実機Safari / WebKitは未確認。WebKitを取得したが、GTK4等のOSライブラリ不足で実行できなかった。ChromiumのiPhone相当エミュレーションを実Safari成功とは扱わない。
- ユーザー本人の本番ログイン失敗は再現しておらず、根本原因の確定はできていない。
- 実SMTPのメール到達・本番ユーザーのログイン・本番CRM書込みは行っていない。
- 元の単体/37DBテスト、元HTTP/Playwrightテスト、補助スクリプト、Supabaseローカル設定は未回収。
- ローカルE2Eは主要な正常系と指定の権限境界を確認したもので、全画面・全入力条件の網羅ではない。

公開承認は、回収したソースのGitHub保存と既存Vercel本番反映について受領済みです。公開後のcommit/deployment IDと実URLの確認結果は別の公開結果報告に記録します。
