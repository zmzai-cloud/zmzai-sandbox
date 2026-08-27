import { NextResponse } from "next/server";

import { executeExecRun, idempotentExecRun, readExecInput } from "@/lib/exec-api";
import { sandboxCaller } from "@/lib/sandbox-api";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const caller = await sandboxCaller(request).catch(() => null);
  if (!caller) return NextResponse.json({ code: "SANDBOX_KEY_INVALID", error: "Sandbox key 无效或已撤销" }, { status: 401 });
  const input = readExecInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ code: "INVALID_BODY", error: "需要 language（javascript/python/shell）与 code（1-12000 字符）；可选 timeoutMs（1000-60000）、inputFiles（总量不超过 1 MiB）与 limits" }, { status: 400 });
  const result = await idempotentExecRun(caller, request.headers.get("idempotency-key"), input);
  if ("error" in result) {
    const message = result.error ?? "创建运行失败";
    const concurrency = message.includes("运行中") || message.includes("并发");
    return NextResponse.json({ code: concurrency ? "RATE_LIMITED" : request.headers.get("idempotency-key") ? "IDEMPOTENCY_CONFLICT" : "INVALID_IDEMPOTENCY_KEY", error: message }, { status: concurrency ? 429 : request.headers.get("idempotency-key") ? 409 : 400, headers: concurrency ? { "Retry-After": "15" } : undefined });
  }
  if (!result.replayed) executeExecRun(result.run.id, caller.keyId, input);
  return NextResponse.json({ run: result.run }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
