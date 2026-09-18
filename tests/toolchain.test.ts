import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { equalTo, inRange, solve } from "yalps"

describe("toolchain smoke tests", () => {
  it("solves an LP with the equality and range constraints the optimizer relies on", () => {
    // Two-hour toy: meet demand of 10 each hour, buy grid at 1 then 5 BDT.
    // A battery starting at 0 may charge up to 6/hour and must end at 0,
    // so the only sensible play is to over-buy in hour 0 and discharge in hour 1.
    const solution = solve({
      direction: "minimize",
      objective: "cost",
      constraints: {
        balance0: equalTo(10),
        balance1: equalTo(10),
        level0: inRange(0, 6), // battery level after hour 0
        neutrality: equalTo(0), // battery ends where it started
      },
      variables: {
        grid0: { cost: 1, balance0: 1 },
        grid1: { cost: 5, balance1: 1 },
        chg0: { balance0: -1, level0: 1, neutrality: 1 },
        dis1: { balance1: 1, neutrality: -1 },
      },
    })

    expect(solution.status).toBe("optimal")
    // 16 grid-kWh in hour 0 at 1 BDT, 4 in hour 1 at 5 BDT = 36.
    expect(solution.result).toBeCloseTo(36, 6)
  })

  it("loads the public sample case pack as a fixture", () => {
    const raw = readFileSync(
      resolve(import.meta.dirname, "fixtures/public-sample-cases.json"),
      "utf8",
    )
    const pack = JSON.parse(raw)
    expect(pack.cases).toHaveLength(10)
    expect(pack._meta.allowed_enums.directive_type).toContain("solar_reduction")
  })
})
