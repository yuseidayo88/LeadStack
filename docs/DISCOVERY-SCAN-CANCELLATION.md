# 企業検索の取消と再公開条件

2026-10-06。条件検索の停止後もサーバーが候補を保存していた不具合を修正した。本番は従来版への切戻しを維持する。この変更はローカルのみで、push・本番migration・設定変更・再公開・追加実Gビズ呼出しを行わない。

## 操作と実行範囲

県・業種・従業員数・業務キーワードによる既存の条件検索を維持する。会社名は任意。1回の検索の目標は条件一致20社、累計上限は詳細200社・外部10ページ。途中結果は保存し、営業リストへの取込は既存の確認画面を通す。

各HTTP要求は詳細5社・外部検索2回まで。既存の組織別30秒間隔を維持し、正常な時間/件数上限では待機後に自動継続する。5件ごとの待機により、多数の企業を確認する検索には時間がかかる。取消、通信障害、429は自動再開しない。

停止すると独立したkeepalive取消POSTを送信する。画面は「停止を確認中」と表示し、DB受付の確認まで新規開始と再開を禁止する。失敗時は「停止を再確認」を表示する。reload・ページ離脱・条件変更でも同じ取消を行い、別タブでの新規検索は以前の検索を停止する。

## DBによる保存の停止

専用 `/api/organizations/{org}/company-discovery/scan` は `runId` とISO形式の `issuedAt` を必須とする。旧共用APIの `action: scan` は409で拒否する。専用 `/scan/cancel` は同じrunIdを受け取り、終端状態の確認を返す。

新しい `private.discovery_scan_runs` が取消、期限、件数を保持する。外部呼出しの直前に許可を取り、候補保存と取消は同じrun行のロックで直列化する。取消の成功応答後は、そのrunによる新しい候補コミットを拒否する。取消がロックを取る前に完了した保存は残る。実行中の外部要求が返っても、取消後の遅延結果は保存しない。

停止通知そのものが届かない場合でも、サーバー開始+25秒、要求発行+25秒、カーソル期限の最短で失効する。詳細5件・検索2回の上限もDBで確認する。クライアント時計が大きくずれていると要求を安全側に拒否する。開始前取消、同じrunの再送、古い開始の遅延到着、別のrunによる置換を処理し、停止済み検索を自動で復活させない。

応答EOF前に終了RPCを最大3秒待つ。処理を応答後に切り離して継続する仕組みは追加しない。関数が即座に終了して後処理が走らなくてもDB期限が残る。各組織64runまで、保持10分後に次の開始/取消時に整理する。定期処理はない。

## 本番適用に必要な具体的変更

1. リポジトリ `vercel.json` の `functions["src/app/api/organizations/*/company-discovery/scan/route.ts"].supportsCancellation = true`。検索専用Node.js関数だけに切断時の終了を有効化する。取消受付・取込・補完APIは対象外。
2. `supabase/migrations/20261006061219_durable_discovery_scan_cancellation.sql` の追加適用。privateテーブル1個と限定RPCを追加する。既存CRM/候補テーブルの削除・列変更・データ移行はない。

authenticatedに新しいRPC実行権限を付与するが、privateテーブルの直接アクセスは拒否する。各RPC内で有効セッション、組織所属、owner/admin/sales、実行者を検証する。認証方式や既存ロールの昇格はない。既存候補の手動編集は楽観ロックで保持する。

Vercelの外部project設定、環境変数、新サービス、課金プラン、秘密値の読出し・移送は不要。追加のDB行・RPCは既存サービスの利用量に含まれる。利用量が完全に不変とは保証しない。これらの本番適用は親が内容を確認した後に判断する。

## 隔離検証

- 単体/API: `npm test`。
- DB: `npm run test:discovery:scan:database`、既存 `node --test tests/recovery/discovery-database.mjs`。
- 実Postgres競合: `npm run test:discovery:scan:concurrency`。専用ローカルcontainer `leadstack-e2e-db` 内に使い捨てDBを作成する。
- ブラウザー停止: `npm run test:discovery:stop`。`discovery-stop-proxy.mjs` がlocalhost:3012から3011へ中継し、ブラウザー切断後もscan上流を読み続ける。明示取消とDB上限による停止を検証する。
- 既存の合成検索: `npm run test:discovery:scan`。20一致・70社の重複なし再開・200上限を小チャンク反復で検証する。
- `npm run lint`、`npm run typecheck`、`npm run build`、既存の取込・架電フローのブラウザー回帰。

専用fixture以外へテストを向けない。外部取得は明示オプトインの合成Gビズpreloadに限定し、実Gビズ・公開サイトへ接続しない。切戻し前の本番試験で増えた84候補は削除しない。再公開時には別途、少量の実データで取消ACK直後・5秒後・30秒後に件数、ID、updated_atが不変なことを確認する。

既知の軽微な制限: ブラウザーの「タブを複製」がsessionStorageのタブIDも複製した場合、元タブの検索を停止することがある。通常の独立した別タブを開くだけでは取消しない。

## 検証記録（2026-10-06）

- 単体/API665件、DB78件（新規26・既存検索18・CRM/RLS34）、実Postgres競合7件が合格。lint/typecheck/buildも合格。
- 切断を上流へ伝えないプロキシで18動作確認が合格。停止ACK後の約5秒・32秒でも候補ID・法人番号・updated_atが一致した。
- 1詳細9秒の追加試験では3件目を全体期限で中断し、25,104msで応答終了。先行2候補のみ保存され、EOF後の書込みなし。
- 既存の合成条件検索6グループが合格。20一致、70社の重複なし再開、40要求で200社の上限、実30秒の待機、署名・閲覧権限を確認。
- 営業対象検索の既存10グループが合格。人数・不明値・複合条件・文字エスケープ、プリセット・県保持・条件保存、別タブ、プルダウン・モバイル表示、出典・長い事業内容、RLSを確認。
- 既存取込・架電の9グループが合格。候補から取込、架電活動保存、重複防止、既存CRM番号の維持、手動編集、出典保持、閲覧者権限、候補削除時のCRM保持を確認。

ログは `/workspace/handoff/conditional-release/cancellation-*.log`。停止の証跡は `test-results/discovery-stop/evidence.json`、`discovery-stop-focused/evidence.json`、`discovery-stop-deadline/evidence.json`。いずれもローカル合成データであり、本番ランタイム設定や実Gビズ停止の確認に代わるものではない。

公式仕様: [Vercelの取消](https://vercel.com/docs/functions/functions-api-reference#cancel-requests)、[functions設定](https://vercel.com/docs/project-configuration/vercel-json#functions)。
