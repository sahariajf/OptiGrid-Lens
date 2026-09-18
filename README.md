# Shakti

**LLM-assisted operator directive interpretation and 24-hour campus energy
optimization.** BUP CSE Fest 2026 preliminary round.

Shakti takes a 24-hour energy scenario plus 1–3 natural-language operator notes,
interprets each note into a structured directive using a language model,
validates that interpretation with deterministic guardrails, and returns a
cost-optimal 24-hour schedule that obeys every valid directive.

Operator notes may be written in **English, Bangla, or Banglish**.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Readiness probe → `{"status":"ok"}` |
| `POST /optimize-energy` | Interpretation + 24-hour schedule |

---

## Architecture

The core idea is that **human notes are never trusted as mathematics**. A note
passes through three layers, each with one job, and nothing reaches the solver
until it has a shape the solver can verify.

```
POST /optimize-energy
      │
      ▼
┌─────────────────┐   zod schema. Structure is strict (fields, types, 24 hours);
│ 1. VALIDATE     │   value ranges are lenient. Rejecting a valid hidden case
│   lib/schema.ts │   costs more than accepting an odd one. → 400 on failure
└────────┬────────┘
         ▼
┌─────────────────┐   ONE call for all 1–3 notes. Returns `unknown` by design —
│ 2. INTERPRET    │   the type signature is what enforces the trust boundary.
│   lib/llm/      │   Content-hash cache, shared timeout, provider failover.
└────────┬────────┘
         ▼  raw, untrusted
┌─────────────────┐   The containment boundary. Coerces, range-checks, and
│ 3. GUARDRAILS   │   rebuilds every directive from scratch. Anything that
│ lib/guardrails  │   fails degrades to no_op — never throws.
└────────┬────────┘
         ▼  Directive[]  (a closed, typed union)
┌─────────────────┐   Compiles directives into per-hour constraints, then
│ 4. OPTIMIZE     │   solves a linear program. Provably cost-optimal, not
│ lib/optimizer   │   a heuristic.
└────────┬────────┘
         ▼
┌─────────────────┐   Replays our own schedule hour by hour, exactly as the
│ 5. REPLAY       │   judge will. If it fails, we fall back rather than ship
│   lib/replay.ts │   something invalid.
└────────┬────────┘
         ▼
     200 + response
```

### 1. Validate — `lib/schema.ts`

A zod schema enforces the request contract: `scenario_id`, 1–3 non-empty notes,
exactly 24 hour entries covering 0–23 once each, and a complete battery object.
Malformed input returns a controlled `400`, never a crash.

Hours may arrive in any order; they are sorted once here so every layer
downstream can assume `index === hour`.

### 2. Interpret — `lib/llm/`

This is the layer the challenge requires a language model for, and it is the
layer that produces the optimizer's constraints — not a cosmetic summary.

**One call covers all notes.** Calling per note would triple the only expensive
step in the request.

**Providers return a flat shape**, not the final response shape:

```jsonc
{ "note_index": 0, "directive_type": "solar_reduction",
  "hours": [13, 14], "factor": 0.2,
  "minimum_energy_kwh": null, "max_grid_kwh": null,
  "explanation": "..." }
```

A discriminated union over four adjustment shapes is handled poorly by strict
structured-output modes. A flat object with nullable fields is handled reliably
by both providers, and the guardrails assemble the real `structured_adjustment`
afterwards — which means **a provider is structurally incapable of emitting a
malformed adjustment**.

`interpret()` returns `unknown`. That is deliberate: the type system, not
convention, forces every caller through the guardrails.

**Shared budget and failover.** `LLM_TIMEOUT_MS` is the total budget for the
whole provider chain, not per provider. A single attempt is capped at a share of
it so a stalled primary always leaves the fallback usable time. If the primary
fails and a second provider is configured, it is tried with the remainder.

