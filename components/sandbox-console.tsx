"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ModelSelector, Navbar, type ModelSelectorData, type ModelSelectorValue } from "@zmzai/theme";
import type { RunStatus, SandboxRun } from "@/lib/sandbox-types";

type SessionUser = { id: string; name: string; email: string };
type ArtifactItem = { path: string; bytes: number; contentType: string };
type PreviewState = { path: string; text: string };

const maxPreviewChars = 64_000;

function previewable(contentType: string) {
  return /^text\//.test(contentType) || /json|javascript|xml|csv|markdown|svg/.test(contentType);
}

function encodeArtifactPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function formatBytes(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(from: string, to: string) {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const statusLabels: Record<RunStatus, string> = {
  queued: "排队中",
  planning: "规划中",
  running: "执行中",
  cancellation_requested: "正在取消",
  cleanup_pending: "等待清理",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const statusClass: Record<RunStatus, string> = {
  queued: "status-queued",
  planning: "status-running",
  running: "status-running",
  cancellation_requested: "status-waiting",
  cleanup_pending: "status-waiting",
  succeeded: "status-succeeded",
  failed: "status-failed",
  cancelled: "status-cancelled",
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function SandboxConsole() {
  const [runs, setRuns] = useState<SandboxRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [modelSelectorData, setModelSelectorData] = useState<ModelSelectorData | null>(null);
  const [modelValue, setModelValue] = useState<ModelSelectorValue>({ model: "" });
  const model = modelValue.model;
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedId) ?? runs[0], [runs, selectedId]);
  const artifactItems = useMemo<ArtifactItem[]>(() => {
    if (!selectedRun) return [];
    if (selectedRun.deliverables?.length) return selectedRun.deliverables.map(({ path, bytes, contentType }) => ({ path, bytes, contentType }));
    return selectedRun.artifacts.map((path) => ({ path, bytes: 0, contentType: "" }));
  }, [selectedRun]);
  const activeCount = runs.filter((run) => ["queued", "planning", "running", "cancellation_requested", "cleanup_pending"].includes(run.status)).length;

  const refreshRuns = useCallback(async () => {
    const response = await fetch("/api/runs", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { runs: SandboxRun[] };
    setRuns(data.runs);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const sessionResponse = await fetch("/api/session", { cache: "no-store" });
      if (cancelled) return;
      if (!sessionResponse.ok) {
        setIsLoadingSession(false);
        return;
      }
      const session = (await sessionResponse.json()) as { user?: SessionUser };
      if (!session.user) {
        setIsLoadingSession(false);
        return;
      }
      setUser(session.user);
      const modelResponse = await fetch("/api/models", { cache: "no-store" });
      if (modelResponse.ok) {
        const data = (await modelResponse.json()) as { modelSelectorData?: ModelSelectorData };
        if (data.modelSelectorData) {
          setModelSelectorData(data.modelSelectorData);
          const allModels = data.modelSelectorData.channels.flatMap((ch: { models: { id: string }[] }) => ch.models);
          const firstModel = data.modelSelectorData.featured[0]?.id || allModels[0]?.id || "";
          if (firstModel) setModelValue({ model: firstModel });
        }
      } else {
        setError("模型目录暂时不可用");
      }
      setIsLoadingSession(false);
      void refreshRuns();
    })();
    return () => { cancelled = true; };
  }, [refreshRuns]);

  useEffect(() => {
    if (!selectedRun || !["queued", "running", "waiting_approval"].includes(selectedRun.status)) return;
    const source = new EventSource(`/api/runs/${selectedRun.id}/events`);
    source.onmessage = (message) => {
      const payload = JSON.parse(message.data) as { run: SandboxRun };
      setRuns((current) => current.map((run) => (run.id === payload.run.id ? payload.run : run)));
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [selectedRun?.id, selectedRun?.status]);

  async function submitRun(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) {
      setError("请先登录后再运行任务");
      return;
    }
    if (!model) {
      setError("当前没有可用模型");
      return;
    }
    if (task.trim().length < 3) {
      setError("先写下要完成的任务");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, model }),
    });
    const data = (await response.json()) as { run?: SandboxRun; error?: string; loginUrl?: string };
    if (!response.ok || !data.run) {
      if (response.status === 401 && data.loginUrl) window.location.href = `${data.loginUrl}?next=${encodeURIComponent(window.location.href)}`;
      setError(data.error ?? "创建任务失败");
      setIsSubmitting(false);
      return;
    }
    setRuns((current) => [data.run!, ...current]);
    setSelectedId(data.run.id);
    setTask("");
    setIsSubmitting(false);
  }

  async function cancelSelected() {
    if (!selectedRun || selectedRun.archived) return;
    const response = await fetch(`/api/runs/${selectedRun.id}/cancel`, { method: "POST" });
    if (!response.ok) return;
    const data = (await response.json()) as { run: SandboxRun };
    setRuns((current) => current.map((run) => (run.id === data.run.id ? data.run : run)));
  }

  async function openPreview(item: ArtifactItem) {
    if (!selectedRun) return;
    const fallback = (text: string) => setPreview({ path: item.path, text });
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/artifacts/${encodeArtifactPath(item.path)}`);
      if (!response.ok) return fallback("产物内容不可用（可能已随服务重启清理）");
      const text = await response.text();
      if (text.length > maxPreviewChars) return fallback(`${text.slice(0, maxPreviewChars)}\n…（预览已截断，完整内容请下载查看，共 ${formatBytes(text.length) || `${text.length} 字符`}）`);
      setPreview({ path: item.path, text });
    } catch {
      fallback("产物内容读取失败");
    }
  }

  return (
    <main className="console-shell">
      <Navbar
        sublabel="sandbox"
        brandHref="/"
        badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">z.zmzai.cloud</span>}
        actions={
          <>
            <span className="flex items-center gap-1.5 text-xs text-ink-2"><span className="connection-dot" />{user ? user.name : isLoadingSession ? "正在检查登录" : "未登录"}</span>
            <span className="font-mono text-xs text-ink-3">并发 {activeCount}/1</span>
            <a className="text-xs text-ink-2 transition-colors hover:text-accent" href="/developers">开发者文档</a>
            {!user && !isLoadingSession ? <a className="text-xs text-accent-readable underline underline-offset-4" href={`https://auth.zmzai.cloud/login?next=${encodeURIComponent("https://z.zmzai.cloud/")}`}>登录</a> : null}
          </>
        }
      >
        <h1 className="text-sm font-semibold">Sandbox</h1>
      </Navbar>

      <section className="console-intro">
        <div><p className="eyebrow">执行控制台</p><h2>让代码先在边界里跑起来。</h2></div>
        <p className="intro-copy">每次运行都从一个临时 Workspace 快照开始。日志、退出码和产物会被完整留下，正式文件不会被沙箱直接改写。</p>
      </section>

      <section className="run-composer">
        <div className="composer-label"><span className="section-index">01</span><span>新建运行</span></div>
        <form onSubmit={submitRun} className="composer-form">
          <label className="sr-only" htmlFor="task">任务描述</label>
          <textarea id="task" value={task} onChange={(event) => setTask(event.target.value)} placeholder="例如：读取当前 Workspace 的资料，整理成 Markdown 报告并保存。" rows={3} />
          <div className="composer-actions">
            <label className="model-select"><span>模型</span><ModelSelector data={modelSelectorData ?? { featured: [], channels: [] }} value={modelValue} onChange={setModelValue} placeholder={isLoadingSession ? "检查登录…" : "选择模型"} /></label>
            <button className="btn-primary" disabled={isSubmitting || !user || !model} type="submit">{isSubmitting ? "创建中…" : "开始运行 →"}</button>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
        </form>
      </section>

      <section className="runs-layout">
        <aside className="run-index">
          <div className="section-heading"><span className="eyebrow">02 · Runs</span><span className="run-count">{runs.length.toString().padStart(2, "0")}</span></div>
          {runs.length === 0 ? <div className="empty-index">还没有运行。<br />从上面提交第一个任务。</div> : <div className="run-list">{runs.map((run) => <button key={run.id} className={`run-row ${selectedRun?.id === run.id ? "is-selected" : ""}`} onClick={() => setSelectedId(run.id)} type="button"><span className={`status-dot ${statusClass[run.status]}`} /><span className="run-row-copy"><span className="run-row-title">{run.archived ? <span className="archived-tag">归档</span> : null}{run.task}</span><span className="run-row-meta">{formatDate(run.createdAt)} · {run.id}</span></span><span className={`status-label ${statusClass[run.status]}`}>{statusLabels[run.status]}</span></button>)}</div>}
        </aside>

        <article className="run-detail">
          {selectedRun ? <>
            <div className="detail-heading"><div><p className="eyebrow">03 · Run detail</p><h2>{selectedRun.task}</h2><p className="detail-id">{selectedRun.id} · {selectedRun.provider === "demo" ? "演示 Provider" : "OpenSandbox"} · {selectedRun.model === "direct" ? `直接执行${selectedRun.command ? ` · ${selectedRun.command.program}` : ""}` : selectedRun.model}</p><div className="detail-metrics"><span>退出码 {selectedRun.exitCode ?? "—"}</span>{selectedRun.startedAt && selectedRun.finishedAt ? <span>耗时 {formatDuration(selectedRun.startedAt, selectedRun.finishedAt)}</span> : null}{selectedRun.archived ? <span className="archived-tag">已归档 · 只读</span> : null}</div></div><div className="detail-status"><span className={`status-label large ${statusClass[selectedRun.status]}`}>{statusLabels[selectedRun.status]}</span>{["queued", "running", "waiting_approval"].includes(selectedRun.status) && !selectedRun.archived ? <button className="btn-quiet" onClick={cancelSelected} type="button">取消运行</button> : null}</div></div>
            <div className="detail-grid"><section className="detail-section"><div className="section-heading"><span className="eyebrow">事件流</span><span className="detail-time">{selectedRun.finishedAt ? `完成于 ${formatTime(selectedRun.finishedAt)}` : "正在监听"}</span></div><div className="event-stream" aria-live="polite">{selectedRun.events.map((item) => <div className="event-line" key={item.id}><time>{formatTime(item.at)}</time><span className={`event-kind event-${item.kind.replace(/\./g, "-")}`}>{item.kind}</span><span>{item.message}</span></div>)}</div></section><section className="detail-section artifact-section"><div className="section-heading"><span className="eyebrow">产物</span><span className="detail-time">{artifactItems.length.toString().padStart(2, "0")}</span></div>{artifactItems.length ? <ul className="artifact-list">{artifactItems.map((item) => <li className="artifact-row" key={item.path}><span className="artifact-bullet">↳</span><span className="artifact-name"><code>{item.path}</code>{item.bytes ? <small>{formatBytes(item.bytes)}</small> : null}</span>{selectedRun.archived ? null : <span className="artifact-actions">{previewable(item.contentType) ? <button className="btn-quiet" type="button" onClick={() => void openPreview(item)}>预览</button> : null}<a className="btn-quiet" href={`/api/runs/${selectedRun.id}/artifacts/${encodeArtifactPath(item.path)}?download=1`}>下载</a></span>}</li>)}</ul> : <p className="empty-detail">运行完成后，产物会出现在这里，可预览或下载。</p>}</section></div>
          </> : <div className="empty-detail empty-detail-large"><p className="eyebrow">等待第一个 Run</p><h2>沙箱还没有开始工作。</h2><p>提交一个任务，看看它如何在临时环境里读取、执行并交付结果。</p></div>}
        </article>
      </section>

      <footer className="console-footer"><span>Sandbox · ZMZAI OS execution layer</span><span>OpenSandbox adapter · Docker runtime</span></footer>

      {preview ? <div className="artifact-overlay" role="dialog" aria-modal="true" aria-label={`产物预览 ${preview.path}`} onClick={() => setPreview(null)}><div className="artifact-preview" onClick={(event) => event.stopPropagation()}><div className="artifact-preview-head"><code>{preview.path}</code><button className="btn-quiet" type="button" onClick={() => setPreview(null)}>关闭</button></div><pre><code>{preview.text}</code></pre></div></div> : null}
    </main>
  );
}
