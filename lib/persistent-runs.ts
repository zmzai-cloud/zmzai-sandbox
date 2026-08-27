import { model, models, Schema, type Model } from "mongoose";

import { connectMongo } from "@/lib/mongo";
import type { SandboxRun } from "@/lib/sandbox-types";

type ExecutionLease = { executionId: string; leaseExpiresAt: Date; providerSandboxId?: string };
type StoredRun = { runId: string; userId: string; ownerSandboxKeyId?: string; payload: SandboxRun; execution?: ExecutionLease; expiresAt: Date };
type CapacitySlot = { slot: number; executionId?: string; leaseExpiresAt?: Date };
type Submission = { ownerSandboxKeyId: string; idempotencyKey: string; requestHash: string; runId: string; expiresAt: Date };
type AgentSubmission = { taskRunId: string; requestId: string; requestHash: string; runId: string; expiresAt: Date };

const runSchema = new Schema<StoredRun>({ runId: { type: String, unique: true, index: true, required: true }, userId: { type: String, index: true, required: true }, ownerSandboxKeyId: { type: String, index: true }, payload: { type: Schema.Types.Mixed, required: true }, execution: { type: Schema.Types.Mixed }, expiresAt: { type: Date, required: true } }, { strict: "throw", timestamps: true });
runSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const submissionSchema = new Schema<Submission>({ ownerSandboxKeyId: { type: String, required: true }, idempotencyKey: { type: String, required: true }, requestHash: { type: String, required: true }, runId: { type: String, required: true }, expiresAt: { type: Date, required: true } }, { strict: "throw", timestamps: true });
submissionSchema.index({ ownerSandboxKeyId: 1, idempotencyKey: 1 }, { unique: true });
submissionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const agentSubmissionSchema = new Schema<AgentSubmission>({ taskRunId: { type: String, required: true }, requestId: { type: String, required: true }, requestHash: { type: String, required: true }, runId: { type: String, required: true }, expiresAt: { type: Date, required: true } }, { strict: "throw", timestamps: true });
agentSubmissionSchema.index({ taskRunId: 1, requestId: 1 }, { unique: true });
agentSubmissionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SandboxRunModel = (models.ZmzaiSandboxRun as Model<StoredRun> | undefined) ?? model<StoredRun>("ZmzaiSandboxRun", runSchema);
const SandboxSubmissionModel = (models.ZmzaiSandboxSubmission as Model<Submission> | undefined) ?? model<Submission>("ZmzaiSandboxSubmission", submissionSchema);
const capacitySchema = new Schema<CapacitySlot>({ slot: { type: Number, unique: true, required: true }, executionId: { type: String, index: true }, leaseExpiresAt: { type: Date, index: true } }, { strict: "throw" });
const SandboxCapacityModel = (models.ZmzaiSandboxCapacity as Model<CapacitySlot> | undefined) ?? model<CapacitySlot>("ZmzaiSandboxCapacity", capacitySchema);
const AgentSandboxSubmissionModel = (models.ZmzaiSandboxAgentSubmission as Model<AgentSubmission> | undefined) ?? model<AgentSubmission>("ZmzaiSandboxAgentSubmission", agentSubmissionSchema);
// Consumer runs default to 24h retention; SANDBOX_RUN_TTL_HOURS overrides it
// (0 disables Mongo persistence for consumer runs entirely — memory only).
function consumerTtlMs() {
  const hours = Number.parseFloat(process.env.SANDBOX_RUN_TTL_HOURS?.trim() ?? "");
  if (!Number.isFinite(hours) || hours < 0) return 24 * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}
// Agent runs must survive long enough for the Agent to reconcile after a
// service restart; 7 days is the retention window.
const agentTtlMs = 7 * 24 * 60 * 60 * 1000;

export async function persistRun(run: SandboxRun) {
  if (!run.taskRunId && consumerTtlMs() === 0) return;
  await connectMongo();
  const ttlMs = run.taskRunId ? agentTtlMs : consumerTtlMs();
  await SandboxRunModel.updateOne({ runId: run.id }, { $set: { userId: run.userId, ownerSandboxKeyId: run.ownerSandboxKeyId, payload: run, expiresAt: new Date(Date.now() + ttlMs) } }, { upsert: true });
}

