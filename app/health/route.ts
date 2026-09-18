import { NextResponse } from "next/server"

/**
 * Readiness probe. Must answer 200 with {"status":"ok"} within 60s of start.
 *
 * Deliberately does no work: it touches neither the model provider nor the
 * solver, so it stays fast and cannot report unready because of an upstream
 * hiccup. It also doubles as the warm-up ping before a judging window.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json({ status: "ok" })
}
