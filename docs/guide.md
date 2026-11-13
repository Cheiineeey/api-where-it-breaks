# 大模型 API 入门与进阶指南：从第一次请求到生产级接入

> 状态：第一版草稿  
> 最后核对：2026-11-13  
> 适用范围：Claude 官方 API、兼容其消息协议的中转站／网关，以及接入 CC 的双 Provider 架构  
> 验证口径：`[实测]`、`[倒推]`、`[未验证]`。没有证据的地方不写成结论。

这不是一篇“复制一段 curl 就算接入完成”的文章。

真正把 API 放进聊天 App、Agent、工具系统或长期陪伴产品之后，问题通常不出在第一发请求，而出在后面：流式看起来开着却不逐字、工具块返回了却没执行、缓存标记被接受却从未命中、一次按钮打出七八条消费记录、客户端断线后钱扣了但结果丢了，以及切到 Claude Code 后像突然失忆。

这份指南分成两条阅读路径：

- **基础版**：从零发出请求，处理流式、工具、错误和费用。
- **进阶版**：缓存工程、生产可靠性、观测、长上下文，以及 Claude Code（下文简称 CC）和普通 API 作为两个 Provider 的无缝切换。

如果你从没碰过 API，先读 0.5 节。只想先跑通，读第 1～6 节，配合仓库里的 `examples/`。要做长期运行的产品，再读第 7 节以后。

仓库里的例子和体检工具都是零依赖 Node（22+），离线测试 `npm test` 不花钱。

---

## 0. 先说十条结论

1. **先固定协议版本，再讨论兼容。** 2026-10-21 版 API 已移除 `temperature`、`top_p`、`top_k`；旧请求原样搬过来会直接 400。
2. **中转站返回 200，不代表模型请求成功。** 错误可能藏在 SSE 数据里。
3. **流式是一条独立链路。** 同一站的流式和非流式可能走不同后端，缓存能力也可能相反。
4. **工具循环不能只信 `stop_reason`。** 先看响应里有没有真实 `tool_use` 块。
5. **缓存是前缀缓存。** 实际顺序是 `tools → system → messages`，越靠前越不能变。
6. **长度相等不代表内容相等。** 工具数量和字符数都没变，顺序变化仍会让整个缓存失效。
7. **“看不到”不是“没命中”。** 缓存字段缺失、请求失败、请求被截断，都必须是独立状态。
8. **重试不带退避和幂等，就是重复扣费。** 尤其是付费已经发生、客户端只是没等到结果的场景。
9. **CC 和 API 无缝切换，不是把两份历史互相全量复制。** 正确做法是共享持久层、Provider 水位和增量同步。
10. **诊断工具只报告事实、证据和代价，不替用户决定换不换站。**

---

# 第一部分：基础版

## 0.5 从没碰过 API？先认识四个词

**API**：不打开聊天网页，而是用代码直接给模型发一段文字、拿回一段回答。你自己做的 App、机器人、定时任务，背后都是这样一发一发的请求。

**API key**：一串密码，代表"这笔钱记在谁账上"。谁拿到它，谁就能用你的额度。所以它只能放在你自己的服务器上（见 1.5）。

**token**：模型计费和计长度的单位。中文大约一个字一到两个 token，英文大约四个字母一个。**每次请求都要为你发过去的全部内容付输入费**——包括整段历史、人格、工具说明——再为模型写出来的内容（含思考）付输出费。这就是为什么聊得越久越贵，也是第 7 节缓存存在的理由。

**中转站**：第三方转发服务。你把请求发给它，它再转给官方（或别的后端）。常见原因是付款方便或网络可达。代价是：它可能改写字段、不兑现缓存、偷换后端、把错误藏在 200 里。本文大量篇幅在讲怎么用证据判断一个中转站，而不是凭感觉。

---

## 1. 先跑通一发最小请求

### 1.1 你需要的四个值

```text
API_BASE       例如 https://api.anthropic.com
API_KEY        只放服务端环境变量，不写进网页或 App 包
MODEL          先通过 /v1/models 查询，不要凭印象抄名字
API_VERSION    官方当前示例为 2026-10-21；中转站可能只兼容旧版
```

官方当前版本要求请求带 `anthropic-version`。新 SDK 会自动处理；手写 HTTP 请求时必须自己带上。

### 1.1.1 key 放在哪个请求头

这是新手第一个 401 的来源。

| 你连的是 | key 放在 |
|---|---|
| 官方 API，用控制台发的 API key | 新版文档推荐 `Authorization: Bearer $API_KEY`；`x-api-key: $API_KEY` 仍兼容 |
| 官方 API，用 OAuth 登录拿到的临时 token | `Authorization: Bearer $TOKEN`，另加 `anthropic-beta: oauth-2025-04-20` |
| 大多数中转站 | 通常是 `Authorization: Bearer $API_KEY`，以站方文档为准 |

官方新版文档把 `Authorization: Bearer` 列为推荐写法，`x-api-key` 作为旧写法继续兼容，两种直连官方都能用。中转站则按站方规则：很多只认 Bearer，也有只认 `x-api-key` 的。下文示例统一写成 `$AUTH_HEADER`，按上表二选一：

```bash
# 官方推荐 / 多数中转站
AUTH_HEADER="Authorization: Bearer $API_KEY"
# 官方兼容的旧写法 / 只认它的中转站
AUTH_HEADER="x-api-key: $API_KEY"
```

官方 SDK 默认用 `x-api-key`；把 SDK 的 `base_url` 指向中转站时，如果站方只认 Bearer，要改用 SDK 的 auth token 参数（如 `ANTHROPIC_AUTH_TOKEN`），而不是 `ANTHROPIC_API_KEY`。

### 1.2 先列模型

```bash
curl "$API_BASE/v1/models" \
  -H "$AUTH_HEADER" \
  -H "anthropic-version: 2026-10-21"
```

为什么先列模型：

- 中转站的模型标签常常不是官方模型名。
- 同一个标签可以在不同时间换后端。
- 定时任务最容易因为旧模型名静默死掉。
- “官网有这个模型”不等于“你当前 key 所在通道有这个模型”。

### 1.3 最小非流式请求

