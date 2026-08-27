import { NextResponse } from "next/server";

import { getSessionUser, relaySessionRequest } from "@/lib/relay-client";
import { keyUsageStats } from "@/lib/persistent-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RelayKey = { id: string; prefix: string; name: string; status: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

export async function GET(request: Request) {
  if (!(await getSessionUser(request))) return NextResponse.json({ code: "UNAUTHENTICATED", error: "请先登录" }, { status: 401 });
  const response = await relaySessionRequest(request, "/api/me/sandbox-keys");
  const contentType = response.headers.get("content-type") ?? "application/json";
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { "content-type": contentType, "cache-control": "no-store" } });
  const body = (await response.json().catch(() => null)) as { keys?: RelayKey[] } | null;
  if (!body?.keys) return new Response(JSON.stringify(body ?? {}), { status: response.status, headers: { "content-type": contentType, "cache-control": "no-store" } });
  // Enrich with per-key run usage from the Sandbox's own run history.
  const usage = await keyUsageStats().catch(() => new Map<string, { runCount: number; lastRunAt: string | null }>());
  const keys = body.keys.map((key) => ({ ...key, runCount: usage.get(key.id)?.runCount ?? 0, lastRunAt: usage.get(key.id)?.lastRunAt ?? null }));
  return NextResponse.json({ keys }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!(await getSessionUser(request))) return NextResponse.json({ code: "UNAUTHENTICATED", error: "请先登录" }, { status: 401 });
  const response = await relaySessionRequest(request, "/api/me/sandbox-keys", { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() });
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
}
