/**
 * Domain types for the Shakti service.
 *
 * Wire types (snake_case) mirror the Problem Statement exactly and must not be
 * renamed. Internal types (camelCase) are ours and never leave the process.
 */

export const DIRECTIVE_TYPES = [
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
] as const

export type DirectiveType = (typeof DIRECTIVE_TYPES)[number]

export const BATTERY_ACTIONS = ["charge", "discharge", "idle"] as const
export type BatteryAction = (typeof BATTERY_ACTIONS)[number]

/** Absolute tolerance the judge uses for kWh and BDT comparisons. */
export const TOLERANCE = 0.01

export const HOURS_IN_DAY = 24

// --- Request (wire) -------------------------------------------------------

export interface HourInput {
  hour: number
  demand_kwh: number
  solar_kwh: number
  tariff_bdt_per_kwh: number
}

export interface BatteryInput {
  capacity_kwh: number
  initial_energy_kwh: number
  minimum_energy_kwh: number
  max_charge_kwh_per_hour: number
  max_discharge_kwh_per_hour: number
}

export interface ScenarioRequest {
  scenario_id: string
  operator_notes: string[]
  hours: HourInput[]
  battery: BatteryInput
}

// --- Response (wire) ------------------------------------------------------

/**
 * The exact shapes Section 04 requires. `no_charge_window` and
 * `no_discharge_window` carry hours only - no extra keys.
 */
export type StructuredAdjustment =
  | { hours: number[]; factor: number }
  | { hours: number[]; minimum_energy_kwh: number }
  | { hours: number[]; max_grid_kwh: number }
  | { hours: number[] }

export interface DirectiveInterpretation {
  note_index: number
  applies: boolean
  directive_type: DirectiveType
  structured_adjustment: StructuredAdjustment | null
  explanation: string
}

export interface HourlyPlanEntry {
  hour: number
  grid_kwh: number
  solar_used_kwh: number
  battery_action: BatteryAction
  battery_kwh: number
  battery_energy_after_kwh: number
}

export interface OptimizeResponse {
  scenario_id: string
  directive_interpretation: DirectiveInterpretation[]
  hourly_plan: HourlyPlanEntry[]
  total_grid_kwh: number
  total_cost_bdt: number
  peak_grid_kwh: number
  plan_summary: string
}

// --- Internal -------------------------------------------------------------

/**
 * A directive after it has cleared the guardrails. Discriminated on `kind` so
 * the compiler forces every consumer to handle all five active types.
 */
export type Directive =
  | { kind: "solar_reduction"; hours: number[]; factor: number }
  | { kind: "minimum_battery_reserve"; hours: number[]; minimumEnergyKwh: number }
  | { kind: "no_charge_window"; hours: number[] }
  | { kind: "no_discharge_window"; hours: number[] }
  | { kind: "max_grid_window"; hours: number[]; maxGridKwh: number }
  | { kind: "no_op" }

/** One note's outcome: the wire entry plus the directive the optimizer consumes. */
export interface InterpretedNote {
  entry: DirectiveInterpretation
  directive: Directive
}
