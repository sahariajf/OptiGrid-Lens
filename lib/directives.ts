import {
  type BatteryInput,
  type Directive,
  type DirectiveInterpretation,
  HOURS_IN_DAY,
  type HourInput,
} from "./types"

/**
 * Per-hour constraint arrays compiled from the base scenario plus every active
 * directive. Both the optimizer and the replay checker consume this, so a
 * directive can never be applied in one place and forgotten in the other -
 * which is precisely the failure the rubric penalizes twice.
 */
export interface CompiledConstraints {
  /** Solar actually usable each hour, after any solar_reduction. */
  effectiveSolar: number[]
  /** Battery floor each hour: base minimum raised by any reserve directive. */
  minLevel: number[]
  /** Grid import ceiling each hour; Infinity where uncapped. */
  maxGrid: number[]
  /** False where a no_charge_window applies. */
  canCharge: boolean[]
  /** False where a no_discharge_window applies. */
  canDischarge: boolean[]
}

export function compileConstraints(
  hours: HourInput[],
  battery: BatteryInput,
  directives: Directive[],
): CompiledConstraints {
  const effectiveSolar = hours.map((h) => h.solar_kwh)
  const minLevel = new Array<number>(HOURS_IN_DAY).fill(battery.minimum_energy_kwh)
  const maxGrid = new Array<number>(HOURS_IN_DAY).fill(Number.POSITIVE_INFINITY)
  const canCharge = new Array<boolean>(HOURS_IN_DAY).fill(true)
  const canDischarge = new Array<boolean>(HOURS_IN_DAY).fill(true)

  for (const directive of directives) {
    switch (directive.kind) {
      case "solar_reduction":
        // Overlapping directives take the most restrictive factor.
        for (const h of directive.hours) {
          effectiveSolar[h] = Math.min(effectiveSolar[h], hours[h].solar_kwh * directive.factor)
        }
        break
      case "minimum_battery_reserve":
        for (const h of directive.hours) {
          minLevel[h] = Math.max(minLevel[h], directive.minimumEnergyKwh)
        }
        break
      case "max_grid_window":
        for (const h of directive.hours) {
          maxGrid[h] = Math.min(maxGrid[h], directive.maxGridKwh)
        }
        break
      case "no_charge_window":
        for (const h of directive.hours) canCharge[h] = false
        break
      case "no_discharge_window":
        for (const h of directive.hours) canDischarge[h] = false
        break
      case "no_op":
        break
    }
  }

  return { effectiveSolar, minLevel, maxGrid, canCharge, canDischarge }
}

/**
 * Converts a wire interpretation entry into the internal directive form.
 *
 * Used by the case runner and the test fixtures to turn an EXPECTED
 * interpretation into constraints, so a schedule can be replayed against
 * ground truth the way the judge does rather than against our own answer.
 */
export function directiveFromInterpretation(entry: DirectiveInterpretation): Directive {
  const adjustment = (entry.structured_adjustment ?? {}) as Record<string, unknown>
  const hours = Array.isArray(adjustment.hours) ? (adjustment.hours as number[]) : []

  switch (entry.directive_type) {
    case "solar_reduction":
      return { kind: "solar_reduction", hours, factor: Number(adjustment.factor) }
    case "minimum_battery_reserve":
      return {
        kind: "minimum_battery_reserve",
        hours,
        minimumEnergyKwh: Number(adjustment.minimum_energy_kwh),
      }
    case "max_grid_window":
      return { kind: "max_grid_window", hours, maxGridKwh: Number(adjustment.max_grid_kwh) }
    case "no_charge_window":
      return { kind: "no_charge_window", hours }
    case "no_discharge_window":
      return { kind: "no_discharge_window", hours }
    case "no_op":
      return { kind: "no_op" }
  }
}
