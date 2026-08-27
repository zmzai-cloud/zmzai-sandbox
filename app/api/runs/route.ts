import { NextResponse } from "next/server";
import { commandForAgent, imageForAgent, planTask } from "@/lib/agent-planner";
import { recordDeliverables } from "@/lib/deliverables";
import { persistedRuns } from "@/lib/persistent-runs";
import { getRelayModels, getSessionUser } from "@/lib/relay-client";
import type { SandboxRun } from "@/lib/sandbox-types";
import { appendRunEvent, createRun, getRun, listRuns, updateRun } from "@/lib/sandbox-store";
import { runAgentSandboxCommand } from "@/lib/opensandbox-provider";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getSessionUser(request).catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const live = listRuns(user.id);
  const liveIds = new Set(live.map((run) => run.id));
  // Persisted history beyond the in-memory window is read-only ("archived"):
  // artifact bytes live only in the process, so no downloads or cancellation.
  const archived = await persistedRuns(user.id)
    .then((runs) => runs.filter((run) => !liveIds.has(run.id)).map((run) => ({ ...run, archived: true }) as SandboxRun))
    .catch(() => [] as SandboxRun[]);
  return NextResponse.json({ runs: [...live, ...archived].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request).catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { task?: unknown; model?: unknown } | null;
  const task = typeof body?.task === "string" ? body.task.trim() : "";
  const model = typeof body?.model === "string" ? body.model.trim() : "";

  if (task.length < 3 || task.length > 2000) {
    return NextResponse.json({ error: "任务描述需要在 3 到 2000 个字符之间" }, { status: 400 });
  }

  if (!model) return NextResponse.json({ error: "请选择模型" }, { status: 400 });
  let availableModels;
  try {
    availableModels = await getRelayModels(request);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "模型目录不可用" }, { status: 503 });
  }
  if (!availableModels.some((item) => item.model === model)) {
    return NextResponse.json({ error: "所选模型不可用，请重新加载模型目录" }, { status: 400 });
  }
  const run = createRun({ task, model, userId: user.id });
  updateRun(run.id, "running", `已登录为 ${user.name}，正在请求 Agent 规划命令`);
  void executeRun(request, run.id, model, task);
  return NextResponse.json({ run }, { status: 201 });
}

async function executeRun(request: Request, runId: string, model: string, task: string) {
  const controller = new AbortController();
  try {
    const command = await planTask(request, model, task);
    updateRun(runId, "running", `Agent 已生成 ${command.language} 命令，正在启动隔离沙箱`);
    const result = await runAgentSandboxCommand({
      files: [],
      program: "sh",
      args: ["-c", commandForAgent(command)],
      image: imageForAgent(command),
      timeoutMs: command.timeoutMs,
      signal: controller.signal,
      onLine: (kind, text) => appendRunEvent(runId, kind, text),
      collectArtifacts: true,
      inputFiles: [],
    });
    if (controller.signal.aborted || getRun(runId)?.status === "cancelled") {
      updateRun(runId, "cancelled", "沙箱执行已取消并清理");
      return;
    }
    if (result.exitCode !== 0) {
      updateRun(runId, "failed", `沙箱命令执行失败（退出码 ${result.exitCode}）`, result.exitCode);
      return;
    }
    recordDeliverables(runId, result.artifacts);
    if (result.artifacts.length) appendRunEvent(runId, "artifact", `产物 ${result.artifacts.length} 个：${result.artifacts.map((item) => item.path).join("、")}`, { artifacts: result.artifacts.map(({ content: _content, ...meta }) => meta) });
    updateRun(runId, "succeeded", "沙箱执行完成，临时环境已清理", 0);
  } catch (error) {
    updateRun(runId, "failed", error instanceof Error ? error.message : "Agent 或沙箱执行失败", 1);
  }
}