export async function persistedRun(runId: string, ownerSandboxKeyId?: string) {
  await connectMongo();
  const doc = await SandboxRunModel.findOne({ runId, ...(ownerSandboxKeyId ? { ownerSandboxKeyId } : {}) }).lean();
  return doc?.payload;
}

export async function persistedRuns(userId: string, ownerSandboxKeyId?: string) {
  await connectMongo();
  const docs = await SandboxRunModel.find({ userId, ...(ownerSandboxKeyId ? { ownerSandboxKeyId } : {}) }).sort({ createdAt: -1 }).lean();
  return docs.map((doc) => doc.payload);
}

export async function requestPersistedCancellation(runId: string, ownerSandboxKeyId: string) {
  await connectMongo();
  const doc = await SandboxRunModel.findOne({ runId, ownerSandboxKeyId });
  if (!doc) return undefined;
  const run = doc.payload;
  if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
  if (run.status !== "cancellation_requested") {
    const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
    run.status = "cancellation_requested";
    run.events.push({ id: crypto.randomUUID(), sequence, at: new Date().toISOString(), kind: "status", message: "正在取消并清理沙箱" });
    doc.markModified("payload");
    await doc.save();
  }
  return run;
}

/** Finalize an internal Agent cancellation when its in-process run record is
 * gone (for example after a Sandbox service restart). */
export async function cancelPersistedAgentRun(runId: string) {
  await connectMongo();
  const doc = await SandboxRunModel.findOne({ runId, "payload.taskRunId": { $exists: true } });
  if (!doc) return undefined;
  const run = doc.payload;
  if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
  const finishedAt = new Date().toISOString();
  const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
  run.status = "cancelled";
  run.finishedAt = finishedAt;
  run.events.push({ id: crypto.randomUUID(), sequence, at: finishedAt, kind: "status", message: "沙箱执行已取消并清理" });
  doc.markModified("payload");
  await doc.save();
  return run;
}

const leaseExpiry = () => new Date(Date.now() + 90_000);

export async function startExecutionLease(runId: string, ownerSandboxKeyId: string, executionId: string) {
  await connectMongo();
  await Promise.all([0, 1, 2].map((slot) => SandboxCapacityModel.updateOne({ slot }, { $setOnInsert: { slot } }, { upsert: true })));
  const slot = await SandboxCapacityModel.findOneAndUpdate({ executionId: { $exists: false } }, { $set: { executionId, leaseExpiresAt: leaseExpiry() } }, { sort: { slot: 1 }, new: true });
  if (!slot) return false;
  await SandboxRunModel.updateOne({ runId, ownerSandboxKeyId }, { $set: { execution: { executionId, leaseExpiresAt: leaseExpiry() } } });
  return true;
}

export async function heartbeatExecutionLease(runId: string, executionId: string) {
  await connectMongo();
  const expiresAt = leaseExpiry();
  await Promise.all([
    SandboxRunModel.updateOne({ runId, "execution.executionId": executionId }, { $set: { "execution.leaseExpiresAt": expiresAt } }),
    SandboxCapacityModel.updateOne({ executionId }, { $set: { leaseExpiresAt: expiresAt } }),
  ]);
}

export async function recordProviderSandbox(runId: string, executionId: string, providerSandboxId: string) {
  await connectMongo();
  await SandboxRunModel.updateOne({ runId, "execution.executionId": executionId }, { $set: { "execution.providerSandboxId": providerSandboxId, "execution.leaseExpiresAt": leaseExpiry() } });
}

export async function releaseExecutionLease(runId: string, executionId: string) {
  await connectMongo();
  await Promise.all([
    SandboxRunModel.updateOne({ runId, "execution.executionId": executionId }, { $unset: { execution: 1 } }),
    SandboxCapacityModel.updateOne({ executionId }, { $unset: { executionId: 1, leaseExpiresAt: 1 } }),
  ]);
}

