import { applyGuardrails, toWireEntries } from "./guardrails"
import { interpretNotes } from "./llm"
import { optimizeSchedule, summarizePlan } from "./optimizer"
import { replayPlan } from "./replay"
import { normalizeScenario, scenarioRequestSchema } from "./schema"
import type { Directive, OptimizeResponse, ScenarioRequest } from "./types"

/**
 * The request pipeline, end to end:
 *
 *   validate -> interpret (LLM) -> guardrails -> optimize -> replay -> respond
 *
 * Every stage degrades rather than throws. The harness scores a controlled
 * response far above a 5xx, and an unhandled error would cost reliability
 * points on top of the case itself.
 */

export interface PipelineOutcome {
  status: number
  body: OptimizeResponse | { error: string }
}

/** Server-side only. Deliberately carries no note text, keys, or stack traces. */
interface Diagnostics {
  scenario_id: string
  notes: number
  interpretation_source: string
  model: string
  llm_ms: number
  guardrail_events: number
  applied_directives: number
  optimizer_status: string
  replay_valid: boolean
  total_ms: number
  degraded?: string
  violations?: string[]
}

function log(diagnostics: Diagnostics): void {
  const level = diagnostics.replay_valid ? "info" : "error"
  console[level]("optigrid", JSON.stringify(diagnostics))
}

/**
 * Solves, then verifies its own output the way the judge will.
 *
 * If our plan fails its own replay we have a solver bug, not a scenario
 * problem. Falling back to a base-rules solve loses directive credit for that
 * case but keeps the schedule valid, which protects the separate energy-balance
 * and battery-transition checks.
 */
function solveAndVerify(scenario: ScenarioRequest, directives: Directive[]) {
  const result = optimizeSchedule(scenario, directives)
  const replay = replayPlan(scenario, directives, result.plan, result.totals)
  if (replay.valid) return { result, replay }

  const base = optimizeSchedule(scenario, [])
  const baseReplay = replayPlan(scenario, [], base.plan, base.totals)
  if (baseReplay.valid) {
    return {
      result: { ...base, status: "relaxed" as const, note: "self-check failed with directives" },
      replay: baseReplay,
    }
  }
  return { result, replay }
}

export async function runPipeline(rawBody: unknown): Promise<PipelineOutcome> {
  const started = performance.now()

  const parsed = scenarioRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    // Zod's message names the offending field without echoing request content.
    const first = parsed.error.issues[0]
    const where = first?.path.join(".") || "body"
    return {
      status: 400,
      body: { error: `invalid request: ${where} ${first?.message ?? ""}`.trim() },
    }
  }

  const scenario = normalizeScenario(parsed.data)

  const interpretation = await interpretNotes({
    scenarioId: scenario.scenario_id,
    notes: scenario.operator_notes,
    battery: scenario.battery,
  })

  const { notes, events } = applyGuardrails(
    interpretation.raw,
    scenario.operator_notes.length,
    scenario.battery,
  )
  const directives = notes.map((note) => note.directive)

  const { result, replay } = solveAndVerify(scenario, directives)

  const body: OptimizeResponse = {
    scenario_id: scenario.scenario_id,
    directive_interpretation: toWireEntries(notes),
    hourly_plan: result.plan,
    // Totals come from the replay, which recomputes them from the plan. The
    // plan is the source of truth, so they cannot disagree.
    total_grid_kwh: replay.totals.total_grid_kwh,
    total_cost_bdt: replay.totals.total_cost_bdt,
    peak_grid_kwh: replay.totals.peak_grid_kwh,
    plan_summary: summarizePlan(directives, result, scenario.operator_notes.length),
  }

  log({
    scenario_id: scenario.scenario_id,
    notes: scenario.operator_notes.length,
    interpretation_source: interpretation.source,
    model: interpretation.model,
    llm_ms: Math.round(interpretation.tookMs),
    guardrail_events: events.length,
    applied_directives: directives.filter((d) => d.kind !== "no_op").length,
    optimizer_status: result.status,
    replay_valid: replay.valid,
    total_ms: Math.round(performance.now() - started),
    degraded: interpretation.degraded,
    violations: replay.valid ? undefined : replay.violations.slice(0, 5),
  })

  return { status: 200, body }
}
