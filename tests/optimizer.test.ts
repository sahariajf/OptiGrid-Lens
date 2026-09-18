import { describe, expect, it } from "vitest"
import { optimizeSchedule, summarizePlan } from "@/lib/optimizer"
import { replayPlan } from "@/lib/replay"
import type { Directive, ScenarioRequest } from "@/lib/types"
import { directivesFor, sampleCases } from "./fixtures"

/**
 * The optimizer is scored two ways: validity first, then cost quality via
 * min(1, organizer_optimal / our_cost). Both are checked here against the
 * organizer's own reference results.
 */
describe("optimizeSchedule against the organizer sample cases", () => {
  for (const sample of sampleCases) {
    it(`${sample.id} produces a schedule that replays clean`, () => {
      const directives = directivesFor(sample)
      const result = optimizeSchedule(sample.input, directives)

      expect(result.status).toBe("optimal")

      const replay = replayPlan(sample.input, directives, result.plan, result.totals)
      expect(replay.violations).toEqual([])
    })

    it(`${sample.id} matches or beats the reference cost`, () => {
      const result = optimizeSchedule(sample.input, directivesFor(sample))
      const reference = sample.expected_output.total_cost_bdt
      // quality_ratio = min(1, reference / ours); anything <= reference scores 1.
      expect(result.totals.total_cost_bdt).toBeLessThanOrEqual(reference + 0.01)
    })
  }

  it("scores a perfect cost ratio across the whole public pack", () => {
    let ratioSum = 0
    for (const sample of sampleCases) {
      const result = optimizeSchedule(sample.input, directivesFor(sample))
      ratioSum += Math.min(1, sample.expected_output.total_cost_bdt / result.totals.total_cost_bdt)
    }
    expect(ratioSum / sampleCases.length).toBeCloseTo(1, 4)
  })
})

describe("optimizeSchedule respects each directive type", () => {
  const find = (id: string) => {
    const sample = sampleCases.find((c) => c.id === id)
    if (!sample) throw new Error(`fixture ${id} missing`)
    return sample
  }

  it("never charges inside a no_charge_window", () => {
    const sample = find("SAMPLE-02")
    const result = optimizeSchedule(sample.input, directivesFor(sample))
    for (const h of [2, 3, 4]) {
      expect(result.plan[h].battery_action).not.toBe("charge")
    }
  })

  it("never discharges inside a no_discharge_window", () => {
    const sample = find("SAMPLE-04")
    const result = optimizeSchedule(sample.input, directivesFor(sample))
    for (const h of [18, 19]) {
      expect(result.plan[h].battery_action).not.toBe("discharge")
    }
  })

  it("holds the battery at or above a minimum_battery_reserve", () => {
    const sample = find("SAMPLE-03")
    const result = optimizeSchedule(sample.input, directivesFor(sample))
    for (const h of [18, 19, 20]) {
      expect(result.plan[h].battery_energy_after_kwh).toBeGreaterThanOrEqual(100 - 0.01)
    }
  })

  it("keeps grid import under a max_grid_window cap", () => {
    const sample = find("SAMPLE-05")
    const result = optimizeSchedule(sample.input, directivesFor(sample))
    for (const h of [18, 19, 20]) {
      expect(result.plan[h].grid_kwh).toBeLessThanOrEqual(155 + 0.01)
    }
  })

  it("never uses more than the reduced solar", () => {
    const sample = find("SAMPLE-09") // 80% reduction -> factor 0.2 on 11,12,13
    const result = optimizeSchedule(sample.input, directivesFor(sample))
    for (const h of [11, 12, 13]) {
      const ceiling = sample.input.hours[h].solar_kwh * 0.2
      expect(result.plan[h].solar_used_kwh).toBeLessThanOrEqual(ceiling + 0.01)
    }
  })

  it("produces a strictly costlier plan when a directive binds", () => {
    // Blocking discharge through the evening peak must cost something.
    const sample = find("SAMPLE-01")
    const free = optimizeSchedule(sample.input, [])
    const blocked = optimizeSchedule(sample.input, [
      { kind: "no_discharge_window", hours: [17, 18, 19, 20] },
    ])
    expect(blocked.totals.total_cost_bdt).toBeGreaterThan(free.totals.total_cost_bdt)
  })
})

