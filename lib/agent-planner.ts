import { randomUUID } from "node:crypto";

import { quoteExecdArgument } from "@/lib/execd-shell";
import { relayRequest, relaySandboxRequest } from "@/lib/relay-client";

export type AgentCommand = {
  language: "javascript" | "python" | "shell";
  code: string;
  timeoutMs: number;
};

/** One conversation turn handed back to the planner between steps. */
export type PlannerTurn = { role: "user" | "assistant"; content: string };

export type PlannerDecision = { type: "run_code"; command: AgentCommand } | { type: "finish"; summary: string };

const runCodeTool = {
  type: "function",
  function: {
    name: "run_code",
    description: "在临时隔离沙箱中执行一段短代码并返回标准输出。不要访问网络，不要执行破坏宿主机的操作。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { type: "string", enum: ["javascript", "python", "shell"] },
        code: { type: "string", minLength: 1, maxLength: 12_000 },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: 60_000 },
      },
      required: ["language", "code", "timeoutMs"],
    },
  },
} as const;

const finishTool = {
  type: "function",
  function: {
    name: "finish",
    description: "任务已完成或无法继续时调用，输出给用户的最终结论。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", maxLength: 2_000 },
      },
      required: ["summary"],
    },
  },
} as const;

function parseArguments(raw: unknown): AgentCommand {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") throw new Error("Agent 没有返回结构化命令");
  const command = value as Record<string, unknown>;
  if (!(["javascript", "python", "shell"] as const).includes(command.language as AgentCommand["language"])) throw new Error("Agent 返回了不支持的语言");
  if (typeof command.code !== "string" || command.code.trim().length === 0 || command.code.length > 12_000) throw new Error("Agent 返回的代码无效");
  const timeoutMs = typeof command.timeoutMs === "number" && Number.isFinite(command.timeoutMs) ? Math.round(command.timeoutMs) : 30_000;
  if (timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("Agent 返回的超时时间无效");
  return { language: command.language as AgentCommand["language"], code: command.code, timeoutMs };
}

function parseContent(content: unknown): AgentCommand {
  if (typeof content !== "string") throw new Error("Agent 没有返回可执行命令");
  const json = content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? content.trim();
  return parseArguments(json);
}

export async function planTask(request: Request, model: string, task: string) {
  const response = await relayRequest(request, "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(agentRequest(model, task)) });
  return parsePlanResponse(response);
}

export async function planSandboxTask(sandboxKey: string, model: string, task: string) {
  const response = await relaySandboxRequest(sandboxKey, agentRequest(model, task));
  return parsePlanResponse(response);
}

/** One multi-turn planning step: the executor feeds previous run_code output
 *  back as turns; the model either issues another run_code or finishes. */
export async function planNextSandboxStep(sandboxKey: string, model: string, history: PlannerTurn[]): Promise<PlannerDecision> {
  const response = await relaySandboxRequest(sandboxKey, planningRequest(model, history));
  return parseDecision(response);
}

export function maxPlanSteps() {
  const raw = Number.parseInt(process.env.SANDBOX_MAX_PLAN_STEPS?.trim() ?? "", 10);
  if (!Number.isFinite(raw)) return 3;
  return Math.min(8, Math.max(1, raw));
}

function planningRequest(model: string, history: PlannerTurn[]) {
  return {
    model,
    stream: false,
    max_tokens: 500,
    requestId: `sandbox_${randomUUID()}`,
    messages: [
      {
        role: "system",
        content: "你是 ZMZAI 沙箱的安全命令规划器。你每轮最多调用一次 run_code 工具在隔离沙箱中执行一小段代码；结合执行输出决定下一轮继续 run_code 还是调用 finish 输出最终结论。优先使用 javascript；只生成短小、可验证的计算或文本处理代码。不要解释计划，不要生成访问网络、读取宿主机或删除数据的命令。",
      },
      ...history,
    ],
    tools: [runCodeTool, finishTool],
    tool_choice: "auto",
  };
}

function agentRequest(model: string, task: string) {
  return {
      model,
      stream: false,
      max_tokens: 500,
      requestId: `sandbox_${randomUUID()}`,
      messages: [
        {
          role: "system",
          content: "你是 ZMZAI 沙箱的安全命令规划器。你必须调用一次 run_code 工具来完成用户任务。优先使用 javascript；只生成短小、可验证的计算或文本处理代码。不要解释，不要生成访问网络、读取宿主机或删除数据的命令。",
        },
        { role: "user", content: task },
      ],
      tools: [runCodeTool],
      tool_choice: { type: "function", function: { name: "run_code" } },
  };
}

async function parsePlanResponse(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: string; choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ function?: { arguments?: unknown } }> } }> } | null;
  if (!response.ok) throw new Error(body?.error || `Relay 返回 HTTP ${response.status}`);
  const message = body?.choices?.[0]?.message;
  const toolArguments = message?.tool_calls?.[0]?.function?.arguments;
  return toolArguments !== undefined ? parseArguments(toolArguments) : parseContent(message?.content);
}

export async function parseDecision(response: Response): Promise<PlannerDecision> {
  const body = (await response.json().catch(() => null)) as { error?: string; choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }> } }> } | null;
  if (!response.ok) throw new Error(body?.error || `Relay 返回 HTTP ${response.status}`);
  const message = body?.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0]?.function;
  if (toolCall?.name === "finish") {
    const value = typeof toolCall.arguments === "string" ? JSON.parse(toolCall.arguments) as { summary?: unknown } : toolCall.arguments as { summary?: unknown } | undefined;
    return { type: "finish", summary: typeof value?.summary === "string" && value.summary.trim() ? value.summary.trim().slice(0, 2_000) : "执行完成" };
  }
  if (toolCall?.name === "run_code" || toolCall?.arguments !== undefined) return { type: "run_code", command: parseArguments(toolCall.arguments) };
  // No tool call: a plain-text answer is treated as the final conclusion.
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  return { type: "finish", summary: content ? content.slice(0, 2_000) : "规划器没有返回可执行命令" };
}

export function commandForAgent(command: AgentCommand) {
  if (command.language === "shell") return command.code;
  return `${command.language === "python" ? "python3 -c" : "node -e"} ${quoteExecdArgument(command.code)}`;
}

export function imageForAgent(command: AgentCommand) {
  if (command.language === "python") return "python:3.12-alpine";
  return process.env.OPEN_SANDBOX_IMAGE?.trim() || "node:22-alpine";
}
