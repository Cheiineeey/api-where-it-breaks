#!/usr/bin/env node
// 接入体检：鉴权方式、模型名、最小请求、200 里藏的错误、stop_reason。
// 最多两次请求：一次列模型（不收费），一次最小对话（收费，很少）。
//   node --env-file=.env tools/api-check.mjs [--json]
import { config, call, bodyError, textOf, API_VERSION } from "../lib/client.mjs";

const asJson = process.argv.includes("--json");
const report = { api_version: API_VERSION, checks: [] };
const add = (name, status, detail) => report.checks.push({ name, status, detail });

const cfg = config();
report.base_host = new URL(cfg.base).host;
report.auth_style = cfg.style;

// 1. 列模型
const models = await call(cfg, "/v1/models", { method: "GET", timeoutMs: 30_000 });
if (models.status === 401 || models.status === 403) {
  const other = cfg.style === "bearer" ? "x-api-key" : "bearer";
  add("auth", "fail", `HTTP ${models.status}。key 可能放错了请求头：现在用的是 ${cfg.style}，试试 AUTH_STYLE=${other}（guide §1.1.1）`);
} else if (!models.ok) {
  add("models", "warn", `列模型 HTTP ${models.status}，有些中转站不开放这个接口：${models.raw.slice(0, 200)}`);
} else {
  const ids = (models.json?.data || []).map((m) => m.id);
  report.models = ids;
  add("auth", "ok", `鉴权通过（${cfg.style}）`);
  if (cfg.model && ids.length && !ids.includes(cfg.model)) {
    add("model", "fail", `MODEL=${cfg.model} 不在这个通道的模型列表里。可用：${ids.slice(0, 12).join(", ")}${ids.length > 12 ? " …" : ""}`);
  } else if (cfg.model) {
    add("model", "ok", `${cfg.model} 在列表里`);
  }
}

// 2. 最小请求
if (!cfg.model) {
  add("request", "skip", "没设 MODEL，跳过对话请求");
} else if (!report.checks.some((c) => c.status === "fail")) {
  const t0 = performance.now();
  const res = await call(cfg, "/v1/messages", {
    body: { model: cfg.model, max_tokens: 16000, messages: [{ role: "user", content: "只回复：连接成功" }] },
  });
  report.latency_ms = Math.round(performance.now() - t0);
  report.request_id = res.requestId;
  const err = bodyError(res.json);
  if (!res.ok) {
    add("request", "fail", `HTTP ${res.status}：${res.raw.slice(0, 300)}`);
    if (/temperature|top_p|top_k|budget_tokens|tool_choice/.test(res.raw)) {
      add("hint", "info", "错误提到了新模型已经不接受的参数，见 guide §1.6");
    }
  } else if (err) {
    add("request", "fail", `HTTP 200 但响应里是错误：${JSON.stringify(err).slice(0, 300)}`);
  } else {
    const m = res.json;
    report.stop_reason = m.stop_reason;
    report.usage = m.usage;
    const text = textOf(m);
    if (m.stop_reason === "max_tokens") add("request", "warn", "被截断（max_tokens）");
    else if (m.stop_reason === "refusal") add("request", "warn", `拒答：${JSON.stringify(m.stop_details)}`);
    else if (!text) add("request", "warn", `没有 text 块，stop_reason=${m.stop_reason}`);
    else add("request", "ok", `回答「${text.slice(0, 40)}」，stop_reason=${m.stop_reason}`);
    if (!m.usage || m.usage.input_tokens == null) add("usage", "warn", "响应里没有 usage.input_tokens —— 缺失不要渲染成 0");
  }
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const mark = { ok: "✓", fail: "✗", warn: "!", skip: "-", info: "·" };
  console.log(`${report.base_host}  ·  ${report.auth_style}  ·  anthropic-version ${report.api_version}\n`);
  for (const c of report.checks) console.log(`${mark[c.status]} ${c.name.padEnd(8)} ${c.detail}`);
  if (report.latency_ms != null) console.log(`\n耗时 ${report.latency_ms}ms  usage ${JSON.stringify(report.usage ?? null)}`);
}
process.exit(report.checks.some((c) => c.status === "fail") ? 1 : 0);
