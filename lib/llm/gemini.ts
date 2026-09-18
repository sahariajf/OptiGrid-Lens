import { GoogleGenAI } from "@google/genai"
import { INTERPRETATION_JSON_SCHEMA } from "../schema"
import { buildUserMessage, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from "./prompt"
import type { InterpretationInput, InterpretationProvider } from "./provider"

/**
 * Gemini interpretation provider.
 *
 * Uses `responseJsonSchema`, which takes standard JSON Schema, so both providers
 * are handed the identical schema object from lib/schema.ts. Thinking budget is
 * zeroed for the same reason OpenAI's effort is low - this is a short extraction
 * and latency is the constraint.
 *
 * If a future model rejects part of the schema, the guardrails still cope: they
 * accept any shape and validate it themselves. That is the point of treating
 * provider output as untrusted rather than relying on the schema alone.
 */

let cached: GoogleGenAI | null = null

function client(): GoogleGenAI {
  if (!cached) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured")
    cached = new GoogleGenAI({ apiKey })
  }
  return cached
}

export function createGeminiProvider(model: string): InterpretationProvider {
  return {
    id: "gemini",
    model,
    async interpret(input: InterpretationInput, signal: AbortSignal): Promise<unknown> {
      const response = await client().models.generateContent({
        model,
        contents: buildUserMessage(input),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseJsonSchema: INTERPRETATION_JSON_SCHEMA,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: signal,
        },
      })

      const text = response.text
      if (!text) throw new Error("empty response from gemini")
      return JSON.parse(text) as unknown
    },
  }
}
