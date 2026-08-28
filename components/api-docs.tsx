"use client";

import { useMemo } from "react";

const baseUrl = "https://z.zmzai.cloud";

/** API 文档页主体：Quick Start / Direct Exec / Events / Boundaries / Billing。外壳由 SandboxShell 提供。 */
export function ApiDocs() {
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

  return (
    <>
      <section className="developer-hero"><p className="eyebrow">Sandbox Runner · Developer Preview</p><h1>把一次执行接进你的 Agent。</h1><p>用 <code>sandbox_key</code> 调用 Sandbox HTTP API。模型、额度与结算仍统一经过 ZMZAI Relay，临时环境默认禁网并受资源限制。</p></section>
      <section className="developer-section quickstart"><div><p className="eyebrow">01 · Quick Start</p><h2>提交任务，订阅事件。</h2><p>每次创建运行都需要唯一的 <code>Idempotency-Key</code>（16-128 字符），便于网络重试时避免重复执行；同一 key 重复提交相同内容会返回原运行。</p></div><pre><code>{curl}</code></pre></section>
      <section className="developer-section quickstart"><div><p className="eyebrow">02 · Direct Exec</p><h2>跳过规划，直接执行代码。</h2><p>已经知道要跑什么代码时，用 <code>POST /api/v1/exec</code> 省去 LLM 规划。可选 <code>inputFiles</code> 携带输入文件，产出的新文件可通过 <code>GET /api/v1/runs/:runId/artifacts/:path</code> 下载。</p></div><pre><code>{execCurl}</code></pre></section>
      <section className="developer-section integration-grid"><article><p className="eyebrow">03 · Events</p><h2>通过 SSE 读取输出。</h2><p>调用 <code>GET /api/v1/runs/:runId/events</code>，使用同一 <code>Authorization</code>。事件会区分 stdout、stderr、状态和产物；多轮规划任务会追加 <code>sandbox.step</code> 事件。</p></article><article><p className="eyebrow">04 · Boundaries</p><h2>key 只访问 Sandbox。</h2><p><code>zsk_</code> 不能直接调用 Relay 模型接口。外网默认禁止，连接器和 webfetch 将由受控工具单独提供。</p></article><article><p className="eyebrow">05 · Billing</p><h2>额度仍归 Relay 管理。</h2><p>模型调用和扣费统一经过 <code>m.zmzai.cloud</code>。余额不足时，请前往 Relay 提额后重试。</p></article></section>
    </>
  );
}
