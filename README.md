# GridWise

LLM-assisted operator-directive interpretation and 24-hour campus energy
optimization, for the BUP CSE Fest 2026 preliminary round.

The service takes a 24-hour energy scenario plus 1–3 natural-language operator
notes, interprets each note into a structured directive with a language model,
validates that interpretation with deterministic guardrails, and returns a
cost-optimal 24-hour schedule that obeys every valid directive.

Operator notes may be written in **English, Bangla, or Banglish**.

---

## Quickstart

Requires Node.js 20 or newer (developed on 24) and an OpenAI API key.

```bash
git clone <this-repo> && cd gridwise
npm install
cp .env.example .env.local        # then put your key in .env.local
npm run build
npm start                          # serves on http://localhost:3000
```

Check it is up:

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok" }
```

Run one public sample case end to end:

```bash
curl -s -X POST http://localhost:3000/optimize-energy \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
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
    "capacity_kwh": 220,
    "initial_energy_kwh": 110,
    "minimum_energy_kwh": 40,
    "max_charge_kwh_per_hour": 50,
    "max_discharge_kwh_per_hour": 50
  }
}
JSON
```

The first note becomes `solar_reduction` on hours `[13, 14]` with `factor 0.2`;
the second is `no_op`. The response carries a 24-entry `hourly_plan` and totals
recalculated from it.

### Run the whole public sample pack

```bash
npm run cases
```

Expected: **10 passed, 0 failed**, 18/18 notes correct, `cost ratio 1.0000`.
Each response is written to `.cases-out/<case-id>.json` for inspection.

---

## Environment variables

Names only — never commit values. Copy `.env.example` to `.env.local`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | yes | — | Primary interpretation provider |
| `GEMINI_API_KEY` | no | — | Fallback provider; enables automatic failover |
| `LLM_PROVIDER` | no | `openai` | `openai` or `gemini`. The only line to change to swap |
| `LLM_MODEL` | no | see below | Overrides the provider's default model |
| `LLM_TIMEOUT_MS` | no | `12000` | **Total** interpretation budget, shared across the provider chain |
| `OPENAI_REASONING_EFFORT` | no | `low` | `none`\|`minimal`\|`low`\|`medium`\|`high` |
| `PORT` | no | `3000` | Server port |

**Model / provider used:** OpenAI `gpt-5.4-mini` at `low` reasoning effort, via
the Responses API with a strict JSON schema. Fallback is Google
`gemini-3.8-flash` via `generateContent` with `responseJsonSchema`.

List what your account actually exposes before pinning a model:

```bash
npm run models            # both providers
npm run models -- gemini  # one provider
```

---

## Architecture

```
POST /optimize-energy
   │
   ├─ 1. validate          zod schema, 400 on anything unusable
   ├─ 2. interpret         ONE LLM call for all 1–3 notes  ── lib/llm/
   ├─ 3. guardrails        untrusted output → canonical directives ── lib/guardrails.ts
   ├─ 4. optimize          linear program over 96 variables ── lib/optimizer.ts
   ├─ 5. replay            re-verify our own plan the way the judge will ── lib/replay.ts
   └─ 6. respond           200 with the exact response schema