describe("optimizeSchedule output hygiene", () => {
  const sample = sampleCases[0]

  it("emits exactly 24 entries with hours 0..23 in order", () => {
    const { plan } = optimizeSchedule(sample.input, directivesFor(sample))
    expect(plan).toHaveLength(24)
    expect(plan.map((e) => e.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i))
  })

  it("never emits negative values or an idle hour carrying energy", () => {
    for (const current of sampleCases) {
      const { plan } = optimizeSchedule(current.input, directivesFor(current))
      for (const entry of plan) {
        expect(entry.grid_kwh).toBeGreaterThanOrEqual(0)
        expect(entry.solar_used_kwh).toBeGreaterThanOrEqual(0)
        expect(entry.battery_kwh).toBeGreaterThanOrEqual(0)
        expect(entry.battery_energy_after_kwh).toBeGreaterThanOrEqual(0)
        if (entry.battery_action === "idle") expect(entry.battery_kwh).toBe(0)
      }
    }
  })

  it("reports totals that agree with the plan it returns", () => {
    for (const current of sampleCases) {
      const result = optimizeSchedule(current.input, directivesFor(current))
      const replay = replayPlan(current.input, directivesFor(current), result.plan, result.totals)
      expect(replay.violations).toEqual([])
    }
  })
})

describe("optimizeSchedule degrades safely", () => {
  const sample = sampleCases[0]

  const impossible: Directive[] = [
    // A reserve at full capacity plus a total charging ban cannot both hold.
    {
      kind: "minimum_battery_reserve",
      hours: [12],
      minimumEnergyKwh: sample.input.battery.capacity_kwh,
    },
    { kind: "no_charge_window", hours: Array.from({ length: 24 }, (_, i) => i) },
  ]

  it("falls back to base rules rather than throwing on an infeasible set", () => {
    const result = optimizeSchedule(sample.input, impossible)
    expect(result.status).not.toBe("optimal")
    // Whatever tier ran, the plan must still satisfy the base energy rules.
    const replay = replayPlan(sample.input, [], result.plan, result.totals)
    expect(replay.violations).toEqual([])
  })

  it("returns a valid plan when the battery cannot move at all", () => {
    const frozen: ScenarioRequest = {
      ...sample.input,
      battery: {
        ...sample.input.battery,
        max_charge_kwh_per_hour: 0,
        max_discharge_kwh_per_hour: 0,
      },
    }
    const result = optimizeSchedule(frozen, [])
    const replay = replayPlan(frozen, [], result.plan, result.totals)
    expect(replay.violations).toEqual([])
  })

  it("handles a day with no solar at all", () => {
    const dark: ScenarioRequest = {
      ...sample.input,
      hours: sample.input.hours.map((h) => ({ ...h, solar_kwh: 0 })),
    }
    const result = optimizeSchedule(dark, [])
    expect(result.status).toBe("optimal")
    const replay = replayPlan(dark, [], result.plan, result.totals)
    expect(replay.violations).toEqual([])
    expect(result.plan.every((e) => e.solar_used_kwh === 0)).toBe(true)
  })

  it("handles a flat tariff, where shifting energy earns nothing", () => {
    const flat: ScenarioRequest = {
      ...sample.input,
      hours: sample.input.hours.map((h) => ({ ...h, tariff_bdt_per_kwh: 10 })),
    }
    const result = optimizeSchedule(flat, [])
    expect(result.status).toBe("optimal")
    const replay = replayPlan(flat, [], result.plan, result.totals)
    expect(replay.violations).toEqual([])
  })
})

describe("summarizePlan", () => {
  it("names the applied directives and counts the ignored notes", () => {
    const sample = sampleCases[5] // two directives plus one distractor
    const directives = directivesFor(sample)
    const result = optimizeSchedule(sample.input, directives)
    const summary = summarizePlan(directives, result, sample.input.operator_notes.length)

    expect(summary).toContain("Applied 2 operator directives")
    expect(summary).toContain("Ignored 1 unrelated note")
    expect(summary.length).toBeLessThan(400)
  })

  it("says so plainly when nothing applied", () => {
    const summary = summarizePlan(
      [{ kind: "no_op" }],
      optimizeSchedule(sampleCases[0].input, []),
      1,
    )
    expect(summary).toContain("No operator note affected the schedule")
  })
})

describe("optimizeSchedule performance", () => {
  it("solves every sample case well inside the latency budget", () => {
    const start = performance.now()
    for (const sample of sampleCases) optimizeSchedule(sample.input, directivesFor(sample))
    const perCase = (performance.now() - start) / sampleCases.length
    // The LLM call owns the latency budget; the solver must be rounding error.
    expect(perCase).toBeLessThan(50)
  })
})
