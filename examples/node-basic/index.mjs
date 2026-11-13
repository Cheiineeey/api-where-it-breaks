// 最小非流式请求（guide §1.3–1.4）。
// 用法：node --env-file=.env examples/node-basic/index.mjs
import { config, call, bodyError, textOf } from "../../lib/client.mjs";

const cfg = config();
if (!cfg.model) throw new Error("缺少 MODEL —— 先跑 examples/curl/01-models.sh 看看这个通道真正有哪些模型");

const res = await call(cfg, "/v1/messages", {
  body: {
    model: cfg.model,
    // 新模型思考关不掉，思考也算在 max_tokens 里。给小了会拿到空回答（guide §1.3.1）。
    max_tokens: 16000,
    messages: [{ role: "user", content: "只回复：连接成功" }],
  },
});

if (!res.ok) {
  console.error(`HTTP ${res.status}（request-id: ${res.requestId ?? "无"}）\n${res.raw.slice(0, 1000)}`);
  process.exit(1);
}
const err = bodyError(res.json);
if (err) {
  console.error("HTTP 200 但响应里是错误（guide §2.1）：", err);
  process.exit(1);
}

const message = res.json;
if (message.stop_reason === "max_tokens") console.warn("⚠ 被截断：max_tokens 不够");
if (message.stop_reason === "refusal") console.warn("⚠ 模型拒答：", message.stop_details);

console.log("回答：", textOf(message) || "（没有 text 块）");
console.log("stop_reason：", message.stop_reason);
console.log("usage：", message.usage);
