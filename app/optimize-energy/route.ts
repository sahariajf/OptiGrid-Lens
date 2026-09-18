import { NextResponse } from "next/server"
import { runPipeline } from "@/lib/pipeline"

/**
 * The judged endpoint.
 *
 * Status codes follow Section 6.1: 400 for a body that is not usable, 200 for a
 * scenario we could schedule, 500 only for something genuinely unexpected. No
 * response ever carries a stack trace, provider message, or configuration
 * value.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Headroom under the harness's 30s per-request limit; the interpretation call
// has its own, shorter abort so we degrade before we get here.
export const maxDuration = 60

export async function POST(request: Request) {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid request: body is not valid JSON" }, { status: 400 })
  }

  try {
    const { status, body } = await runPipeline(payload)
    return NextResponse.json(body, { status })
  } catch (error) {
    // Logged in full server-side, reported generically to the caller.
    console.error("shakti", JSON.stringify({ fatal: String(error).slice(0, 200) }))
    return NextResponse.json({ error: "internal error" }, { status: 500 })
  }
}
