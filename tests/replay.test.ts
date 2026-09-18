import { describe, expect, it } from "vitest"
import { replayPlan } from "@/lib/replay"
import type { HourlyPlanEntry } from "@/lib/types"
import { directivesFor, sampleCases } from "./fixtures"

/**
 * The replay checker is our local stand-in for the judge. If it disagrees with
 * the organizer's own reference plans, the checker is wrong - so every sample
 * case must come back clean, and each deliberate corruption must be caught.
 */
describe("replayPlan against the organizer reference schedules", () => {
  for (const sample of sampleCases) {
    it(`${sample.id} (${sample.label}) replays with no violations`, () => {
      const result = replayPlan(
        sample.input,
        directivesFor(sample),
        sample.expected_output.hourly_plan,
        {
          total_grid_kwh: sample.expected_output.total_grid_kwh,
          total_cost_bdt: sample.expected_output.total_cost_bdt,
          peak_grid_kwh: sample.expected_output.peak_grid_kwh,
        },
      )
      expect(result.violations).toEqual([])
      expect(result.valid).toBe(true)
    })
  }

  it("recomputes totals that match the reference values", () => {
    for (const sample of sampleCases) {
      const { totals } = replayPlan(
        sample.input,
        directivesFor(sample),
        sample.expected_output.hourly_plan,
      )
      expect(totals.total_cost_bdt).toBeCloseTo(sample.expected_output.total_cost_bdt, 2)
      expect(totals.total_grid_kwh).toBeCloseTo(sample.expected_output.total_grid_kwh, 2)
      expect(totals.peak_grid_kwh).toBeCloseTo(sample.expected_output.peak_grid_kwh, 2)
    }
  })
})

/** Each mutation below is a violation class the rubric zeroes a case for. */
describe("replayPlan catches every violation class", () => {
  const base = sampleCases[0]
  const clone = (): HourlyPlanEntry[] =>
    base.expected_output.hourly_plan.map((entry) => ({ ...entry }))

  const expectViolation = (plan: HourlyPlanEntry[], fragment: string) => {
    const result = replayPlan(base.input, directivesFor(base), plan)
    expect(result.valid).toBe(false)
    expect(result.violations.join(" | ")).toContain(fragment)
  }

  it("catches an energy balance failure", () => {
    const plan = clone()
    plan[0].grid_kwh += 5
    expectViolation(plan, "energy balance")
  })

  it("catches unmet demand", () => {
    const plan = clone()
    plan[5].grid_kwh = 0
    expectViolation(plan, "energy balance")
  })

  it("catches effective-solar overuse after a solar_reduction", () => {
    // Hour 12 is inside the reference solar_reduction window for SAMPLE-01.
    const plan = clone()
    const boost = 40
    plan[12].solar_used_kwh += boost
    plan[12].grid_kwh = Math.max(0, plan[12].grid_kwh - boost)
    expectViolation(plan, "exceeds effective solar")
  })

  it("catches a broken battery state transition", () => {
    const plan = clone()
    plan[3].battery_energy_after_kwh += 10
    expectViolation(plan, "does not match replayed")
  })

  it("catches a charge-rate violation", () => {
    const plan = clone()
    const hour = plan.findIndex((e) => e.battery_action === "charge")
    plan[hour].battery_kwh += 500
    expectViolation(plan, "exceeds max")
  })

  it("catches an idle hour carrying energy", () => {
    const plan = clone()
    const hour = plan.findIndex((e) => e.battery_action === "idle")
    plan[hour].battery_kwh = 5
    expectViolation(plan, "idle hour must have battery_kwh 0")
  })

  it("catches broken end-of-day neutrality", () => {
    const plan = clone()
    const hour = plan.findLastIndex((e) => e.battery_action === "charge")
    plan[hour].battery_kwh -= 10
    for (let h = hour; h < plan.length; h++) plan[h].battery_energy_after_kwh -= 10
    plan[hour].grid_kwh -= 10
    expectViolation(plan, "must return to initial")
  })

  it("catches reported totals that disagree with the plan", () => {
    const result = replayPlan(base.input, directivesFor(base), clone(), {
      total_cost_bdt: 1,
    })
    expect(result.valid).toBe(false)
    expect(result.violations.join(" | ")).toContain("total_cost_bdt reported as 1")
  })

  it("catches a missing hour", () => {
    expectViolation(clone().slice(0, 23), "missing from hourly_plan")
  })

  it("catches a duplicated hour", () => {
    const plan = clone()
    plan[23] = { ...plan[22] }
    expectViolation(plan, "appears more than once")
  })
})

