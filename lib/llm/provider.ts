import type { BatteryInput } from "../types"

/**
 * Provider-agnostic interpretation contract.
 *
 * Swapping models is a one-line env change, so OpenAI and Gemini can be compared
 * on the same hidden cases without touching the pipeline. Two rules keep that
 * honest:
 *
 *   1. `interpret` returns `unknown`. A provider is not trusted to have produced
 *      the right shape - `applyGuardrails` decides that. The type signature is
 *      what enforces the untrusted boundary, not convention.
 *   2. Every provider receives the same `InterpretationInput` and the same JSON
 *      schema from `lib/schema.ts`, so a difference in results is a difference
 *      in the model, not in the prompt.
 */

export const PROVIDER_IDS = ["openai", "gemini"] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export interface InterpretationInput {
  scenarioId: string
  /** Operator notes verbatim. May be English, Bangla, or a mix. */
  notes: string[]
  /** Needed so relative phrasings ("50% of capacity") resolve to kWh. */
  battery: BatteryInput
}

export interface InterpretationProvider {
  readonly id: ProviderId
  readonly model: string
  /**
   * Raw, untrusted model output. Callers MUST pass the result through
   * `applyGuardrails` before it reaches the optimizer.
   */
  interpret(input: InterpretationInput, signal: AbortSignal): Promise<unknown>
}

export interface LlmConfig {
  provider: ProviderId
  model: string
  timeoutMs: number
}

/**
 * Small, fast models by default. Note interpretation is a short structured
 * extraction over at most three sentences - the frontier tier buys little here
 * and costs latency against the 5s p95 band.
 *
 * Verified present on the account with `npm run models`. Override per
 * deployment with LLM_MODEL; step up to gpt-5.4 or gemini-3.8-pro if a
 * paraphrase class turns out to need it.
 */
const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.4-mini",
  gemini: "gemini-3.8-flash",
}

const DEFAULT_TIMEOUT_MS = 12_000

function asProviderId(value: string | undefined): ProviderId {
  const normalized = value?.trim().toLowerCase()
  return (PROVIDER_IDS as readonly string[]).includes(normalized ?? "")
    ? (normalized as ProviderId)
    : "openai"
}

/**
 * Resolves provider settings from the environment.
 *
 * `timeoutMs` is the TOTAL budget for interpretation, shared across the primary
 * provider and any fallback - it is not a per-provider timeout. Treating it as
 * per-provider is how a 12s setting produced a 24s request: the primary hung for
 * its full allowance and the fallback then started a fresh one. 12s total keeps
 * even a complete failover chain inside the 5-15s latency band, and far from the
 * 30s mark where a slow response stops counting as slow and counts as a failure.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = asProviderId(env.LLM_PROVIDER)
  const parsedTimeout = Number(env.LLM_TIMEOUT_MS)
  return {
    provider,
    model: env.LLM_MODEL?.trim() || DEFAULT_MODELS[provider],
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS,
  }
}
