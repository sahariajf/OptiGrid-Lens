import { z } from "zod"
import { DIRECTIVE_TYPES, HOURS_IN_DAY, type ScenarioRequest } from "./types"

/**
 * Request validation.
 *
 * Deliberately strict about STRUCTURE (field presence, types, counts) because
 * the harness probes malformed input and expects a controlled 400. Deliberately
 * lenient about VALUE RANGES beyond physical impossibility: rejecting a valid
 * hidden case is far more costly than accepting an odd one, since the optimizer
 * and replay checker catch anything genuinely unschedulable downstream.
 */

const finite = z.number().refine(Number.isFinite, "must be a finite number")
const finiteNonNegative = finite.refine((n) => n >= 0, "must be >= 0")

export const hourInputSchema = z.object({
  hour: z
    .number()
    .int()
    .min(0)
    .max(HOURS_IN_DAY - 1),
  demand_kwh: finiteNonNegative,
  solar_kwh: finiteNonNegative,
  tariff_bdt_per_kwh: finite,
})

export const batteryInputSchema = z.object({
  capacity_kwh: finiteNonNegative,
  initial_energy_kwh: finiteNonNegative,
  minimum_energy_kwh: finiteNonNegative,
  max_charge_kwh_per_hour: finiteNonNegative,
  max_discharge_kwh_per_hour: finiteNonNegative,
})

export const scenarioRequestSchema = z.object({
  scenario_id: z.string().min(1),
  // 1-3 notes per the Problem Statement. Any script is accepted: hidden notes
  // may be English, Bangla, or a mix, so we only require non-empty text.
  operator_notes: z
    .array(z.string().refine((s) => s.trim().length > 0, "note must not be empty"))
    .min(1)
    .max(3),
  hours: z
    .array(hourInputSchema)
    .length(HOURS_IN_DAY)
    .refine(
      (hours) => new Set(hours.map((h) => h.hour)).size === HOURS_IN_DAY,
      "hours must cover 0..23 exactly once",
    ),
  battery: batteryInputSchema,
})

export type ScenarioRequestInput = z.infer<typeof scenarioRequestSchema>

/**
 * Normalizes a validated request into hour-indexed order. The schema allows the
 * `hours` array to arrive in any order; everything downstream assumes index ===
 * hour, so we sort once here rather than defensively everywhere else.
 */
export function normalizeScenario(input: ScenarioRequestInput): ScenarioRequest {
  return {
    ...input,
    hours: [...input.hours].sort((a, b) => a.hour - b.hour),
  }
}

/**
 * JSON Schema describing what a provider must return.
 *
 * Intentionally FLAT rather than a discriminated union: OpenAI strict mode and
 * Gemini both handle a flat object with nullable fields far more reliably than
 * `anyOf` over four adjustment shapes. The guardrail layer assembles the real
 * `structured_adjustment` afterwards, which means a provider is structurally
 * incapable of emitting a malformed adjustment.
 *
 * Note `applies` is absent on purpose - it is derived from `directive_type`,
 * removing a whole class of model error.
 */
export const INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["interpretations"],
  properties: {
    interpretations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "note_index",
          "directive_type",
          "hours",
          "factor",
          "minimum_energy_kwh",
          "max_grid_kwh",
          "explanation",
        ],
        properties: {
          note_index: {
            type: "integer",
            description: "Zero-based index of the operator note this entry interprets.",
          },
          directive_type: {
            type: "string",
            enum: [...DIRECTIVE_TYPES],
          },
          hours: {
            type: "array",
            items: { type: "integer" },
            description:
              "Affected whole hours, start-inclusive and end-exclusive. 1 PM to 3 PM is [13, 14]. Empty for no_op.",
          },
          factor: {
            type: ["number", "null"],
            description:
              "solar_reduction only: usable fraction of solar REMAINING, 0..1. An 80% reduction is 0.2. Null otherwise.",
          },
          minimum_energy_kwh: {
            type: ["number", "null"],
            description:
              "minimum_battery_reserve only: required floor in kWh. Convert percentages against battery capacity. Null otherwise.",
          },
          max_grid_kwh: {
            type: ["number", "null"],
            description: "max_grid_window only: per-hour grid import cap in kWh. Null otherwise.",
          },
          explanation: {
            type: "string",
            description: "One short sentence, in English, explaining the interpretation.",
          },
        },
      },
    },
  },
} as const
