import { createHash } from "node:crypto";

import { setRunArtifacts } from "@/lib/artifact-store";
import { deleteOpenSandbox, runAgentSandboxCommand } from "@/lib/opensandbox-provider";
import { appendRunEvent, createRun, getRun, setRunDeliverables, setRunProviderSandbox, updateRun } from "@/lib/sandbox-store";
import { runBindTrace, runEndSpan } from "@/lib/telemetry";
import type { CreateAgentRunInput, SandboxArtifactData } from "@/lib/sandbox-types";

const globalExecutions = globalThis as typeof globalThis & { __zmzaiAgentSandboxExecutions?: Map<string, AbortController> };
const executions = globalExecutions.__zmzaiAgentSandboxExecutions ?? new Map<string, AbortController>();
globalExecutions.__zmzaiAgentSandboxExecutions = executions;

export function createAgentRunRecord(input: CreateAgentRunInput, id: string) {
  return createRun(
    {
      userId: input.userId,
      task: `Agent 执行：${input.command.program} ${input.command.args.join(" ")}`,
      model: "agent",
      taskRunId: input.taskRunId,
      requestId: input.requestId,
      snapshot: input.snapshot,
      command: input.command,
      limits: input.limits,
    },
    id,
  );
}

/** Records collected artifacts: manifest on the run + bytes in the cache. */
function recordDeliverables(runId: string, artifacts: SandboxArtifactData[]): void {
  if (!artifacts.length) return;
  setRunArtifacts(runId, artifacts);
  setRunDeliverables(runId, artifacts.map(({ content: _content, ...meta }) => meta));
}

/**
 * Executes an internal agent run: creates the sandbox, writes the snapshot,
 * runs the command, and streams `sandbox.*` events into the run store.
 * On success, deliverables (files new or changed vs the snapshot) are read
 * back and made available via the internal artifacts endpoints.
 * With no OPEN_SANDBOX_URL configured the provider is "demo" and the run is
 * simulated so the agent integration can be developed end-to-end locally.
 */