**Caching.** Identical notes against the same battery return the cached
interpretation. The key includes capacity and base minimum, because a percentage
phrasing resolves to a different kWh figure on a different battery.

### 3. Guardrails — `lib/guardrails.ts`

Every byte from a provider is untrusted. This layer guarantees three properties
regardless of what the model does:

1. **Exactly one entry per note**, in `note_index` order `0..N-1`, no gaps or
   duplicates — even if the provider returns nothing at all.
2. **`applies` and `structured_adjustment` are derived** from the validated
   directive type, never read from the model. `no_op` is the only `applies:
   false` and always carries a null adjustment, so the two can never disagree.
3. **Any entry that fails validation becomes `no_op`** rather than throwing. A
   dropped directive costs interpretation credit; an exception costs the case.

Checks: directive type within the allowed enum; hours coerced to unique ascending
integers in 0–23; `factor` within `[0, 1]`; reserve finite and not above
capacity; grid cap finite and non-negative. Non-ASCII numerals (Bangla ০–৯,
Arabic-Indic) are normalized, so a Bangla note cannot silently lose its hours.

**This is also the prompt-injection boundary.** A note that tries to issue
instructions can at most produce one of six enum values with range-checked
numbers — it cannot reach the optimizer with anything else. The free-text
`explanation` is the only model-authored field that appears in the response, so
it is stripped of control characters and capped at 200 characters.

### 4. Optimize — `lib/optimizer.ts`

The schedule is a single-commodity flow over time with storage, which is exactly
what linear programming solves optimally. A greedy "charge cheap, discharge
dear" heuristic looks right until a `max_grid_window` forces pre-charging hours
earlier — and since scoring is `min(1, optimal / ours)`, every avoidable BDT is
lost credit.

