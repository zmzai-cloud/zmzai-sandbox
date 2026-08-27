import { sandboxCaller } from "@/lib/sandbox-api";
import { getRunArtifact } from "@/lib/artifact-store";
import { persistedRun } from "@/lib/persistent-runs";
import { getRunForSandboxKey } from "@/lib/sandbox-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxArtifactFileBytes = 20 * 1024 * 1024;

export async function GET(request: Request, context: { params: Promise<{ runId: string; path: string[] }> }) {
  const caller = await sandboxCaller(request).catch(() => null);
  if (!caller) return new Response(null, { status: 401 });
  const { runId, path } = await context.params;
  const artifactPath = (path ?? []).join("/");
  if (!artifactPath) return new Response(null, { status: 404 });

  const run = getRunForSandboxKey(runId, caller.keyId) ?? (await persistedRun(runId, caller.keyId).catch(() => undefined));
  if (!run) return new Response(null, { status: 404 });
  // Path whitelist: only paths declared in the run's deliverables manifest.
  const entry = (run.deliverables ?? []).find((item) => item.path === artifactPath);
  if (!entry || entry.tooLarge || entry.bytes > maxArtifactFileBytes) return new Response(null, { status: 404 });

  const artifact = getRunArtifact(runId, artifactPath);
  if (!artifact || artifact.content.length !== entry.bytes || artifact.sha256 !== entry.sha256) {
    // Bytes lost (e.g. service restart) or tampered — treat as unavailable.
    return new Response(null, { status: 404 });
  }
  const filename = artifactPath.split("/").pop() ?? "artifact";
  return new Response(new Uint8Array(artifact.content), {
    status: 200,
    headers: {
      "Content-Type": entry.contentType,
      "Content-Length": String(artifact.content.length),
      "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