```bash
curl "$API_BASE/v1/messages" \
  -H "$AUTH_HEADER" \
  -H "anthropic-version: 2026-10-21" \
  -H "content-type: application/json" \
  --max-time 120 \
  -d '{
    "model": "claude-opus-5-5",
    "max_tokens": 4096,
    "messages": [
      {"role": "user", "content": "只回复：连接成功"}
    ]
  }'
```

直连官方 API 时，以官方文档中的当前模型为准；中转站用户把 `model` 换成 `/v1/models` 真正返回的值。

### 1.3.1 第一个雷：`max_tokens` 给小了，拿回一个空回答

新一代模型（Opus 5.5 等）**思考关不掉**，而思考 token 也算在 `max_tokens` 里。如果你照老教程写 `"max_tokens": 256`，很可能 256 个 token 全被思考用完，返回里没有任何 `text` 块，`stop_reason` 是 `max_tokens`。

看起来像"接通了但模型不说话"，新手通常会去怀疑 key、中转站或解析代码，其实只是额度太小。

```text
非流式：max_tokens 先给 ~16000（太大可能撞 HTTP 超时）
流式：  max_tokens 可以给 ~64000
只有分类这类极短输出，才刻意压低
```

拿到响应先看 `stop_reason`：是 `max_tokens` 就说明被截断了，不要当作正常结束。

### 1.4 Node.js 零依赖版本

```js
const base = process.env.API_BASE || "https://api.anthropic.com";
const key = process.env.API_KEY;
const model = process.env.MODEL;
// 官方两种都收；中转站按站方规则（见 1.1.1）
const useBearer = process.env.AUTH_STYLE === "bearer";

if (!key || !model) throw new Error("缺少 API_KEY 或 MODEL");

const response = await fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: {
    ...(useBearer ? { authorization: `Bearer ${key}` } : { "x-api-key": key }),
    "anthropic-version": "2026-10-21",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content: "只回复：连接成功" }],
  }),
  signal: AbortSignal.timeout(120_000),
});

const raw = await response.text();

if (!response.ok) {
  throw new Error(`HTTP ${response.status}: ${raw.slice(0, 1000)}`);
}

const message = JSON.parse(raw);
const text = (message.content || [])
  .filter((block) => block.type === "text")
  .map((block) => block.text)
  .join("");

if (message.stop_reason === "max_tokens") console.warn("被截断：max_tokens 不够");
if (message.stop_reason === "refusal") console.warn("模型拒答：", message.stop_details);

console.log(text);
console.log(message.usage);
```

### 1.5 不要把 key 放浏览器里

推荐结构：

```text
网页 / App
    ↓ 你自己的登录态
你的后端 /gateway/chat
    ↓ 服务端读取 API key
Claude 官方 API 或中转站
```

浏览器直接请求第三方 API 会带来四个问题：

- key 能被用户、浏览器扩展和抓包工具读到；
- 无法统一做限流、预算和日志脱敏；
- 难以处理断线续接和任务状态；
- CORS 成功不等于安全。

### 1.6 网上老教程里，在新模型上直接 400 的写法

照搬一年前的代码，最常见的不是"效果变差"，而是请求直接被拒。以 Opus 5.5 为例：

| 老写法 | 现在 | 怎么改 |
|---|---|---|
| `temperature` / `top_p` / `top_k` | 2026-10-21 版对所有模型 400 | 删掉；想控制风格写进提示词 |
| `thinking: {type: "enabled", budget_tokens: N}` | 400 | 删掉 `thinking`（默认就是自适应思考），用 `output_config.effort` 控制深浅 |
| `thinking: {type: "disabled"}` | Opus 5.5 上 400 | 关不掉；嫌慢嫌贵就把 effort 调到 `low` |
| `tool_choice: {type: "any"}` 或指定某个工具 | Opus 5.5 / Sonnet 5.5 上 400 | 用 `auto`，在提示词里点名该用哪个工具；要参数严格合法就给工具加 `strict: true` |
| 最后一条放 assistant 消息做"预填充" | 400 | 用结构化输出 `output_config.format` 或提示词约束格式 |

`effort` 的写法：

```json
{"output_config": {"effort": "low"}}
```

可选 `low` / `medium` / `high` / `xhigh` / `max`。注意 Opus 5.5 的默认是 `medium`，比上一代低一档；聊天类通常 `low` 或 `medium` 就够，写代码、多步工具任务再往上调。

中转站可能还停在旧版本、仍然接受这些参数——这不代表你的写法对，只代表它没校验。换到官方或换站时会突然全挂。

---

## 2. 正确理解 Messages 响应

一个成功响应不等于只有一段字符串。`content` 是有顺序的内容块数组：

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "text", "text": "我去查一下。"},
    {"type": "tool_use", "id": "toolu_...", "name": "get_weather", "input": {"city": "London"}}
  ],
  "stop_reason": "tool_use",
  "usage": {
    "input_tokens": 123,
    "output_tokens": 45
  }
}
```

至少保留这些字段：

| 字段 | 为什么要存 |
|---|---|
| `id` | 排查重复、路由和中转层改写 |
| `content[]` | 文本、工具、思考不能压成一个字符串 |
| `stop_reason` | 有参考价值，但不能单独决定工具循环 |
| `usage` | 成本、缓存和上下文水位 |
| HTTP request ID | 找官方或站方排障时最有用的关联键 |
| Provider、模型、API 版本 | 同一个“模型名”可能在不同通道行为完全不同 |

`stop_reason` 至少要分开处理这几种：

| 值 | 含义 | 处理 |
|---|---|---|
| `end_turn` | 正常说完 | 展示 |
| `tool_use` | 要求调用工具 | 进入工具循环（但见 4.2：以真实 `tool_use` 块为准） |
| `max_tokens` | 被截断 | 不当作正常结束；调大额度或续写 |
| `refusal` | 安全分类器拒答（HTTP 仍是 200） | 读 `stop_details.category`，不要把空正文当成功展示 |
| `pause_turn` | 服务端工具（如联网搜索）中途暂停 | 原样把 assistant 内容带回去再发一轮，让它继续 |

### 2.1 HTTP 200 也要继续检查

中转站常见三类“200 但失败”：

1. JSON 顶层是 `{ok:false}` 或 `{error:{...}}`。
2. SSE 先发一个正常 `message_start`，后面再塞 `overloaded_error`。
3. 生成任务接口返回 200，只代表“任务已创建”，最终任务可能是 error。

因此成功条件应该是：

```text
HTTP 状态成功
AND 响应结构合法
AND 没有顶层或流内 error
AND 最终状态确实完成
```

`tools/api-check.mjs` 会把这几种情况分开报告。

### 2.2 中转站可能在你的请求前面加了它自己的系统提示词 [实测 2026-11-13]

我们对一个中转站发了一条**不带任何 system** 的请求：“用三句话介绍一下你自己。”回答是另一个产品的名字和它的工作守则——这个通道在转发前塞进了自己的系统提示词。

它带来三件事：

- 你的人格 / 规则不是唯一的 system，模型同时在听另一份；
- 你看到的 `input_tokens` 和你真正发出去的长度对不上；
- 它变了你不会收到通知。

自查方法很简单：不带 system，问一句“你是谁”。官方 API 上模型只会说自己是 Claude。

同一个通道对“只回复：连接成功”报了 `input_tokens: 1`——所以第 6 节说的“不要跨站比较 `input_tokens`”不是理论。

---

## 3. 流式输出：别把“开了 stream”当作“真的在流”

请求里设置：

```json
{"stream": true}
```

返回是 SSE。你需要按事件名和数据行解析，而不是按网络 chunk 直接 `JSON.parse`。

### 3.1 最少要认识的事件

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
error
```

