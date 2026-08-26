import { renderLineReportHelpManualMarkdown } from "../supabase/functions/_shared/line_report_help_manual.ts"
import {
  EDGE_FUNCTION_HELP_CODES,
  extractStaticApiPaths,
  helpCodesForAuxiliaryCode,
  helpCodesForApiPath,
  helpCodesForSharedModule,
  PUBLIC_CODE_HELP_CODES,
} from "../supabase/functions/_shared/line_report_help_coverage.ts"

const outputUrl = new URL("../docs/LINE-REPORT-JOURNAL-AI-MANUAL.md", import.meta.url)

async function listNames(url: URL, predicate: (name: string, isDirectory: boolean) => boolean): Promise<string[]> {
  const names: string[] = []
  for await (const entry of Deno.readDir(url)) {
    if (predicate(entry.name, entry.isDirectory)) names.push(entry.name)
  }
  return names.sort()
}

export async function buildLineReportHelpDocument(): Promise<string> {
  const publicRows = Object.entries(PUBLIC_CODE_HELP_CODES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, codes]) => `| \`${file}\` | ${codes.join(' / ')} |`)
  const edgeRows = Object.entries(EDGE_FUNCTION_HELP_CODES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, codes]) => `| \`${name}\` | ${codes.join(' / ')} |`)

  const sharedNames = await listNames(
    new URL("../supabase/functions/_shared/", import.meta.url),
    (name, isDirectory) => !isDirectory && name.endsWith(".ts"),
  )
  const sharedRows = sharedNames.map((name) => (
    `| \`supabase/functions/_shared/${name}\` | ${helpCodesForSharedModule(name).join(' / ')} |`
  ))

  const auxiliaryFiles: string[] = []
  for await (const entry of Deno.readDir(new URL("../scripts/", import.meta.url))) {
    if (entry.isFile && /\.(mjs|ts|py|sh)$/.test(entry.name)) {
      auxiliaryFiles.push(`scripts/${entry.name}`)
    }
  }
  for (const [folder, allowed] of [
    ["google-apps-script/receipt-sheets-pilot", /\.(gs|json)$/],
    ["cloudflare-worker", /^(package\.json|wrangler\.toml)$/],
    ["cloudflare-worker/src", /\.js$/],
    ["ocr-bridge", /^(Dockerfile|app\.py|requirements\.txt)$/],
    ["src", /\.js$/],
  ] as const) {
    for await (const entry of Deno.readDir(new URL(`../${folder}/`, import.meta.url))) {
      if (entry.isFile && allowed.test(entry.name)) auxiliaryFiles.push(`${folder}/${entry.name}`)
    }
  }
  auxiliaryFiles.push("schema.sql")
  auxiliaryFiles.sort()
  const auxiliaryRows = auxiliaryFiles.map((file) => (
    `| \`${file}\` | ${helpCodesForAuxiliaryCode(file).join(' / ')} |`
  ))

  const adminApiSource = await Deno.readTextFile(
    new URL("../supabase/functions/admin-api/index.ts", import.meta.url),
  )
  const apiPaths = extractStaticApiPaths(adminApiSource)
  const apiRows = apiPaths.map((path) => `| \`${path}\` | ${helpCodesForApiPath(path).join(' / ')} |`)

  const migrations = await listNames(
    new URL("../supabase/migrations/", import.meta.url),
    (name, isDirectory) => !isDirectory && name.endsWith(".sql"),
  )
  const tests = await listNames(
    new URL("../tests/", import.meta.url),
    (name, isDirectory) => !isDirectory && /\.(ts|mjs)$/.test(name),
  )

  const appendix = [
    '---',
    '',
    '## コード全体精査インベントリ',
    '',
    'この節はリポジトリの実コード入口を区分コードへ対応付けた監査表です。',
    '`npm run help:check` は、新しい入口が未分類のまま追加された場合に失敗します。',
    '',
    `- 公開コード入口: ${publicRows.length}件`,
    `- Edge Functions: ${edgeRows.length}件`,
    `- 共有TypeScriptモジュール: ${sharedRows.length}件`,
    `- 補助・運用・レガシーコード: ${auxiliaryRows.length}件`,
    `- admin-api静的ルート: ${apiRows.length}件`,
    `- SQL migrations: ${migrations.length}件（全件の構文・関係はGraphify/knowledge:checkで監査）`,
    `- テストファイル: ${tests.length}件`,
    '',
    '### 公開画面・ブラウザコード',
    '',
    '| ファイル | 対応する資料区分 |',
    '|---|---|',
    ...publicRows,
    '',
    '### Edge Functions',
    '',
    '| Function | 対応する資料区分 |',
    '|---|---|',
    ...edgeRows,
    '',
    '### 共有TypeScriptモジュール',
    '',
    '| モジュール | 対応する資料区分 |',
    '|---|---|',
    ...sharedRows,
    '',
    '### 補助・運用・レガシーコード',
    '',
    '| ファイル | 対応する資料区分 |',
    '|---|---|',
    ...auxiliaryRows,
    '',
    '### admin-api静的ルート',
    '',
    '| APIパス | 対応する資料区分 |',
    '|---|---|',
    ...apiRows,
    '',
    '動的IDを含む正規表現ルートは、`/chat-admin/` 等の親プレフィックスとEdge Function責務で監査します。',
    'DBの全SQLは `npm run knowledge:update` / `knowledge:check` のSQL coverageで別途全件確認します。',
    '',
  ].join('\n')

  return `${renderLineReportHelpManualMarkdown().trim()}\n\n${appendix}`
}

if (import.meta.main) {
  await Deno.writeTextFile(outputUrl, await buildLineReportHelpDocument())
  console.log(`[help] generated ${outputUrl.pathname}`)
}
