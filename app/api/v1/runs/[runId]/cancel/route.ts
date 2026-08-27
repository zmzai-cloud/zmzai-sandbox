import { NextResponse } from "next/server";

import { abortSandboxRun, sandboxCaller } from "@/lib/sandbox-api";
import { abortExecRun } from "@/lib/exec-api";
import { cancelRun, getRunForSandboxKey } from "@/lib/sandbox-store";
import { persistedRun, requestPersistedCancellation } from "@/lib/persistent-runs";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await sandboxCaller(request).catch(() => null);
  if (!caller) return NextResponse.json({ code: "SANDBOX_KEY_INVALID", error: "Sandbox key 无效或已撤销" }, { status: 401 });
  const { runId } = await params;
  const run = getRunForSandboxKey(runId, caller.keyId) ?? await persistedRun(runId, caller.keyId).catch(() => undefined);
  if (!run) return NextResponse.json({ code: "RUN_NOT_FOUND", error: "运行不存在" }, { status: 404 });
  abortSandboxRun(runId);
  abortExecRun(runId);
  const cancelled = cancelRun(runId) ?? await requestPersistedCancellation(runId, caller.keyId) ?? run;
  return NextResponse.json({ run: cancelled }, { status: ["succeeded", "failed", "cancelled"].includes(cancelled.status) ? 200 : 202 });
}