`content_block_delta` 里可能是：

- 文本增量；
- 工具参数 JSON 增量；
- thinking 增量；
- 新版本增加的其他 delta 类型。

未知事件和未知 block 类型不要让整个解析器崩掉：记录原始事件，跳过展示，继续等最终状态。

### 3.2 一个够用的 SSE 累积器形状

```js
async function readSSE(response, onEvent) {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error("响应没有 body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) break;

      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);

      let event = "message";
      const data = [];

      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }

      if (!data.length) continue;
      const raw = data.join("\n");
      let json;
      try { json = JSON.parse(raw); }
      catch { json = { type: "unparsed", raw }; }

      await onEvent(event, json);
    }
  }
}
```

上面这段只认 `\n`，碰上用 CRLF 的服务端会一帧都切不出来。仓库里的 `lib/sse.mjs` 补上了 CRLF、单独的 `\r`、正好切在两块之间的 `\r\n` 和心跳注释；生产环境还要再补异常断流、最大帧大小、取消信号和原始事件留档。

### 3.3 如何判断假流式

同时记录：

```text
t_request      请求发出
t_headers      收到响应头
t_first_event  收到第一条 SSE
t_first_text   收到第一段可见文本
t_last_text    收到最后一段文本
t_stop         收到最终停止事件
```

如果 `t_first_event` 很早，但中间只有空的 block start/stop，真正文本直到结束前一次性出现，这条上游链路就是“协议上流式、体验上非流式”。客户端无法凭空把它变成真实逐字生成；最多只能做本地假播放，并诚实标注首字延迟。

### 3.4 usage 要同时看开头和结尾

兼容站可能在 `message_start.usage` 返回 0，却在 `message_delta.usage` 给出真实输入和缓存数据。

稳妥做法：每轮对同名 usage 字段取已观测到的最大值，同时保留原始 start/end 两份，防止误加两次。

---

## 4. 工具调用：模型只提出请求，真正执行的是你的程序

### 4.1 定义一个客户端工具

```json
{
  "name": "get_weather",
  "description": "查询指定城市的当前天气。只有用户的问题确实需要实时天气时才调用。",
  "input_schema": {
    "type": "object",
    "properties": {
      "city": {"type": "string"}
    },
    "required": ["city"],
    "additionalProperties": false
  }
}
```

### 4.2 正确的工具循环

```text
1. 发 messages + tools
2. 遍历响应 content
3. 发现 tool_use：本地校验参数并执行
4. 把原 assistant content 完整加入历史
5. 追加一条 user 消息，其中包含对应的 tool_result
6. 再发下一轮
7. 没有 tool_use，或达到回合上限时结束
```

不要只写：

```js
if (message.stop_reason !== "tool_use") break;
```

更稳的是先看事实：

```js
const calls = (message.content || []).filter((b) => b.type === "tool_use");
if (calls.length === 0) break;
```

我们遇到过完整 `tool_use` 块已经返回、`stop_reason` 却写 `end_turn` 的兼容层。信块，不要只信标签。

