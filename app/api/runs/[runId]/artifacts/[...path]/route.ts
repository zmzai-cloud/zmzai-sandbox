import { NextResponse } from "next/server";

import { getRunArtifact } from "@/lib/artifact-store";
import { getSessionUser } from "@/lib/relay-client";
import { getRun } from "@/lib/sandbox-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxArtifactFileBytes = 20 * 1024 * 1024;

/** Console artifact endpoint. Returns the bytes inline by default (for
 *  preview); `?download=1` switches to an attachment response. */
export async function GET(request: Request, context: { params: Promise<{ runId: string; path: string[] }> }) {
  const user = await getSessionUser(request).catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { runId, path } = await context.params;
  const artifactPath = (path ?? []).join("/");
  if (!artifactPath) return NextResponse.json({ error: "产物不存在" }, { status: 404 });

  const run = getRun(runId, user.id);
  if (!run) return NextResponse.json({ error: "运行不存在或已归档" }, { status: 404 });
  // Path whitelist: only paths declared in the run's deliverables manifest.
  const entry = (run.deliverables ?? []).find((item) => item.path === artifactPath);
  if (!entry || entry.tooLarge || entry.bytes > maxArtifactFileBytes) return NextResponse.json({ error: "产物不可用" }, { status: 404 });

  const artifact = getRunArtifact(runId, artifactPath);
  if (!artifact || artifact.content.length !== entry.bytes || artifact.sha256 !== entry.sha256) {
    return NextResponse.json({ error: "产物不可用" }, { status: 404 });
  }

  const filename = artifactPath.split("/").pop() ?? "artifact";
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new Response(new Uint8Array(artifact.content), {
    status: 200,
    headers: {
      "Content-Type": entry.contentType,
      "Content-Length": String(artifact.content.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
