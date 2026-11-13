// 判断一条流是「真流式」还是「协议上流式、体验上一次性吐完」（guide §3.3）。
// 输入是带到达时间的事件列表：[{ t: 毫秒, event, data }]，t 从请求发出算起。
// 纯函数，测试直接喂 fixtures/fake-stream.jsonl。

export function streamVerdict(events) {
  const textEvents = events.filter(
    (e) => e.data?.type === "content_block_delta" && e.data.delta?.type === "text_delta" && e.data.delta.text,
  );
  const first = events[0]?.t ?? null;
  const stop = events.find((e) => (e.data?.type || e.event) === "message_stop")?.t ?? null;
  const errors = events.filter((e) => (e.data?.type || e.event) === "error");

  const out = {
    t_first_event: first,
    t_first_text: textEvents[0]?.t ?? null,
    t_last_text: textEvents.at(-1)?.t ?? null,
    t_stop: stop,
    text_events: textEvents.length,
    inline_errors: errors.length,
    verdict: "unknown",
    why: "",
  };

  if (errors.length) {
    out.verdict = "inline_error";
    out.why = "流里有 error 事件 —— HTTP 200 不代表成功";
    return out;
  }
  if (stop == null) {
    out.verdict = "truncated";
    out.why = "没有收到 message_stop，流中途断了";
    return out;
  }
  if (textEvents.length === 0) {
    out.verdict = "no_text";
    out.why = "整条流没有任何文字增量（看 stop_reason：max_tokens 还是 refusal）";
    return out;
  }
  if (textEvents.length < 3) {
    out.verdict = "too_short";
    out.why = "文字增量少于 3 段，回答太短，判断不了 —— 换一个需要多写几句的问题";
    return out;
  }
  const spread = out.t_last_text - out.t_first_text;
  const waited = out.t_first_text - (first ?? 0);
  // 所有文字挤在最后很短的窗口里，而前面等了很久：一次性吐完
  if (spread < 150 && waited > 3 * Math.max(spread, 50)) {
    out.verdict = "fake_stream";
    out.why = `前 ${Math.round(waited)}ms 没有文字，然后 ${textEvents.length} 段文字在 ${Math.round(spread)}ms 内全部到达`;
    return out;
  }
  out.verdict = "real_stream";
  out.why = `${textEvents.length} 段文字分散在 ${Math.round(spread)}ms 里陆续到达`;
  return out;
}