```

### The LLM's role

The language model performs the operator-note interpretation itself. It receives
the notes and returns, for each one, a directive type plus the hours and numbers
it extracted. That structured output is what produces the optimizer's
constraints — it is not used for `plan_summary` or documentation, which are
generated deterministically.

Providers return a **flat** shape (`directive_type`, `hours`, `factor`,
`minimum_energy_kwh`, `max_grid_kwh`, `explanation`) rather than the final
response shape. The guardrails assemble the real `structured_adjustment`, so a
provider is structurally incapable of emitting a malformed adjustment.

### The guardrails

`lib/guardrails.ts` treats every byte from a provider as untrusted and
guarantees three properties regardless of what the model does:

1. **Exactly one entry per note**, in `note_index` order `0..N-1`, with no gaps
   or duplicates — even if the provider returns nothing at all.
2. **`applies` and `structured_adjustment` are derived** from the validated
   directive type, never taken from the model. `no_op` is the only `applies:
   false`, and it always carries a null adjustment.
3. **Any entry that fails validation degrades to `no_op`** instead of throwing.

Validation covers: directive type in the allowed enum, hours unique/ascending
and within 0–23, `factor` in `[0, 1]`, reserve finite and not above capacity,
grid cap finite and non-negative. Non-ASCII numerals (Bangla ০–৯, Arabic-Indic)
are normalized so a Bangla note cannot silently lose its hours.

This is also the prompt-injection boundary. A note that tries to issue
instructions can at most yield one of six enum values with range-checked
numbers; it cannot reach the optimizer with anything else. The free-text
`explanation` is stripped of control characters and capped at 200 characters,
since it is the only model-authored field that appears in the response.

### The optimizer

`lib/optimizer.ts` solves a linear program with [YALPS](https://www.npmjs.com/package/yalps)
(pure TypeScript, no native or WASM dependency). Decision variables per hour:
grid, solar used, charge, discharge — 96 in total, all naturally non-negative.

Battery level is **not** a variable. The level after hour *h* is the running sum
of charge minus discharge, so the reserve floor and capacity ceiling collapse
into one range constraint over that cumulative sum.

Directive windows **drop** the corresponding variable rather than bounding it to
zero, so the solver cannot return a token movement inside a forbidden hour.

Post-processing nets any simultaneous charge/discharge into a single action,
recomputes grid from the balance equation so energy balance is exact by
construction, and swaps free solar in for grid wherever headroom remains.

If the directive set is infeasible the optimizer degrades in defined steps —
all directives → base rules only → an all-grid plan that is valid by
construction — rather than throwing.

### Self-verification

Before responding, the service replays its own schedule hour by hour against the
directives, exactly as Section 11 describes: energy balance, effective solar,
battery transitions, bounds, rate limits, directive windows, end-of-day
neutrality, and the three totals. If our own plan fails that check, the service
falls back rather than shipping something invalid.

---

## Testing

```bash
npm test          # 129 unit tests, no network, no API key needed
npm run lint      # biome
npm run typecheck # tsc --noEmit
npm run cases     # public sample pack against the live pipeline
```

The case runner accepts any JSON file of scenarios and reports per-case
pass/fail with the reason:

```bash
npm run cases -- testcases/multilingual.json
npm run cases -- testcases/multilingual.json --url https://your-deployment.app
npm run cases -- testcases/multilingual.json --filter BN- --verbose
```

`testcases/GENERATOR_PROMPT.md` is a prompt for producing more adversarial cases
with any model.

### Measured results

| Suite | Cases | Notes correct | p95 |
|---|---|---|---|
| Public sample pack | 10/10 | 18/18 (100%) | 3.5s |
| Multilingual (Bangla / Banglish) | 12/12 | 15/15 (100%) | 3.8s |
| Adversarial batch A | 12/12 | 26/26 (100%) | 2.9s |
| Adversarial batch B | 20/20 | 39/39 (100%) | 4.1s |
| Adversarial batch C | 48/50 | 105/107 (98%) | 6.6s |

Cost quality on the public pack is `quality_ratio 1.0000` — the optimizer matches
the organizer's optimal cost exactly, to the BDT, on all ten cases.

---

## Docker fallback

Published automatically to GHCR by `.github/workflows/docker.yml` on every push
to `main`.

```bash
docker pull ghcr.io/<owner>/<repo>:latest
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=<your-key> ghcr.io/<owner>/<repo>:latest
curl http://localhost:3000/health
```

The image exposes port **3000** and binds **0.0.0.0**. It contains **no baked-in
credentials** — the key is supplied at runtime with `-e` or `--env-file`.
`/health` becomes ready in a few seconds; the workflow smoke-tests exactly this
before publishing.

To build locally instead:

```bash
docker build -t gridwise .
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=<your-key> gridwise
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
| [vitest](https://vitest.dev), [@biomejs/biome](https://biomejs.dev) | Tests, lint and format |

External services: OpenAI API (primary), Google Gemini API (fallback). Built
with the assistance of AI coding tools; architecture, prompt design, guardrails
and the optimizer formulation are the team's own work.

---

## Secret handling

- No key, token, or credential is committed. `.gitignore` excludes all `.env*`
  files with a single exception for `.env.example`, which holds variable **names**
  with empty values.
- No secret, provider error body, or stack trace ever appears in an API
  response. Failures return `{"error": "..."}` with a generic message; details
  are logged server-side only, truncated, and never include note text or keys.
- The Docker image contains no credentials; they are injected at runtime.

---

## Known limitations

- **Interpretation depends on a hosted model.** If OpenAI is unreachable and no
  Gemini key is configured, every note degrades to `no_op`. The response stays
  schema-valid and the schedule stays valid under base energy rules, but
  directive credit for that case is lost.
- **Rate limiting under burst load.** Firing ~50 requests back to back can push
  individual calls past the interpretation budget. Configuring `GEMINI_API_KEY`
  enables failover, and `LLM_TIMEOUT_MS` can be raised if the judging harness
  bursts harder than expected.
- **`through` is treated as end-exclusive**, the same as `to` and `until`. The
  Problem Statement states one uniform convention and never uses `through` for a
  time window, so we follow the stated rule rather than English convention.
- **Infeasible directive sets** produce a valid-but-relaxed schedule rather than
  an error. Organizer scoring scenarios are guaranteed feasible, so this path
  should not trigger during judging.
- The solar-versus-grid preference is only exercised when a tariff is zero;
  otherwise the LP already prefers free solar.
