# LeadStack 認証・権限監査（2026-10-05 UTC）

## 判断

通常ログインと組織分離の基本防御は実装・検証されている。一方、一般ユーザーへのメール配信は未設定で、セッション盗難・失効・頻度制限への追加防御が必要。「ログインできる基本動作は確認済み」だが「本人の本番ログイン成功」「絶対安全」は未確認・保証不可。

対象を区別する：

- 公開版：`2b0706b`。メール＋パスワードのログイン、新規登録、ローカルログアウト。パスワード再設定・確認メール再送UIはない。公開ページの通常GETでも復旧ボタンがないことを確認。
- 未公開改善版：`460cd82`。前記＋reset/resend/update-password、CSV等。監査中は公開も修正適用もしていない。
- 共通の認証クライアント、所属チェック、既存4件のSQL、safeNextは両版で同じ。SQLの追加権限テストは4件適用版と5件適用版をそれぞれ検証。
- 本番Supabase設定は新プロジェクトだけGET。実ユーザー・資格情報・設定を変更せず、実メール送信なし。実Auth操作は隔離したローカルAuth v2.197.0、Postgres、PostgRESTのみ。SMTPは外部へ中継しないローカル受信箱。

## 優先順位付きの不足と最小対策

| 優先度 | 観測した事実 | 影響・最小対策案 | 公開版/未公開版 |
| --- | --- | --- | --- |
| P1 運用開始前 | カスタムSMTPなし、標準メール2通/時、確認必須。再設定用query付きcallback URL未許可 | 一般ユーザーの登録確認/再設定を提供できる状態ではない。既存SMTPの利用可否、送信元を確認し、下記URLを追加。確認を無効にする回避はしない | 配信制約は両版。resetは未公開版だけ |
| P1 認証強化判断 | 普通にログインしたセッションから旧パスワード・復旧リンクなしでupdate-password成功。本番再認証設定もfalse | 他人ID指定ではなく、盗難/放置セッションによる本人アカウントのパスワード変更が問題。通常変更と復旧を分け、旧パスワードまたは再認証を要求し、復旧は検証済みフローとユーザーに結び付ける。Supabase直接APIにも効く設定と整合させる。24時間以内のセッションを許す再認証設定だけでは全ケースを防げない | アプリ変更導線は未公開版。直接Auth APIの設定は両版共通 |
| P2 セッション失効 | logout後はアプリ/profile=401、Auth/user=403、refresh=400。一方、保存したJWTで直接PostgRESTへ自分のprofileを読むと200/1行 | アクセストークンの期限前利用が残る。現在JWT1時間。即時失効が必要ならsession_idの有効性チェックをDB側の共通権限判定/RLSへ追加し、全表/RPCで検証。JWT期限短縮は残存時間の低減であり即時遮断ではない | 両版共通。RLSは所属を調べるがsession有効性を調べない |
| P2 Cookie/XSS防御 | SDK既定cookieはHttpOnly=false、コードにSecure指定なし。ローカルcookieも双方false。公開HTTPSログイン応答はHSTSあり、CSPなし | 直ちにXSS成立を示すものではない。現状ブラウザSupabaseヘルパーは未使用なので、SSR/proxyの両方でHttpOnlyとHTTPS時Secureを明示する案を検証。必要に応じCSP。HttpOnly単独でも同一originのXSS操作すべては防げない | 両版共通。実本番の認証Cookie属性は実ログイン未実施につき未採取 |
| P2 頻度・負荷 | アプリ独自のlogin/signup/reset/CSV頻度制限なし。Auth側の制限はあるがサーバー経由の利用者IP転送なし。CSVは容量/件数制限のみ、確認時に企業表をロック | 本番で大量試行はしていない。信頼できる利用者/IP別制限とアカウント別の制限を既存基盤で設計。CSVは組織/利用者の並行数・頻度・lock timeout制限を追加する候補。APIだけでなく直接RPC経路も考慮 | Authは両版、CSVは未公開版 |
| P2 弱いパスワード | 最低12文字はAuth側でも有効。一方aaaaaaaaaaaaは通る。必須文字種なし、漏洩パスワード検査false、アプリにMFA導線/必須化なし | よくある弱い値の拒否、長いパスフレーズの案内、利用可能な認証強化の検討。漏洩検査/セッション制御にはプラン制約があるため勝手に契約変更しない | 両版共通 |
| P3 重複時UX | 同時3登録の結果201/422/422、DBは1件。既存確認済みアカウントへの再登録は201/confirmationRequired=true | 二重アカウントは防止。競合時の再試行案内を改善可能。200/201だから新アカウント作成済みとは判断しない | 両版共通のsignup処理 |

