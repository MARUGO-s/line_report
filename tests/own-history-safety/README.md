# 本人履歴・送信継続の portable SAFE 回帰

```sh
npm ci                    # 通常の clean CI dependency provisioning
npm run test:chat-security # 外部 API・資格情報・レビュー証拠ファイルは不要
npm run test:ci            # 上の suite を一回だけ含む
```

この suite は製品 `public/chat.html` の **12 classic scripts を同一 persistent VM** で実行する。コピーした製品アルゴリズムではなく、実際の row callback / sender / callee と記録した I/O を検証する。JSDOM と synthetic Supabase 境界であり、本番 RLS・PostgREST デプロイ・実認証の検証ではない。

通常の root は `import.meta.url` 相対。任意の readonly 比較対象を使う場合だけ `CHAT_SAFETY_CANDIDATE_ROOT=/path/to/baseline npm run test:chat-security` を明示する。主 fixture は `fixture({candidateRoot})` でも注入可能。依存解決を別 worktree に向ける `createRequire` は使わない。

## 所見 → 実行される安全契約

- **WEB-S05**: `forward-continuation` / `forward-stages` は実 openForward→forwardToUser→loadGroups→insertForwardedMessage の sign / fetch / blob / upload / INSERT を hold。source clear・会員削除・owner/token/選択 ABA・exact source 交換後に次段の I/O を開始しない。dispatch 済み upload/INSERT の結果を勝手に取り消さない。`forward-positive-control` は通常画像転送と clear 後の fresh retained-album 明示転送を各 1 upload / 1 INSERT として保全。
- **WEB-L03**: `private-branch` / `private-editor` は実 sendMessage の private/edit 分岐を通し、新 draft・input/options/room ABA・session・selection・pending identity を旧成功が消さないことと、正当な同一 editor の成功を検証。
- **WEB-L04**: `private-note-display` は実 savePrivateNote の commit 成功を保ったまま、別 room/owner/session/選択の配列・実 DOM に本文を混入させず、新 modal draft を閉じないことを検証。個人メモの新機能ではない。
- **UI-R1**: `ui-semantic` の ADAPTED-SAFE08/11 / RACE と `initial-proof` は初回拒否の journal/body/owner lifetime を検証。通常 refresh と owner/logout-login ABA を区別し、actual poll 後でも正しい request の拒否 archive を保存、本人明示 ack と fresh state の後だけ別 UUID の新操作へ進む。not_found・通信断・malformed・loaded/resend は解除証拠にしない。archive/ack/delete の storage failure は fail-closed。
- `independent-*` / `extended-regressions` / `access-*` / `worker-cache` は旧 S01–S04/L01/L02/R2/R3、全 5 sender の receipt 付き一回 INSERT、正常 5 row actions、unknown scope、Keep/album/個人メモ/draft 保全、古い worker と新 query の整合を保持。

`fixtures/own-history-stale-wire.json` は保存済み実 HTTP raw の 400 / exact code,message,details,hint だけを抽出した secret-free fixture。元 raw SHA と抽出 indices は同ファイルに記録。CI は元 raw/evidence を読まない。

## fixture と集計

fetch/XHR/WS/EventSource/beacon と未許可 RPC/table は拒否する。製品側が例外を catch しても **teardown で失敗**する。private-note の許可は exact owner/room/content と `.insert(...).select(...).single()` の一致だけ。HARNESS self-check は安全条件の件数と区別する。旧 FACT2 は観測であり SAFE pass 数へ算入しない。

旧69のうち同一 SAFE を移植し、CAS/queued drawer/初期 auth の重複はより強い semantic-button / 実12 script のケースへ集約した。ファイル単位の provenance は `coverage-provenance.json`。実行件数は Node runner の summary を正とし、focused / full CI / clean-copy の再実行を合計しない。旧 positional-button の SAFE08/11 raw 失敗は書き換えない。
