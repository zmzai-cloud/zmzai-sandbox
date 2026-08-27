import { createHash, randomUUID } from "node:crypto";

import { commandForAgent, imageForAgent, maxPlanSteps, planNextSandboxStep, type AgentCommand, type PlannerTurn } from "@/lib/agent-planner";
import { recordDeliverables } from "@/lib/deliverables";
import { resolveSandboxCaller, type SandboxCaller } from "@/lib/relay-client";
import { deleteOpenSandbox, findOpenSandboxes, runAgentSandboxCommand } from "@/lib/opensandbox-provider";
import { appendRunEvent, getRun, updateRun } from "@/lib/sandbox-store";
import { activeRunCount, claimSubmission, existingSubmission, heartbeatExecutionLease, persistedRun, recordProviderSandbox, recoverExpiredExecutions, releaseExecutionLease, startExecutionLease } from "@/lib/persistent-runs";
import type { SandboxArtifactData, SandboxRun } from "@/lib/sandbox-types";

const globalExecutions = globalThis as typeof globalThis & { __zmzaiSandboxExecutions?: Map<string, AbortController> };
const executions = globalExecutions.__zmzaiSandboxExecutions ?? new Map<string, AbortController>();
globalExecutions.__zmzaiSandboxExecutions = executions;


export async function sandboxCaller(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(zsk_[A-Za-z0-9_-]+)$/);
  return match ? resolveSandboxCaller(match[1]) : null;
}

export function readRunInput(body: unknown) {
  const value = body as { task?: unknown; model?: unknown } | null;
  const task = typeof value?.task === "string" ? value.task.trim() : "";
  const model = typeof value?.model === "string" ? value.model.trim() : "";
  if (task.length < 3 || task.length > 2000 || !model) return null;
  return { task, model };
}

/** Claims an idempotency slot and creates the run via the caller-supplied
 *  factory (task runs use the default createRun shape; exec runs carry their
 *  own command/limits). */
export async function idempotentRun(caller: SandboxCaller, idempotencyKey: string | null, input: unknown, create: (runId: string) => SandboxRun) {
  if (!idempotencyKey || !/^[\x21-\x7e]{16,128}$/.test(idempotencyKey)) return { error: "Idempotency-Key 必须是 16 到 128 个可打印字符" } as const;
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
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
  return { run: create(runId), replayed: false } as const;
}

/** Text-only artifacts carry over between planning steps so later steps can
 *  read files produced by earlier ones; binary deliverables stay download-only. */
function carryOverFiles(files: Array<{ path: string; content: string }>, artifacts: SandboxArtifactData[]) {
  const carried = new Map(files.map((file) => [file.path, file]));
  for (const artifact of artifacts) {
    if (artifact.tooLarge || artifact.content.length === 0) continue;
    if (!artifact.contentType.startsWith("text/") && artifact.contentType !== "application/json") continue;
    carried.set(artifact.path, { path: artifact.path, content: artifact.content.toString("utf8") });
  }
  return [...carried.values()];
}

function stepObservation(command: AgentCommand, result: { stdout: string[]; stderr: string[]; exitCode: number }) {
  const stdout = result.stdout.join("\n").slice(0, 4_000) || "(无输出)";
  const stderr = result.stderr.join("\n").slice(0, 2_000);
  return [
    `上一步 run_code（${command.language}）退出码 ${result.exitCode}。`,
    `stdout：\n${stdout}`,
    stderr ? `stderr：\n${stderr}` : null,
    result.exitCode === 0 ? "如果任务已经完成，调用 finish 输出最终结论；否则继续 run_code。" : "上一步失败，请修正代码后继续 run_code。",
  ].filter(Boolean).join("\n");
}

export function executeSandboxRun(runId: string, ownerSandboxKeyId: string, sandboxKey: string, input: { task: string; model: string }) {
  const controller = new AbortController();
  const executionId = randomUUID();
  executions.set(runId, controller);
  void (async () => {
    const heartbeat = setInterval(() => { void heartbeatExecutionLease(runId, executionId).catch(() => undefined); }, 20_000);
    try {
      if (!(await startExecutionLease(runId, ownerSandboxKeyId, executionId))) throw new Error("Sandbox 当前并发已满，请稍后重试");
      const maxSteps = maxPlanSteps();
      const history: PlannerTurn[] = [{ role: "user", content: input.task }];
      let files: Array<{ path: string; content: string }> = [];
      const collected = new Map<string, SandboxArtifactData>();
      let finished = false;
      for (let step = 1; step <= maxSteps && !controller.signal.aborted; step++) {
        updateRun(runId, "planning", step === 1 ? "正在通过 Relay 规划受限命令" : `第 ${step}/${maxSteps} 轮：根据上一步输出继续规划`);
        const decision = await planNextSandboxStep(sandboxKey, input.model, history);
        if (decision.type === "finish") {
          appendRunEvent(runId, "stdout", decision.summary);
          finished = true;
          break;
        }
        appendRunEvent(runId, "sandbox.started", `第 ${step} 步：执行 ${decision.command.language} 命令`);
        updateRun(runId, "running", `Agent 已生成 ${decision.command.language} 命令，正在启动隔离沙箱`);
        const result = await runAgentSandboxCommand({
          files,
          program: "sh",
          args: ["-c", commandForAgent(decision.command)],
          image: imageForAgent(decision.command),
          timeoutMs: decision.command.timeoutMs,
          signal: controller.signal,
          onSandboxCreated: async (sandboxId) => { await recordProviderSandbox(runId, executionId, sandboxId); updateRun(runId, "running", "临时沙箱已创建，正在执行受限命令"); },
          onLine: (kind, text) => appendRunEvent(runId, kind, text),
          collectArtifacts: true,
          inputFiles: files,
        });
        history.push({ role: "assistant", content: JSON.stringify(decision.command) });
        history.push({ role: "user", content: stepObservation(decision.command, result) });
        for (const artifact of result.artifacts) collected.set(artifact.path, artifact);
        files = carryOverFiles(files, result.artifacts);
        if (result.exitCode !== 0) {
          updateRun(runId, "failed", `第 ${step} 步命令执行失败（退出码 ${result.exitCode}）`, result.exitCode);
          return;
        }
        appendRunEvent(runId, "sandbox.completed", `第 ${step} 步执行完成`);
      }
      if (controller.signal.aborted || getRun(runId)?.status === "cancelled") {
        appendRunEvent(runId, "sandbox.failed", "执行已取消并清理");
        updateRun(runId, "cancelled", "沙箱执行已取消并清理");
        return;
      }
      if (!finished) appendRunEvent(runId, "status", `已达 ${maxSteps} 轮规划上限，结束本次运行`);
      const deliverables = [...collected.values()];
      recordDeliverables(runId, deliverables);
      if (deliverables.length) appendRunEvent(runId, "artifact", `产物 ${deliverables.length} 个：${deliverables.map((item) => item.path).join("、")}`, { artifacts: deliverables.map(({ content: _content, ...meta }) => meta) });
      updateRun(runId, "succeeded", finished ? "任务完成，沙箱已清理" : "沙箱执行完成，临时环境已清理", 0);
    } catch (error) {
      updateRun(runId, controller.signal.aborted ? "cancelled" : "failed", controller.signal.aborted ? "沙箱执行已取消并清理" : error instanceof Error ? error.message : "Agent 或沙箱执行失败", controller.signal.aborted ? undefined : 1);
    } finally { clearInterval(heartbeat); executions.delete(runId); await releaseExecutionLease(runId, executionId).catch(() => undefined); }
  })();
}

export function abortSandboxRun(runId: string) {
  const controller = executions.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}