### 4.3 每个 tool_result 必须按 ID 对回去

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_abc",
      "content": "{\"temperature\":18}",
      "is_error": false
    }
  ]
}
```

一轮里可能有多个工具调用。不要靠数组位置猜，要用 `tool_use_id` 配对。

### 4.4 工具执行的安全底线

- 模型给的参数永远是不可信输入，必须走本地 schema 校验。
- URL 抓取要限制协议、域名、DNS 解析结果和重定向，防 SSRF。
- 文件工具要做 basename、目录边界、扩展名和大小限制。
- shell 参数不能直接字符串拼接；能不用 shell 就不用。
- 读工具和写工具分级；删除、发送、付款等动作需要更高授权。
- 工具回执要限制体积，但不能按字符把 JSON 截成非法结构。

### 4.5 纯写入工具可以少一轮，但不能吞失败

如果第一轮正文已经完整，工具只是“把这段内容保存下来”，可以把它设计成终结型写入：

```text
模型完整说完 + 提出写入动作
→ 服务端执行
→ 全部成功则直接结束
→ 失败、没有正文、或混有读取工具时继续下一轮
```

读取工具不能这样省，因为模型必须看到返回结果才能回答。

### 4.6 要参数一定合法：`strict: true`

模型给的参数大多数时候是对的，但"大多数"不够。在工具定义上加 `strict: true`（和 `name`、`input_schema` 平级，不是放在 `tool_choice` 里），API 会保证 `tool_use.input` 严格符合 schema：

```json
{
  "name": "get_weather",
  "description": "查询指定城市的当前天气。",
  "strict": true,
  "input_schema": {
    "type": "object",
    "properties": {"city": {"type": "string"}},
    "required": ["city"],
    "additionalProperties": false
  }
}
```

schema 必须写 `required` 和 `"additionalProperties": false`。新模型上强制调用（`tool_choice: any` / 指定工具）会直接 400（见 1.6），以前靠强制调用拿合法参数的，现在改成 `auto` + `strict: true` + 在提示词里点名该用哪个工具。`auto` 不保证一定调用，所以还要检查这一轮到底调没调。

`strict` 管的是"参数长什么样"，不管"参数对不对"：城市名合法不代表城市存在。4.4 的本地校验照样要做。

### 4.7 一次叫好几个工具：结果放在同一条消息里

模型默认可以在一条回复里提出多个工具调用（"伦敦和新加坡各多少度"就会一次叫两个）。全部执行完，把**所有** `tool_result` 放进**同一条** user 消息再发回去：

```json
{"role": "user", "content": [
  {"type": "tool_result", "tool_use_id": "toolu_a", "content": "{\"temperature_c\":12}"},
  {"type": "tool_result", "tool_use_id": "toolu_b", "content": "{\"temperature_c\":31}"}
]}
```

拆成两条 user 消息分开回，请求不会报错，但官方说明这会让模型慢慢不再并行调用——之后每个工具都多花一个来回。某个工具失败了，也要回一条 `is_error: true` 的结果，不能直接丢掉，否则下一轮会因为 ID 对不上被拒。

真要求一次只调一个，在 `tool_choice` 里加 `"disable_parallel_tool_use": true`。仓库的 `examples/node-tool-loop/` 就是按这个形状写的。

---

## 5. 错误、重试与幂等

### 5.1 先分类，再决定是否重试

| 情况 | 默认动作 |
|---|---|
| 请求格式错误、模型不存在 | 不自动重试，修配置 |
| key 无效或权限不足 | 不自动重试，报告原文 |
| 额度不足 | 不重试，先处理额度 |
| 限流 | 读取重试提示，指数退避并加随机抖动 |
| 服务过载、网关错误 | 有上限地重试 |
| 客户端超时或断线 | 先查服务端任务是否仍在跑，不要立刻再发一份 |
| 工具写入结果未知 | 先按幂等键查询，不要盲目重做 |

### 5.2 推荐的退避形状

```js
function retryDelay(attempt, retryAfterMs) {
  if (Number.isFinite(retryAfterMs)) return retryAfterMs;
  const cap = Math.min(30_000, 500 * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}
```

必须同时存在：

- 最大尝试次数；
- 整体截止时间；
- 每次失败原文；
- 是否已产生费用或副作用的记录；
- 写操作的幂等键。

### 5.3 失败时不要清掉在途记号

客户端断线不等于远端任务停止。失败恰恰是最需要保留 job ID 的时候。

推荐流程：

```text
创建 job（持久化）
→ 返回 job_id
→ 后端执行并持续写 partial / status
→ 客户端按 job_id 轮询或重连
→ 只有拿到终态后才清客户端在途状态
```

不要把“正在生成”只存在内存变量里。进程重启、App 重开或网络切换后，它一定会与真实状态分岔。

---

## 6. 费用与最小观测

每轮至少记录：

```json
{
  "provider": "api",
  "base_url_id": "relay-a",
  "model": "model-label",
  "api_version": "2026-10-21",
  "stream": true,
  "thinking_mode": "adaptive",
  "input_tokens": 0,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0,
  "output_tokens": 0,
  "tool_count": 0,
  "round_count": 1,
  "request_id": "...",
  "started_at": "...",
  "first_text_ms": 0,
  "total_ms": 0
}
```

### 6.1 三个不要

- 不要把字段缺失渲染成 0。
- 不要把账号级异步账单差值直接当成单次请求成本。
- 不要跨站比较 `input_tokens`，除非先验证它们对同一载荷的计量口径。

### 6.2 Agent 循环为什么会很贵

一个工具回合不仅产生本轮 output；它还会在后续每个回合被重新读入上下文。

```text
上下文 70k × 30 个内部回合 ≈ 210 万处理量
```

因此最有效的优化通常不是在最后一轮省几十个字，而是：

- 减少无意义的内部回合；
- 合并可以一起执行的工具；
- 控制过长的工具结果和思考输出；
- 让稳定前缀真实命中缓存；
- 把“当前上下文大小”和“本轮累计处理量”分开显示。

---

# 第二部分：进阶版

## 7. Prompt Cache：先验证前缀，再评价中转站

### 7.0 怎么开缓存、它值多少钱

缓存的意思是：这一发和上一发**开头一模一样**的那部分，第二次不按全价收。长对话里人格、工具、历史每轮都重发，命中缓存能省下大头。

两种开法：

```json
// 1. 最简单：顶层自动缓存，系统把断点放在最后一个可缓存块上，随对话往后挪
{"cache_control": {"type": "ephemeral"}, "model": "...", "messages": [...]}

// 2. 手动：在具体的块上打标记（system 文本块、工具定义、消息内容块都可以）
{"type": "text", "text": "很长的稳定人格……", "cache_control": {"type": "ephemeral"}}
```

几条硬规则：

| 项目 | 值 |
|---|---|
| 每次请求最多断点 | 4 个（顶层自动缓存也占一个） |
| 最短可缓存长度 | 按模型不同：最新一代 512 token，部分旧模型 1024 / 2048 / 4096。**不够长不会报错，只是 `cache_creation_input_tokens` 一直是 0** |
| 有效期（TTL） | 默认 5 分钟；可设 `"ttl": "1h"`。每次命中都会刷新计时 |
| 写入价格 | 5 分钟档约 1.25 倍输入价；1 小时档约 2 倍 |
| 读取价格 | 约 0.1 倍输入价（Opus 5.5 是 0.05 倍） |
| 混用 TTL | 1 小时的断点必须排在 5 分钟的前面 |

怎么选 TTL：看**同一前缀的两发请求，开始时间隔多久**。几分钟内连着聊，5 分钟档每轮都在刷新，最便宜；对方常常隔二十分钟才回一句，1 小时档才划算。

最稳的组合：在稳定人格 / system 的最后一块打一个显式断点，再开顶层自动缓存兜住不断增长的对话尾巴。

### 7.0.1 实际前缀顺序

```text
tools → system → messages
```

建议布局：

```text
静态工具定义
→ 稳定人格 / 规则
→ 滚动摘要
→ 历史消息断点
→ 当前轮动态状态与用户原话
```

### 7.1 工具顺序必须稳定

外部 MCP 的 `tools/list` 顺序不一定固定。按工具名排序，再把断点挂到排序后的最后一个工具上。

必须记录：

```text
工具数量
序列化长度
工具名顺序
规范化 JSON 的 SHA
```

长度相同、SHA 不同，通常就是顺序或内容变了。

### 7.2 动态事实不能长在工具描述里

“上次按按钮是 42 分钟前”“今天已经保存了哪些记录”这类事实每轮都变。如果它们被拼进工具 description，排在最前面的 tools 会持续变化，后面人格和历史全部失效。

正确位置是当前轮的动态上下文，而且应排在历史缓存断点之后。

### 7.3 判断缓存至少需要两发可比请求

两发必须保持：

- 同一个站；
- 同一个模型标签和版本；
- 同一个 stream 模式；
- 同一个 thinking 配置；
- 同一批工具及顺序；
- 同一份稳定 system；
- 在缓存 TTL 内。

同时读取 `message_start.usage` 和 `message_delta.usage`。

判定至少四态：

```text
命中
明确未命中
写入但读不回来
没测出来 / 看不见
```

中转站接受 `cache_control` 不等于兑现缓存。只有真实 `cache_creation_input_tokens`／`cache_read_input_tokens` 和等价的成本、延迟变化才是证据。

### 7.4 真实使用记录优先于付费探针

探针只证明“探针那份前缀”能否缓存。14k 玩具请求命中，不代表 60k、几十个工具和 thinking 的生产请求也命中。

诊断顺序：

```text
先读已有真实 usage
→ 再看前缀指纹
→ 最后才打最多两发付费探针
```

### 7.5 工具太多：先收起来，用到再拿 [按官方文档 2026-11 核对，未实测]

每个工具的名字、描述和 schema 每轮都算输入 token，而且排在整个前缀的最前面。工具一多，光定义就能吃掉上万 token；官方还提到，可用工具超过三五十个之后，模型挑对工具的准确率也会往下掉。

**工具搜索（tool search）**：把所有工具照常放进 `tools`，不常用的标上 `"defer_loading": true`，再加一个搜索工具。模型一开始只看得到搜索工具和没标 defer 的那几个，需要时自己搜，搜到的定义才加载进上下文：

```json
"tools": [
  {"type": "tool_search_tool_bm25_20251119", "name": "tool_search_tool_bm25"},
  {"name": "get_weather", "description": "…", "input_schema": {…}},
  {"name": "save_letter", "description": "…", "input_schema": {…}, "defer_loading": true},
  {"name": "search_memories", "description": "…", "input_schema": {…}, "defer_loading": true}
]
```

几条要注意的：

- 被收起来的工具**还是要每次都发**完整定义——`defer_loading` 管的是"进不进上下文"，不是"发不发"。API 要靠这份列表去搜、去展开。
- 至少留一个不 defer 的（通常就是搜索工具本身）；全部 defer 直接 400。最常用的三五个也别收，免得每次都先搜一轮。
- 两种搜索：`bm25` 让模型用自然语言搜，`regex` 让模型写正则。名字和描述里多放用户会说的关键词，搜得更准。
- 搜到的工具是"追加"进对话的，不替换前面的内容，**缓存前缀不受影响**。但标了 `defer_loading` 的工具不能再挂 `cache_control`（400），断点要放在没 defer 的工具上。
- 模型那次搜索在响应里是 `server_tool_use` + `tool_search_tool_result` 两个块：原样留在历史里发回去，**不要**给 `srvtoolu_…` 回 `tool_result`，会被拒。
- 不到十个工具、每轮都要用到的，不值得开。

**按模式开关工具**（beta `mid-conversation-tool-changes-2026-07-01`，只在部分新模型上）：工具搜索是"模型自己找"；如果是你的程序知道"现在进了写信模式，只需要这三个"，可以在 `messages` 里追加一条 system 消息，用 `tool_addition` / `tool_removal` 开关工具。要加的工具同样得事先以 `defer_loading: true` 声明。直接改 `tools` 数组会让整个缓存失效，这个办法不会。

中转站不一定支持这些：工具搜索是服务端工具，按模式开关还要 beta 头。先用一发小请求确认它认，再往生产里放。

### 7.6 旧的工具结果：清掉，但要清得值 [按官方文档 2026-11 核对，未实测]

长对话里最占地方的往往不是聊天，而是很多轮以前的工具回执——搜出来的长文本、读过的文件。它们每轮都被重新读一遍、重新计费。

上下文编辑（beta `context-management-2025-06-27`）可以让 API 在服务端把最旧的工具结果换成一句占位说明：

```json
"context_management": {
  "edits": [{
    "type": "clear_tool_uses_20250919",
    "trigger": {"type": "input_tokens", "value": 30000},
    "keep": {"type": "tool_uses", "value": 3},
    "clear_at_least": {"type": "input_tokens", "value": 5000},
    "exclude_tools": ["search_memories"]
  }]
}
```

`trigger` 是上下文超过多少开始清（默认 10 万 token），`keep` 是保留最近几次工具调用（默认 3 次），`exclude_tools` 列出永远不清的工具。

**最要紧的一条：清一次，缓存就断一次。**被清掉的位置之后的前缀全部要重新写缓存。`clear_at_least` 就是为这个存在的——清不到这么多就干脆不清，免得为省几百 token 打掉一整段缓存。和 7.0 的 TTL 一起算账：缓存命中好的长对话，清得太勤反而更贵。

你自己存的历史不会被改，编辑只发生在服务端那一份上；响应里的 `context_management.applied_edits` 会告诉你这次清了几个、省了多少 token。

---

## 8. 生产级任务层：把 Provider 藏在统一合同后面

客户端不要分别直连 API 和 CC。统一入口：

```http
POST /chat/run
{
  "session_id": 42,
  "provider": "api" | "cc",
  "message_id": 123
}
```

Provider 只负责“怎样生成”；以下能力必须留在统一任务层：

- 鉴权；
- 注入上下文；
- job 创建与持久化；
- partial 写入；
- 工具记录；
- 最终消息落库；
- 推送；
- 取消；
- 断线重连；
- 错误状态；
- 客户端展示协议。

Provider 合同可以长这样：

```ts
type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text?: string; tokens?: number }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; result: unknown; isError: boolean }
  | { type: "usage"; usage: NormalizedUsage }
  | { type: "done"; stopReason?: string }
  | { type: "error"; error: NormalizedError };

