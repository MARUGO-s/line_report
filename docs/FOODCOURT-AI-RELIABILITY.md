# フードコートAIのモデル構成と障害対策

更新日: 2026-09-10。対象は文章分析とテナント表画像抽出。数値予測の5方式・台帳・採用条件、Journal固有のAI設定は変更しない。

## 標準構成

| 役割 | 主モデル | 選定・設定 |
|---|---|---|
| 数値・他店比較① | Groq `openai/gpt-oss-120b` | 既存の高速推論。確定値はコードで計算 |
| イベント・天気② | Gemini `gemini-3.5-flash` | 渡された背景情報の整理。推論量low |
| 運営改善③ | Grok `grok-3-mini` | 従来どおり。X検索は別経路 |
| 反証④ | Gemini `gemini-3.5-flash` | 複数メモの矛盾・根拠不足を検査。推論量low |
| 最終統合⑤ | OpenAI `gpt-5.6-luna` | 従来どおり。推論量low |
| 品質評価⑥ | Groq `openai/gpt-oss-120b` | 統合⑤と別モデルで5軸JSON採点。空・欠損採点は不採用 |
| テナント表抽出 | Gemini `gemini-3.5-flash` | 通常レシート用モデルから分離。推論量low、出力枠8192 |

これはモデルの一般的な優劣ランキングではない。本番で成功しているプロバイダーと、処理の役割・応答期限を合わせた運用上の選定。実運用の品質と失敗率は今後の履歴で検証する。

反証・評価は失敗時にそれぞれGroq・Geminiへ退避。統合はOpenAI→Gemini→Groqを保持。画像はGemini→Azure Foundry（既存の `gpt-5.4-nano` デプロイ）とする。Azureは推論量low、出力枠6000、応答の保存は無効。非常時の安全経路は削除しない。

## 確認した問題

- 本番の9月1日〜10日の履歴で、Claude反証・評価が繰り返し `http_400` となり、Geminiへ切り替わっていた。採点の1件はtimeout。HTTP 400の詳細本文は今回取得できず、課金上限・リクエスト条件などの内訳は未確定。モデルの能力不足と断定しない。
- 主モデルに渡す残り時間から固定で最大20秒を引くため、主モデルが250msしか使えない場合があった。前段の待ち時間により統合・評価が連鎖的にtimeoutした記録もある。
- 旧画像抽出は、非テナント画像への試行・APIエラー・JSON途中切れ・行不足をすべて `invalid_or_insufficient_tenants` と記録していた。9月8日の「全滅」の個別原因は旧記録から復元できない。
- 画像のHTTPヘッダー受信後にタイマーを解除しており、本文の受信・JSON解析は期限の外だった。Azureの2000トークン枠には推論も含まれるため、全行を出し切れないリスクがあった。

## 再発防止

- 反証をGemini、採点をGroqへ変更。新しい役割別設定を使用するため、古い `FOODCOURT_LOOP_EVALUATOR_PROVIDER=claude` が残っていても旧経路へ戻らない。
- 共有締切は延長せず、専門・反証・統合の各段階で後続の時間を確保。フォールバックの予約は残り時間の最大30%で、主モデルを極端に短くしない。
- HTTP 429/500/502/503/504は同じ期限・同じモデル内で最大1回だけ再試行。課金制限・認証・400・推論開始後のtimeoutは再試行しない。1秒を超えるRetry-Afterでは待機再試行しない。
- HTTPの詳細は秘密値や入力を保存せず、`billing_limit` / `auth_error` / `invalid_request` / `model_not_found` / `rate_limited` 等へ分類。
- 画像はMIMEのパラメーターを除去し、PNG/JPEG等のヘッダーからも形式を判定。本文受信まで同じ期限で制御する。
- `is_tenant_table=false` かつ空行で、文字側のテナント表マーカーとも矛盾しない場合のみ「正常な非テナント画像」と扱う。通信失敗や不正JSONはこの扱いにしない。マーカーと矛盾すれば別モデルでも検査する。
- MAX_TOKENS / incomplete は部分的な表を保存せず `output_truncated`。読めない数値を0に置き換えずnullを保持する。既存の基準店・最低行数・日付確認・月次誤登録防止は維持。
- 5軸の欠損・不正JSONを採点成功と扱わない。不正応答でも消費したトークンは使用料履歴へ保存する。合格点・数値監査を緩和しない。
- 過去の切替・全滅記録は削除／自動確認済みにしない。新たな実障害も記録する。

## 設定と運用

新しい任意設定は `FOODCOURT_CRITIC_PROVIDER`（既定gemini）、`FOODCOURT_EVALUATOR_PROVIDER`（既定groq）、`FOODCOURT_TENANT_GEMINI_MODEL`（既定gemini-3.5-flash）。既存 `FOODCOURT_GEMINI_MODEL` は文章分析用。通常レシートの `RECEIPT_GEMINI_MODEL` を流用しない。

Claudeクライアントとモデル設定は復旧・比較用に保持するが標準経路では呼ばない。明示的に戻す際は、新しい役割設定を使い、当該アカウントでの正常応答を確認する。新しい契約・追加クレジット購入は行わない。料金改善は保証せず、トークン実測と請求を確認する。

解析キャッシュは `foodcourt-analysis-ai-v19-reliable-routing`。既存の数値予測台帳と過去の採点履歴は再書換えしない。

## 検証と限界

`tests/foodcourt_ai_reliability.test.ts` は実際の本番関数を実行し、外部HTTP・DBだけを模擬する。正常な主モデル、再試行制限、期限、11行の表、途中切れ、非テナント画像、実障害の記録、欠損採点、費用記録を検証する。実売上や顧客画像をテストに持ち込まない。

通信先の障害・料金制限・認証失効があり得るため、フォールバック0件を保証しない。配置確認と、実データによる長期の失敗率・品質改善の実証は別。新規実行後の `foodcourt_ai_fallback_events`、`foodcourt_ai_loop_runs`、`ai_usage_events` で確認する。

公式仕様: [Gemini 3.5の推論量と温度設定](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5)、[Responsesの出力・推論上限](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)、[ClaudeのHTTPエラー](https://platform.claude.com/docs/en/api/errors)。
