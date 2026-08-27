export type RunStatus = "queued" | "planning" | "running" | "cancellation_requested" | "cleanup_pending" | "succeeded" | "failed" | "cancelled";

export type RunEventKind = "system" | "stdout" | "stderr" | "status" | "artifact" | "sandbox.started" | "sandbox.output" | "sandbox.completed" | "sandbox.failed";

export type RunEvent = {
  id: string;
  sequence: number;
  at: string;
  kind: RunEventKind;
  message: string;
  /** Optional structured payload (e.g. sandbox.completed -> deliverables manifest). */
  data?: unknown;
};

export type SandboxSnapshotFile = { path: string; content: string };
export type SandboxSnapshot = { revisionId: string | null; files: SandboxSnapshotFile[] };
export type SandboxCommand = { program: string; args: string[]; cwd?: string; envs?: Record<string, string> };
export type SandboxLimits = { timeoutMs?: number; cpuMillis?: number; memoryMiB?: number };

/** Metadata of a deliverable produced inside the sandbox workdir. */
export type SandboxArtifactMeta = {
  path: string;
  bytes: number;
  contentType: string;
  sha256: string;
  tooLarge: boolean;
};

/** Full artifact data returned by the provider before the sandbox is deleted. */
export type SandboxArtifactData = SandboxArtifactMeta & { content: Buffer };

export const maxArtifactFileBytes = 20 * 1024 * 1024;
export const maxArtifactCount = 50;
export const maxArtifactTotalBytes = 100 * 1024 * 1024;

export type SandboxRun = {
  id: string;
  userId: string;
  ownerSandboxKeyId?: string;
  task: string;
  model: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  failure?: { code: string; error: string; retryable: boolean };
  provider: "demo" | "opensandbox";
  events: RunEvent[];
  artifacts: string[];
  // Internal agent runs (from a.zmzai.cloud exec tool) carry these fields.
  taskRunId?: string;
  requestId?: string;
  snapshot?: SandboxSnapshot;
  command?: SandboxCommand;
  limits?: SandboxLimits;
  /** OpenSandbox ID while a real provider run is active. Internal only. */
  providerSandboxId?: string;
  /** Deliverables manifest produced by the run (metadata only; bytes are cached
   *  separately in the in-memory artifact store, never persisted to Mongo). */
  deliverables?: SandboxArtifactMeta[];
  /** Set when a run is served from the Mongo archive instead of the live
   *  in-process store (read-only: no cancel, no artifact bytes). */
  archived?: boolean;
};

export type CreateRunInput = {
  userId: string;
  ownerSandboxKeyId?: string;
  task: string;
  model: string;
};

export type CreateAgentRunInput = {
  userId: string;
  taskRunId: string;
  requestId: string;
  snapshot: SandboxSnapshot;
  command: SandboxCommand;
  limits?: SandboxLimits;
};
