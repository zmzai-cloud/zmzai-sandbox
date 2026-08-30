import { randomUUID } from "node:crypto";

import {
  SpanClosedEventSchema,
  generateTraceId,
  resolveIncomingTraceId,
  type SpanClosedEvent,
  type SpanClosedPayload,
} from "@zmzai/contracts";

/**
 * sandbox 侧埋点：
 * - run 开始时绑定 trace（runBindTrace），执行链路里通过 runTraceId 取回
 * - run 结束（终态）时 runEndSpan 发 span.closed（op=run.execute）
 * - runOutboundHeaders：出站调用（relay 等）透传 x-trace-id
 *
 * traceId 存进程内 Map（与 AbortController 的 executions Map 同生命周期假设：
 * 单实例 pm2；进程重启后恢复的 run 丢失 trace 关联是可接受的 v1 取舍）。
 * 硬约束：绝不阻塞主流程 —— 150ms 超时、失败静默丢弃仅计数、不重试。
 */

const EMIT_TIMEOUT_MS = 150;

const runTraces = new Map<string, { traceId: string; spanId: string; startedAt: Date }>();

export function runBindTrace(runId: string, incomingTraceId?: string | null): string {
  const traceId = incomingTraceId ? resolveIncomingTraceId(incomingTraceId) : generateTraceId();
  runTraces.set(runId, { traceId, spanId: randomUUID(), startedAt: new Date() });
  return traceId;
}

export function runTraceId(runId: string): string | undefined {
  return runTraces.get(runId)?.traceId;
}

/** 出站调用头：带 run 的 trace（无则不带，避免编造关联）。 */
export function runOutboundHeaders(runId?: string): Record<string, string> {
  const traceId = runId ? runTraceId(runId) : undefined;
  return traceId ? { "x-trace-id": traceId } : {};
}

const stats = { sent: 0, failed: 0 };
export function telemetryStats() {
  return { ...stats };
}

function countFailure(reason: string): void {
  stats.failed += 1;
  if (process.env.NODE_ENV !== "production") console.debug(`[telemetry] emit failed: ${reason}`);
}

function ingest(event: SpanClosedEvent): void {
  const url = process.env.BILLING_INGEST_URL?.trim();
  const key = process.env.BILLING_INGEST_KEY?.trim();
  if (!url || !key) return; // 未配置 → 静默跳过
  void fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ events: [event] }),
    signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
    cache: "no-store",
  })
    .then((res) => {
      if (!res.ok) countFailure(`http_${res.status}`);
      else stats.sent += 1;
    })
    .catch(() => countFailure("network_or_timeout"));
}

/** run 终态时发 span.closed（op=run.execute），并清理 run 的 trace 绑定。绝不抛错。 */
export function runEndSpan(runId: string, status: "ok" | "error", exitCode?: number): void {
  const bound = runTraces.get(runId);
  if (!bound) return;
  runTraces.delete(runId);
  const payload: SpanClosedPayload = {
    traceId: bound.traceId,
    spanId: bound.spanId,
    service: "sandbox",
    op: "run.execute",
    durationMs: Math.max(0, Date.now() - bound.startedAt.getTime()),
    status,
    startedAt: bound.startedAt.toISOString(),
  };
  const event = {
    id: randomUUID(),
    traceId: bound.traceId,
    service: "sandbox" as const,
    type: "span.closed" as const,
    actorId: null,
    payload,
    at: new Date().toISOString(),
  } satisfies SpanClosedEvent;
  const parsed = SpanClosedEventSchema.safeParse(event);
  if (!parsed.success) {
    countFailure("schema:span");
    return;
  }
  ingest(parsed.data as SpanClosedEvent);
}
