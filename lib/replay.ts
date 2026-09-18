import { compileConstraints } from "./directives"
import {
  BATTERY_ACTIONS,
  type BatteryAction,
  type Directive,
  HOURS_IN_DAY,
  type HourlyPlanEntry,
  type ScenarioRequest,
  TOLERANCE,
} from "./types"

/**
 * Independent replay of a finished schedule.
 *
 * This mirrors what the judge does in Section 11: walk the plan hour by hour
 * and re-derive every quantity from the scenario rather than trusting the plan.
 * We run it on our own output before responding, so a solver bug surfaces as a
 * logged violation here instead of as an invalid hidden case.
 *
 * Note it takes `directives` as an argument rather than reading them from the
 * response. The judge replays against ITS ground truth, so the useful local
 * check is the same shape: plan versus a directive set supplied separately.
 */

export interface ReplayTotals {
  total_grid_kwh: number
  total_cost_bdt: number
  peak_grid_kwh: number
}

export interface ReplayResult {
  valid: boolean
  violations: string[]
  /** Totals recomputed from the plan. The plan is the source of truth. */
  totals: ReplayTotals
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function chargeOf(entry: HourlyPlanEntry): number {
  return entry.battery_action === "charge" ? entry.battery_kwh : 0
}

function dischargeOf(entry: HourlyPlanEntry): number {
  return entry.battery_action === "discharge" ? entry.battery_kwh : 0
}

export function replayPlan(
  scenario: ScenarioRequest,
  directives: Directive[],
  plan: HourlyPlanEntry[],
  reported?: Partial<ReplayTotals>,
): ReplayResult {
  const violations: string[] = []
  const { battery, hours } = scenario
  const constraints = compileConstraints(hours, battery, directives)

  // --- structural: exactly 24 unique hours, 0..23 -------------------------
  if (plan.length !== HOURS_IN_DAY) {
    violations.push(`hourly_plan has ${plan.length} entries, expected ${HOURS_IN_DAY}`)
  }
  const byHour = new Map<number, HourlyPlanEntry>()
  for (const entry of plan) {
    if (!Number.isInteger(entry.hour) || entry.hour < 0 || entry.hour >= HOURS_IN_DAY) {
      violations.push(`hour ${String(entry.hour)} is outside 0..23`)
      continue
    }
    if (byHour.has(entry.hour)) {
      violations.push(`hour ${entry.hour} appears more than once`)
      continue
    }
    byHour.set(entry.hour, entry)
  }

  let level = battery.initial_energy_kwh
  let totalGrid = 0
  let totalCost = 0
  let peakGrid = 0

  for (let h = 0; h < HOURS_IN_DAY; h++) {
    const entry = byHour.get(h)
    if (!entry) {
      violations.push(`hour ${h} is missing from hourly_plan`)
      continue
    }

    // --- numeric sanity ---------------------------------------------------
    if (!isFiniteNonNegative(entry.grid_kwh)) violations.push(`h${h}: grid_kwh must be finite >= 0`)
    if (!isFiniteNonNegative(entry.solar_used_kwh)) {
      violations.push(`h${h}: solar_used_kwh must be finite >= 0`)
    }
    if (!isFiniteNonNegative(entry.battery_kwh)) {
      violations.push(`h${h}: battery_kwh must be finite >= 0`)
    }
    if (!(BATTERY_ACTIONS as readonly string[]).includes(entry.battery_action)) {
      violations.push(`h${h}: battery_action ${String(entry.battery_action)} is not a valid action`)
      continue
    }

    const action: BatteryAction = entry.battery_action
    const charge = chargeOf(entry)
    const discharge = dischargeOf(entry)

    // --- action consistency ----------------------------------------------
    if (action === "idle" && Math.abs(entry.battery_kwh) > TOLERANCE) {
      violations.push(`h${h}: idle hour must have battery_kwh 0, got ${entry.battery_kwh}`)
    }

    // --- effective solar --------------------------------------------------
    if (entry.solar_used_kwh > constraints.effectiveSolar[h] + TOLERANCE) {
      violations.push(
        `h${h}: solar_used_kwh ${entry.solar_used_kwh} exceeds effective solar ${constraints.effectiveSolar[h]}`,
      )
    }

    // --- energy balance ---------------------------------------------------
    const supply = entry.grid_kwh + entry.solar_used_kwh + discharge
    const draw = hours[h].demand_kwh + charge
    if (Math.abs(supply - draw) > TOLERANCE) {
      violations.push(`h${h}: energy balance off by ${(supply - draw).toFixed(4)} kWh`)
    }

    // --- rate limits ------------------------------------------------------
    if (charge > battery.max_charge_kwh_per_hour + TOLERANCE) {
      violations.push(`h${h}: charge ${charge} exceeds max ${battery.max_charge_kwh_per_hour}`)
    }
    if (discharge > battery.max_discharge_kwh_per_hour + TOLERANCE) {
      violations.push(
        `h${h}: discharge ${discharge} exceeds max ${battery.max_discharge_kwh_per_hour}`,
      )
    }

    // --- directive windows -------------------------------------------------
    if (!constraints.canCharge[h] && charge > TOLERANCE) {
      violations.push(`h${h}: charged ${charge} kWh inside a no_charge_window`)
    }
    if (!constraints.canDischarge[h] && discharge > TOLERANCE) {
      violations.push(`h${h}: discharged ${discharge} kWh inside a no_discharge_window`)
    }
    if (entry.grid_kwh > constraints.maxGrid[h] + TOLERANCE) {
      violations.push(
        `h${h}: grid_kwh ${entry.grid_kwh} exceeds max_grid_window cap ${constraints.maxGrid[h]}`,
      )
    }

    // --- battery state transition ------------------------------------------
    level = level + charge - discharge
    if (Math.abs(level - entry.battery_energy_after_kwh) > TOLERANCE) {
      violations.push(
        `h${h}: battery_energy_after_kwh ${entry.battery_energy_after_kwh} does not match replayed ${level.toFixed(4)}`,
      )
    }
    if (level < constraints.minLevel[h] - TOLERANCE) {
      violations.push(
        `h${h}: battery level ${level.toFixed(4)} below required minimum ${constraints.minLevel[h]}`,
      )
    }
    if (level > battery.capacity_kwh + TOLERANCE) {
      violations.push(
        `h${h}: battery level ${level.toFixed(4)} above capacity ${battery.capacity_kwh}`,
      )
    }

    totalGrid += entry.grid_kwh
    totalCost += entry.grid_kwh * hours[h].tariff_bdt_per_kwh
    peakGrid = Math.max(peakGrid, entry.grid_kwh)
  }

  // --- end-of-day neutrality ----------------------------------------------
  if (Math.abs(level - battery.initial_energy_kwh) > TOLERANCE) {
    violations.push(
      `battery ends at ${level.toFixed(4)}, must return to initial ${battery.initial_energy_kwh}`,
    )
  }

  const totals: ReplayTotals = {
    total_grid_kwh: totalGrid,
    total_cost_bdt: totalCost,
    peak_grid_kwh: peakGrid,
  }

  // --- reported totals must agree with the plan ----------------------------
  if (reported) {
    for (const key of ["total_grid_kwh", "total_cost_bdt", "peak_grid_kwh"] as const) {
      const claimed = reported[key]
      if (claimed === undefined) continue
      if (!Number.isFinite(claimed) || Math.abs(claimed - totals[key]) > TOLERANCE) {
        violations.push(`${key} reported as ${String(claimed)}, recalculated ${totals[key]}`)
      }
    }
  }

  return { valid: violations.length === 0, violations, totals }
}