interface ChatProvider {
  run(input: ProviderInput, emit: (event: ProviderEvent) => Promise<void>): Promise<void>;
  cancel(jobId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}
```

统一合同的价值是：客户端不需要知道 CC 用 stream-json、API 用 SSE；它只认同一套 job 和 partial。

---

## 9. CC 和 API 无缝衔接：真正要解决的八件事

### 9.1 先定义什么叫“无缝”

切换 Provider 后：

1. 用户仍在同一个会话里；
2. 消息仍落同一张共享消息表；
3. 两边看到一致的人格和长期规则；
4. 两边能用同一套业务工具；
5. 用户在 API 线说过的话，切到 CC 后不会失忆；反方向同理；
6. 不重复灌历史，不破坏 CC 自己的缓存；
7. 思考、工具和 usage 不互相污染；
8. 客户端仍然用同一套生成、取消、重连和时间线 UI。

**只加一个 Provider 选择器，不叫无缝。**

### 9.2 推荐架构

```text
                 ┌──────────────────────────┐
App / Web ──────→│ 统一 Chat Gateway         │
                 │ job / partial / auth      │
                 │ injection / persistence   │
                 └───────────┬──────────────┘
                             │ provider adapter
                    ┌────────┴────────┐
                    │                 │
              Messages API       CC Bridge
              SSE + tool loop     persistent session
                    │                 │
                    └────────┬────────┘
                             │
                 shared chat_messages / jobs
```

不要让 App 直接连 CC Bridge。否则 API 和 CC 会各自长出一份鉴权、落库、重连、工具卡、推送和错误处理，迟早分叉。

### 9.3 共享消息库，但不要共享原始 transcript

共享持久层建议至少存：

```sql
message_id
session_id
role
content
provider        -- api / cc
provider_run_id
tool_log
steps
thinking
usage_json
no_ctx
created_at
```

共享 `chat_messages` 解决的是“产品里只有一段聊天记录”。

CC 自己的 session transcript 仍是独立的，因为它承担 CC 的上下文缓存、工具状态和续聊。不要试图让数据库历史完全替代 CC transcript，也不要把整个数据库窗口每轮重新灌给 CC。

### 9.4 双向同步必须用 Provider 水位

[实测] 如果 API 每轮都从共享库读取历史，那么 **CC → API** 天然成立：CC 消息落库后，API 下一轮能看到。

**API → CC** 不会天然成立。CC 常驻 session 只知道写进自己 transcript 的内容；用户两天没走 CC 线，接回来的就是一个停在两天前的模型。

错误修法：切到 CC 时，把共享库最近 N 条全量倒灌。

它会导致：

- CC 自己说过的话被重复一遍；
- 人格和动态注入重复；
- 缓存前缀剧烈变化；
- 越切换历史越胖；
- 很难判断哪条是原消息，哪条是同步副本。

正确做法是给每个 Provider 会话维护水位：

```sql
CREATE TABLE provider_sync_state (
  session_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  last_seen_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, provider)
);
```

切换到 CC 前：

```text
1. 读取 CC 的 last_seen_message_id
2. 查询共享库中 id 更大、且不是该 CC session 自己产生的消息
3. 按原顺序构造一个 catch-up 块
4. catch-up 与当前用户原话分区
5. 成功写入 CC 后，原子推进水位 —— 推到补课块的 through，不要推到本轮自己刚落库的那条：
   等 CC 回话期间，对方可能插进来新消息（比如一条主动推送），推过头就把它跳了
