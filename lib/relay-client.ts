type RelayUser = { id: string; name: string; email: string; role: string };
export type RelayModel = { model: string; maxInputTokens?: number; maxOutputTokens?: number; allowedReasoningEfforts?: string[]; availableChannels?: number };

const authUrl = () => (process.env.AUTH_URL?.trim() || "https://auth.zmzai.cloud").replace(/\/$/, "");
const relayUrl = () => (process.env.RELAY_URL?.trim() || "https://m.zmzai.cloud/api/v1").replace(/\/$/, "");
const relayOrigin = () => relayUrl().replace(/\/api\/v1$/, "");
const relayInternalUrl = () => (process.env.RELAY_INTERNAL_URL?.trim() || relayOrigin()).replace(/\/$/, "");

function forwardedHeaders(request: Request, extra?: HeadersInit) {
  const headers = new Headers(extra);
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  headers.set("accept", "application/json");
  // TODO(telemetry): 浏览器会话链路的 x-trace-id 透传（agent→sandbox 内部 run 链已覆盖）
  return headers;
}

export async function getSessionUser(request: Request): Promise<RelayUser | null> {
  if (!request.headers.get("cookie")) return null;
  const response = await fetch(`${authUrl()}/api/me`, {
    headers: forwardedHeaders(request),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`认证服务返回 HTTP ${response.status}`);
  const body = (await response.json()) as { user?: RelayUser | null };
  return body.user ?? null;
}

export async function relayRequest(request: Request, path: string, init?: RequestInit) {
  return fetch(`${relayUrl()}${path}`, {
    ...init,
    headers: forwardedHeaders(request, init?.headers),
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(120_000),
  });
}

export async function relaySessionRequest(request: Request, path: string, init?: RequestInit) {
  return fetch(`${relayOrigin()}${path}`, { ...init, headers: forwardedHeaders(request, init?.headers), cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(15_000) });
}

export type SandboxCaller = { keyId: string; userId: string; name: string };

function sandboxServiceHeaders(extra?: HeadersInit) {
  const secret = process.env.RELAY_SANDBOX_SERVICE_SECRET_CURRENT?.trim();
  if (!secret) throw new Error("RELAY_SANDBOX_SERVICE_SECRET_CURRENT 未配置");
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${secret}`);
  headers.set("content-type", "application/json");
  return headers;
}

export async function resolveSandboxCaller(sandboxKey: string): Promise<SandboxCaller | null> {
  const response = await fetch(`${relayInternalUrl()}/api/internal/sandbox/resolve`, { method: "POST", headers: sandboxServiceHeaders(), body: JSON.stringify({ sandboxKey }), cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Relay Sandbox 认证返回 HTTP ${response.status}`);
  const body = (await response.json()) as { keyId: string; userId: string; name: string };
  return body;
}

export async function relaySandboxRequest(sandboxKey: string, body: unknown) {
  return fetch(`${relayInternalUrl()}/api/internal/sandbox/chat`, { method: "POST", headers: sandboxServiceHeaders(), body: JSON.stringify({ sandboxKey, ...(body as object) }), cache: "no-store", signal: AbortSignal.timeout(120_000) });
}

export async function getSandboxModels(sandboxKey: string) {
  const response = await fetch(`${relayInternalUrl()}/api/internal/sandbox/models`, {
    method: "POST",
    headers: sandboxServiceHeaders(),
    body: JSON.stringify({ sandboxKey }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as { code?: string; models?: unknown; error?: string } | null;
  if (!response.ok) {
    const error = new Error(body?.error || `Relay 模型目录返回 HTTP ${response.status}`);
    Object.assign(error, { code: body?.code, status: response.status });
    throw error;
  }
  const models = Array.isArray(body?.models) ? body.models : [];
  return models.filter((model): model is RelayModel => Boolean(model) && typeof model === "object" && typeof (model as { model?: unknown }).model === "string");
}

export async function getRelayModels(request: Request) {
  const response = await relayRequest(request, "/models", { method: "GET" });
  const body = (await response.json().catch(() => null)) as { models?: unknown } | null;
  if (!response.ok) throw new Error(`Relay 模型目录返回 HTTP ${response.status}`);
  const models = Array.isArray(body?.models) ? body.models : [];
  return models.filter((model): model is RelayModel => {
    if (!model || typeof model !== "object") return false;
    return typeof (model as { model?: unknown }).model === "string";
  });
}

export function loginUrl() {
  return `${authUrl()}/login`;
}
