"use client";

import { useEffect, useMemo, useState } from "react";

import { Navbar } from "@zmzai/theme";

type User = { name: string; email: string };
type SandboxKey = { id: string; prefix: string; name: string; status: "active" | "revoked"; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; runCount?: number; lastRunAt?: string | null };

const baseUrl = "https://z.zmzai.cloud";

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)) : "尚未使用";
}

export function DeveloperWorkbench() {
  const [user, setUser] = useState<User | null>(null);
  const [keys, setKeys] = useState<SandboxKey[]>([]);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshKeys() {
    const response = await fetch("/api/keys", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { keys: SandboxKey[] };
    setKeys(data.keys);
  }

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/session", { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json()) as { user: User };
        setUser(data.user);
        await refreshKeys();
      }
      setLoading(false);
    })();
  }, []);

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null);
    const response = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
    const data = (await response.json().catch(() => ({}))) as { key?: string; error?: string };
    if (!response.ok || !data.key) setError(data.error ?? "创建密钥失败");
    else { setNewKey(data.key); setName(""); await refreshKeys(); }
    setBusy(false);
  }

  async function revoke(key: SandboxKey) {
    if (!window.confirm(`撤销 ${key.prefix}？此操作不可恢复。`)) return;
    setBusy(true); setError(null);
    const response = await fetch(`/api/keys/${key.id}`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; setError(data.error ?? "撤销失败"); }
    await refreshKeys(); setBusy(false);
  }

  const curl = useMemo(() => `curl ${baseUrl}/api/v1/runs \\
  -H "Authorization: Bearer zsk_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{"task":"计算 1+1 并输出结果","model":"你的模型 ID"}'`, []);

  const execCurl = useMemo(() => `curl ${baseUrl}/api/v1/exec \\
  -H "Authorization: Bearer zsk_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{"language":"javascript","code":"console.log(6 * 7)","timeoutMs":10000}'`, []);

  return <main className="developer-shell">
    <Navbar
    sublabel="sandbox"
    brandHref="/"
    badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">z.zmzai.cloud</span>}
    actions={
      user ? (
        <span className="flex items-center gap-1.5 text-xs text-ink-2"><span className="connection-dot" />{user.name}<span className="font-mono text-ink-3">· {user.email}</span></span>
      ) : loading ? (
        <span className="text-xs text-ink-3">正在检查登录</span>
      ) : (
        <a className="text-xs text-accent-readable underline underline-offset-4" href={`https://auth.zmzai.cloud/login?next=${encodeURIComponent(`${baseUrl}/developers`)}`}>登录以创建 sandbox_key</a>
      )
    }
  >
    <a href="/" className="inline-flex items-center rounded-full px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">开发者工作台</a>
  </Navbar>
    <section className="developer-hero"><p className="eyebrow">Sandbox Runner · Developer Preview</p><h1>把一次执行接进你的 Agent。</h1><p>创建只授权 Sandbox Runner 的 <code>sandbox_key</code>。模型、额度与结算仍统一经过 ZMZAI Relay，临时环境默认禁网并受资源限制。</p></section>
    {!user && !loading ? <section className="developer-login"><h2>先登录，再创建你的 Sandbox 凭据。</h2><a className="btn-primary" href={`https://auth.zmzai.cloud/login?next=${encodeURIComponent(`${baseUrl}/developers`)}`}>前往登录 →</a></section> : <>
      <section className="developer-section key-section"><div><p className="eyebrow">01 · Sandbox Keys</p><h2>创建一把只属于你的 key。</h2><p>明文只展示一次。请保存到 Agent 的服务端密钥管理中，不要写入浏览器、代码仓库或日志。</p></div><form onSubmit={createKey} className="key-form"><label htmlFor="key-name">名称</label><input id="key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="例如：我的本地 Agent" disabled={busy} /><button className="btn-primary" type="submit" disabled={busy || !name.trim()}>{busy ? "处理中…" : "创建 sandbox_key"}</button>{error ? <p className="form-error">{error}</p> : null}</form></section>
      {newKey ? <section className="key-reveal" aria-live="polite"><div><p className="eyebrow">仅显示一次</p><h2>复制并妥善保存。</h2><code>{newKey}</code></div><div className="key-reveal-actions"><button className="btn-primary" onClick={() => void navigator.clipboard.writeText(newKey)} type="button">复制密钥</button><button className="btn-quiet" onClick={() => setNewKey(null)} type="button">我已保存</button></div></section> : null}
      <section className="developer-section key-list-section"><div className="section-heading"><span><span className="eyebrow">已创建的 keys</span><h2>密钥管理</h2></span><span className="run-count">{keys.length.toString().padStart(2, "0")}</span></div>{keys.length ? <div className="key-list">{keys.map((key) => <article className="key-row" key={key.id}><div><code>{key.prefix}••••••••</code><strong>{key.name}</strong><span>创建于 {formatDate(key.createdAt)} · 上次使用 {formatDate(key.lastUsedAt)} · 运行 {key.runCount ?? 0} 次</span></div><div><span className={`key-status ${key.status}`}>{key.status === "active" ? "活跃" : "已撤销"}</span>{key.status === "active" ? <button className="btn-quiet" type="button" disabled={busy} onClick={() => void revoke(key)}>撤销</button> : null}</div></article>)}</div> : <p className="empty-detail">还没有 key。创建一把用于你的第一个 Agent。</p>}</section>
    </>}
    <section className="developer-section quickstart"><div><p className="eyebrow">02 · Quick Start</p><h2>提交任务，订阅事件。</h2><p>每次创建运行都需要唯一的 <code>Idempotency-Key</code>，便于网络重试时避免重复执行。</p></div><pre><code>{curl}</code></pre></section>
    <section className="developer-section quickstart"><div><p className="eyebrow">03 · Direct Exec</p><h2>跳过规划，直接执行代码。</h2><p>已经知道要跑什么代码时，用 <code>POST /api/v1/exec</code> 省去 LLM 规划。可选 <code>inputFiles</code> 携带输入文件，产出的新文件可通过 <code>GET /api/v1/runs/:runId/artifacts/:path</code> 下载。</p></div><pre><code>{execCurl}</code></pre></section>
    <section className="developer-section integration-grid"><article><p className="eyebrow">04 · Events</p><h2>通过 SSE 读取输出。</h2><p>调用 <code>GET /api/v1/runs/:runId/events</code>，使用同一 <code>Authorization</code>。事件会区分 stdout、stderr、状态和产物。</p></article><article><p className="eyebrow">05 · Boundaries</p><h2>key 只访问 Sandbox。</h2><p><code>zsk_</code> 不能直接调用 Relay 模型接口。外网默认禁止，连接器和 webfetch 将由受控工具单独提供。</p></article><article><p className="eyebrow">06 · Billing</p><h2>额度仍归 Relay 管理。</h2><p>模型调用和扣费统一经过 <code>m.zmzai.cloud</code>。余额不足时，请前往 Relay 提额后重试。</p></article></section>
    <footer className="console-footer"><span>ZMZAI Sandbox · developer preview</span><a href="/">打开运行控制台</a></footer>
  </main>;
}
