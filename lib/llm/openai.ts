import OpenAI from "openai"
import { INTERPRETATION_JSON_SCHEMA } from "../schema"
import { buildUserMessage, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from "./prompt"
import type { InterpretationInput, InterpretationProvider } from "./provider"

/**
 * OpenAI interpretation provider.
 *
 * Uses the Responses API with a strict JSON schema, so the model is constrained
 * to the exact flat shape the guardrails expect rather than asked politely for
 * it. Reasoning effort is pinned low: this is a short extraction over at most
 * three sentences, and effort is the single biggest lever on latency.
 *
 * The client is constructed once per module load and reused across warm
 * invocations - building it per request would add handshake cost to every call.
 */

let cached: OpenAI | null = null

function client(): OpenAI {
  if (!cached) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured")
    cached = new OpenAI({ apiKey, maxRetries: 1 })
  }
  return cached
}

const EFFORTS = ["none", "minimal", "low", "medium", "high"] as const
type Effort = (typeof EFFORTS)[number]

/**
 * Reasoning effort is the largest single lever on latency for this call.
 * Overridable because the right setting is an empirical question - run
 * `npm run eval` after changing it and compare accuracy against p95.
 */
function effort(): Effort {
  const value = process.env.OPENAI_REASONING_EFFORT?.trim().toLowerCase()
  return (EFFORTS as readonly string[]).includes(value ?? "") ? (value as Effort) : "low"
}

export function createOpenAiProvider(model: string): InterpretationProvider {
  return {
    id: "openai",
    model,
    async interpret(input: InterpretationInput, signal: AbortSignal): Promise<unknown> {
      const response = await client().responses.create(
        {
          model,
          instructions: SYSTEM_PROMPT,
          input: buildUserMessage(input),
          reasoning: { effort: effort() },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          text: {
            format: {
              type: "json_schema",
              name: "shakti_interpretation",
              schema: INTERPRETATION_JSON_SCHEMA as unknown as Record<string, unknown>,
              strict: true,
            },
          },
        },
        { signal },
      )

      const text = response.output_text
      if (!text) throw new Error("empty response from openai")
      // Still parsed defensively: strict mode guarantees the schema, not that
      // the call succeeded, and the guardrails own validation from here.
      return JSON.parse(text) as unknown
    },
  }
}