P1/P2は改修・運用判断の優先度であり、外部攻撃者が無条件にログインできる脆弱性が確認されたという意味ではない。今回、他組織閲覧・他人へのパスワード指定・adminのowner昇格・秘密鍵の露出は確認されていない。

## 確認済み：ID・重複・保存

- ログインIDはメールアドレス。表示名はプロフィールであり一意ではない。内部ユーザーIDはAuthが発行するUUID。アプリのプロフィール編集は表示名/avatarのみで、メールや他人IDを変更するAPIではない。
- アプリはメール前後をtrimし、Supabaseは小文字へ正規化。大小文字・前後空白の登録/ログインを実Authで確認。同時3件の登録でも同一メールのauth.usersは1件。
- メール別名（+付き、メールプロバイダ独自のドット無視など）まで同一人物と判定する機能ではない。CRMの連絡先メールや表示名の重複とAuthのアカウント重複は別。
- 不存在メールと既存メールの誤パスワードはともに401/login_failed。未確認メールは正しいパスワードの場合だけemail_not_confirmedを確認した。確認済みアカウント再登録でも通常応答は201/confirmationRequired=true。
- resetの存在しないメールも200/ok。存在情報を通常の文面で返していない。ただし時間差・バックエンド障害・送信制限を含む完全なユーザー列挙耐性/一定時間応答は保証していない。網羅的な列挙試験は実施していない。
- パスワードはアプリDBに平文保存しない。ローカルauth.usersのencrypted_passwordはbcrypt形式、実ログインで照合成功。クラウド保存実装はSupabaseの責任範囲であり、本番のパスワード列を読んだわけではない。[公式保存方式](https://supabase.com/docs/guides/auth/password-security)
- 本番minimum=12をGETで確認。直接Auth APIへの6文字登録は422。アプリ経由だけの見せかけの制限ではない。ログイン自体は既存パスワードを変更しないため入力最低1文字。

## 確認済み：復旧・セッション

- reset→ローカルメール受信→PKCE callback→再設定ページの実フローが成功。
- 使用済みリンクはエラー。申込みブラウザ以外で開くとPKCE交換に失敗し、profile=401。コードがない/不正の場合も失敗案内。
- ローカルAuthのOTP有効期間だけを1秒に短縮し3秒待って、新しい復旧リンクが303/otp_expiredになることを確認。本番期限は3600秒の設定を読取り確認しただけで、1時間待つ本番試験はしていない。内部テーブルの時刻だけを書き換える方法は期限切れの正確な再現にならなかったため、最終評価には使用していない。
- 再送した確認メールでローカルpendingユーザーの確認が成功。実配信の受信箱・迷惑メール判定は未確認。
- アプリupdate-passwordはuser_idを受け取らず、getUserで検証した現在ユーザーだけを更新する。未認証・不一致・12文字未満を拒否する単体/APIテストあり。ただし通常セッションと復旧セッションを区別していないことは上記の改善点。
- refresh tokenはローテーションし、10秒の猶予を超えた古い祖先トークンの再利用が400、最新の同じファミリーも400になることを実Authで確認。
- signOutはscope=local。他端末をまとめてログアウトするUIではない。本番sessions_timebox=0、inactivity_timeout=0、single_per_user=false。refreshが続くセッションを1時間で終了する設定ではない。
- 保護ページはproxyのgetUser、APIはrequireUser/requireOrganizationで検証し、getSessionだけの信用はしない。未認証/profile=401、保護ページはログインへ。既存E2Eで戻る・reload・期限切れrefresh・logout・再ログイン確認済み。
- モバイル実績はiPhoneサイズChromium。実機iOS Safariではない。

## 確認済み：組織/RLS・入力・秘密

- 両版SQLで他組織のmembership/会社閲覧拒否、他組織への招待作成拒否。既存33件/28件回帰にviewerのAPI・DB書込み拒否、複合FK、全public表RLS、invoker view、CSV組織境界が含まれる。
- adminがuser_metadata.role=ownerを入れても昇格不能。直接membershipを書き換える権限もない。認可は編集可能なmetadataでなくDBのorganization_membersを見る。
- 招待は一致する確認済みメールが必要。別ユーザー・未確認ユーザー・同じ招待の再利用を拒否。退会後は有効なUIDでも会社の読取り0行/書込み拒否。
- 他人のprofile更新は0行、profile.emailの直接更新は権限拒否。活動のuser_idを他人にする挿入も拒否。公開schemaのsecurity definer関数にanon実行権限が残っていないことをSQLで確認。
- 組織内データは営業チーム共有。salesが自分担当以外の同じ組織の企業を扱えることは現仕様であり、個人別の非公開領域ではない。
- JSON APIはOrigin/Fetch-Site、Content-Type、Zod strict schema、サイズ上限で防御。CSRF nonce自体はなく、同一origin検証＋ブラウザのJSON preflight＋SameSite=Laxに依存。Originがない非ブラウザ要求も認証とRLSは必要。異なるOriginは単体テスト403。CSRFを絶対防げるという主張はしない。
- safeNextは外部origin、//、バックスラッシュを拒否。callbackの行先は設定済みSite URLから作る。外部redirectと期限切れ/不正callbackの単体テストあり。
- アプリにservice_role/secret key使用なし。tracked sourceと.next/staticの合計139ファイルを既知の管理トークン・ローカルservice key等の実値で照合し一致0。未知の秘密まで包括的に検出する保証ではない。公開publishable key自体は秘密ではなくRLSが防御境界。
- 公開/loginの通常GET：200、HSTS、X-Frame-Options=DENY、nosniff、Referrer-Policy、Permissions-Policyあり。CSPはなし。公開/loginはpublic cache可能だが認証APIはprivate/no-store、保護proxyもprivate/no-store。

## 本番設定と承認が必要な範囲

監査の読取り結果：`/workspace/handoff/security-auth-config.json`（秘密値なし）。

- `password_min_length=12`, `password_hibp_enabled=false`, `security_update_password_require_reauthentication=false`, `security_captcha_enabled=false`。
- `jwt_exp=3600`, `refresh_token_rotation_enabled=true`, reuse interval=10、セッション上限/無操作期限なし。
- secure email change=true。アプリはメール変更UIを提供しない。manual identity linking=false。
- `rate_limit_token_refresh=150`, `rate_limit_verify=30`, `rate_limit_otp=30`, email=2。AuthはIPベースtoken bucket。アプリ経由ではサーバーIPの集約の影響があり得る。大量要求で閾値まで叩く試験はしない。[公式頻度制限とIP転送](https://supabase.com/docs/guides/auth/rate-limits)

未承認の変更は行っていない。必要な承認は、(1)監査で見つかった認証強化をどこまで実装するか、(2)レビュー済みcommitのpush/deploy、(3)非破壊DB migration、(4)Authの再認証/期限/送信設定変更、(5)次のRedirect URL追加。秘密情報はチャットやGitへ書かない。

`https://leadstack-amber.vercel.app/auth/callback?next=%2Freset-password`

設定箇所：新SupabaseのAuthentication → URL Configuration → Redirect URLs。既存callbackは残す。SMTPは現在未設定で標準送信先がSupabase組織メンバーに限られる。一般利用には既存SMTPの利用可否確認が必要。契約追加・課金・確認無効化は実施しない。[公式SMTP制限](https://supabase.com/docs/guides/auth/auth-smtp)

## 証拠・再実行

- `tests/audit/auth-security.mjs`：隔離環境の通常登録、同時登録、実Auth/PKCE/再送/セッション挙動。`PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright node tests/audit/auth-security.mjs`。ローカルfixture/API3004/Auth55321/SMTP sink必須。外部接続先を渡す仕組みはない。
- `tests/audit/authorization.mjs`：`node --test tests/audit/authorization.mjs`。公開/未公開版それぞれのSQLで権限境界を確認。2ケース成功。
- `tests/audit/expiry.py`：隔離AuthコンテナだけOTP TTLを短縮して検証。上の認証試験後に実行。実SMTP送信なし。
- `/workspace/handoff/security-auth.log`, `security-auth-results.json`, `security-expiry.json`, `security-authorization.log`, `security-public-headers.json`。
- `npm run test:recovery`：33＋28件成功、`npm run lint`成功。アプリ/src・SQL・依存関係に監査による差分なし。
- 以前の本番本人ログイン失敗の原因は未確定。本人が試した時刻・画面文面・API status/error.codeを秘密を含めず取得すれば、今回の設定問題との関連を切り分けられる。
