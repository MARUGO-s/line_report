import {
  EDGE_FUNCTION_HELP_CODES,
  extractStaticApiPaths,
  helpCodesForAuxiliaryCode,
  helpCodesForApiPath,
  helpCodesForSharedModule,
  PUBLIC_CODE_HELP_CODES,
} from "../supabase/functions/_shared/line_report_help_coverage.ts"
import { LINE_REPORT_HELP_SECTIONS } from "../supabase/functions/_shared/line_report_help_manual.ts"

const root = new URL("../", import.meta.url)
const helpCodes = new Set(LINE_REPORT_HELP_SECTIONS.map((section) => section.code))
const errors: string[] = []

function relative(url: URL): string {
  return decodeURIComponent(url.pathname.slice(root.pathname.length))
}

async function exists(url: URL): Promise<boolean> {
  try {
    await Deno.stat(url)
    return true
  } catch {
    return false
  }
}

function checkCodes(label: string, codes: string[]): void {
  if (!codes.length) errors.push(`${label}: help code is empty`)
  for (const code of codes) {
    if (!helpCodes.has(code)) errors.push(`${label}: unknown help code ${code}`)
  }
}

// publicの利用者向けコードを全件監査。vendorは外部固定ライブラリなので対象外。
const actualPublicFiles: string[] = []
for await (const entry of Deno.readDir(new URL("../public/", import.meta.url))) {
  if (entry.isFile && /\.(html|js|webmanifest)$/.test(entry.name)) {
    actualPublicFiles.push(`public/${entry.name}`)
  }
  if (entry.isDirectory && (entry.name === "jnm" || entry.name === "system-map")) {
    for await (const child of Deno.readDir(new URL(`../public/${entry.name}/`, import.meta.url))) {
      if (child.isFile && /\.(html|js|webmanifest)$/.test(child.name)) {
        actualPublicFiles.push(`public/${entry.name}/${child.name}`)
      }
    }
  }
}
actualPublicFiles.sort()
for (const file of actualPublicFiles) {
  const codes = PUBLIC_CODE_HELP_CODES[file] ?? []
  checkCodes(`public ${file}`, codes)
}
for (const [file, codes] of Object.entries(PUBLIC_CODE_HELP_CODES)) {
  checkCodes(`public map ${file}`, codes)
  if (!(await exists(new URL(`../${file}`, import.meta.url)))) errors.push(`public map missing file: ${file}`)
}

// 全Edge Functionディレクトリを監査。
const actualFunctions: string[] = []
for await (const entry of Deno.readDir(new URL("../supabase/functions/", import.meta.url))) {
  if (entry.isDirectory && entry.name !== "_shared") actualFunctions.push(entry.name)
}
actualFunctions.sort()
for (const name of actualFunctions) {
  checkCodes(`edge ${name}`, EDGE_FUNCTION_HELP_CODES[name] ?? [])
}
for (const [name, codes] of Object.entries(EDGE_FUNCTION_HELP_CODES)) {
  checkCodes(`edge map ${name}`, codes)
  if (!(await exists(new URL(`../supabase/functions/${name}/`, import.meta.url)))) {
    errors.push(`edge map missing directory: ${name}`)
  }
}

// _sharedの全TypeScriptモジュールを、ファイル名規則で利用者向け区分へ結び付ける。
const sharedFiles: string[] = []
for await (const entry of Deno.readDir(new URL("../supabase/functions/_shared/", import.meta.url))) {
  if (entry.isFile && entry.name.endsWith(".ts")) sharedFiles.push(entry.name)
}
sharedFiles.sort()
for (const file of sharedFiles) {
  checkCodes(`shared ${file}`, helpCodesForSharedModule(file))
}

// GAS・OCR・旧Worker/Express・運用スクリプトも、本番経路との区別を含めて監査する。
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
if (await exists(new URL("../schema.sql", import.meta.url))) auxiliaryFiles.push("schema.sql")
auxiliaryFiles.sort()
for (const file of auxiliaryFiles) {
  checkCodes(`auxiliary ${file}`, helpCodesForAuxiliaryCode(file))
}

// admin-api内の静的パス文字列を抽出し、区分不能なAPI入口を検出する。
const adminApiSource = await Deno.readTextFile(new URL("../supabase/functions/admin-api/index.ts", import.meta.url))
const apiPaths = extractStaticApiPaths(adminApiSource)
for (const path of apiPaths) {
  checkCodes(`api ${path}`, helpCodesForApiPath(path))
}

if (errors.length) {
  console.error("[help-coverage] FAILED")
  for (const error of errors) console.error(`- ${error}`)
  Deno.exit(1)
}

console.log("[help-coverage] OK")
console.log(`- public code: ${actualPublicFiles.length}`)
console.log(`- edge functions: ${actualFunctions.length}`)
console.log(`- shared modules: ${sharedFiles.length}`)
console.log(`- auxiliary code: ${auxiliaryFiles.length}`)
console.log(`- static admin-api paths: ${apiPaths.length}`)
console.log(`- help sections: ${helpCodes.size}`)
