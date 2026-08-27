import { NextResponse } from "next/server";

import { executeSandboxRun, idempotentRun, readRunInput, sandboxCaller } from "@/lib/sandbox-api";
import { createRun, listRuns } from "@/lib/sandbox-store";
import { persistedRuns } from "@/lib/persistent-runs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const caller = await sandboxCaller(request).catch(() => null);
  if (!caller) return NextResponse.json({ code: "SANDBOX_KEY_INVALID", error: "Sandbox key 无效或已撤销" }, { status: 401 });
  const input = readRunInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ code: "INVALID_BODY", error: "task 需要 3 到 2000 个字符，且必须选择模型" }, { status: 400 });
  const result = await idempotentRun(caller, request.headers.get("idempotency-key"), input, (runId) => createRun({ task: input.task, model: input.model, userId: caller.userId, ownerSandboxKeyId: caller.keyId }, runId));
  if ("error" in result) {
    const message = result.error ?? "创建运行失败";
    const concurrency = message.includes("运行中") || message.includes("并发");
    return NextResponse.json({ code: concurrency ? "RATE_LIMITED" : request.headers.get("idempotency-key") ? "IDEMPOTENCY_CONFLICT" : "INVALID_IDEMPOTENCY_KEY", error: message }, { status: concurrency ? 429 : request.headers.get("idempotency-key") ? 409 : 400, headers: concurrency ? { "Retry-After": "15" } : undefined });
  }
  if (!result.replayed) executeSandboxRun(result.run.id, caller.keyId, request.headers.get("authorization")!.slice(7).trim(), input);
  return NextResponse.json({ run: result.run }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const caller = await sandboxCaller(request).catch(() => null);
  if (!caller) return NextResponse.json({ code: "SANDBOX_KEY_INVALID", error: "Sandbox key 无效或已撤销" }, { status: 401 });
  const runs = await persistedRuns(caller.userId, caller.keyId).catch(() => listRuns(caller.userId).filter((run) => run.ownerSandboxKeyId === caller.keyId));
  return NextResponse.json({ runs });
}
