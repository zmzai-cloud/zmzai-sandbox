import type { CreateAgentRunInput, CreateRunInput, RunEvent, RunEventKind, RunStatus, SandboxArtifactMeta, SandboxRun } from "./sandbox-types";
import { persistRun } from "./persistent-runs";

type Store = Map<string, SandboxRun>;

const globalStore = globalThis as typeof globalThis & { __zmzaiSandboxRuns?: Store };
const runs: Store = globalStore.__zmzaiSandboxRuns ?? new Map();
globalStore.__zmzaiSandboxRuns = runs;

function now() {
  return new Date().toISOString();
}

function event(sequence: number, kind: RunEventKind, message: string): RunEvent {
  return { id: crypto.randomUUID(), sequence, at: now(), kind, message };
}

function addEvent(run: SandboxRun, kind: RunEventKind, message: string) {
  const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
  run.events.push(event(sequence, kind, message));
}

export function listRuns(userId: string) {
  return [...runs.values()].filter((run) => run.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getRun(runId: string, userId?: string) {
  const run = runs.get(runId);
  return run && (!userId || run.userId === userId) ? run : undefined;
}

export function getRunForSandboxKey(runId: string, sandboxKeyId: string) {
  const run = runs.get(runId);
  return run?.ownerSandboxKeyId === sandboxKeyId ? run : undefined;
}

export function createRun(input: CreateRunInput & Partial<Pick<CreateAgentRunInput, "taskRunId" | "requestId" | "snapshot" | "command" | "limits">>, id = `run_${crypto.randomUUID().slice(0, 8)}`) {
  const run: SandboxRun = {
    id,
    userId: input.userId,
    ownerSandboxKeyId: input.ownerSandboxKeyId,
    task: input.task,
    model: input.model,
    status: "queued",
    createdAt: now(),
    provider: process.env.OPEN_SANDBOX_URL ? "opensandbox" : "demo",
    events: [event(1, "system", "任务已进入沙箱队列")],
    artifacts: [],
    ...(input.taskRunId ? { taskRunId: input.taskRunId, requestId: input.requestId } : {}),
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
  };
  runs.set(run.id, run);
  void persistRun(run).catch((error) => console.error("persist sandbox run", error));
  return run;
}

export function updateRun(runId: string, status: RunStatus, message?: string, exitCode?: number) {
  const run = runs.get(runId);
  if (!run) return undefined;

  if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
  if (run.status === "cancellation_requested" && status !== "cancelled") return run;

  run.status = status;
  if (["planning", "running"].includes(status) && !run.startedAt) run.startedAt = now();
  if (["succeeded", "failed", "cancelled"].includes(status)) {
    run.finishedAt = now();
    run.exitCode = exitCode;
  }
  if (message) addEvent(run, status === "failed" ? "stderr" : ["planning", "running"].includes(status) ? "stdout" : "status", message);
  void persistRun(run).catch((error) => console.error("persist sandbox run", error));
  return run;
}

export function appendRunEvent(runId: string, kind: RunEvent["kind"], message: string, data?: unknown) {
  const run = runs.get(runId);
  if (!run) return undefined;
  addEvent(run, kind, message);
  if (data !== undefined) run.events.at(-1)!.data = data;
  void persistRun(run).catch((error) => console.error("persist sandbox run", error));
  return run;
}

/** Records the deliverables manifest on the run (metadata only). */
export function setRunDeliverables(runId: string, deliverables: SandboxArtifactMeta[]) {
  const run = runs.get(runId);
  if (!run) return undefined;
  run.deliverables = deliverables;
  void persistRun(run).catch((error) => console.error("persist sandbox run", error));
  return run;
}

export function setRunProviderSandbox(runId: string, providerSandboxId: string) {
  const run = runs.get(runId);
  if (!run) return undefined;
  run.providerSandboxId = providerSandboxId;
  void persistRun(run).catch((error) => console.error("persist sandbox run", error));
  return run;
}

export function addArtifact(runId: string, name: string) {
  const run = runs.get(runId);
  if (!run) return undefined;
  run.artifacts.push(name);
  addEvent(run, "artifact", `产物已生成：${name}`);
  void persistRun(run).catch((error) => console.error("persist sandbox run", error));
  return run;
}

export function cancelRun(runId: string) {
  const run = runs.get(runId);
  if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) return run;
  return updateRun(runId, "cancellation_requested", "正在取消并清理沙箱");
}

export function startDemoRun(runId: string) {
  const run = runs.get(runId);
  if (!run) return;

  updateRun(runId, "running", "Sandbox Runner 已分配临时执行环境");
  const steps = [
    [500, "读取 Workspace 快照"],
    [1200, "启动 Node.js + TypeScript 执行镜像"],
    [2100, "执行任务脚本"],
    [3000, "收集 stdout、stderr 和产物"],
  ] as const;

  for (const [delay, message] of steps) {
    setTimeout(() => {
      const current = runs.get(runId);
      if (!current || ["succeeded", "failed", "cancelled"].includes(current.status)) return;
      appendRunEvent(runId, "stdout", message);
    }, delay);
  }

  setTimeout(() => {
    const current = runs.get(runId);
    if (!current || current.status === "cancelled") return;
    addArtifact(runId, "task-report.md");
    updateRun(runId, "succeeded", "任务完成，沙箱已清理", 0);
  }, 3900);
}