export async function executeAgentRun(runId: string, traceId?: string | null): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  // 埋点：绑定 run 的 trace（agent 入口透传或新生成）；终态时发 span.closed（内部吞错，绝不影响执行）
  runBindTrace(runId, traceId);
  const input = run.taskRunId && run.requestId && run.snapshot && run.command ? { userId: run.userId, taskRunId: run.taskRunId, requestId: run.requestId, snapshot: run.snapshot, command: run.command, limits: run.limits } : null;
  if (!input) {
    updateRun(runId, "failed", "内部运行缺少执行参数");
    runEndSpan(runId, "error");
    return;
  }
  try {
    updateRun(runId, "running", "已接收执行请求，正在准备隔离沙箱");
    appendRunEvent(runId, "sandbox.started", `开始执行 ${input.command.program} ${input.command.args.join(" ")}`);
    if (run.provider === "demo") {
      updateRun(runId, "running", `Demo Sandbox：载入 ${input.snapshot.files.length} 个快照文件（${input.snapshot.revisionId ?? "草稿"}）`);
      const summary = input.snapshot.files.slice(0, 5).map((file) => file.path).join("、");
      appendRunEvent(runId, "sandbox.output", `快照文件：${summary}${input.snapshot.files.length > 5 ? ` 等 ${input.snapshot.files.length} 个` : ""}`);
      appendRunEvent(runId, "sandbox.output", `模拟执行：${input.command.program} ${input.command.args.join(" ")}`);
      // Demo deliverable so the full pull -> GridFS -> download chain works offline.
      const demoText = [
        `demo artifact for run ${runId}`,
        `command: ${input.command.program} ${input.command.args.join(" ")}`,
        `snapshot files: ${input.snapshot.files.length}`,
      ].join("\n");
      const demoArtifact: SandboxArtifactData = {
        path: "demo-output.txt",
        bytes: Buffer.byteLength(demoText, "utf8"),
        contentType: "text/plain",
        sha256: createHash("sha256").update(demoText).digest("hex"),
        tooLarge: false,
        content: Buffer.from(demoText, "utf8"),
      };
      recordDeliverables(runId, [demoArtifact]);
      const manifest = [{ path: demoArtifact.path, bytes: demoArtifact.bytes, contentType: demoArtifact.contentType, sha256: demoArtifact.sha256, tooLarge: false }];
      appendRunEvent(runId, "sandbox.completed", "Demo Sandbox 执行完成（未连接 OpenSandbox，未真实运行）", { artifacts: manifest });
      updateRun(runId, "succeeded", "Demo Sandbox 执行完成", 0);
      runEndSpan(runId, "ok", 0);
      return;
    }
    const limits = {
      timeoutMs: input.limits?.timeoutMs ?? 60000,
      cpuMillis: input.limits?.cpuMillis ?? 500,
      memoryMiB: input.limits?.memoryMiB ?? 512,
    };
    const result = await runAgentSandboxCommand({
      files: input.snapshot.files,
      program: input.command.program,
      args: input.command.args,
      cwd: input.command.cwd,
      envs: input.command.envs,
      timeoutMs: limits.timeoutMs,
      cpuMillis: limits.cpuMillis,
      memoryMiB: limits.memoryMiB,
      signal: executions.get(runId)?.signal,
      onSandboxCreated: async (sandboxId) => {
        setRunProviderSandbox(runId, sandboxId);
        const current = getRun(runId);
        if (current?.status === "cancellation_requested" || current?.status === "cancelled") {
          await deleteOpenSandbox(sandboxId).catch(() => undefined);
          throw new Error("执行已取消");
        }
      },
      onLine: (kind, text) => appendRunEvent(runId, "sandbox.output", text),
      collectArtifacts: true,
      inputFiles: input.snapshot.files,
    });
    const currentStatus = getRun(runId)?.status;
    const cancellationRequested = executions.get(runId)?.signal.aborted || currentStatus === "cancellation_requested" || currentStatus === "cancelled";
    if (cancellationRequested) {
      appendRunEvent(runId, "sandbox.failed", "执行已取消并清理");
      updateRun(runId, "cancelled", "沙箱执行已取消并清理");
      runEndSpan(runId, "error");
    } else if (result.exitCode === 0) {
      recordDeliverables(runId, result.artifacts);
      const manifest = result.artifacts.map(({ content: _content, ...meta }) => meta);
      appendRunEvent(runId, "sandbox.completed", `执行完成，退出码 ${result.exitCode}，临时环境已清理`, { artifacts: manifest });
      updateRun(runId, "succeeded", "沙箱执行完成，临时环境已清理", result.exitCode);
      runEndSpan(runId, "ok", result.exitCode);
    } else {
      appendRunEvent(runId, "sandbox.failed", `命令以退出码 ${result.exitCode} 结束`);
      updateRun(runId, "failed", `沙箱命令执行失败（退出码 ${result.exitCode}）`, result.exitCode);
      runEndSpan(runId, "error", result.exitCode);
    }
  } catch (error) {
    const status = getRun(runId)?.status;
    const cancelled = executions.get(runId)?.signal.aborted || status === "cancellation_requested" || status === "cancelled";
    if (cancelled) {
      appendRunEvent(runId, "sandbox.failed", "执行已取消并清理");
      updateRun(runId, "cancelled", "沙箱执行已取消并清理");
      runEndSpan(runId, "error");
    } else {
      const message = error instanceof Error ? error.message : "Agent 或沙箱执行失败";
      appendRunEvent(runId, "sandbox.failed", message);
      updateRun(runId, "failed", message, 1);
      runEndSpan(runId, "error", 1);
    }
  } finally {
    // Artifact bytes intentionally stay cached (in-memory) so the Agent can
    // pull deliverables after the run reaches a terminal state; the manifest
    // lives on the run record. The in-memory cache is process-lifetime and
    // bounded by per-run artifact caps.
    executions.delete(runId);
  }
}

export function executeAgentSandboxRun(runId: string, traceId?: string | null) {
  const controller = new AbortController();
  executions.set(runId, controller);
  void executeAgentRun(runId, traceId);
}

export function abortAgentRun(runId: string) {
  executions.get(runId)?.abort();
}
