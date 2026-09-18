/**
 * Lists the models each configured provider actually exposes on this account.
 *
 * Model ids move faster than documentation, and a stale id fails at request
 * time rather than at boot. Run this before pinning LLM_MODEL:
 *
 *   npm run models            # both providers
 *   npm run models -- gemini  # one provider
 *
 * Reads keys from .env.local via --env-file and never prints them.
 */

const wanted = process.argv.slice(2).map((a) => a.toLowerCase())
const shouldRun = (id) => wanted.length === 0 || wanted.includes(id)

async function listOpenAi() {
  const key = process.env.OPENAI_API_KEY
  if (!key) return console.log("openai:  OPENAI_API_KEY not set, skipped\n")
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!res.ok) {
    return console.log(`openai:  HTTP ${res.status} - check OPENAI_API_KEY\n`)
  }
  const body = await res.json()
  const ids = body.data
    .map((m) => m.id)
    .filter(
      (id) => /^(gpt|o[0-9])/.test(id) && !/(audio|image|realtime|transcribe|tts|search)/.test(id),
    )
    .sort()
  console.log(`openai:  ${ids.length} text models`)
  console.log(ids.map((id) => `  ${id}`).join("\n"))
  console.log()
}

async function listGemini() {
  const key = process.env.GEMINI_API_KEY
  if (!key) return console.log("gemini:  GEMINI_API_KEY not set, skipped\n")
  // Key goes in a header, never the query string.
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": key },
  })
  if (!res.ok) {
    console.log(`gemini:  HTTP ${res.status} - check GEMINI_API_KEY`)
    console.log("         An AI Studio key starts with 'AIza'. Get one at")
    console.log("         https://aistudio.google.com/apikey\n")
    return
  }
  const body = await res.json()
  const ids = (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => m.name.replace("models/", ""))
    .sort()
  console.log(`gemini:  ${ids.length} generateContent models`)
  console.log(ids.map((id) => `  ${id}`).join("\n"))
  console.log()
}

if (shouldRun("openai")) await listOpenAi()
if (shouldRun("gemini")) await listGemini()
