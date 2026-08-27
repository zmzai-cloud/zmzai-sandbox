import { createHash, randomUUID } from "node:crypto";

import { imageForAgent } from "@/lib/agent-planner";
import { recordDeliverables } from "@/lib/deliverables";
import { deleteOpenSandbox, findOpenSandboxes, runAgentSandboxCommand } from "@/lib/opensandbox-provider";
import { activeRunCount, claimSubmission, existingSubmission, heartbeatExecutionLease, persistedRun, recoverExpiredExecutions, releaseExecutionLease, startExecutionLease } from "@/lib/persistent-runs";
import type { SandboxCaller } from "@/lib/relay-client";
import { appendRunEvent, createRun, getRun, updateRun } from "@/lib/sandbox-store";

const globalExecutions = globalThis as typeof globalThis & { __zmzaiSandboxExecRuns?: Map<string, AbortController> };
const executions = globalExecutions.__zmzaiSandboxExecRuns ?? new Map<string, AbortController>();
globalExecutions.__zmzaiSandboxExecRuns = executions;

/** Direct structured execution: run code in a temp sandbox without any LLM
 *  planning. Reuses the run record so GET /events /cancel /artifacts work. */
export type ExecInput = {
  language: "javascript" | "python" | "shell";
  code: string;
  timeoutMs: number;
  inputFiles: Array<{ path: string; content: string }>;
  limits?: { cpuMillis?: number; memoryMiB?: number };
};

const execLanguages = ["javascript", "python", "shell"] as const;
const maxSnapshotBytes = 1024 * 1024;
const maxSnapshotFiles = 50;

function validSnapshotPath(path: string) {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0");
}

export function readExecInput(body: unknown): ExecInput | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const language = value.language;
  if (typeof language !== "string" || !(execLanguages as readonly string[]).includes(language)) return null;
  const code = value.code;
  if (typeof code !== "string" || code.trim().length === 0 || code.length > 12_000) return null;
  const timeoutMs = value.timeoutMs === undefined ? 30_000 : value.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) return null;
  let limits: ExecInput["limits"];
  if (value.limits !== undefined) {
    if (!value.limits || typeof value.limits !== "object") return null;
    const raw = value.limits as Record<string, unknown>;
    if (raw.cpuMillis !== undefined && (typeof raw.cpuMillis !== "number" || !Number.isFinite(raw.cpuMillis) || raw.cpuMillis < 100 || raw.cpuMillis > 4_000)) return null;
    if (raw.memoryMiB !== undefined && (typeof raw.memoryMiB !== "number" || !Number.isFinite(raw.memoryMiB) || raw.memoryMiB < 128 || raw.memoryMiB > 2_048)) return null;
    limits = { cpuMillis: raw.cpuMillis, memoryMiB: raw.memoryMiB };
  }
  const inputFiles: Array<{ path: string; content: string }> = [];
  if (value.inputFiles !== undefined) {
    if (!Array.isArray(value.inputFiles) || value.inputFiles.length > maxSnapshotFiles) return null;
    let totalBytes = 0;
    for (const item of value.inputFiles) {
      const file = item as { path?: unknown; content?: unknown } | null;
      if (!file || typeof file.path !== "string" || typeof file.content !== "string") return null;
      if (!validSnapshotPath(file.path)) return null;
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > maxSnapshotBytes) return null;
      totalBytes += bytes;
      inputFiles.push({ path: file.path, content: file.content });
    }
    if (totalBytes > maxSnapshotBytes) return null;
  }
  return { language: language as ExecInput["language"], code, timeoutMs: Math.round(timeoutMs), inputFiles, limits };
}

export function execCommand(input: ExecInput): { program: string; args: string[] } {
  if (input.language === "shell") return { program: "sh", args: ["-c", input.code] };
  return input.language === "python" ? { program: "python3", args: ["-c", input.code] } : { program: "node", args: ["-e", input.code] };
}

export function createExecRun(caller: SandboxCaller, input: ExecInput, runId: string) {
  const command = execCommand(input);
  const title = input.code.trim().split("\n")[0]?.trim().slice(0, 120) || "直接执行代码";
  return createRun(
    {
      userId: caller.userId,
      ownerSandboxKeyId: caller.keyId,
      task: `Exec · ${title}`,
      model: "direct",
      command,
      limits: { timeoutMs: input.timeoutMs, cpuMillis: input.limits?.cpuMillis, memoryMiB: input.limits?.memoryMiB },
    },
    runId,
  );
}

