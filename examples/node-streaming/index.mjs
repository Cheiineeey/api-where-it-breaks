// 流式请求：边收边打字，同时记下首字时间（guide §3）。
// 用法：node --env-file=.env examples/node-streaming/index.mjs
import { config, headers } from "../../lib/client.mjs";
import { frames, bodyChunks, createAccumulator } from "../../lib/sse.mjs";

const cfg = config();
if (!cfg.model) throw new Error("缺少 MODEL");

const t0 = performance.now();
const response = await fetch(`${cfg.base}/v1/messages`, {
  method: "POST",
  headers: headers(cfg),
  body: JSON.stringify({
    model: cfg.model,
    max_tokens: 64000,
    stream: true,
    messages: [{ role: "user", content: "用三句话介绍一下你自己。" }],
  }),
  signal: AbortSignal.timeout(300_000),
});

if (!response.ok) {
  console.error(`HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  process.exit(1);
}

const acc = createAccumulator();
let firstText = null;
for await (const { event, data } of frames(bodyChunks(response))) {
  acc.push(event, data);
  if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
    firstText ??= performance.now();
    process.stdout.write(data.delta.text);
  }
}
const total = performance.now() - t0;
const r = acc.result();

console.log("\n");
if (r.errors.length) console.error("流里出现了 error 事件（HTTP 仍是 200）：", r.errors);
if (!r.finished) console.error("没有收到 stop_reason —— 流被截断了，不要当作正常结束");
console.log("stop_reason：", r.message.stop_reason);
console.log("首字：", firstText ? `${Math.round(firstText - t0)}ms` : "没有文字", "／ 总计：", `${Math.round(total)}ms`);
console.log("usage（开头）：", r.usageStart);
console.log("usage（结尾）：", r.usageEnd);
if (r.unknown.length) console.log(`另有 ${r.unknown.length} 个未识别事件，已跳过`);