/** Directive-specific enforcement, checked against cases that carry them. */
describe("replayPlan enforces directive windows", () => {
  const find = (id: string) => {
    const sample = sampleCases.find((c) => c.id === id)
    if (!sample) throw new Error(`fixture ${id} missing`)
    return sample
  }

  it("rejects charging inside a no_charge_window", () => {
    const sample = find("SAMPLE-02") // no_charge_window on hours 2,3,4
    const plan = sample.expected_output.hourly_plan.map((e) => ({ ...e }))
    plan[3] = {
      ...plan[3],
      battery_action: "charge",
      battery_kwh: 20,
      grid_kwh: plan[3].grid_kwh + 20,
      battery_energy_after_kwh: plan[3].battery_energy_after_kwh + 20,
    }
    const result = replayPlan(sample.input, directivesFor(sample), plan)
    expect(result.violations.join(" | ")).toContain("no_charge_window")
  })

  it("rejects discharging inside a no_discharge_window", () => {
    const sample = find("SAMPLE-04") // no_discharge_window on hours 18,19
    const plan = sample.expected_output.hourly_plan.map((e) => ({ ...e }))
    plan[18] = {
      ...plan[18],
      battery_action: "discharge",
      battery_kwh: 20,
      grid_kwh: plan[18].grid_kwh - 20,
      battery_energy_after_kwh: plan[18].battery_energy_after_kwh - 20,
    }
    const result = replayPlan(sample.input, directivesFor(sample), plan)
    expect(result.violations.join(" | ")).toContain("no_discharge_window")
  })

  it("rejects exceeding a max_grid_window cap", () => {
    const sample = find("SAMPLE-05") // cap 155 kWh on hours 18,19,20
    const plan = sample.expected_output.hourly_plan.map((e) => ({ ...e }))
    plan[19] = { ...plan[19], grid_kwh: 200 }
    const result = replayPlan(sample.input, directivesFor(sample), plan)
    expect(result.violations.join(" | ")).toContain("max_grid_window cap")
  })

  it("rejects dropping below a minimum_battery_reserve", () => {
    const sample = find("SAMPLE-03") // reserve 100 kWh on hours 18,19,20
    const { battery, hours } = sample.input
    const plan = sample.expected_output.hourly_plan.map((e) => ({ ...e }))

    // Drain at the max rate from hour 17 so the replayed level falls under the
    // 100 kWh floor by hour 19, keeping balance and transitions internally
    // consistent so the reserve check is what actually fires.
    let level = battery.initial_energy_kwh
    for (let h = 0; h < plan.length; h++) {
      if (h >= 17 && h <= 20) {
        const discharge = Math.min(battery.max_discharge_kwh_per_hour, level)
        level -= discharge
        plan[h] = {
          ...plan[h],
          battery_action: discharge > 0 ? "discharge" : "idle",
          battery_kwh: discharge,
          grid_kwh: hours[h].demand_kwh - plan[h].solar_used_kwh - discharge,
          battery_energy_after_kwh: level,
        }
      } else {
        const entry = plan[h]
        level +=
          (entry.battery_action === "charge" ? entry.battery_kwh : 0) -
          (entry.battery_action === "discharge" ? entry.battery_kwh : 0)
        plan[h] = { ...entry, battery_energy_after_kwh: level }
      }
    }

    const result = replayPlan(sample.input, directivesFor(sample), plan)
    expect(result.violations.join(" | ")).toContain("below required minimum")
  })

  it("treats the base minimum as active when no reserve directive applies", () => {
    const sample = find("SAMPLE-02")
    const plan = sample.expected_output.hourly_plan.map((e) => ({ ...e }))
    // Drain far below the 30 kWh floor while keeping the transition consistent.
    plan[10] = {
      ...plan[10],
      battery_action: "discharge",
      battery_kwh: 55,
      grid_kwh: Math.max(0, plan[10].grid_kwh - 55),
      battery_energy_after_kwh: -500,
    }
    const result = replayPlan(sample.input, directivesFor(sample), plan)
    expect(result.valid).toBe(false)
  })
})