Solved with [YALPS](https://www.npmjs.com/package/yalps): pure TypeScript, no
native or WASM dependency, so nothing can fail to bundle on a serverless
deployment.

**96 variables** — grid, solar used, charge and discharge per hour, all
naturally non-negative.

**Battery level is not a variable.** The level after hour *h* is the running sum
of charge minus discharge, so the reserve floor and capacity ceiling collapse
into one range constraint over that cumulative sum. Fewer variables, and an
entire class of state-tracking bug disappears.

**Directive windows drop the variable** rather than bounding it to zero. Inside a
`no_charge_window`, the charge variable does not exist — the solver is not
merely discouraged from charging, it has no way to express it.

**`lib/directives.ts` compiles directives once** into per-hour constraints, and
both the optimizer and the replay checker consume that same output. A directive
therefore cannot be applied in one place and forgotten in the other, which is
the failure the rubric penalises twice.

Post-processing nets any simultaneous charge/discharge into one action,
recomputes grid from the balance equation so energy balance is exact by
construction rather than by floating-point luck, and swaps free solar in for grid
wherever headroom remains.

If a directive set is infeasible, the optimizer degrades in defined steps — all
directives → base rules only → an all-grid plan that is valid by construction —
rather than throwing.

### 5. Replay — `lib/replay.ts`

Before responding, the service replays its own schedule hour by hour and
re-derives every quantity from the scenario: energy balance, effective solar
after reduction, battery transitions, bounds, rate limits, every directive
window, end-of-day neutrality, and the three reported totals.

It takes the directive set as an argument rather than reading it from the
response, mirroring how the judge replays against *its* ground truth. If our own
plan fails this check we have a solver bug, and the service falls back to a
schedule it can verify instead of shipping one it cannot.

Totals in the response come from this replay, so they are recomputed from the
plan and cannot disagree with it.

---

## Quickstart

Requires Node.js 20 or newer (developed on 24) and an OpenAI API key.

```bash
git clone <this-repo> && cd shakti-energy-optimizer
npm install
cp .env.example .env.local        # then put your key in .env.local
npm run build
npm start                          # http://localhost:3000
```

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### Run the public sample pack

```bash
npm run cases
```

Expected: **10 passed, 0 failed**, 18/18 notes correct, `cost ratio 1.0000`
(the optimizer matches the organizer's optimal cost exactly on all ten cases).
Every response is written to `.cases-out/<case-id>.json` for inspection.

### One request by hand

```bash
curl -s -X POST http://localhost:3000/optimize-energy \
  -H "Content-Type: application/json" \
  -d '{
    "scenario_id": "GRID-101",
    "operator_notes": [
      "Solar output will drop to about 20% from 1 PM to 3 PM.",
      "The cafeteria menu changes tomorrow."
    ],
    "hours": [
      {"hour":0,"demand_kwh":90,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":1,"demand_kwh":85,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":2,"demand_kwh":80,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":3,"demand_kwh":80,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":4,"demand_kwh":85,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":5,"demand_kwh":95,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":6,"demand_kwh":110,"solar_kwh":5,"tariff_bdt_per_kwh":8},
      {"hour":7,"demand_kwh":130,"solar_kwh":20,"tariff_bdt_per_kwh":10},
      {"hour":8,"demand_kwh":150,"solar_kwh":50,"tariff_bdt_per_kwh":12},
      {"hour":9,"demand_kwh":165,"solar_kwh":90,"tariff_bdt_per_kwh":14},
      {"hour":10,"demand_kwh":175,"solar_kwh":130,"tariff_bdt_per_kwh":16},
      {"hour":11,"demand_kwh":180,"solar_kwh":160,"tariff_bdt_per_kwh":16},
      {"hour":12,"demand_kwh":185,"solar_kwh":180,"tariff_bdt_per_kwh":15},
      {"hour":13,"demand_kwh":180,"solar_kwh":170,"tariff_bdt_per_kwh":14},
      {"hour":14,"demand_kwh":170,"solar_kwh":140,"tariff_bdt_per_kwh":13},
      {"hour":15,"demand_kwh":165,"solar_kwh":90,"tariff_bdt_per_kwh":14},
      {"hour":16,"demand_kwh":170,"solar_kwh":45,"tariff_bdt_per_kwh":18},
      {"hour":17,"demand_kwh":185,"solar_kwh":10,"tariff_bdt_per_kwh":22},
      {"hour":18,"demand_kwh":205,"solar_kwh":0,"tariff_bdt_per_kwh":28},
      {"hour":19,"demand_kwh":215,"solar_kwh":0,"tariff_bdt_per_kwh":30},
      {"hour":20,"demand_kwh":205,"solar_kwh":0,"tariff_bdt_per_kwh":26},
      {"hour":21,"demand_kwh":175,"solar_kwh":0,"tariff_bdt_per_kwh":18},
      {"hour":22,"demand_kwh":135,"solar_kwh":0,"tariff_bdt_per_kwh":10},
      {"hour":23,"demand_kwh":105,"solar_kwh":0,"tariff_bdt_per_kwh":7}
    ],
    "battery": {
      "capacity_kwh": 220, "initial_energy_kwh": 110, "minimum_energy_kwh": 40,
      "max_charge_kwh_per_hour": 50, "max_discharge_kwh_per_hour": 50
    }
  }'
```

The first note becomes `solar_reduction` on hours `[13, 14]` with `factor 0.2`;
the second is `no_op`.

---

## Configuration

Names only — never commit values. Copy `.env.example` to `.env.local`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | yes | — | Primary interpretation provider |
| `GEMINI_API_KEY` | no | — | Fallback provider; enables failover |
| `LLM_PROVIDER` | no | `openai` | `openai` or `gemini` — the only line to change to swap |
| `LLM_MODEL` | no | see below | Overrides the provider's default model id |
| `LLM_TIMEOUT_MS` | no | `12000` | **Total** budget for the provider chain |
| `OPENAI_REASONING_EFFORT` | no | `low` | `none`\|`minimal`\|`low`\|`medium`\|`high` |
| `PORT` | no | `3000` | Server port |

**Model and provider:** OpenAI `gpt-5.4-mini` at `low` reasoning effort, through
the Responses API with a strict JSON schema. Fallback is Google
`gemini-3.8-flash` through `generateContent` with `responseJsonSchema`. Both
receive the identical prompt and schema, so a difference in results is a
difference in the model rather than in what was asked.

Model ids move faster than documentation — list what your account exposes:

```bash
npm run models            # both providers
npm run models -- gemini  # one provider
```

---

## Testing

```bash
npm test          # 129 unit tests — no network, no API key required
npm run lint      # biome
npm run typecheck # tsc --noEmit
npm run cases     # public sample pack against the live pipeline
```

The case runner accepts any JSON file of scenarios and reports per-case
pass/fail with the reason, writing every response to disk:

```bash
npm run cases -- testcases/multilingual.json
npm run cases -- testcases/multilingual.json --url https://your-deployment.app
npm run cases -- testcases/multilingual.json --filter BN- --verbose
```

`--url` runs against a deployed service instead of in-process, so the same
scorecard can be produced against production.

`testcases/` holds Bangla, Banglish, English and prompt-injection scenarios.
`testcases/GENERATOR_PROMPT.md` is a prompt for producing more adversarial cases
with any model.

---

## Docker fallback

Published to GHCR by `.github/workflows/docker.yml` on every push to `main`. The
workflow starts the built image and polls `/health` before publishing, so a
broken image never reaches the registry.

```bash
docker pull ghcr.io/<owner>/<repo>:latest
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=<your-key> ghcr.io/<owner>/<repo>:latest
curl http://localhost:3000/health
```

The image exposes port **3000** and binds **0.0.0.0**. It contains **no baked-in
credentials** — keys are supplied at runtime with `-e` or `--env-file`.

To build locally instead:

```bash
docker build -t shakti .
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=<your-key> shakti
```

---

## Dependencies

| Package | Role |
|---|---|
| [next](https://nextjs.org) 16 | HTTP server and route handlers |
| [yalps](https://www.npmjs.com/package/yalps) | Linear programming solver |
| [zod](https://zod.dev) | Request validation and provider JSON schema |
| [openai](https://www.npmjs.com/package/openai) | Primary interpretation provider |
| [@google/genai](https://www.npmjs.com/package/@google/genai) | Fallback provider |
| [vitest](https://vitest.dev) · [biome](https://biomejs.dev) | Tests, lint, format |

External services: OpenAI API (primary), Google Gemini API (fallback). Built with
the assistance of AI coding tools; the architecture, prompt design, guardrail
rules and optimizer formulation are the team's own work.

---

## Secret handling

- No key or token is committed. `.gitignore` excludes every `.env*` file with a
  single exception for `.env.example`, which carries variable **names** and empty
  values.
- No secret, provider error body, or stack trace reaches an API response.
  Failures return `{"error": "..."}` with a generic message; detail is logged
  server-side only, truncated, and never includes note text or credentials.
- The Docker image contains no credentials; they are injected at runtime.

---

## Known limitations

- **Interpretation depends on a hosted model.** If the primary is unreachable and
  no fallback key is configured, every note degrades to `no_op`. The response
  stays schema-valid and the schedule stays valid under base energy rules, but
  directive credit for that case is lost.
- **Burst load can push individual calls past the budget.** Firing many requests
  back to back may hit provider rate limits. Configuring `GEMINI_API_KEY` enables
  failover; `LLM_TIMEOUT_MS` can be raised if a harness bursts harder than
  expected.
- **`through` is treated as end-exclusive**, the same as `to` and `until`. The
  Problem Statement states one uniform convention and never uses `through` for a
  time window, so we follow the stated rule rather than English convention.
- **Infeasible directive sets** yield a valid-but-relaxed schedule rather than an
  error. Organizer scoring scenarios are guaranteed feasible, so this path should
  not trigger during judging.
