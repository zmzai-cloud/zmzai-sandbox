import { afterEach, describe, expect, it } from "vitest";

import { commandForAgent, maxPlanSteps, parseDecision } from "@/lib/agent-planner";

describe("commandForAgent", () => {
  it("keeps single quotes in JavaScript code for Execd", () => {
    expect(commandForAgent({ language: "javascript", code: "console.log('ready')", timeoutMs: 1_000 }))
      .toBe('node -e "console.log(\'ready\')"');
  });

  it("leaves an explicitly requested shell command unchanged", () => {
    expect(commandForAgent({ language: "shell", code: "echo ready", timeoutMs: 1_000 })).toBe("echo ready");
  });
});

describe("maxPlanSteps", () => {
  const original = process.env.SANDBOX_MAX_PLAN_STEPS;

  afterEach(() => {
    if (original === undefined) delete process.env.SANDBOX_MAX_PLAN_STEPS;
    else process.env.SANDBOX_MAX_PLAN_STEPS = original;
  });

  it("defaults to 3 and clamps the configured value into 1-8", () => {
    delete process.env.SANDBOX_MAX_PLAN_STEPS;
    expect(maxPlanSteps()).toBe(3);
    process.env.SANDBOX_MAX_PLAN_STEPS = "5";
    expect(maxPlanSteps()).toBe(5);
    process.env.SANDBOX_MAX_PLAN_STEPS = "0";
    expect(maxPlanSteps()).toBe(1);
    process.env.SANDBOX_MAX_PLAN_STEPS = "99";
    expect(maxPlanSteps()).toBe(8);
    process.env.SANDBOX_MAX_PLAN_STEPS = "not-a-number";
    expect(maxPlanSteps()).toBe(3);
  });
});

describe("parseDecision", () => {
  const relayResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

  it("treats a finish tool call as the final conclusion", async () => {
    const decision = await parseDecision(relayResponse({
      choices: [{ message: { tool_calls: [{ function: { name: "finish", arguments: JSON.stringify({ summary: "答案是 42" }) } }] } }],
    }));
    expect(decision).toEqual({ type: "finish", summary: "答案是 42" });
  });

  it("maps a run_code tool call to a command", async () => {
    const decision = await parseDecision(relayResponse({
      choices: [{ message: { tool_calls: [{ function: { name: "run_code", arguments: JSON.stringify({ language: "python", code: "print(1)", timeoutMs: 5_000 }) } }] } }],
    }));
    expect(decision).toEqual({ type: "run_code", command: { language: "python", code: "print(1)", timeoutMs: 5_000 } });
  });

  it("falls back to plain content as the final conclusion", async () => {
    const decision = await parseDecision(relayResponse({ choices: [{ message: { content: "  已完成。  " } }] }));
    expect(decision).toEqual({ type: "finish", summary: "已完成。" });
  });

  it("throws on relay errors", async () => {
    await expect(parseDecision(relayResponse({ error: "model unavailable" }, 502))).rejects.toThrow("model unavailable");
  });
});
