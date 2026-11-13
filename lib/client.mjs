// 零依赖的最小客户端：读环境变量、拼请求头、发请求。
// 例子和 tools/ 都用这一份，免得四个文件里各写一遍鉴权然后漂开。

export const API_VERSION = process.env.API_VERSION || "2026-10-21";

export function config() {
  const base = (process.env.API_BASE || "https://api.anthropic.com").replace(/\/+$/, "");
  const key = process.env.API_KEY;
  const model = process.env.MODEL;
  // 直连官方的 API key 放 x-api-key；多数中转站认 Authorization: Bearer。
  // 不设 AUTH_STYLE 时：官方域名用 x-api-key，其他一律 Bearer。
  const style = process.env.AUTH_STYLE || (base.includes("api.anthropic.com") ? "x-api-key" : "bearer");
  if (!key) throw new Error("缺少 API_KEY（复制 .env.example 为 .env 并填好，或直接 export）");
  return { base, key, model, style };
}

export function headers(cfg, extra = {}) {
  const auth = cfg.style === "bearer"
    ? { authorization: `Bearer ${cfg.key}` }
    : { "x-api-key": cfg.key };
  return {
    ...auth,
    "anthropic-version": API_VERSION,
    "content-type": "application/json",
    ...extra,
  };
}

// 返回 { status, ok, raw, json, requestId }，不在这里抛错 ——
// 「200 但失败」和「4xx 原文」都要交给调用方看见，不要被一个 throw 吞掉。
export async function call(cfg, path, { method = "POST", body, timeoutMs = 120_000 } = {}) {
  const res = await fetch(`${cfg.base}${path}`, {
    method,
    headers: headers(cfg),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  return {
    status: res.status,
    ok: res.ok,
    raw,
    json,
    requestId: res.headers.get("request-id") || res.headers.get("x-request-id"),
  };
}

// 顶层 {error} / {ok:false} 也算失败（见 guide §2.1）。
export function bodyError(json) {
  if (!json || typeof json !== "object") return null;
  if (json.type === "error" || json.error) return json.error || json;
  if (json.ok === false) return json;
  return null;
}

export function textOf(message) {
  return (message?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}
