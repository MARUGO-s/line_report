import { renderLineReportHelpManualMarkdown } from "../supabase/functions/_shared/line_report_help_manual.ts"

const outputUrl = new URL("../docs/LINE-REPORT-JOURNAL-AI-MANUAL.md", import.meta.url)
await Deno.writeTextFile(outputUrl, renderLineReportHelpManualMarkdown())
console.log(`[help] generated ${outputUrl.pathname}`)
