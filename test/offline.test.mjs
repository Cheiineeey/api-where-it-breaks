// 全部离线，不花钱：node --test test/
// 每个测试按它防的那个雷命名，而不是按函数名。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { frames, createAccumulator } from "../lib/sse.mjs";
import { streamVerdict } from "../lib/stream-verdict.mjs";
import { bodyError } from "../lib/client.mjs";
import { SharedLog, Watermarks, buildCatchup, sendWithCatchup } from "../examples/dual-provider-skeleton/catchup.mjs";

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

// 把一段文本切成固定大小的块，模拟网络把帧切断
async function* chunked(text, size) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

async function accumulate(text, size = 7) {
  const acc = createAccumulator();
  for await (const { event, data } of frames(chunked(text, size))) acc.push(event, data);
  return acc.result();
}

test("网络把 SSE 帧切成碎块也能拼回同样的文字", async () => {
  for (const size of [1, 3, 7, 64, 100000]) {
    const r = await accumulate(fx("normal-stream.sse"), size);
    assert.equal(r.message.content[0].text, "你好，世界");
    assert.equal(r.message.stop_reason, "end_turn");
  }
});

test("message_delta 已带 stop_reason、但 message_stop 前断流，不算完成", async () => {
  const full = fx("normal-stream.sse");
  const cut = full.slice(0, full.indexOf("event: message_stop"));
  assert.equal((await accumulate(full)).finished, true);
  const r = await accumulate(cut);
  assert.equal(r.message.stop_reason, "end_turn");
  assert.equal(r.finished, false);
});

test("CRLF 换行的流跟 LF 的解析结果一样", async () => {
  const a = await accumulate(fx("normal-stream.sse"));
  const b = await accumulate(fx("normal-stream-crlf.sse"));
  assert.deepEqual(b.message, a.message);
});

test("心跳注释行不会被当成事件", async () => {
  const r = await accumulate(fx("normal-stream.sse"));
  assert.equal(r.unknown.length, 0);
});

test("HTTP 200 的流里夹着 error 事件，不能算成功", async () => {
  const r = await accumulate(fx("inline-error-200.sse"));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].type, "overloaded_error");
  assert.equal(r.finished, false);
});

test("usage 开头是 0、结尾才给真值时，取结尾的", async () => {
  const r = await accumulate(fx("final-usage-only.sse"));
  assert.equal(r.message.usage.input_tokens, 3400);
  assert.equal(r.message.usage.cache_read_input_tokens, 51000);
  assert.equal(r.usageStart.input_tokens, 0); // 原始两份都留着
});

test("usage 开头和结尾都有时不会加两次", async () => {
  const r = await accumulate(fx("normal-stream.sse"));
  assert.equal(r.message.usage.input_tokens, 25);
  assert.equal(r.message.usage.output_tokens, 8);
});

test("工具参数分几段 JSON 增量到达，拼完是完整对象", async () => {
  const r = await accumulate(fx("tool-stream.sse"), 5);
  const call = r.message.content.find((b) => b.type === "tool_use");
  assert.deepEqual(call.input, { city: "London" });
});

test("没见过的 block 类型不会让解析器崩掉", async () => {
  const r = await accumulate(fx("tool-stream.sse"));
  assert.equal(r.message.stop_reason, "tool_use");
  assert.ok(r.message.content.some((b) => b.type === "some_future_block"));
});

test("tool_use 块在、stop_reason 却是 end_turn：按块判断仍要执行", () => {
  const m = JSON.parse(fx("tool-use-end-turn.json"));
  const calls = m.content.filter((b) => b.type === "tool_use");
  assert.equal(m.stop_reason, "end_turn");
  assert.equal(calls.length, 1);
});

test("200 里的顶层 error / ok:false 能被认出来", () => {
  assert.ok(bodyError({ type: "error", error: { type: "overloaded_error" } }));
  assert.ok(bodyError({ ok: false, msg: "额度不足" }));
  assert.equal(bodyError({ type: "message", content: [] }), null);
});

const jsonl = (name) => fx(name).split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("所有文字挤在最后一瞬间到达，判为假流式", () => {
  assert.equal(streamVerdict(jsonl("fake-stream.jsonl")).verdict, "fake_stream");
});

test("等了很久后所有事件一起到达，判为假流式而不是真流式", () => {
  const ev = jsonl("real-stream.jsonl").map((e) => ({ ...e, t: 4000 }));
  assert.equal(streamVerdict(ev).verdict, "fake_stream");
});

test("文字陆续到达，判为真流式", () => {
  assert.equal(streamVerdict(jsonl("real-stream.jsonl")).verdict, "real_stream");
});

test("流没收到 message_stop，判为截断而不是成功", () => {
  const ev = jsonl("real-stream.jsonl").filter((e) => e.data.type !== "message_stop");
  assert.equal(streamVerdict(ev).verdict, "truncated");
});

// ── 双 Provider 补课 ──

test("补课不会把对方自己说过的话再塞回去", () => {
  const log = new SharedLog();
  const marks = new Watermarks();
  log.append("user", "cc", "在 CC 说的");
  log.append("assistant", "cc", "CC 回的");
  log.append("user", "api", "在 API 说的");
  const cu = buildCatchup(log, marks, "cc");
  assert.match(cu.text, /在 API 说的/);
  assert.doesNotMatch(cu.text, /在 CC 说的|CC 回的/);
});

test("同一句话真说了两次，两次都补过去（去重认来源不认文本）", () => {
  const log = new SharedLog();
  log.append("user", "api", "好");
  log.append("user", "api", "好");
  const cu = buildCatchup(log, new Watermarks(), "cc");
  assert.equal(cu.text.match(/\] 好/g).length, 2);
});

test("写入对方失败时水位不动，下一轮重补", async () => {
  const log = new SharedLog();
  const marks = new Watermarks();
  log.append("user", "api", "要补的话");
  await assert.rejects(sendWithCatchup(log, marks, "cc", "嗨", async () => { throw new Error("断了"); }));
  assert.equal(marks.get("cc"), 0);
  let seen = "";
  await sendWithCatchup(log, marks, "cc", "嗨", async (input) => { seen = input; return "回"; });
  assert.match(seen, /要补的话/);
});

test("连切三次，补课只带真正新增的那几条", async () => {
  const log = new SharedLog();
  const marks = new Watermarks();
  const inputs = { api: [], cc: [] };
  const deliver = (p) => async (input) => { inputs[p].push(input); return `${p} 回`; };
  await sendWithCatchup(log, marks, "api", "一", deliver("api"));
  await sendWithCatchup(log, marks, "cc", "二", deliver("cc"));
  await sendWithCatchup(log, marks, "api", "三", deliver("api"));
  await sendWithCatchup(log, marks, "cc", "四", deliver("cc"));
  // 第二次进 CC：只该看到 API 的「三」和它的回答，不该再看到「一」
  const last = inputs.cc.at(-1);
  assert.match(last, /\] 三/);
  assert.doesNotMatch(last, /\] 一/);
  assert.equal(log.messages.length, 8);
});

test("超出预算时丢的是最旧的，并且说明丢了几条", () => {
  const log = new SharedLog();
  for (let i = 1; i <= 50; i++) log.append("user", "api", `第${i}句 ${"字".repeat(100)}`);
  const cu = buildCatchup(log, new Watermarks(), "cc", { budget: 1000 });
  assert.match(cu.text, /第50句/);
  assert.doesNotMatch(cu.text, /第1句 /);
  assert.ok(cu.dropped > 0);
  assert.match(cu.text, /超出预算没带上/);
});
