import { setRunArtifacts } from "@/lib/artifact-store";
import { setRunDeliverables } from "@/lib/sandbox-store";
import type { SandboxArtifactData } from "@/lib/sandbox-types";

/** Records collected artifacts: manifest on the run + bytes in the cache.
 *  Shared by the internal agent executor, the consumer run executor and the
 *  direct exec executor so deliverable semantics stay identical. */
export function recordDeliverables(runId: string, artifacts: SandboxArtifactData[]): void {
  if (!artifacts.length) return;
  setRunArtifacts(runId, artifacts);
  setRunDeliverables(runId, artifacts.map(({ content: _content, ...meta }) => meta));
}
