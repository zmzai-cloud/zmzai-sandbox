import { describe, expect, it } from "vitest";

import { createExecRun, execCommand, inputFingerprint, readExecInput } from "@/lib/exec-api";
import type { SandboxCaller } from "@/lib/relay-client";

const caller: SandboxCaller = { keyId: "key_1", userId: "user_1", name: "tester" };

function validBody() {
  return { language: "javascript", code: "console.log(6 * 7)" };
}

describe("readExecInput validation", () => {
  it("accepts a well-formed exec request", () => {
    const input = readExecInput(validBody());
    expect(input).not.toBeNull();
    expect(input?.language).toBe("javascript");
    expect(input?.timeoutMs).toBe(30_000);
    expect(input?.inputFiles).toEqual([]);
  });

  it("applies the default timeout and keeps explicit timeouts", () => {
    expect(readExecInput({ ...validBody(), timeoutMs: 10_000 })?.timeoutMs).toBe(10_000);
  });

  it("rejects unknown languages and empty or oversized code", () => {
    expect(readExecInput({ ...validBody(), language: "ruby" })).toBeNull();
    expect(readExecInput({ ...validBody(), code: "   " })).toBeNull();
    expect(readExecInput({ ...validBody(), code: "x".repeat(12_001) })).toBeNull();
    expect(readExecInput(null)).toBeNull();
  });

  it("rejects out-of-range timeouts and limits", () => {
    expect(readExecInput({ ...validBody(), timeoutMs: 999 })).toBeNull();
    expect(readExecInput({ ...validBody(), timeoutMs: 61_000 })).toBeNull();
    expect(readExecInput({ ...validBody(), limits: { cpuMillis: 50 } })).toBeNull();
    expect(readExecInput({ ...validBody(), limits: { memoryMiB: 4096 } })).toBeNull();
  });

  it("rejects invalid input files", () => {
    expect(readExecInput({ ...validBody(), inputFiles: [{ path: "../escape", content: "x" }] })).toBeNull();
    expect(readExecInput({ ...validBody(), inputFiles: [{ path: "/etc/passwd", content: "x" }] })).toBeNull();
    expect(readExecInput({ ...validBody(), inputFiles: [{ path: "ok.txt" }] })).toBeNull();
    expect(readExecInput({ ...validBody(), inputFiles: Array.from({ length: 51 }, (_, index) => ({ path: `f${index}.txt`, content: "x" })) })).toBeNull();
    expect(readExecInput({ ...validBody(), inputFiles: [{ path: "big.txt", content: "x".repeat(1024 * 1024 + 1) }] })).toBeNull();
  });

  it("rejects input files over the total snapshot budget", () => {
    const half = "x".repeat(600 * 1024);
    expect(readExecInput({ ...validBody(), inputFiles: [{ path: "a.txt", content: half }, { path: "b.txt", content: half }] })).toBeNull();
  });
});

describe("execCommand", () => {
  it("maps each language to its interpreter", () => {
    expect(execCommand({ language: "javascript", code: "1", timeoutMs: 1_000, inputFiles: [] })).toEqual({ program: "node", args: ["-e", "1"] });
    expect(execCommand({ language: "python", code: "1", timeoutMs: 1_000, inputFiles: [] })).toEqual({ program: "python3", args: ["-c", "1"] });
    expect(execCommand({ language: "shell", code: "echo hi", timeoutMs: 1_000, inputFiles: [] })).toEqual({ program: "sh", args: ["-c", "echo hi"] });
  });
});

describe("createExecRun", () => {
  it("creates a direct-exec run owned by the sandbox key", () => {
    const input = readExecInput(validBody())!;
    const run = createExecRun(caller, input, "run_test0001");
    expect(run.model).toBe("direct");
    expect(run.ownerSandboxKeyId).toBe("key_1");
    expect(run.command).toEqual(execCommand(input));
    expect(run.limits?.timeoutMs).toBe(30_000);
    expect(run.task.startsWith("Exec · ")).toBe(true);
  });
});

describe("inputFingerprint", () => {
  it("is stable for identical payloads and differs on code change", () => {
    const a = readExecInput(validBody())!;
    const b = readExecInput({ ...validBody() })!;
    const c = readExecInput({ ...validBody(), code: "console.log(7)" })!;
    expect(inputFingerprint(a)).toBe(inputFingerprint(b));
    expect(inputFingerprint(a)).not.toBe(inputFingerprint(c));
  });
});
