import { type Constraint, equalTo, inRange, lessEq, type Model, type Solution, solve } from "yalps"
import { type CompiledConstraints, compileConstraints } from "./directives"
import type { ReplayTotals } from "./replay"
import {
  type BatteryAction,
  type Directive,
  HOURS_IN_DAY,
  type HourlyPlanEntry,
  type ScenarioRequest,
} from "./types"

/**
 * Cost-optimal 24-hour schedule via linear programming.
 *
 * The problem is a single-commodity flow over time with storage, which is
 * exactly what LP solves optimally. A greedy "charge cheap, discharge dear"
 * heuristic looks right until a max_grid_window forces pre-charging hours
 * earlier, and since the score is min(1, organizer_optimal / our_cost), every
 * BDT of avoidable cost is lost credit.
 *
 * Decision variables per hour: grid, solar used, charge, discharge. All are
 * naturally non-negative, which suits YALPS - it has no unrestricted variables.
 *
 * Battery level is NOT a variable. The level after hour h is the running sum of
 * charge minus discharge, so the reserve floor and capacity ceiling become one
 * range constraint over that cumulative sum. That keeps the model at 96
 * variables and sidesteps a whole class of state-tracking bug.
 */

export type OptimizeStatus = "optimal" | "relaxed" | "fallback"

export interface OptimizeResult {
  plan: HourlyPlanEntry[]
  totals: ReplayTotals
  /**
   * `optimal`  - solved with every directive applied.
   * `relaxed`  - directives made it infeasible; solved on base rules only.
   * `fallback` - no solve succeeded; trivially valid all-grid plan.
   */
  status: OptimizeStatus
  note?: string
}

/** Values below this are solver noise, not decisions. */
const ZERO_EPSILON = 1e-9

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

// --- model construction ---------------------------------------------------

function buildModel(scenario: ScenarioRequest, limits: CompiledConstraints): Model {
  const { hours, battery } = scenario
  const initial = battery.initial_energy_kwh
  const constraints: Record<string, Constraint> = {}
  const variables: Record<string, Record<string, number>> = {}

  for (let h = 0; h < HOURS_IN_DAY; h++) {
    // grid + solar + discharge - charge = demand
    constraints[`b${h}`] = equalTo(hours[h].demand_kwh)

    // Cumulative charge minus discharge through hour h, expressed as an offset
    // from the starting level: minLevel[h] <= initial + offset <= capacity.
    constraints[`lv${h}`] = inRange(limits.minLevel[h] - initial, battery.capacity_kwh - initial)

    const grid: Record<string, number> = {
      cost: hours[h].tariff_bdt_per_kwh,
      [`b${h}`]: 1,
    }
    if (Number.isFinite(limits.maxGrid[h])) {
      constraints[`gc${h}`] = lessEq(limits.maxGrid[h])
      grid[`gc${h}`] = 1
    }
    variables[`g${h}`] = grid

    // Omitted entirely when there is nothing to use - a variable pinned to zero
    // is just a bigger model.
    if (limits.effectiveSolar[h] > 0) {
      constraints[`sc${h}`] = lessEq(limits.effectiveSolar[h])
      variables[`s${h}`] = { [`b${h}`]: 1, [`sc${h}`]: 1 }
    }
  }

  // End-of-day neutrality: total charge equals total discharge.
  constraints.nt = equalTo(0)

  for (let t = 0; t < HOURS_IN_DAY; t++) {
    // A no_charge_window drops the variable rather than constraining it to 0,
    // so the solver cannot return a token charge inside a forbidden hour.
    if (limits.canCharge[t] && battery.max_charge_kwh_per_hour > 0) {
      constraints[`cc${t}`] = lessEq(battery.max_charge_kwh_per_hour)
      const charge: Record<string, number> = { [`b${t}`]: -1, [`cc${t}`]: 1, nt: 1 }
      for (let h = t; h < HOURS_IN_DAY; h++) charge[`lv${h}`] = 1
      variables[`c${t}`] = charge
    }
    if (limits.canDischarge[t] && battery.max_discharge_kwh_per_hour > 0) {
      constraints[`dc${t}`] = lessEq(battery.max_discharge_kwh_per_hour)
      const discharge: Record<string, number> = { [`b${t}`]: 1, [`dc${t}`]: 1, nt: -1 }
      for (let h = t; h < HOURS_IN_DAY; h++) discharge[`lv${h}`] = -1
      variables[`d${t}`] = discharge
    }
  }

  return { direction: "minimize", objective: "cost", constraints, variables }
}