6. 失败时不推进：水位不会丢；但如果写入其实成功、只是响应不明（超时、断线），下次会重复补一遍
```

示意：

```text
<provider_catchup from="api" after="18210" through="18218">
[user] ……
[assistant] ……
</provider_catchup>

━━━ 以上是你切换期间错过的共享对话。下面是用户现在说的话 ━━━
用户当前消息
```

水位必须在同步成功后推进，最好与“已接收 catch-up”的持久标记共同提交，避免进程在两步之间死亡后重复灌入。

### 9.4.1 我们实际跑着的简化版 [实测]

上面是完整设计。我们线上跑的是一个更简单的版本，已经能解决"切回 CC 就失忆"的主要症状：

```text
每条 CC 道持久化一个水位 api_upto_id（随 bridge 状态一起存盘，重启不丢）
第一次运行：只把水位钉到当前最大 id，不补
之后每一轮用户消息进 CC 之前：
  1. 取共享库里 id > 水位 的消息
  2. 剔除 CC 自己产生的：assistant 回复的 usage_json 带 cc 标记；
     user 消息看紧跟它的那条回复是不是 CC 的
  3. 从最新往回取，用户原话每条截 200 字、助手每条截 100 字，总预算 6000 字
  4. 翻回正序，作为一个带说明的块垫在用户原话前面
  5. 推进水位
  补课失败：记日志，放行用户消息（fail-open），绝不因为补课卡住对话
