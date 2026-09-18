import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type {
  Directive,
  DirectiveInterpretation,
  HourlyPlanEntry,
  ScenarioRequest,
} from "@/lib/types"

/**
 * Loader for the organizer's public sample pack.
 *
 * The pack is used as a REGRESSION fixture only. No note wording, case id, or
 * reference schedule is ever read by production code - the guide explicitly
 * forbids fitting to public phrasing, and hidden notes paraphrase these.
 */

export interface SampleCase {
  id: string
  label: string
  input: ScenarioRequest
  expected_output: {
    scenario_id: string
    directive_interpretation: DirectiveInterpretation[]
    hourly_plan: HourlyPlanEntry[]
    total_grid_kwh: number
    total_cost_bdt: number
    peak_grid_kwh: number
    plan_summary: string
  }
  rationale: string
}

const pack = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/public-sample-cases.json"), "utf8"),
) as { cases: SampleCase[] }

export const sampleCases = pack.cases

/**
 * Converts a reference interpretation entry into the internal directive the
 * optimizer and replay checker consume. Mirrors what the guardrails produce, so
 * tests can replay reference plans against reference directives.
 */
export function toDirective(entry: DirectiveInterpretation): Directive {
  const adjustment = entry.structured_adjustment
  switch (entry.directive_type) {
    case "no_op":
      return { kind: "no_op" }
    case "solar_reduction":
      return {
        kind: "solar_reduction",
        hours: (adjustment as { hours: number[] }).hours,
        factor: (adjustment as { factor: number }).factor,
      }
    case "minimum_battery_reserve":
      return {
        kind: "minimum_battery_reserve",
        hours: (adjustment as { hours: number[] }).hours,
        minimumEnergyKwh: (adjustment as { minimum_energy_kwh: number }).minimum_energy_kwh,
      }
    case "max_grid_window":
      return {
        kind: "max_grid_window",
        hours: (adjustment as { hours: number[] }).hours,
        maxGridKwh: (adjustment as { max_grid_kwh: number }).max_grid_kwh,
      }
    case "no_charge_window":
      return { kind: "no_charge_window", hours: (adjustment as { hours: number[] }).hours }
    case "no_discharge_window":
      return { kind: "no_discharge_window", hours: (adjustment as { hours: number[] }).hours }
  }
}

export function directivesFor(sample: SampleCase): Directive[] {
  return sample.expected_output.directive_interpretation.map(toDirective)
}
