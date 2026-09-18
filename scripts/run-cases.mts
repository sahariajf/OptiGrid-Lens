import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { directiveFromInterpretation } from "../lib/directives"
import { runPipeline } from "../lib/pipeline"
import { replayPlan } from "../lib/replay"
import { normalizeScenario, scenarioRequestSchema } from "../lib/schema"
import type {
  Directive,
  DirectiveInterpretation,
  OptimizeResponse,
  ScenarioRequest,
} from "../lib/types"

/**
 * Case runner - the loop you work in while tuning.
 *
 * Feed it a JSON file of scenarios, run them through the pipeline (or against a
 * deployed URL), and get a per-case pass/fail with the reason. Every response is
 * written to disk so a failure can be opened and read rather than guessed at.
 *
 *   npm run cases                                  public sample pack
 *   npm run cases -- testcases/multilingual.json   your own file
 *   npm run cases -- my.json --url https://x.app   against a deployment
 *   npm run cases -- my.json --filter BN-          only ids containing "BN-"
 *   npm run cases -- my.json --verbose             print the full response
 *   npm run cases -- my.json --out results/        where responses are written
 *
 * Accepted file shapes:
 *   { "cases": [ { "id": "...", "input": {...}, "expected_output": {...} } ] }
 *   [ {...scenario...}, {...scenario...} ]      bare array of scenarios
 *   { ...scenario... }                          a single scenario
 *
 * `expected_output` is optional. With it, interpretation and cost are graded
 * against ground truth. Without it, the case is still checked for schema
 * validity and for whether the returned schedule honours the directives the
 * service itself reported - which catches "extracted but never applied".
 */

// --- argument parsing -----------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const has = (name: string) => argv.includes(`--${name}`)

const filePath = argv.find(
  (a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true,
)
const source = filePath ?? "tests/fixtures/public-sample-cases.json"
const baseUrl = flag("url")?.replace(/\/+$/, "")
const filter = flag("filter")
const outDir = flag("out") ?? ".cases-out"
const verbose = has("verbose")

// Load .env.local for in-process runs. Harmless when targeting a URL.
try {
  for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
} catch {
  // No .env.local is fine when running against a deployed URL.
}

// --- case loading ---------------------------------------------------------

interface LoadedCase {
  id: string
  input: ScenarioRequest
  expected?: {
    directive_interpretation?: DirectiveInterpretation[]
    total_cost_bdt?: number
  }
}

function loadCases(path: string): LoadedCase[] {
  const parsed = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"))
  const raw: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.cases)
      ? parsed.cases
      : [parsed]

  return raw.map((item, index) => {
    const record = item as Record<string, unknown>
    // A wrapped case carries `input`; a bare scenario is the input itself.
    const input = (record.input ?? record) as ScenarioRequest
    const expected = record.expected_output as LoadedCase["expected"] | undefined
    return {
      id: String(record.id ?? input?.scenario_id ?? `case-${index}`),
      input,
      expected,
    }
  })
}

// --- grading --------------------------------------------------------------

