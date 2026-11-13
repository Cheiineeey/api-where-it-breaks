#!/usr/bin/env node
// 流式体检：发一条流式请求，记每个事件的到达时间，判断是不是真的在逐字来。
// 一次付费请求。
//   node --env-file=.env tools/stream-check.mjs          人读的报告
//   node --env-file=.env tools/stream-check.mjs --json   机器读
//   node tools/stream-check.mjs --fixture fixtures/fake-stream.jsonl   不联网，拿录好的事件判
import { readFileSync } from "node:fs";
import { config, headers } from "../lib/client.mjs";
import { frames, bodyChunks, createAccumulator } from "../lib/sse.mjs";
import { streamVerdict } from "../lib/stream-verdict.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const fixture = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : null;

let events = [];
let tHeaders = null;
let usage = null;

if (fixture) {
  events = readFileSync(fixture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
} else {
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
      // 要一个够长的回答，不然文字段太少判断不了
      messages: [{ role: "user", content: "写一段大约两百字的话，描述雨后的街道。" }],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  tHeaders = performance.now() - t0;
  if (!response.ok) {
    const raw = await response.text();
    const out = { verdict: "http_error", status: response.status, body: raw.slice(0, 1000) };
    console.log(asJson ? JSON.stringify(out) : `HTTP ${response.status}\n${out.body}`);
    process.exit(1);
  }
  const acc = createAccumulator();
  for await (const f of frames(bodyChunks(response))) {
    events.push({ t: performance.now() - t0, ...f });
    acc.push(f.event, f.data);
  }
  usage = acc.result().message.usage;
}

const v = { t_headers: tHeaders, ...streamVerdict(events), usage };

if (asJson) {
  console.log(JSON.stringify(v, null, 2));
} else {
  const ms = (x) => (x == null ? "—" : `${Math.round(x)}ms`);
  console.log(`响应头      ${ms(v.t_headers)}`);
  console.log(`第一个事件  ${ms(v.t_first_event)}`);
  console.log(`第一段文字  ${ms(v.t_first_text)}`);
  console.log(`最后一段字  ${ms(v.t_last_text)}`);
  console.log(`message_stop ${ms(v.t_stop)}`);
  console.log(`文字增量    ${v.text_events} 段`);
  console.log(`\n结论：${v.verdict} —— ${v.why}`);
  if (v.verdict === "fake_stream") {
    console.log("这条上游链路协议上是流式，体验上是一次性吐完。客户端没法把它变回真流式。");
  }
}