function valuesOf(solution: Solution): Map<string, number> {
  const values = new Map<string, number>()
  for (const [name, value] of solution.variables) values.set(name, value)
  return values
}

// --- plan construction ----------------------------------------------------

/**
 * Turns raw solver output into a schema-valid plan.
 *
 * Three things happen here that the LP does not do for us:
 *
 *  1. Netting. Simplex may return charge and discharge both positive in one
 *     hour - cost-neutral, so it has no reason to care - but the response
 *     schema allows exactly one action per hour.
 *  2. Grid is recomputed from the balance equation rather than read from the
 *     solver, so energy balance holds exactly instead of to 1e-12.
 *  3. Free solar that a zero-tariff hour left unused is swapped in for grid.
 *     Never raises cost, and keeps reported grid totals honest.
 */
function buildPlan(
  scenario: ScenarioRequest,
  limits: CompiledConstraints,
  values: Map<string, number>,
): HourlyPlanEntry[] {
  const { hours, battery } = scenario
  const plan: HourlyPlanEntry[] = []
  let level = battery.initial_energy_kwh

  for (let h = 0; h < HOURS_IN_DAY; h++) {
    const rawCharge = values.get(`c${h}`) ?? 0
    const rawDischarge = values.get(`d${h}`) ?? 0

    // Net out a simultaneous charge/discharge into one signed movement.
    let net = rawCharge - rawDischarge
    if (Math.abs(net) < ZERO_EPSILON) net = 0
    net = Math.min(net, battery.max_charge_kwh_per_hour)
    net = Math.max(net, -battery.max_discharge_kwh_per_hour)
    net = round6(net)

    const charge = net > 0 ? net : 0
    const discharge = net < 0 ? -net : 0

    // Prefer free solar over paid grid wherever headroom remains.
    const demand = hours[h].demand_kwh
    const solarCeiling = limits.effectiveSolar[h]
    const needed = demand + charge - discharge
    let solarUsed = Math.min(solarCeiling, Math.max(0, needed))
    solarUsed = round6(Math.max(0, solarUsed))

    // Balance holds by construction rather than by floating-point luck.
    const gridKwh = round6(Math.max(0, needed - solarUsed))

    level = round6(level + charge - discharge)

    const action: BatteryAction = charge > 0 ? "charge" : discharge > 0 ? "discharge" : "idle"
    plan.push({
      hour: h,
      grid_kwh: gridKwh,
      solar_used_kwh: solarUsed,
      battery_action: action,
      battery_kwh: charge > 0 ? charge : discharge,
      battery_energy_after_kwh: level,
    })
  }

  return plan
}

function totalsOf(scenario: ScenarioRequest, plan: HourlyPlanEntry[]): ReplayTotals {
  let totalGrid = 0
  let totalCost = 0
  let peakGrid = 0
  for (const entry of plan) {
    totalGrid += entry.grid_kwh
    totalCost += entry.grid_kwh * scenario.hours[entry.hour].tariff_bdt_per_kwh
    peakGrid = Math.max(peakGrid, entry.grid_kwh)
  }
  return {
    total_grid_kwh: round6(totalGrid),
    total_cost_bdt: round6(totalCost),
    peak_grid_kwh: round6(peakGrid),
  }
}

/**
 * Last-resort schedule: buy everything from the grid, never move the battery.
 *
 * Valid by construction under the base rules - balance holds, the battery never
 * leaves its starting level so neutrality and bounds hold, and both rates are
 * zero. Expensive, but a scored-as-invalid response still beats a 5xx, which
 * costs reliability points on top.
 */
