import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runPipeline } from "../lib/pipeline"
import { replayPlan } from "../lib/replay"
import type { DirectiveInterpretation, OptimizeResponse } from "../lib/types"
import { directivesFor, sampleCases } from "../tests/fixtures"

/**
 * Scores the live pipeline against the public sample pack, mirroring the judge:
 * interpretation versus ground truth, then schedule validity replayed against
 * the GROUND-TRUTH directives (not ours), then cost quality.
 *
 * This is the only script that spends money. Run it after prompt or model
 * changes to see whether they helped:
 *
 *   npm run eval
 *   LLM_PROVIDER=gemini npm run eval
 */

// Minimal .env.local loader - avoids a dependency for a dev-only script.
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function scoreEntry(got: DirectiveInterpretation, want: DirectiveInterpretation) {
  const relevance = got.applies === want.applies
  const type = got.directive_type === want.directive_type
  const gotAdj = (got.structured_adjustment ?? {}) as Record<string, unknown>
  const wantAdj = (want.structured_adjustment ?? {}) as Record<string, unknown>
  const hours = eq(gotAdj.hours, wantAdj.hours)
  const numbers =
    eq(gotAdj.factor, wantAdj.factor) &&
    eq(gotAdj.minimum_energy_kwh, wantAdj.minimum_energy_kwh) &&
    eq(gotAdj.max_grid_kwh, wantAdj.max_grid_kwh)
  return { relevance, type, hours, numbers, perfect: relevance && type && hours && numbers }
}

const totals = { notes: 0, relevance: 0, type: 0, hours: 0, numbers: 0, perfect: 0 }
const latencies: number[] = []
let validCases = 0
let ratioSum = 0

console.log(
  `provider=${process.env.LLM_PROVIDER ?? "openai"} model=${process.env.LLM_MODEL || "(default)"}\n`,
)
console.log("case      |  ms  | interpretation        | valid | ratio")
console.log("----------|------|-----------------------|-------|-------")

for (const sample of sampleCases) {
  const started = performance.now()
  const { status, body } = await runPipeline(sample.input)
  const ms = performance.now() - started
  latencies.push(ms)

  if (status !== 200) {
    console.log(`${sample.id} | ${ms.toFixed(0).padStart(4)} | HTTP ${status}`)
    continue
  }

  const response = body as OptimizeResponse
  const want = sample.expected_output.directive_interpretation
  const marks: string[] = []
  for (const [i, expected] of want.entries()) {
    const got = response.directive_interpretation[i]
    const score = got
      ? scoreEntry(got, expected)
      : { relevance: false, type: false, hours: false, numbers: false, perfect: false }
    totals.notes++
    if (score.relevance) totals.relevance++
    if (score.type) totals.type++
    if (score.hours) totals.hours++
    if (score.numbers) totals.numbers++
    if (score.perfect) totals.perfect++
    marks.push(
      score.perfect
        ? "OK"
        : `n${i}:${[
            score.relevance ? "" : "rel",
            score.type ? "" : "type",
            score.hours ? "" : "hrs",
            score.numbers ? "" : "num",
          ]
            .filter(Boolean)
            .join("/")}`,
    )
  }

  // Replayed against ground truth, exactly as the judge does.
  const replay = replayPlan(sample.input, directivesFor(sample), response.hourly_plan, {
    total_grid_kwh: response.total_grid_kwh,
    total_cost_bdt: response.total_cost_bdt,
    peak_grid_kwh: response.peak_grid_kwh,
  })
  const ratio = replay.valid
    ? Math.min(1, sample.expected_output.total_cost_bdt / response.total_cost_bdt)
    : 0
  if (replay.valid) validCases++
  ratioSum += ratio

  console.log(
    `${sample.id} | ${ms.toFixed(0).padStart(4)} | ${marks.join(" ").padEnd(21)} | ${String(replay.valid).padEnd(5)} | ${ratio.toFixed(3)}`,
  )
  if (!replay.valid)
    console.log(`           violations: ${replay.violations.slice(0, 3).join("; ")}`)
}

const pct = (n: number) => `${((n / totals.notes) * 100).toFixed(0)}%`
const sorted = [...latencies].sort((a, b) => a - b)
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]

console.log(`\ninterpretation over ${totals.notes} notes`)
console.log(`  relevance / no_op : ${pct(totals.relevance)}`)
console.log(`  directive_type    : ${pct(totals.type)}`)
console.log(`  affected hours    : ${pct(totals.hours)}`)
console.log(`  numeric values    : ${pct(totals.numbers)}`)
console.log(`  fully correct     : ${pct(totals.perfect)}`)
console.log(`\nschedules valid     : ${validCases}/${sampleCases.length}`)
console.log(`mean quality_ratio  : ${(ratioSum / sampleCases.length).toFixed(4)}`)
console.log(
  `latency  mean ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms  p95 ${p95.toFixed(0)}ms  max ${Math.max(...latencies).toFixed(0)}ms`,
)
