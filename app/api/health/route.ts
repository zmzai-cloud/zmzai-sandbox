import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health — 状态页探针目标（zmzai-status 轮询）。 */
export async function GET() {
  return NextResponse.json(
    { ok: true, deps: {} },
    { headers: { "Cache-Control": "no-store" } },
  );
}
