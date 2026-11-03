import {
  EDGE_FUNCTION_HELP_CODES,
  extractStaticApiPaths,
  helpCodesForAuxiliaryCode,
  helpCodesForApiPath,
  helpCodesForSharedModule,
  PUBLIC_CODE_HELP_CODES,
} from "../supabase/functions/_shared/line_report_help_coverage.ts"
import { LINE_REPORT_HELP_SECTIONS } from "../supabase/functions/_shared/line_report_help_manual.ts"

function assertSetEquals(actual: string[], expected: string[], label: string): void {
  const a = [...actual].sort()
  const e = [...expected].sort()
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(`${label}\nactual: ${a.join(", ")}\nexpected: ${e.join(", ")}`)
  }
}

function assertValidCodes(label: string, codes: string[], validCodes: Set<string>): void {
  if (!codes.length) throw new Error(`${label}: 資料区分が未設定です`)
  for (const code of codes) {
    if (!validCodes.has(code)) throw new Error(`${label}: 不明な資料コード ${code}`)
  }
}

Deno.test("公開コード・Edge・共有モジュール・管理APIルートが全て資料区分へ分類される", async () => {
  const validCodes = new Set(LINE_REPORT_HELP_SECTIONS.map((section) => section.code))

  const actualPublic: string[] = []
  for await (const entry of Deno.readDir(new URL("../public/", import.meta.url))) {
    if (entry.isFile && /\.(html|js|webmanifest)$/.test(entry.name)) {
      actualPublic.push(`public/${entry.name}`)
    }
    if (entry.isDirectory && (entry.name === "jnm" || entry.name === "system-map")) {
      for await (const child of Deno.readDir(new URL(`../public/${entry.name}/`, import.meta.url))) {
        if (child.isFile && /\.(html|js|webmanifest)$/.test(child.name)) {
          actualPublic.push(`public/${entry.name}/${child.name}`)
        }
      }
    }
  }
  assertSetEquals(actualPublic, Object.keys(PUBLIC_CODE_HELP_CODES), "公開コードの網羅")
  for (const [file, codes] of Object.entries(PUBLIC_CODE_HELP_CODES)) {
    assertValidCodes(`public ${file}`, codes, validCodes)
  }

  const actualFunctions: string[] = []
  for await (const entry of Deno.readDir(new URL("../supabase/functions/", import.meta.url))) {
    if (entry.isDirectory && entry.name !== "_shared") actualFunctions.push(entry.name)
  }
  assertSetEquals(actualFunctions, Object.keys(EDGE_FUNCTION_HELP_CODES), "Edge Functionsの網羅")
  for (const [name, codes] of Object.entries(EDGE_FUNCTION_HELP_CODES)) {
    assertValidCodes(`edge ${name}`, codes, validCodes)
  }

  for await (const entry of Deno.readDir(new URL("../supabase/functions/_shared/", import.meta.url))) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue
    assertValidCodes(`shared ${entry.name}`, helpCodesForSharedModule(entry.name), validCodes)
  }

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
  for (const file of auxiliaryFiles) {
    assertValidCodes(`auxiliary ${file}`, helpCodesForAuxiliaryCode(file), validCodes)
  }

  const source = await Deno.readTextFile(
    new URL("../supabase/functions/admin-api/index.ts", import.meta.url),
  )
  const paths = extractStaticApiPaths(source)
  if (paths.length < 100) throw new Error(`admin-apiルート抽出が少なすぎます: ${paths.length}`)
  for (const path of paths) {
    assertValidCodes(`api ${path}`, helpCodesForApiPath(path), validCodes)
  }
})