export async function recoverExpiredExecutions(cleanup: (sandboxId: string) => Promise<void>, findOrphans: (metadata: Record<string, string>) => Promise<string[]>) {
  await connectMongo();
  const docs = await SandboxRunModel.find({ "execution.leaseExpiresAt": { $lt: new Date() } }).limit(10);
  for (const doc of docs) {
    const execution = doc.execution;
    if (!execution) continue;
    const sandboxIds = new Set(execution.providerSandboxId ? [execution.providerSandboxId] : []);
    for (const sandboxId of await findOrphans({ "zmzai.run_id": doc.runId, "zmzai.execution_id": execution.executionId }).catch(() => [])) sandboxIds.add(sandboxId);
    for (const sandboxId of sandboxIds) await cleanup(sandboxId).catch(() => undefined);
    const run = doc.payload;
    if (!["succeeded", "failed", "cancelled"].includes(run.status)) {
      const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
      run.status = "failed";
      run.finishedAt = new Date().toISOString();
      run.exitCode = 1;
      run.failure = { code: "EXECUTION_LEASE_EXPIRED", error: "执行进程已失联，临时沙箱已回收", retryable: true };
      run.events.push({ id: crypto.randomUUID(), sequence, at: run.finishedAt, kind: "stderr", message: run.failure.error });
    }
    await SandboxRunModel.updateOne({ _id: doc._id, "execution.executionId": execution.executionId, "execution.leaseExpiresAt": { $lt: new Date() } }, { $set: { payload: run }, $unset: { execution: 1 } });
    await SandboxCapacityModel.updateOne({ executionId: execution.executionId }, { $unset: { executionId: 1, leaseExpiresAt: 1 } });
  }
}

export async function activeRunCount(ownerSandboxKeyId?: string) {
  await connectMongo();
  return SandboxRunModel.countDocuments({ ...(ownerSandboxKeyId ? { ownerSandboxKeyId } : {}), "payload.status": { $in: ["queued", "running", "waiting_approval"] } });
}

/** Per-sandbox-key usage aggregated from the persisted run history. */
export async function keyUsageStats(): Promise<Map<string, { runCount: number; lastRunAt: string | null }>> {
  await connectMongo();
  const rows = await SandboxRunModel.aggregate<{ _id: string; runCount: number; lastRunAt: Date | null }>([
    { $match: { ownerSandboxKeyId: { $exists: true, $ne: null } } },
    { $group: { _id: "$ownerSandboxKeyId", runCount: { $sum: 1 }, lastRunAt: { $max: "$createdAt" } } },
  ]);
  return new Map(rows.map((row) => [row._id, { runCount: row.runCount, lastRunAt: row.lastRunAt instanceof Date ? row.lastRunAt.toISOString() : null }]));
}

export async function activeAgentRunCount(userId?: string) {
  await connectMongo();
  return SandboxRunModel.countDocuments({ ...(userId ? { userId } : {}), "payload.taskRunId": { $exists: true }, "payload.status": { $in: ["queued", "running", "waiting_approval"] } });
}

export async function claimSubmission(ownerSandboxKeyId: string, idempotencyKey: string, requestHash: string, runId: string) {
  await connectMongo();
  try {
    const record = await SandboxSubmissionModel.create({ ownerSandboxKeyId, idempotencyKey, requestHash, runId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    return { created: true as const, runId: record.runId };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate key")) throw error;
    const current = await SandboxSubmissionModel.findOne({ ownerSandboxKeyId, idempotencyKey }).lean();
    if (!current) throw error;
    return current.requestHash === requestHash ? { created: false as const, runId: current.runId } : { conflict: true as const };
  }
}

export async function existingSubmission(ownerSandboxKeyId: string, idempotencyKey: string) {
  await connectMongo();
  return SandboxSubmissionModel.findOne({ ownerSandboxKeyId, idempotencyKey }).lean();
}

export async function claimAgentSubmission(taskRunId: string, requestId: string, requestHash: string, runId: string) {
  await connectMongo();
  try {
    const record = await AgentSandboxSubmissionModel.create({ taskRunId, requestId, requestHash, runId, expiresAt: new Date(Date.now() + agentTtlMs) });
    return { created: true as const, runId: record.runId };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate key")) throw error;
    const current = await AgentSandboxSubmissionModel.findOne({ taskRunId, requestId }).lean();
    if (!current) throw error;
    return current.requestHash === requestHash ? { created: false as const, runId: current.runId } : { conflict: true as const };
  }
}

export async function existingAgentSubmission(taskRunId: string, requestId: string) {
  await connectMongo();
  return AgentSandboxSubmissionModel.findOne({ taskRunId, requestId }).lean();
}
