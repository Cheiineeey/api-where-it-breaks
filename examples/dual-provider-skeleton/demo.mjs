// 不联网的演示：两个假 Provider 轮流说话，看补课块长什么样、失败时水位怎么不动。
// 用法：node examples/dual-provider-skeleton/demo.mjs
import { SharedLog, Watermarks, sendWithCatchup } from "./catchup.mjs";

const log = new SharedLog();
const marks = new Watermarks();

// 假 Provider：把收到的东西打出来，回一句固定的话
const fake = (name, { failOnce = false } = {}) => {
  let failed = false;
  return async (input) => {
    console.log(`\n┌─ ${name} 收到 ─────────────\n${input}\n└────────────────────────`);
    if (failOnce && !failed) { failed = true; throw new Error(`${name} 进程刚好在重启`); }
    return `${name} 的回答`;
  };
};

const api = fake("API");
const cc = fake("CC", { failOnce: true });

await sendWithCatchup(log, marks, "api", "今天把报告第三部分写完了", api);
await sendWithCatchup(log, marks, "api", "好", api);
await sendWithCatchup(log, marks, "api", "好", api); // 真说了两次「好」，不能被当成重复吞掉

try {
  await sendWithCatchup(log, marks, "cc", "我切过来了，你还记得我刚说什么吗", cc);
} catch (e) {
  console.log(`\n✗ ${e.message} —— CC 的水位仍是 ${marks.get("cc")}，下一轮会重新补`);
}

await sendWithCatchup(log, marks, "cc", "我切过来了，你还记得我刚说什么吗", cc);
await sendWithCatchup(log, marks, "api", "又切回来了", api);

console.log("\n水位：", Object.fromEntries(marks.map));
