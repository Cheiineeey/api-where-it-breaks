#!/usr/bin/env node
// 工具调用体检：给一个必然要用工具的问题，看返回里有没有真实的 tool_use 块，
// 以及 stop_reason 跟块对不对得上（guide §4.2）。一次付费请求。
// 注意：用的是 tool_choice: auto —— 新模型上强制调用（any / 指定工具）直接 400（guide §1.6）。
//   node --env-file=.env tools/tool-check.mjs [--json]
import { config, call, bodyError, textOf } from "../lib/client.mjs";

const asJson = process.argv.includes("--json");
const cfg = config();
if (!cfg.model) throw new Error("缺少 MODEL");

const res = await call(cfg, "/v1/messages", {
  body: {
    model: cfg.model,
    max_tokens: 16000,
    tools: [{
      name: "get_order_status",
      description: "按订单号查询订单状态。用户问到订单时必须调用，不能猜。",
      input_schema: {
        type: "object",
        properties: { order_id: { type: "string" } },
        required: ["order_id"],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: "帮我查一下订单 A-1024 到哪了。" }],
  },
});

const out = { status: res.status };
if (!res.ok || bodyError(res.json)) {
  out.verdict = "request_failed";
  out.detail = res.raw.slice(0, 500);
} else {
  const m = res.json;
  const calls = (m.content || []).filter((b) => b.type === "tool_use");
  out.stop_reason = m.stop_reason;
  out.tool_use_blocks = calls.map((c) => ({ name: c.name, input: c.input }));
  out.text = textOf(m).slice(0, 200);
  if (calls.length && m.stop_reason === "tool_use") {
    out.verdict = "ok";
  } else if (calls.length) {
    out.verdict = "stop_reason_mismatch";
    out.detail = `有 tool_use 块，stop_reason 却是 ${m.stop_reason}。只看 stop_reason 的循环会漏执行。`;
  } else if (m.stop_reason === "tool_use") {
    out.verdict = "missing_block";
    out.detail = "stop_reason 说要调工具，但响应里没有 tool_use 块 —— 中间层可能丢了它。";
  } else if (/get_order_status|tool_use|<invoke|function_call/i.test(out.text)) {
    out.verdict = "tool_call_in_text";
    out.detail = "工具调用被写进了正文而不是 tool_use 块 —— 这一调用不会执行。";
  } else {
    out.verdict = "no_tool_call";
    out.detail = "模型没调用工具。单次结果说明不了通道不支持工具，先查真实使用记录（guide §7.4 同理）。";
  }
}

if (asJson) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`结论：${out.verdict}`);
  if (out.detail) console.log(out.detail);
  if (out.tool_use_blocks?.length) console.log("tool_use：", JSON.stringify(out.tool_use_blocks));
  if (out.stop_reason) console.log("stop_reason：", out.stop_reason);
}
process.exit(out.verdict === "ok" ? 0 : 1);