```

第 2 步是踩出来的：最早没有剔除 CC 自己那轮（两条线落库时 `source` 字段一样），结果每轮都把"CC 上一句 + 用户这一句"再垫一遍，纯复读。**去重靠来源标记，不靠文本。**

这个简化版和 9.4 完整设计的差距，照实列出来：

- **水位在构造补课块时就推进了，不是在确认写进 CC 之后。**写入失败时那一段会丢，不会重试。
- **有截断。**API 线一口气聊得太多，超过 6000 字预算的更早部分不会过去；API 线自己的滚动摘要也不会同步给 CC。
- **只同步文字。**图片、工具调用和结果都不带过去。
- 助手消息截得比用户短，是有意的：用户原话是主证据，模型自己的话 CC 读个大意就够。

### 9.5 去重不能只靠文本

同一句“好”可能真的说过两次。建议使用：

```text
共享 message_id
原 provider
provider_run_id
同步批次 id
```

不要只按正文哈希去重；它会误删真实重复表达。

### 9.6 人格、动态注入和用户原话必须分层

两条 Provider 应调用同一份人格生成函数，而不是复制两份文本。验收用规范化文本 SHA：相同人格应得到相同 SHA。

建议分三层：

```text
稳定人格与规则：会话建立时注入，或由 Provider 的 system 机制承担
长期摘要：按水位更新
动态状态：只在需要时增量注入
当前用户原话：永远清楚地放在最后，并有固定分界线
```

我们踩过的两个相反的坑：

- 每轮重复注入整块背景，CC transcript 每轮固定增长数千字符；
- 为了去重，只保留用户原话时又误删了新的主动消息／后台任务增量。

正确做法不是“永远全留”或“永远全删”，而是：稳定背景只注入一次，后续动态事实使用有独立水位的增量块。

### 9.7 聊天道和干活道应分开

CC 常见两种用途：

```text
chat lane：人格、业务工具、长期记忆、用户状态
code lane：代码目录、内建开发工具、较少人格注入
```

干活记录可以留在同一聊天数据库供用户查看，但默认不应进入日常聊天上下文。可以增加 `no_ctx`：

```text
消息仍可见
但普通聊天组历史时过滤 no_ctx=1
用户明确选择“共享到聊天”时再进入上下文
```

只隐藏 assistant、不隐藏对应 user，会留下“一句没人回答的请求”；一问一答必须作为同一个边界处理。

### 9.8 思考协议必须隔离

API 可能返回原生 thinking block；CC headless 可能只给思考 token、签名或自己的降级标记。

不要把 CC 的内部标记原样存进可见正文，再让 API 把它作为历史重读。模型会开始模仿这些标记，原生 thinking 反而消失。

推荐库字段：

```text
content           用户可见正文
thinking          Provider 能合法提供的思考摘要或文本
thinking_tokens   只有数字时就存数字
steps             用户可展示的动作时间线
```

在构造另一 Provider 的历史时，擦掉 Provider 私有协议，只保留可见正文和必要的工具事实。

### 9.9 时间线必须保持单一事件序列

不要分别维护“旁白数组”和“工具数组”。顺序本身就是信息：

```json
[
  {"kind":"text", "text":"我先看一下配置。"},
  {"kind":"tool", "id":"1", "name":"read_file", "input":{}, "result":"..."},
  {"kind":"text", "text":"问题在这里，我来修。"}
]
```

从 Bridge → Gateway → 数据库 → App 的每一层都要保留 `result`、`is_error` 和稳定 step ID。

生成中每次重解析时如果给 step 新建随机 UUID，UI 会把它当成全新行，用户刚展开的工具回执会自动合上。使用 Provider 事件 ID；没有时使用会话内稳定序号。

### 9.10 session 续杯与上下文旋转

CC session 接近上下文上限时：

```text
旧 session 生成交接摘要
→ 验证摘要非空、非拒答、长度合理
→ 附带最后几轮原话
→ 建新 session
→ 写入 seed
→ 验证关键事实仍能回答
→ 才切换 provider_session_id
```

摘要没通过就不推进边界。宁可暂时挤着，也不能把上下文丢掉。

只存“摘要的摘要”会逐轮磨损。更稳的长期方案是定期从有 source message ID 的原始消息重建摘要。

### 9.11 进程生命周期必须认领身份

重启旧 CC 进程后，新进程可能已经启动，旧进程的 exit 回调才姗姗来迟。如果回调无条件执行：

```js
lane.proc = null;
```

它会把新进程的状态抹掉，系统再启动第三个进程。

每个异步回调先认领：

```js
const spawned = spawn(...);
lane.proc = spawned;