interface Failure {
  what: string
  detail: string
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Compares adjustments the way the judge does: hours exactly, numbers within the
 * 0.01 tolerance from the Problem Statement.
 *
 * Exact equality would fail a correct answer over float representation alone -
 * two-thirds arrives as 0.6666666666666666 from one source and 0.6666666667
 * from another, and both are right.
 */
function adjustmentMatches(actual: unknown, expected: unknown): boolean {
  if (actual === null || expected === null) return actual === expected
  const a = actual as Record<string, unknown>
  const b = expected as Record<string, unknown>
  if (!same(a.hours, b.hours)) return false

  for (const field of ["factor", "minimum_energy_kwh", "max_grid_kwh"] as const) {
    const left = a[field]
    const right = b[field]
    if (left === undefined && right === undefined) continue
    if (typeof left !== "number" || typeof right !== "number") {
      if (left !== right) return false
      continue
    }
    if (Math.abs(left - right) > 0.01) return false
  }
  return true
}

function gradeInterpretation(
  got: DirectiveInterpretation[],
  want: DirectiveInterpretation[],
): { correct: number; total: number; failures: Failure[] } {
  const failures: Failure[] = []
  let correct = 0

  for (const [i, expected] of want.entries()) {
    const actual = got[i]
    if (!actual) {
      failures.push({ what: `note ${i}`, detail: "no interpretation entry returned" })
      continue
    }
    const problems: string[] = []
    if (actual.directive_type !== expected.directive_type) {
      problems.push(
        `directive_type: expected ${expected.directive_type}, got ${actual.directive_type}`,
      )
    }
    if (actual.applies !== expected.applies) {
      problems.push(`applies: expected ${expected.applies}, got ${actual.applies}`)
    }
    if (!adjustmentMatches(actual.structured_adjustment, expected.structured_adjustment)) {
      problems.push(
        `adjustment: expected ${JSON.stringify(expected.structured_adjustment)}, got ${JSON.stringify(actual.structured_adjustment)}`,
      )
    }
    if (problems.length === 0) correct++
    else for (const detail of problems) failures.push({ what: `note ${i}`, detail })
  }

  return { correct, total: want.length, failures }
}

function checkSchema(body: unknown, noteCount: number): Failure[] {
  const failures: Failure[] = []
  const response = body as OptimizeResponse
  const required = [
    "scenario_id",
    "directive_interpretation",
    "hourly_plan",
    "total_grid_kwh",
    "total_cost_bdt",
    "peak_grid_kwh",
    "plan_summary",
  ]
  for (const key of required) {
    if (!(key in (response as object))) failures.push({ what: "schema", detail: `missing ${key}` })
  }
  const extra = Object.keys(response ?? {}).filter((k) => !required.includes(k))
  if (extra.length > 0)
    failures.push({ what: "schema", detail: `unexpected keys: ${extra.join(", ")}` })

  if (response?.hourly_plan?.length !== 24) {
    failures.push({
      what: "schema",
      detail: `hourly_plan has ${response?.hourly_plan?.length} entries, expected 24`,
    })
  }
  const indices = response?.directive_interpretation?.map((e) => e.note_index)
  if (
    !same(
      indices,
      Array.from({ length: noteCount }, (_, i) => i),
    )
  ) {
    failures.push({
      what: "schema",
      detail: `note_index sequence is ${JSON.stringify(indices)}, expected 0..${noteCount - 1}`,
    })
  }
  for (const entry of response?.directive_interpretation ?? []) {
    const isNoOp = entry.directive_type === "no_op"
    if (isNoOp && (entry.applies || entry.structured_adjustment !== null)) {
      failures.push({
        what: "schema",
        detail: `note ${entry.note_index}: no_op must be applies=false with null adjustment`,
      })
    }
    if (!isNoOp && !entry.applies) {
      failures.push({
        what: "schema",
        detail: `note ${entry.note_index}: ${entry.directive_type} must be applies=true`,
      })
    }
  }
  return failures
}

// --- execution ------------------------------------------------------------

async function callService(input: ScenarioRequest): Promise<{ status: number; body: unknown }> {
  if (!baseUrl) return runPipeline(input)
  const response = await fetch(`${baseUrl}/optimize-energy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const GREEN = "[32m"
const RED = "[31m"
const DIM = "[2m"
const RESET = "[0m"

const allCases = loadCases(source)
const cases = filter ? allCases.filter((c) => c.id.includes(filter)) : allCases

console.log(`\nGridWise case runner`)
console.log(`  source : ${source} (${cases.length}/${allCases.length} cases)`)
console.log(`  target : ${baseUrl ?? "in-process pipeline"}`)
console.log(`  output : ${outDir}/\n`)

let passed = 0
let failed = 0
let notesCorrect = 0
let notesTotal = 0
let validSchedules = 0
let ratioSum = 0
let ratioCount = 0
const latencies: number[] = []

for (const testCase of cases) {
  const failures: Failure[] = []

  // Reject unusable input up front so a typo in a handwritten case reads as a
  // file problem rather than a service failure.
  const valid = scenarioRequestSchema.safeParse(testCase.input)
  if (!valid.success) {
    const issue = valid.error.issues[0]
    console.log(
      `${RED}FAIL${RESET}  ${testCase.id.padEnd(12)} invalid case input: ${issue.path.join(".")} ${issue.message}`,
    )
    failed++
    continue
  }
  const scenario = normalizeScenario(valid.data)

  const started = performance.now()
  let status: number
  let body: unknown
  try {
    ;({ status, body } = await callService(scenario))
  } catch (error) {
    console.log(
      `${RED}FAIL${RESET}  ${testCase.id.padEnd(12)} request failed: ${String(error).slice(0, 120)}`,
    )
    failed++
    continue
  }
  const ms = performance.now() - started
  latencies.push(ms)

  const outFile = resolve(process.cwd(), outDir, `${testCase.id}.json`)
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, JSON.stringify({ status, request: scenario, response: body }, null, 2))

  if (status !== 200) {
    console.log(
      `${RED}FAIL${RESET}  ${testCase.id.padEnd(12)} HTTP ${status} ${JSON.stringify(body).slice(0, 160)}`,
    )
    failed++
    continue
  }

  const response = body as OptimizeResponse
  failures.push(...checkSchema(response, scenario.operator_notes.length))

  // Grade interpretation when ground truth is supplied.
  let interpretationNote = ""
  if (testCase.expected?.directive_interpretation) {
    const graded = gradeInterpretation(
      response.directive_interpretation,
      testCase.expected.directive_interpretation,
    )
    notesCorrect += graded.correct
    notesTotal += graded.total
    failures.push(...graded.failures)
    interpretationNote = `notes ${graded.correct}/${graded.total}`
  } else {
    interpretationNote = `notes ${response.directive_interpretation.length} (ungraded)`
  }

  // Replay against ground-truth directives when available, otherwise against
  // what the service itself reported - which still catches a directive that was
  // extracted correctly but never applied to the schedule.
  const directives: Directive[] = (
    testCase.expected?.directive_interpretation ?? response.directive_interpretation
  ).map(directiveFromInterpretation)

  const replay = replayPlan(scenario, directives, response.hourly_plan, {
    total_grid_kwh: response.total_grid_kwh,
    total_cost_bdt: response.total_cost_bdt,
    peak_grid_kwh: response.peak_grid_kwh,
  })
  if (replay.valid) validSchedules++
  for (const violation of replay.violations) {
    failures.push({ what: "schedule", detail: violation })
  }

  // The most damaging failure mode has its own name: the service reported a
  // directive as applied, but the schedule does not honour it. The judge scores
  // extraction and application separately, so this loses the case even though
  // the interpretation looks right. Usually it means the directive set was
  // infeasible for this battery and the optimizer degraded to base rules.
  if (!replay.valid && response.directive_interpretation.some((e) => e.applies)) {
    const directiveViolation = replay.violations.some((v) =>
      /no_charge_window|no_discharge_window|max_grid_window|required minimum|effective solar/.test(
        v,
      ),
    )
    if (directiveViolation) {
      failures.push({
        what: "DIAGNOSIS",
        detail:
          "directive was extracted but not reflected in the schedule - check whether it is achievable within the battery rate and capacity limits",
      })
    }
  }

  // Cost quality, when a reference cost is supplied.
  let costNote = `cost ${response.total_cost_bdt.toFixed(2)}`
  if (typeof testCase.expected?.total_cost_bdt === "number") {
    const ratio = replay.valid
      ? Math.min(1, testCase.expected.total_cost_bdt / response.total_cost_bdt)
      : 0
    ratioSum += ratio
    ratioCount++
    costNote = `cost ${response.total_cost_bdt.toFixed(2)} (ref ${testCase.expected.total_cost_bdt.toFixed(2)}, ratio ${ratio.toFixed(3)})`
    if (ratio < 0.999 && replay.valid) {
      failures.push({
        what: "cost",
        detail: `above reference by ${(response.total_cost_bdt - testCase.expected.total_cost_bdt).toFixed(2)} BDT`,
      })
    }
  }

  if (failures.length === 0) {
    passed++
    console.log(
      `${GREEN}PASS${RESET}  ${testCase.id.padEnd(12)} ${(ms / 1000).toFixed(1)}s  ${interpretationNote}  ${costNote}`,
    )
  } else {
    failed++
    console.log(
      `${RED}FAIL${RESET}  ${testCase.id.padEnd(12)} ${(ms / 1000).toFixed(1)}s  ${interpretationNote}  ${costNote}`,
    )
    for (const failure of failures.slice(0, 8)) {
      console.log(`        ${DIM}${failure.what}:${RESET} ${failure.detail}`)
    }
    if (failures.length > 8)
      console.log(`        ${DIM}... and ${failures.length - 8} more${RESET}`)
    console.log(`        ${DIM}response: ${outDir}/${testCase.id}.json${RESET}`)
  }

  if (verbose) {
    for (const entry of response.directive_interpretation) {
      console.log(
        `        ${DIM}note ${entry.note_index}: ${entry.directive_type} ${JSON.stringify(entry.structured_adjustment)} - ${entry.explanation}${RESET}`,
      )
    }
  }
}

// --- summary --------------------------------------------------------------

const sorted = [...latencies].sort((a, b) => a - b)
const p95 =
  sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0
const mean = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0

console.log(`\n${"-".repeat(60)}`)
console.log(` cases      : ${passed} passed, ${failed} failed, ${cases.length} total`)
if (notesTotal > 0) {
  console.log(
    ` notes      : ${notesCorrect}/${notesTotal} fully correct (${((notesCorrect / notesTotal) * 100).toFixed(0)}%)`,
  )
}
console.log(` schedules  : ${validSchedules}/${latencies.length} valid`)
if (ratioCount > 0) {
  console.log(
    ` cost ratio : ${(ratioSum / ratioCount).toFixed(4)}  ->  ${((ratioSum / ratioCount) * 10).toFixed(1)}/10 optimization points`,
  )
}
if (latencies.length > 0) {
  const band = p95 <= 5000 ? "3/3" : p95 <= 15000 ? "2/3" : p95 <= 30000 ? "1/3" : "0/3"
  console.log(
    ` latency    : mean ${mean.toFixed(0)}ms  p95 ${p95.toFixed(0)}ms  -> ${band} latency points`,
  )
}
console.log(` responses  : ${outDir}/`)
console.log(`${"-".repeat(60)}\n`)

process.exit(failed > 0 ? 1 : 0)
