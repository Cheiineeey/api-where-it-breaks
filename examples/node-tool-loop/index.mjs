// 工具循环（guide §4）：模型只提出请求，执行的是你的程序。
// 天气是本地假数据，不联网。
// 用法：node --env-file=.env examples/node-tool-loop/index.mjs
import { config, call, bodyError, textOf } from "../../lib/client.mjs";

const cfg = config();
if (!cfg.model) throw new Error("缺少 MODEL");

const tools = [
  {
    name: "get_weather",
    description: "查询指定城市的当前天气。只有用户的问题确实需要实时天气时才调用。",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
];

// 模型给的参数是不可信输入：先校验再执行。
const handlers = {
  get_weather(input) {
    if (typeof input?.city !== "string" || !input.city.trim() || input.city.length > 80) {
      throw new Error("city 必须是非空短字符串");
    }
    const fake = { London: 12, 伦敦: 12, Singapore: 31, 新加坡: 31 };
    const t = fake[input.city.trim()];
    return t == null ? { city: input.city, note: "演示数据里没有这个城市" } : { city: input.city, temperature_c: t };
  },
};

const messages = [{ role: "user", content: "伦敦和新加坡现在各多少度？" }];
const MAX_ROUNDS = 6;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const res = await call(cfg, "/v1/messages", {
    body: { model: cfg.model, max_tokens: 16000, tools, messages },
  });
  if (!res.ok || bodyError(res.json)) {
    console.error(`第 ${round} 轮失败：HTTP ${res.status}\n${res.raw.slice(0, 1000)}`);
    process.exit(1);
  }
  const message = res.json;

  // 信块，不只信 stop_reason（guide §4.2）
  const calls = (message.content || []).filter((b) => b.type === "tool_use");
  if (calls.length && message.stop_reason !== "tool_use") {
    console.warn(`⚠ 有 ${calls.length} 个 tool_use 块，stop_reason 却是 ${message.stop_reason} —— 照样执行`);
  }

  // 原 assistant content 完整放回历史（含 thinking 块，不能只留文字）
  messages.push({ role: "assistant", content: message.content });

  if (calls.length === 0) {
    console.log(`\n第 ${round} 轮结束：\n${textOf(message)}`);
    break;
  }

  // 一轮里的多个工具结果放进同一条 user 消息，按 tool_use_id 配对
  const results = calls.map((c) => {
    try {
      const out = handlers[c.name]?.(c.input);
      if (out === undefined) throw new Error(`没有这个工具：${c.name}`);
      console.log(`→ ${c.name}(${JSON.stringify(c.input)}) = ${JSON.stringify(out)}`);
      return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) };
    } catch (e) {
      console.log(`→ ${c.name} 失败：${e.message}`);
      return { type: "tool_result", tool_use_id: c.id, content: e.message, is_error: true };
    }
  });
  messages.push({ role: "user", content: results });

  if (round === MAX_ROUNDS) console.warn("达到回合上限，停止");
}
