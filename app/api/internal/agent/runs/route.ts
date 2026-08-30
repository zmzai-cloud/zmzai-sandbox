import { NextResponse } from "next/server";

import { agentCaller } from "@/lib/agent-auth";
import { idempotentAgentRun, readAgentRunInput, startAgentExecution } from "@/lib/agent-api";
import { persistedRuns } from "@/lib/persistent-runs";
import { listRuns } from "@/lib/sandbox-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!agentCaller(request)) return NextResponse.json({ code: "UNAUTHORIZED", error: "服务认证失败" }, { status: 401 });
  const parsed = readAgentRunInput(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ code: "INVALID_BODY", error: parsed.error }, { status: 400 });

  const result = await idempotentAgentRun(parsed.input);
  if ("error" in result) {
    const concurrency = result.status === 429;
    return NextResponse.json({ code: result.code, error: result.error }, { status: result.status, headers: concurrency ? { "Retry-After": "15" } : undefined });
  }
  startAgentExecution(result.run.id, result.replayed, request.headers.get("x-trace-id"));
  return NextResponse.json({ run: result.run }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  if (!agentCaller(request)) return NextResponse.json({ code: "UNAUTHORIZED", error: "服务认证失败" }, { status: 401 });
  const userId = new URL(request.url).searchParams.get("userId") ?? undefined;
  const runs = await persistedRuns(userId ?? "", undefined).catch(() => listRuns(userId ?? ""));
  const agentRuns = runs.filter((run) => run.taskRunId);
  return NextResponse.json({ runs: agentRuns }, { headers: { "Cache-Control": "no-store" } });
}
