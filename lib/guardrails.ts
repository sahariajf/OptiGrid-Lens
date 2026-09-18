import {
  type BatteryInput,
  DIRECTIVE_TYPES,
  type Directive,
  type DirectiveInterpretation,
  type DirectiveType,
  HOURS_IN_DAY,
  type InterpretedNote,
  type StructuredAdjustment,
} from "./types"

/**
 * Deterministic guardrails over untrusted model output.
 *
 * Everything a provider returns is `unknown` until it has passed through here.
 * Three properties this layer guarantees regardless of what the model does:
 *
 *   1. Exactly one entry per operator note, in note_index order 0..N-1.
 *   2. `applies` and `structured_adjustment` are DERIVED from the validated
 *      directive type, never taken from the model, so they cannot disagree.
 *   3. Any entry that fails validation degrades to no_op rather than throwing.
 *      A dropped directive costs interpretation points; a crash costs the case.
 *
 * This is also the containment boundary for prompt injection. A note that tries
 * to issue instructions can at most produce one of six enum values with
 * range-checked numbers - it cannot reach the optimizer with anything else.
 */

/** Upper bound on the free-text explanation echoed back in the response. */
const MAX_EXPLANATION_CHARS = 200

export interface GuardrailEvent {
  noteIndex: number
  reason: string
}

export interface GuardrailResult {
  notes: InterpretedNote[]
  events: GuardrailEvent[]
}

// --- coercion helpers -----------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Non-ASCII decimal digit blocks we may see echoed back from a non-English note.
 * `Number("১৩")` is NaN, so without this a Bangla-numeral hour would
 * be silently dropped and the directive lost.
 */
const DIGIT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0660, 0x0669], // Arabic-Indic
  [0x06f0, 0x06f9], // Extended Arabic-Indic (Persian, Urdu)
  [0x09e6, 0x09ef], // Bengali
]

function normalizeDigits(text: string): string {
  let out = ""
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const range = DIGIT_RANGES.find(([lo, hi]) => code >= lo && code <= hi)
    out += range ? String(code - range[0]) : char
  }
  return out
}

/** Accepts a number or a numeric string; providers differ on JSON number typing. */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(normalizeDigits(value.trim()))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Normalizes an hours list to the contract: unique integers 0..23, ascending.
 * Out-of-range and non-integer entries are dropped rather than rejecting the
 * whole directive, since a single stray value should not lose a correct window.
 */
function normalizeHours(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : []
  const seen = new Set<number>()
  for (const item of raw) {
    const n = asFiniteNumber(item)
    if (n === null || !Number.isInteger(n) || n < 0 || n >= HOURS_IN_DAY) continue
    seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

function asDirectiveType(value: unknown): DirectiveType | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return (DIRECTIVE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as DirectiveType)
    : null
}

/**
 * The explanation is the one free-text field that flows from model output back
 * out in the response, so it is the only channel an injected note could use to
 * exfiltrate text. Collapse it to a single short line and cap it hard.
 */
function sanitizeExplanation(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  // Iterated by code point rather than matched by regex: keeps astral-plane
  // characters intact (notes may be Bangla or mixed script) and avoids baking
  // literal control characters into the source.
  let stripped = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f)
    stripped += isControl ? " " : char
  }
  const cleaned = stripped.replace(/\s+/g, " ").trim()
  if (cleaned.length === 0) return fallback
  return cleaned.length > MAX_EXPLANATION_CHARS
    ? `${cleaned.slice(0, MAX_EXPLANATION_CHARS - 1).trimEnd()}…`
    : cleaned
}

const NO_OP_EXPLANATION = "This note does not affect the 24-hour energy schedule."

function noOpNote(noteIndex: number, explanation = NO_OP_EXPLANATION): InterpretedNote {
  return {
    entry: {
      note_index: noteIndex,
      applies: false,
      directive_type: "no_op",
      structured_adjustment: null,
      explanation,
    },
    directive: { kind: "no_op" },
  }
}

// --- entry point ----------------------------------------------------------

/**
 * Locates the interpretation array in whatever wrapper a provider used. Tolerant
 * of a bare array, the documented `interpretations` key, or the response field
 * name itself, all of which show up in practice across providers.
 */
function extractEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const record = asRecord(raw)
  if (!record) return []
  for (const key of ["interpretations", "directive_interpretation", "results"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}

export function applyGuardrails(
  raw: unknown,
  noteCount: number,
  battery: BatteryInput,
): GuardrailResult {
  const events: GuardrailEvent[] = []
  const entries = extractEntries(raw)

  // Index entries by the note they claim. First writer wins: a duplicate index
  // is a model error, and silently overwriting it would hide that.
  const byNote = new Map<number, Record<string, unknown>>()
  for (const item of entries) {
    const record = asRecord(item)
    if (!record) continue
    const index = asFiniteNumber(record.note_index)
    if (index === null || !Number.isInteger(index) || index < 0 || index >= noteCount) {
      events.push({ noteIndex: -1, reason: `entry with unusable note_index ${String(index)}` })
      continue
    }
    if (byNote.has(index)) {
      events.push({ noteIndex: index, reason: "duplicate note_index, ignored" })
      continue
    }
    byNote.set(index, record)
  }

  // Always emit exactly noteCount entries, in order. Missing ones become no_op.
  const notes: InterpretedNote[] = []
  for (let noteIndex = 0; noteIndex < noteCount; noteIndex++) {
    const record = byNote.get(noteIndex)
    if (!record) {
      events.push({ noteIndex, reason: "no interpretation returned for this note" })
      notes.push(noOpNote(noteIndex))
      continue
    }
    notes.push(validateEntry(noteIndex, record, battery, events))
  }

  return { notes, events }
}

function validateEntry(
  noteIndex: number,
  record: Record<string, unknown>,
  battery: BatteryInput,
  events: GuardrailEvent[],
): InterpretedNote {
  const explanation = sanitizeExplanation(record.explanation, NO_OP_EXPLANATION)
  const type = asDirectiveType(record.directive_type)

  if (type === null) {
    events.push({
      noteIndex,
      reason: `unsupported directive_type ${String(record.directive_type)}`,
    })
    return noOpNote(noteIndex)
  }
  if (type === "no_op") return noOpNote(noteIndex, explanation)

  const hours = normalizeHours(record.hours)
  if (hours.length === 0) {
    events.push({ noteIndex, reason: `${type} had no usable hours` })
    return noOpNote(noteIndex)
  }

  const build = (directive: Directive, adjustment: StructuredAdjustment): InterpretedNote => ({
    entry: {
      note_index: noteIndex,
      // Derived, never taken from the model: no_op is the only false.
      applies: true,
      directive_type: type,
      structured_adjustment: adjustment,
      explanation,
    },
    directive,
  })

  switch (type) {
    case "solar_reduction": {
      const factor = asFiniteNumber(record.factor)
      if (factor === null || factor < 0 || factor > 1) {
        events.push({
          noteIndex,
          reason: `solar_reduction factor out of range: ${String(factor)}`,
        })
        return noOpNote(noteIndex)
      }
      return build({ kind: "solar_reduction", hours, factor }, { hours, factor })
    }

    case "minimum_battery_reserve": {
      const reserve = asFiniteNumber(record.minimum_energy_kwh)
      if (reserve === null || reserve < 0 || reserve > battery.capacity_kwh) {
        events.push({
          noteIndex,
          reason: `reserve out of range for capacity ${battery.capacity_kwh}: ${String(reserve)}`,
        })
        return noOpNote(noteIndex)
      }
      return build(
        { kind: "minimum_battery_reserve", hours, minimumEnergyKwh: reserve },
        { hours, minimum_energy_kwh: reserve },
      )
    }

    case "max_grid_window": {
      const cap = asFiniteNumber(record.max_grid_kwh)
      if (cap === null || cap < 0) {
        events.push({ noteIndex, reason: `max_grid_kwh out of range: ${String(cap)}` })
        return noOpNote(noteIndex)
      }
      return build(
        { kind: "max_grid_window", hours, maxGridKwh: cap },
        { hours, max_grid_kwh: cap },
      )
    }

    case "no_charge_window":
      return build({ kind: "no_charge_window", hours }, { hours })

    case "no_discharge_window":
      return build({ kind: "no_discharge_window", hours }, { hours })
  }
}

/** Convenience view for callers that only need the wire entries. */
export function toWireEntries(notes: InterpretedNote[]): DirectiveInterpretation[] {
  return notes.map((n) => n.entry)
}
