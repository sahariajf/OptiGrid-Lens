import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BatteryInput } from "@/lib/types"

/**
 * The interpretation budget must cover the WHOLE provider chain.
 *
 * Regression for a real failure seen on an adversarial case: with a per-provider
 * timeout, a hung primary plus a fallback stacked to 24s on a 12s setting -
 * close enough to the harness's 30s limit that a slow case becomes a failed one.
 *
 * Real timers with a small budget rather than fake ones, because
 * `AbortSignal.timeout` is not driven by vitest's fake timers.
 */

const battery: BatteryInput = {
  capacity_kwh: 220,
  initial_energy_kwh: 110,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
}

/** Never settles until its signal aborts, like a provider that has stalled. */
const stall = (_input: unknown, signal: AbortSignal) =>
  new Promise<unknown>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")))
  })

const openaiInterpret = vi.fn(stall)
const geminiInterpret = vi.fn(stall)

vi.mock("@/lib/llm/openai", () => ({
  createOpenAiProvider: (model: string) => ({
    id: "openai",
    model,
    interpret: (i: unknown, s: AbortSignal) => openaiInterpret(i, s),
  }),
}))
vi.mock("@/lib/llm/gemini", () => ({
  createGeminiProvider: (model: string) => ({
    id: "gemini",
    model,
    interpret: (i: unknown, s: AbortSignal) => geminiInterpret(i, s),
  }),
}))

const { interpretNotes, clearInterpretationCache } = await import("@/lib/llm")

const BUDGET = 900

const envWith = (over: Record<string, string> = {}) =>
  ({
    LLM_PROVIDER: "openai",
    LLM_TIMEOUT_MS: String(BUDGET),
    OPENAI_API_KEY: "test",
    GEMINI_API_KEY: "test",
    ...over,
  }) as unknown as NodeJS.ProcessEnv

beforeEach(() => {
  openaiInterpret.mockReset().mockImplementation(stall)
  geminiInterpret.mockReset().mockImplementation(stall)
  clearInterpretationCache()
})

describe("interpretation budget", () => {
  it("bounds the whole chain, not each provider, when both stall", async () => {
    const started = performance.now()
    const outcome = await interpretNotes({ scenarioId: "T", notes: ["a"], battery }, envWith())
    const elapsed = performance.now() - started

    expect(outcome.source).toBe("unavailable")
    expect(outcome.raw).toBeNull()

    // Both were attempted - failover still happens.
    expect(openaiInterpret).toHaveBeenCalledTimes(1)
    expect(geminiInterpret).toHaveBeenCalledTimes(1)

    // The point of the fix: two stalled providers cost one budget, not two.
    expect(elapsed).toBeLessThan(BUDGET * 1.5)
    expect(outcome.degraded).toContain("openai")
    expect(outcome.degraded).toContain("gemini")
  })

  it("leaves the fallback usable time instead of letting the primary take it all", async () => {
    // The primary is capped at a share of the budget, so the fallback still gets
    // a real attempt rather than a few leftover milliseconds.
    let geminiBudget = 0
    geminiInterpret.mockImplementation((_input, signal) => {
      const at = performance.now()
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          geminiBudget = performance.now() - at
          reject(new Error("aborted"))
        })
      })
    })

    await interpretNotes({ scenarioId: "T", notes: ["a"], battery }, envWith())
    expect(geminiBudget).toBeGreaterThan(BUDGET * 0.15)
  })

  it("skips a fallback when the primary has consumed almost everything", async () => {
    openaiInterpret.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("upstream 503")), BUDGET * 0.95)
        }),
    )

    const outcome = await interpretNotes({ scenarioId: "T", notes: ["a"], battery }, envWith())

    expect(openaiInterpret).toHaveBeenCalledTimes(1)
    expect(geminiInterpret).not.toHaveBeenCalled()
    expect(outcome.degraded).toContain("no time left in budget")
  })

  it("does not attempt a provider whose key is absent", async () => {
    const outcome = await interpretNotes(
      { scenarioId: "T", notes: ["a"], battery },
      envWith({ GEMINI_API_KEY: "" }),
    )
    expect(geminiInterpret).not.toHaveBeenCalled()
    expect(outcome.source).toBe("unavailable")
  })

  it("reports a provider failure without leaking the message verbatim", async () => {
    openaiInterpret.mockRejectedValue(new Error(`401 Incorrect API key sk-proj-${"x".repeat(60)}`))
    geminiInterpret.mockRejectedValue(new Error("403 forbidden"))

    const outcome = await interpretNotes({ scenarioId: "T", notes: ["a"], battery }, envWith())
    // Truncated for logs, and it never reaches the HTTP response regardless.
    expect(outcome.degraded?.length).toBeLessThan(300)
  })
})
