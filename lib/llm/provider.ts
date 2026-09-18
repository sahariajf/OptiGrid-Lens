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

const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5",
  gemini: "gemini-3-pro",
}

const DEFAULT_TIMEOUT_MS = 12_000

function asProviderId(value: string | undefined): ProviderId {
  const normalized = value?.trim().toLowerCase()
  return (PROVIDER_IDS as readonly string[]).includes(normalized ?? "")
    ? (normalized as ProviderId)
    : "openai"
}

/**
 * Resolves provider settings from the environment. The timeout is deliberately
 * well under the harness's 30s per-request limit: a slow call should degrade to
 * the fallback path, never time the request out, because a timeout counts as a
 * failure rather than merely slow.
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