export async function idempotentExecRun(caller: SandboxCaller, idempotencyKey: string | null, input: ExecInput) {
  if (!idempotencyKey || !/^[\x21-\x7e]{16,128}$/.test(idempotencyKey)) return { error: "Idempotency-Key 必须是 16 到 128 个可打印字符" } as const;
  const fingerprint = inputFingerprint(input);
  await recoverExpiredExecutions(deleteOpenSandbox, findOpenSandboxes).catch(() => undefined);
  const existing = await existingSubmission(caller.keyId, idempotencyKey);
  if (existing) {
    if (existing.requestHash !== fingerprint) return { error: "同一 Idempotency-Key 不能对应不同请求" } as const;
    const run = await persistedRun(existing.runId, caller.keyId);
    return run ? { run, replayed: true } as const : { error: "该请求正在恢复，请稍后查询 runId" } as const;
  }
  const [keyActive, totalActive] = await Promise.all([activeRunCount(caller.keyId), activeRunCount()]);
  if (keyActive >= 1) return { error: "当前 sandbox_key 已有运行中的任务" } as const;
  if (totalActive >= 3) return { error: "Sandbox 当前并发已满，请稍后重试" } as const;
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const claimed = await claimSubmission(caller.keyId, idempotencyKey, fingerprint, runId);
  if ("conflict" in claimed) return { error: "同一 Idempotency-Key 不能对应不同请求" } as const;
  if (!claimed.created) {
    const run = await persistedRun(claimed.runId, caller.keyId);
    return run ? { run, replayed: true } as const : { error: "该请求正在恢复，请稍后查询 runId" } as const;
  }
  return { run: createExecRun(caller, input, runId), replayed: false } as const;
}

/** Stable fingerprint over the exec payload (order-sensitive for inputFiles,
 *  which is intentional: file order affects the sandbox workdir). */
export function inputFingerprint(input: ExecInput) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function executeExecRun(runId: string, ownerSandboxKeyId: string, input: ExecInput) {
  const controller = new AbortController();
  const executionId = randomUUID();
  executions.set(runId, controller);
  void (async () => {
    const heartbeat = setInterval(() => { void heartbeatExecutionLease(runId, executionId).catch(() => undefined); }, 20_000);
    try {
      if (!(await startExecutionLease(runId, ownerSandboxKeyId, executionId))) throw new Error("Sandbox 当前并发已满，请稍后重试");
      updateRun(runId, "running", `正在启动隔离沙箱执行 ${input.language} 代码`);
      const command = execCommand(input);
      const result = await runAgentSandboxCommand({
        files: input.inputFiles,
        program: command.program,
        args: command.args,
        image: imageForAgent({ language: input.language, code: input.code, timeoutMs: input.timeoutMs }),
        timeoutMs: input.timeoutMs,
        cpuMillis: input.limits?.cpuMillis,
        memoryMiB: input.limits?.memoryMiB,
        signal: controller.signal,
        onLine: (kind, text) => appendRunEvent(runId, kind, text),
        collectArtifacts: true,
        inputFiles: input.inputFiles,
      });
      if (controller.signal.aborted || getRun(runId)?.status === "cancelled") {
        appendRunEvent(runId, "sandbox.failed", "执行已取消并清理");
        updateRun(runId, "cancelled", "沙箱执行已取消并清理");
        return;
      }
      if (result.exitCode !== 0) {
        updateRun(runId, "failed", `代码执行失败（退出码 ${result.exitCode}）`, result.exitCode);
        return;
      }
      recordDeliverables(runId, result.artifacts);
      if (result.artifacts.length) appendRunEvent(runId, "artifact", `产物 ${result.artifacts.length} 个：${result.artifacts.map((item) => item.path).join("、")}`, { artifacts: result.artifacts.map(({ content: _content, ...meta }) => meta) });
      updateRun(runId, "succeeded", "代码执行完成，临时环境已清理", 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : "代码执行失败";
      updateRun(runId, controller.signal.aborted ? "cancelled" : "failed", controller.signal.aborted ? "沙箱执行已取消并清理" : message, controller.signal.aborted ? undefined : 1);
    } finally {
      clearInterval(heartbeat);
      executions.delete(runId);
      await releaseExecutionLease(runId, executionId).catch(() => undefined);
    }
  })();
}

export function abortExecRun(runId: string) {
  executions.get(runId)?.abort();
}
