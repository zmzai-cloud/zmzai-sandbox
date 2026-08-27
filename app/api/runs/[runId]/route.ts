import { NextResponse } from "next/server";
import { persistedRun } from "@/lib/persistent-runs";
import { getSessionUser } from "@/lib/relay-client";
import type { SandboxRun } from "@/lib/sandbox-types";
import { getRun } from "@/lib/sandbox-store";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ runId: string }> }) {
  const user = await getSessionUser(_).catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { runId } = await params;
  const live = getRun(runId, user.id);
  if (live) return NextResponse.json({ run: live });
  // Fall back to the persisted archive (read-only: artifact bytes are gone).
  const archived = await persistedRun(runId)
    .then((run) => (run && run.userId === user.id ? ({ ...run, archived: true } satisfies SandboxRun) : null))
    .catch(() => null);
  if (!archived) return NextResponse.json({ error: "运行不存在" }, { status: 404 });
  return NextResponse.json({ run: archived });
}
