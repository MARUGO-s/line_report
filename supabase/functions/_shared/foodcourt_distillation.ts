type UnknownRow = Record<string, unknown>

export type FoodCourtDistillationRecord = {
  dataset_version: 'foodcourt-distillation-v1'
  run_id: string
  store_key: string
  surface: string
  accepted_by: string
  input: {
    task: string
    source_ref: unknown
  }
  initial_response: string | null
  initial_evaluation: unknown
  preferred_response: string
  preferred_loop_index: number | null
  final_score: number | null
  returned_reason: string
  trajectory: Array<{
    loop_index: number
    response: string
    score: number | null
    passed: boolean
    evaluator_feedback: unknown
    revision_instruction: unknown
  }>
  human_feedback: {
    rating: string
    note: unknown
    updated_at: unknown
  } | null
  model_version: string
  created_at: unknown
}

export function buildFoodCourtDistillationRecords(
  acceptedRows: UnknownRow[],
  runs: UnknownRow[],
  iterations: UnknownRow[],
  feedbackRows: UnknownRow[],
): FoodCourtDistillationRecord[] {
  const runsById = new Map(runs.map((row) => [String(row.id ?? ''), row]))
  const iterationsByRun = new Map<string, UnknownRow[]>()
  for (const iteration of iterations) {
    const runId = String(iteration.run_id ?? '')
    if (!iterationsByRun.has(runId)) iterationsByRun.set(runId, [])
    iterationsByRun.get(runId)!.push(iteration)
  }
  const feedbackByRun = new Map(feedbackRows.map((row) => [String(row.run_id ?? ''), row]))

  return acceptedRows.flatMap((accepted): FoodCourtDistillationRecord[] => {
    const runId = String(accepted.source_run_id ?? '')
    const run = runsById.get(runId)
    if (!run) return []
    const humanFeedback = feedbackByRun.get(runId) ?? null
    if (String(humanFeedback?.rating ?? '') === 'not_helpful') return []
    const trajectory = (iterationsByRun.get(runId) ?? [])
      .sort((a, b) => Number(a.loop_index ?? 0) - Number(b.loop_index ?? 0))
      .map((iteration) => ({
        loop_index: Number(iteration.loop_index ?? 0),
        response: String(iteration.integrated_answer ?? ''),
        score: iteration.total_score == null ? null : Number(iteration.total_score),
        passed: iteration.passed === true,
        evaluator_feedback: iteration.evaluation ?? null,
        revision_instruction: iteration.feedback_from_previous ?? null,
      }))
    const firstIteration = trajectory[0] ?? null
    return [{
      dataset_version: 'foodcourt-distillation-v1',
      run_id: runId,
      store_key: String(run.store_partition_key ?? ''),
      surface: String(run.surface ?? accepted.surface ?? ''),
      accepted_by: String(accepted.source_type ?? ''),
      input: {
        task: String(run.user_input ?? '') || '定型分析',
        source_ref: run.source_ref ?? {},
      },
      initial_response: firstIteration?.response ?? null,
      initial_evaluation: firstIteration?.evaluator_feedback ?? null,
      preferred_response: String(run.final_answer ?? ''),
      preferred_loop_index: run.best_loop_index == null ? null : Number(run.best_loop_index),
      final_score: run.final_score == null ? null : Number(run.final_score),
      returned_reason: String(run.returned_reason ?? ''),
      trajectory,
      human_feedback: humanFeedback ? {
        rating: String(humanFeedback.rating ?? ''),
        note: humanFeedback.note ?? null,
        updated_at: humanFeedback.updated_at ?? null,
      } : null,
      model_version: String(run.model_version ?? ''),
      created_at: run.created_at ?? null,
    }]
  })
}
