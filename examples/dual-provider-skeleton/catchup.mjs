// API → CC 补课的水位骨架（guide §9.4）。
// 跟我们线上的简化版（§9.4.1）比，修掉了两处：
//   1. 水位只在「确认写进对方」之后推进，水位不会丢；但写入成功而响应不明时，重试可能重复补一遍；
//   2. 去重认来源（origin），不认文本 —— 同一句「好」真说两次也不会被吞。
// 存储故意写成内存里的 Map / 数组，换成你自己的数据库时，
// 「读水位 → 写对方 → 推进水位」要放在能原子提交的地方。

export class SharedLog {
  constructor() {
    this.messages = []; // { id, role, origin: "api" | "cc", text }
    this.nextId = 1;
  }
  append(role, origin, text) {
    const m = { id: this.nextId++, role, origin, text };
    this.messages.push(m);
    return m;
  }
  after(id) {
    return this.messages.filter((m) => m.id > id);
  }
}

export class Watermarks {
  constructor() { this.map = new Map(); }
  get(provider) { return this.map.get(provider) ?? 0; }
  set(provider, id) { this.map.set(provider, id); }
}

// 构造补课块。不改水位 —— 只返回「如果写成功，水位应该推到哪」。
export function buildCatchup(log, marks, provider, { budget = 6000, userCap = 400, assistantCap = 200 } = {}) {
  const from = marks.get(provider);
  const pending = log.after(from);
  if (!pending.length) return null;
  const through = pending.at(-1).id;

  // 对方自己产生的那几条，它的 transcript 里本来就有
  const missed = pending.filter((m) => m.origin !== provider);
  if (!missed.length) return { text: null, from, through };

  // 从新往旧取到预算为止，再翻回正序：留下的是离现在最近的那一截
  const lines = [];
  let used = 0;
  let dropped = 0;
  for (const m of [...missed].reverse()) {
    const cap = m.role === "user" ? userCap : assistantCap;
    const body = m.text.replace(/\s+/g, " ").slice(0, cap);
    const line = `[#${m.id} ${m.role}] ${body}`;
    if (used + line.length > budget) { dropped = missed.length - lines.length; break; }
    lines.push(line);
    used += line.length + 1;
  }
  lines.reverse();
  const head = `<provider_catchup from="other" after="${from}" through="${through}">`;
  const note = dropped ? `\n（更早的 ${dropped} 条超出预算没带上）` : "";
  return { text: `${head}\n${lines.join("\n")}${note}\n</provider_catchup>`, from, through, dropped };
}

// 一轮：先补课，再说当前这句。只有对方确认收下了，水位才推进。
export async function sendWithCatchup(log, marks, provider, userText, deliver) {
  const cu = buildCatchup(log, marks, provider);
  const parts = [];
  if (cu?.text) parts.push(cu.text, "━━━ 以上是你切换期间错过的共享对话。下面是用户现在说的话 ━━━");
  parts.push(userText);

  const reply = await deliver(parts.join("\n")); // 抛错 = 没送达，水位不动，下次重补
  if (cu) marks.set(provider, cu.through);

  // 当前这句和回复也落共享库，标上来源；然后水位跟上，免得下一轮把它自己的话补回去
  log.append("user", provider, userText);
  const r = log.append("assistant", provider, reply);
  marks.set(provider, r.id);
  return reply;
}
