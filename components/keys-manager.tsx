"use client";

import { useEffect, useState } from "react";

type User = { name: string; email: string };
type SandboxKey = { id: string; prefix: string; name: string; status: "active" | "revoked"; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; runCount?: number; lastRunAt?: string | null };

const baseUrl = "https://z.zmzai.cloud";

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)) : "尚未使用";
}

/** API 密钥页主体：创建 / 展示 / 撤销 sandbox_key。外壳由 SandboxShell 提供。 */
export function KeysManager() {
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

  return (
    <>
      <section className="developer-hero"><p className="eyebrow">Sandbox Runner · Developer Preview</p><h1>API 密钥。</h1><p>创建只授权 Sandbox Runner 的 <code>sandbox_key</code>。模型、额度与结算仍统一经过 ZMZAI Relay，临时环境默认禁网并受资源限制。</p></section>
      {!user && !loading ? <section className="developer-login"><h2>先登录，再创建你的 Sandbox 凭据。</h2><a className="btn-primary" href={`https://auth.zmzai.cloud/login?next=${encodeURIComponent(`${baseUrl}/keys`)}`}>前往登录 →</a></section> : <>
        <section className="developer-section key-section"><div><p className="eyebrow">01 · Sandbox Keys</p><h2>创建一把只属于你的 key。</h2><p>明文只展示一次。请保存到 Agent 的服务端密钥管理中，不要写入浏览器、代码仓库或日志。</p></div><form onSubmit={createKey} className="key-form"><label htmlFor="key-name">名称</label><input id="key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="例如：我的本地 Agent" disabled={busy} /><button className="btn-primary" type="submit" disabled={busy || !name.trim()}>{busy ? "处理中…" : "创建 sandbox_key"}</button>{error ? <p className="form-error">{error}</p> : null}</form></section>
        {newKey ? <section className="key-reveal" aria-live="polite"><div><p className="eyebrow">仅显示一次</p><h2>复制并妥善保存。</h2><code>{newKey}</code></div><div className="key-reveal-actions"><button className="btn-primary" onClick={() => void navigator.clipboard.writeText(newKey)} type="button">复制密钥</button><button className="btn-quiet" onClick={() => setNewKey(null)} type="button">我已保存</button></div></section> : null}
        <section className="developer-section key-list-section"><div className="section-heading"><span><span className="eyebrow">已创建的 keys</span><h2>密钥管理</h2></span><span className="run-count">{keys.length.toString().padStart(2, "0")}</span></div>{keys.length ? <div className="key-list">{keys.map((key) => <article className="key-row" key={key.id}><div><code>{key.prefix}••••••••</code><strong>{key.name}</strong><span>创建于 {formatDate(key.createdAt)} · 上次使用 {formatDate(key.lastUsedAt)} · 运行 {key.runCount ?? 0} 次</span></div><div><span className={`key-status ${key.status}`}>{key.status === "active" ? "活跃" : "已撤销"}</span>{key.status === "active" ? <button className="btn-quiet" type="button" disabled={busy} onClick={() => void revoke(key)}>撤销</button> : null}</div></article>)}</div> : <p className="empty-detail">还没有 key。创建一把用于你的第一个 Agent。</p>}</section>
      </>}
    </>
  );
}
