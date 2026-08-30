import { createHash, randomUUID } from "node:crypto";

import { createAgentRunRecord, executeAgentSandboxRun } from "@/lib/agent-executor";
import { activeAgentRunCount, claimAgentSubmission, existingAgentSubmission, persistedRun } from "@/lib/persistent-runs";
import type { CreateAgentRunInput, SandboxCommand, SandboxLimits, SandboxRun, SandboxSnapshot } from "@/lib/sandbox-types";

const maxSnapshotFiles = 200;
const maxSnapshotBytes = 1024 * 1024;
const maxFileBytes = 256 * 1024;
const defaultAllowedPrograms = ["node", "npm", "npx", "python3", "bash", "sh", "git", "ls", "cat", "grep", "find", "mkdir", "cp", "mv", "rm", "echo", "printf", "unzip", "tar", "curl", "wget", "env"];
const perUserActiveLimit = 2;
const totalActiveLimit = 5;

function allowedPrograms(): Set<string> {
  const configured = process.env.SANDBOX_AGENT_ALLOWED_PROGRAMS?.trim();
  if (!configured) return new Set(defaultAllowedPrograms);
  return new Set(configured.split(",").map((item) => item.trim()).filter(Boolean));
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 512 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || path.startsWith("./") || path.startsWith("../")) return false;
  if (path === "..") return false;
  return path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function isSecretEnvKey(key: string): boolean {
  return /secret|key|token|password|credential|authorization/i.test(key);
}

export function readAgentRunInput(body: unknown): { ok: true; input: CreateAgentRunInput } | { ok: false; error: string } {
  const value = body as {
    userId?: unknown;
    taskRunId?: unknown;
    requestId?: unknown;
    snapshot?: unknown;
    command?: unknown;
    limits?: unknown;
  } | null;
  if (!value || typeof value !== "object") return { ok: false, error: "请求体必须是对象" };
  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  const taskRunId = typeof value.taskRunId === "string" ? value.taskRunId.trim() : "";
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  if (!userId || userId.length > 128) return { ok: false, error: "userId 缺失或过长" };
  if (!taskRunId || taskRunId.length > 128) return { ok: false, error: "taskRunId 缺失或过长" };
  if (!/^[\x21-\x7e]{16,128}$/.test(requestId)) return { ok: false, error: "requestId 必须是 16 到 128 个可打印字符" };

  const snapshotValue = value.snapshot as { revisionId?: unknown; files?: unknown } | null;
  if (!snapshotValue || typeof snapshotValue !== "object") return { ok: false, error: "snapshot 缺失" };
  const revisionId = typeof snapshotValue.revisionId === "string" ? snapshotValue.revisionId : null;
  if (revisionId && (revisionId.length > 128 || revisionId.includes("\0"))) return { ok: false, error: "revisionId 不合法" };
  const filesValue = Array.isArray(snapshotValue.files) ? snapshotValue.files : null;
  // A command-only task starts with an empty workspace. It still gets an
  // isolated working directory, but does not need a synthetic placeholder.
  // Keep the upper bound and all path/byte validation below intact.
  if (!filesValue || filesValue.length > maxSnapshotFiles) return { ok: false, error: `snapshot.files 需要 0 到 ${maxSnapshotFiles} 个文件` };
  const snapshot: SandboxSnapshot = { revisionId, files: [] };
  let totalBytes = 0;
  for (const file of filesValue) {
    const item = file as { path?: unknown; content?: unknown } | null;
    const path = typeof item?.path === "string" ? item.path : "";
    const content = typeof item?.content === "string" ? item.content : "";
    if (!isSafeRelativePath(path)) return { ok: false, error: `快照文件路径不合法：${path || "(空)"}` };
    if (content.length > maxFileBytes) return { ok: false, error: `快照文件过大：${path}` };
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > maxSnapshotBytes) return { ok: false, error: "快照总大小超过 1 MiB 限制" };
    snapshot.files.push({ path, content });
  }

  const commandValue = value.command as Partial<SandboxCommand> | null;
  if (!commandValue || typeof commandValue !== "object") return { ok: false, error: "command 缺失" };
  const program = typeof commandValue.program === "string" ? commandValue.program.trim() : "";
  if (!allowedPrograms().has(program)) return { ok: false, error: `程序不在允许列表：${program || "(空)"}` };
  const args = Array.isArray(commandValue.args) ? commandValue.args.map((item) => typeof item === "string" ? item : "").filter((item) => item.length > 0) : [];
  if (args.length > 64) return { ok: false, error: "参数过多" };
  for (const arg of args) {
    if (arg.length > 512 || arg.includes("\0")) return { ok: false, error: "参数不合法" };
  }
  const requestedCwd = typeof commandValue.cwd === "string" ? commandValue.cwd.trim() : "";
  const cwd = requestedCwd && requestedCwd !== "." ? requestedCwd : undefined;
  if (cwd && !isSafeRelativePath(cwd)) return { ok: false, error: "cwd 必须是相对路径" };
  const envs: Record<string, string> = {};
  const envsValue = commandValue.envs as Record<string, unknown> | undefined;
  if (envsValue && typeof envsValue === "object") {
    const entries = Object.entries(envsValue);
    if (entries.length > 16) return { ok: false, error: "环境变量过多" };
    for (const [key, raw] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || isSecretEnvKey(key)) return { ok: false, error: `环境变量名不合法：${key}` };
      const envValue = typeof raw === "string" ? raw : "";
      if (envValue.length > 2048 || envValue.includes("\0")) return { ok: false, error: `环境变量值不合法：${key}` };
      envs[key] = envValue;
    }
  }
  const command: SandboxCommand = { program, args, ...(cwd ? { cwd } : {}), ...(Object.keys(envs).length ? { envs } : {}) };

  const limits: SandboxLimits = {};
  const limitsValue = value.limits as Partial<SandboxLimits> | null;
  if (limitsValue && typeof limitsValue === "object") {
    if (typeof limitsValue.timeoutMs === "number" && (limitsValue.timeoutMs < 1000 || limitsValue.timeoutMs > 300000)) return { ok: false, error: "limits.timeoutMs 需要在 1000 到 300000 之间" };
    if (typeof limitsValue.cpuMillis === "number" && (limitsValue.cpuMillis < 100 || limitsValue.cpuMillis > 2000)) return { ok: false, error: "limits.cpuMillis 需要在 100 到 2000 之间" };
    if (typeof limitsValue.memoryMiB === "number" && (limitsValue.memoryMiB < 64 || limitsValue.memoryMiB > 2048)) return { ok: false, error: "limits.memoryMiB 需要在 64 到 2048 之间" };
    if (limitsValue.timeoutMs !== undefined) limits.timeoutMs = Math.round(limitsValue.timeoutMs);
    if (limitsValue.cpuMillis !== undefined) limits.cpuMillis = Math.round(limitsValue.cpuMillis);
    if (limitsValue.memoryMiB !== undefined) limits.memoryMiB = Math.round(limitsValue.memoryMiB);
  }

  return { ok: true, input: { userId, taskRunId, requestId, snapshot, command, limits } };
}