spawned.on("exit", () => {
  if (lane.proc !== spawned) return;
  lane.proc = null;
});
```

### 9.12 usage 必须带 Provider 身份

不要为了复用字段，把 CC 订阅线记成某个中转站模型。至少存：

```json
{
  "provider": "cc",
  "provider_session_id": "...",
  "model": "claude-code:opus",
  "source": "subscription",
  "usage": {}
}
```

预算闸不能把 cache read 按普通输入全价累加，否则缓存越好，任务越早被错误截断。预算口径应明确区分：

- 当前上下文水位；
- 本轮累计处理量；
- 计费加权消耗；
- 用户设置的硬预算。

### 9.13 CC/API 无缝切换验收表

| 场景 | 验收 |
|---|---|
| API 聊两轮后切 CC | CC 能回答刚才的话，且共享消息不重复 |
| CC 聊两轮后切 API | API 能看到 CC 正文和必要工具事实 |
| API → CC → API 连切三次 | 消息数只增长真实新增量 |
| CC Bridge 重启 | session ID 可恢复，未生成重复回答 |
| Gateway 重启 | running job 被明确收尾或恢复，不永久卡住 |
| 切换时有图片 | 图片要么被传递，要么明确说明跳过原因 |
| 切换时有工具结果 | 结果与原 tool_use ID 对得上 |
| CC 思考不可见 | UI 显示“思考 N token”或步骤，不伪造文本 |
| code lane 完成任务 | 记录可回看，但默认不污染聊天上下文 |
| 接近上下文上限 | 续杯后能回答指定关键事实和最近语气 |
| API 期间产生新 push | 切回 CC 只补新的增量，不倒灌旧历史 |

---

## 10. 这套无缝方案目前哪些是事实，哪些仍是设计

`[实测]`

- 同一网关入口可把 CC 当作第二个 Provider。
- 两边可共用 job、partial、最终落库、工具记录和客户端 UI。
- CC 消息落入共享消息库后，API 能在下一轮读到。
- 人格可由同一生成函数提供，并用 SHA 核对一致性。
- CC 的步骤与工具回执可映射成统一时间线。
- CC session 可持久化 ID、重启后恢复，并在接近上限时做摘要续杯。
- code lane 的消息可以保留可见、同时用 `no_ctx` 排除出聊天上下文。
- API → CC 的水位增量补课（简化版，见 9.4.1）：持久化水位、按来源标记剔除 CC 自己的消息、有字数预算、失败不阻塞对话。

`[未完成／需要实现后验收]`

- 补课水位改为"确认写入后才推进"（仓库骨架已这样写，线上还没改）。
- 超出预算时，把 API 线的摘要而不是截断的原话交给 CC。
- 图片和工具事实跨 Provider 传递。
- 多次 Provider 切换后的严格无重复证明。
- 图片、并行工具和中途取消在切换边界上的完整测试矩阵。
- 长期多次摘要续杯后的信息磨损评估。

所以公开时可以写“我们做到了共用一套产品链路，两个方向都能接上话”，不能写“已经完全双向无缝”。剩下的缺口在 9.4.1 末尾。

---

## 11. 部署与重启

上线前：

```text
备份目标文件
语法检查
比较差异
检查是否有 running job
确认正确的进程管理器和端口 PID
安全重启
本机健康检查
公网或真实客户端最小回归
观察新增错误日志
```

重启前必须查正在生成的任务。直接重启网关，等于掐掉用户正在说话或正在改代码的那一轮。

如果无法等到空闲：拒绝自动部署，让操作者决定取消、等待或明确中断。不要偷偷重启。

进程管理方式是现场事实，不是永恒文档。以端口 PID、父进程和 cgroup 为准，不要只信一条历史笔记。

---

## 12. 按症状查雷

### 缓存始终为 0

检查顺序：站＋模型＋版本＋stream → start/end usage → tools/system 双哈希 → 工具顺序 → 动态事实位置 → 两发是否在 TTL 内。

### 开着流式却最后一次性吐完

记录第一事件和第一文本时间。只有空事件、最后才有文本，问题在上游链路，不是 UI 刷新频率。

### 模型明明调用过工具，体检却说不会

检查是否使用了 `tool_choice:any`（在 Opus 5.5 / Sonnet 5.5 上它直接 400，探针等于没发出去，见 1.6），是否与 thinking 配置冲突，是否因 `max_tokens` 截断，是否撞上过载。真实使用记录优先。

### HTTP 200 但页面显示失败

检查顶层 `ok:false`、SSE 内联 error 和异步 job 最终状态。

### 退出页面后扣钱但拿不到结果

检查客户端是否在 catch/finally 中清掉了 job ID；服务端是否仍在跑；结果缓存是否足够长；回到前台是否自动续接。

### 点一次出现多条消费记录

先确认“一次功能本来需要几轮”；再查 UI 重建、自动恢复和手动点击是否同时进入。防重复必须在服务端花钱入口做 singleflight。

### 定时任务一直烧钱却没有结果

检查模型是否存在、超时是否短于真实响应、失败是否落盘、是否有指数退避、定时器和手动任务是否会并发跑同一批。

### 第一次请求就拿到空回答

先看 `stop_reason`。是 `max_tokens`：思考把额度吃光了，调大 `max_tokens`（见 1.3.1）。是 `refusal`：被安全分类器拦了，读 `stop_details`。

### 直连官方 401，换中转站就好了（或反过来）

多半是 key 放错了请求头。官方 `Authorization: Bearer` 和 `x-api-key` 都收；中转站往往只认其中一种，按站方规则来（见 1.1.1）。

### 工具一多，每轮又慢又贵

先数工具定义一共多少 token。超过一万或者工具超过十个，考虑把不常用的收起来（7.5）；长对话里旧工具结果堆得多，考虑有节制地清（7.6）。

### 缓存标记加了，`cache_creation_input_tokens` 永远是 0

前缀可能比该模型的最短缓存长度还短——这种情况不报错（见 7.0）。也可能是中转站没兑现，按 7.3 用两发可比请求判断。

### 切到 CC 后像失忆

共享消息库不等于共享 transcript。检查 Provider 水位和 API → CC 增量同步，而不是扩大最近 N 条窗口。

### 切换后思考格式坏掉

检查一条 Provider 的私有 thinking 标记是否进入共享可见正文并被另一条 Provider 模仿。

---

## 13. 开源前的安全边界

必须移除：

- API key、refresh token、Cookie、Bearer 示例真值；
- 真实站点配置和内部域名；
- 生产数据库、消息、人物、健康、位置、图片和信件；
- 真实人格提示词与私密记忆；
- 服务器 IP、内部目录结构和可直接攻击的端点；
- 能默认执行任意 shell 的示例。

建议提供：

- `.env.example`；
- 脱敏 SSE fixtures；
- 本地假的天气／记忆工具；
- 默认只读、显式启用写入的 demo；
- `--dry-run` 和最大付费请求数；
- 机器可读 `--json` 输出；
- 密钥与个人数据扫描脚本；
- “最后验证日期”和 API 版本；
- 每条踩雷的证据等级。

第三方中转站只描述“某匿名通道在某日期的可复现实测”，不要把一次结果写成对某家永久能力或主观诚信的判决。

---

## 14. 这个仓库里有什么

```text
docs/guide.md                 本文
examples/curl/                列模型、最小请求、流式（01～03）
examples/node-basic/          最小非流式请求 + stop_reason 检查
examples/node-streaming/      流式 + 首字时间 + 开头/结尾两份 usage
examples/node-tool-loop/      工具循环：按块判断、参数校验、按 ID 回填、回合上限
examples/dual-provider-skeleton/
                              §9.4 的补课水位骨架 + 不联网的演示
lib/                          上面共用的请求、SSE 解析和流式判定
tools/api-check.mjs           鉴权方式 / 模型名 / 200 里的错误 / stop_reason
tools/stream-check.mjs        真流式还是一次性吐完（也能离线判录好的事件）
tools/tool-check.mjs          有没有真实 tool_use 块、跟 stop_reason 对不对得上
fixtures/                     脱敏的流和响应样本，测试直接读
test/offline.test.mjs         离线测试，每条按它防的那个雷命名
```

缓存体检没有放在这里：它要连发两次可比请求、读两份 usage、给前缀打哈希，单独成了一个仓库——[relay-cache-where-it-breaks](https://github.com/Cheiineeey/relay-cache-where-it-breaks)。第 7 节是它的摘要版。

---

## 15. 官方参考与版本说明

- API 版本：<https://platform.claude.com/docs/en/api/versioning>
- Messages API：<https://platform.claude.com/docs/en/api/messages/create>
- 流式：<https://platform.claude.com/docs/en/build-with-claude/streaming>
- 工具：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview>
- Prompt caching：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- 错误：<https://platform.claude.com/docs/en/api/errors>
- 限流：<https://platform.claude.com/docs/en/api/rate-limits>
- Claude Code CLI：<https://docs.anthropic.com/en/docs/claude-code/cli-usage>

官方文档说明官方行为；本文的中转站、客户端和双 Provider 结论来自特定实现的实测。两者冲突时，先确认你实际请求的 API 版本、模型、站点和响应原文。
