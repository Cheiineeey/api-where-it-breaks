// SSE 解析 + 把事件累积回一条完整 message。
// 例子、stream-check 和测试共用。生产版还要补的东西见 guide §3.2 末尾。

// 从一个可迭代的字符串块来源里切出 SSE 帧。
// 处理了 CRLF、单独 \r、注释行（": ping"）和跨块切断的帧。
export async function* frames(chunks) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    buffer = buffer.replace(/\r\n?/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }
  const tail = buffer.replace(/\r\n?/g, "\n").trim();
  if (tail) {
    const parsed = parseFrame(tail);
    if (parsed) yield parsed;
  }
}

function parseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // 心跳注释
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  let json;
  try { json = JSON.parse(raw); } catch { json = { type: "unparsed", raw }; }
  return { event, data: json };
}

// fetch Response → 文本块
export async function* bodyChunks(response) {
  const decoder = new TextDecoder();
  for await (const value of response.body) yield decoder.decode(value, { stream: true });
}

// 把事件累积成 message。未知事件 / 未知 block 只记下来，不崩。
export function createAccumulator() {
  const msg = { id: null, model: null, content: [], stop_reason: null, stop_details: null, usage: {} };
  let sawStop = false;
  const usageStart = {};
  const usageEnd = {};
  const errors = [];
  const unknown = [];
  const partialJson = new Map();

  function mergeUsage(target, u) {
    for (const [k, v] of Object.entries(u || {})) {
      if (typeof v === "number") target[k] = Math.max(target[k] ?? 0, v);
      else if (v != null && target[k] == null) target[k] = v;
    }
  }

  function push(event, data) {
    const type = data?.type || event;
    switch (type) {
      case "message_start":
        msg.id = data.message?.id ?? null;
        msg.model = data.message?.model ?? null;
        Object.assign(usageStart, data.message?.usage || {});
        break;
      case "content_block_start":
        msg.content[data.index] = structuredClone(data.content_block);
        if (data.content_block?.type === "tool_use") partialJson.set(data.index, "");
        break;
      case "content_block_delta": {
        const block = msg.content[data.index];
        const d = data.delta || {};
        if (!block) { unknown.push({ event, data }); break; }
        if (d.type === "text_delta") block.text = (block.text || "") + d.text;
        else if (d.type === "input_json_delta") partialJson.set(data.index, (partialJson.get(data.index) || "") + d.partial_json);
        else if (d.type === "thinking_delta") block.thinking = (block.thinking || "") + d.thinking;
        else if (d.type === "signature_delta") block.signature = d.signature;
        else unknown.push({ event, data });
        break;
      }
      case "content_block_stop": {
        const block = msg.content[data.index];
        if (block?.type === "tool_use" && partialJson.has(data.index)) {
          const raw = partialJson.get(data.index);
          try { block.input = raw ? JSON.parse(raw) : {}; }
          catch { block.input = null; block._invalid_json = raw; }
        }
        break;
      }
      case "message_delta":
        if (data.delta?.stop_reason) msg.stop_reason = data.delta.stop_reason;
        if (data.delta?.stop_details) msg.stop_details = data.delta.stop_details;
        Object.assign(usageEnd, data.usage || {});
        break;
      case "message_stop":
        sawStop = true;
        break;
      case "ping":
        break;
      case "error":
        errors.push(data.error || data);
        break;
      default:
        unknown.push({ event, data });
    }
  }

  function result() {
    // usage：开头和结尾各取一份，同名字段取观测到的最大值（guide §3.4）
    const usage = {};
    mergeUsage(usage, usageStart);
    mergeUsage(usage, usageEnd);
    return {
      message: { ...msg, content: msg.content.filter(Boolean), usage },
      usageStart: { ...usageStart },
      usageEnd: { ...usageEnd },
      errors,
      unknown,
      // 只有 stop_reason 不算完：message_delta 之后断流也会有它，必须等到 message_stop
      finished: sawStop,
    };
  }

  return { push, result };
}
