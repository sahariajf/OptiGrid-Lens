import { createHash } from "node:crypto"
import { createGeminiProvider } from "./gemini"
import { createOpenAiProvider } from "./openai"
import {
  type InterpretationInput,
  type InterpretationProvider,
  type ProviderId,
  resolveLlmConfig,
} from "./provider"

/**
 * Interpretation entry point: provider selection, caching, timeout, failover.
 *
 * Three latency decisions live here, all aimed at the 5s p95 band:
 *
 *  1. One call covers all 1-3 notes. Calling per note would triple the only
 *     expensive step in the request.
 *  2. Identical notes are cached. p95 is a tail statistic, and hidden cases
 *     reuse phrasings, so cache hits pull the tail down hard.
 *  3. The call is bounded by an AbortSignal well under the harness's 30s limit.
 *     A timeout counts as a failure, not merely as slow, so we would rather
 *     degrade early than be cut off.
 */

export interface InterpretationOutcome {
  /** Raw, untrusted. Must go through applyGuardrails. */
  raw: unknown
  source: ProviderId | "cache" | "unavailable"
  model: string
  tookMs: number
  /** Present when the primary provider failed; safe to log, never secret-bearing. */
  degraded?: string
}

const CACHE_LIMIT = 500
const cache = new Map<string, unknown>()

function cacheKey(provider: string, model: string, input: InterpretationInput): string {
  // Capacity and base minimum participate because percentage phrasings resolve
  // against them - the same sentence can mean a different kWh figure.
  const payload = JSON.stringify([
    provider,
    model,
    input.battery.capacity_kwh,
    input.battery.minimum_energy_kwh,
    input.notes,
  ])
  return createHash("sha256").update(payload).digest("hex")
}

function remember(key: string, value: unknown): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, value)
}

function hasKey(provider: ProviderId): boolean {
  const name = provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"
  return Boolean(process.env[name])
}

function build(provider: ProviderId, model: string): InterpretationProvider {
  return provider === "openai" ? createOpenAiProvider(model) : createGeminiProvider(model)
}

/** Short, non-sensitive reason string. Never includes keys, URLs, or stack traces. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timed out"
    return error.message.slice(0, 120)
  }
  return "unknown error"
}

export async function interpretNotes(
  input: InterpretationInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InterpretationOutcome> {
  const config = resolveLlmConfig(env)
  const started = performance.now()

  const key = cacheKey(config.provider, config.model, input)
  if (cache.has(key)) {
    return {
      raw: cache.get(key),
      source: "cache",
      model: config.model,
      tookMs: performance.now() - started,
    }
  }

  // Primary, then the other provider if its key is configured. A hosted model
  // going down mid-judging is a documented risk; a second provider is the
  // cheapest insurance available, and it keeps an LLM in the path.
  const secondary: ProviderId = config.provider === "openai" ? "gemini" : "openai"
  const order: ProviderId[] = hasKey(secondary) ? [config.provider, secondary] : [config.provider]

  const failures: string[] = []
  for (const providerId of order) {
    if (!hasKey(providerId)) {
      failures.push(`${providerId}: no api key`)
      continue
    }
    const model = providerId === config.provider ? config.model : undefined
    const provider = build(
      providerId,
      model ?? resolveLlmConfig({ ...env, LLM_PROVIDER: providerId, LLM_MODEL: "" }).model,
    )
    try {
      const raw = await provider.interpret(input, AbortSignal.timeout(config.timeoutMs))
      if (providerId === config.provider) remember(key, raw)
      return {
        raw,
        source: providerId,
        model: provider.model,
        tookMs: performance.now() - started,
        degraded: failures.length > 0 ? failures.join("; ") : undefined,
      }
    } catch (error) {
      failures.push(`${providerId}: ${describe(error)}`)
    }
  }

  // Every provider failed. Returning null lets the guardrails emit a full set of
  // no_op entries, so the response stays schema-valid and the optimizer still
  // produces a plan valid under base rules.
  return {
    raw: null,
    source: "unavailable",
    model: config.model,
    tookMs: performance.now() - started,
    degraded: failures.join("; "),
  }
}

/** Test seam: the cache is process-global and would otherwise leak between runs. */
export function clearInterpretationCache(): void {
  cache.clear()
}