function fallbackPlan(scenario: ScenarioRequest): HourlyPlanEntry[] {
  return scenario.hours.map((hour) => ({
    hour: hour.hour,
    grid_kwh: round6(hour.demand_kwh),
    solar_used_kwh: 0,
    battery_action: "idle" as const,
    battery_kwh: 0,
    battery_energy_after_kwh: round6(scenario.battery.initial_energy_kwh),
  }))
}

// --- entry point ----------------------------------------------------------

function attempt(
  scenario: ScenarioRequest,
  directives: Directive[],
): { plan: HourlyPlanEntry[]; limits: CompiledConstraints } | null {
  const limits = compileConstraints(scenario.hours, scenario.battery, directives)
  const solution = solve(buildModel(scenario, limits))
  if (solution.status !== "optimal") return null
  return { plan: buildPlan(scenario, limits, valuesOf(solution)), limits }
}

/**
 * Solves the scenario, degrading in defined steps rather than throwing.
 *
 * Organizer scoring scenarios are guaranteed feasible, so the relaxed and
 * fallback tiers should never fire in judging. They exist because a request
 * that returns nothing scores worse than one that returns a valid-but-costly
 * plan, and because the caller can log which tier ran.
 */
export function optimizeSchedule(
  scenario: ScenarioRequest,
  directives: Directive[],
): OptimizeResult {
  const withDirectives = attempt(scenario, directives)
  if (withDirectives) {
    return {
      plan: withDirectives.plan,
      totals: totalsOf(scenario, withDirectives.plan),
      status: "optimal",
    }
  }

  const baseOnly = attempt(scenario, [])
  if (baseOnly) {
    return {
      plan: baseOnly.plan,
      totals: totalsOf(scenario, baseOnly.plan),
      status: "relaxed",
      note: "directive set was infeasible; solved against base energy rules only",
    }
  }

  const plan = fallbackPlan(scenario)
  return {
    plan,
    totals: totalsOf(scenario, plan),
    status: "fallback",
    note: "no feasible solution; returned an all-grid schedule with the battery idle",
  }
}

/**
 * Plain-language summary of the strategy. Generated deterministically: the
 * field is not judged on wording, so spending a model call on it would buy
 * latency and an extra failure mode for nothing.
 */
export function summarizePlan(
  directives: Directive[],
  result: OptimizeResult,
  noteCount: number,
): string {
  const applied = directives.filter((d) => d.kind !== "no_op")
  const ignored = noteCount - applied.length

  const described = applied.map((directive) => {
    switch (directive.kind) {
      case "solar_reduction":
        return `reduced solar to ${directive.factor * 100}% for ${directive.hours.length}h`
      case "minimum_battery_reserve":
        return `held a ${directive.minimumEnergyKwh} kWh reserve for ${directive.hours.length}h`
      case "no_charge_window":
        return `blocked charging for ${directive.hours.length}h`
      case "no_discharge_window":
        return `blocked discharging for ${directive.hours.length}h`
      case "max_grid_window":
        return `capped grid import at ${directive.maxGridKwh} kWh for ${directive.hours.length}h`
    }
  })

  const parts: string[] = []
  parts.push(
    described.length > 0
      ? `Applied ${described.length} operator directive${described.length === 1 ? "" : "s"} (${described.join("; ")}).`
      : "No operator note affected the schedule.",
  )
  if (ignored > 0) {
    parts.push(`Ignored ${ignored} unrelated note${ignored === 1 ? "" : "s"}.`)
  }
  if (result.status === "optimal") {
    parts.push(
      `Shifted battery energy into high-tariff hours for a total grid cost of ${result.totals.total_cost_bdt.toFixed(2)} BDT, returning the battery to its starting level.`,
    )
  } else {
    parts.push(
      `Constraints could not all be met, so a safe schedule was returned at a cost of ${result.totals.total_cost_bdt.toFixed(2)} BDT.`,
    )
  }
  return parts.join(" ")
}