export async function idempotentAgentRun(input: CreateAgentRunInput): Promise<{ run: SandboxRun; replayed: boolean } | { error: string; code: string; status: number }> {
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const existing = await existingAgentSubmission(input.taskRunId, input.requestId);
  if (existing) {
    if (existing.requestHash !== fingerprint) return { error: "同一 requestId 不能对应不同请求", code: "IDEMPOTENCY_CONFLICT", status: 409 };
    const run = await persistedRun(existing.runId);
    return run ? { run, replayed: true } : { error: "该请求正在恢复，请稍后查询 runId", code: "IDEMPOTENCY_RECOVERY_PENDING", status: 409 };
  }
  const [userActive, totalActive] = await Promise.all([activeAgentRunCount(input.userId), activeAgentRunCount()]);
  if (userActive >= perUserActiveLimit) return { error: "该用户已有运行中的 Sandbox 任务", code: "RATE_LIMITED", status: 429 };
  if (totalActive >= totalActiveLimit) return { error: "Sandbox 当前并发已满，请稍后重试", code: "RATE_LIMITED", status: 429 };

  const runId = `run_${randomUUID().slice(0, 8)}`;
  const claimed = await claimAgentSubmission(input.taskRunId, input.requestId, fingerprint, runId);
  if ("conflict" in claimed) return { error: "同一 requestId 不能对应不同请求", code: "IDEMPOTENCY_CONFLICT", status: 409 };
  if (!claimed.created) {
    const run = await persistedRun(claimed.runId);
    return run ? { run, replayed: true } : { error: "该请求正在恢复，请稍后查询 runId", code: "IDEMPOTENCY_RECOVERY_PENDING", status: 409 };
  }

  const run = createAgentRunRecord(input, runId);
  return { run, replayed: false };
}

export function startAgentExecution(runId: string, replayed: boolean, traceId?: string | null) {
  if (!replayed) executeAgentSandboxRun(runId, traceId);
}
