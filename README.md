# api-where-it-breaks

大模型 API 从第一次请求到长期运行的产品，中间每一个会断的地方。Claude 官方 API、兼容它协议的中转站，以及把 Claude Code（CC）当成第二个 Provider 跟 API 线无缝衔接。

**不是"复制一段 curl 就算接入完成"的教程。**真正的问题都在后面：流式开着却不逐字、工具块回来了却没执行、缓存标记被接受却从没命中、HTTP 200 里藏着错误、切到 CC 之后像失忆。

每条结论都标了证据等级：`[实测]` 是我们在真实请求上撞到的，`[倒推]` 是从现象推出来的，`[未验证]` 就是没验证。没有证据的地方不写成结论。

## 五分钟跑通

需要 Node 22 或更高，没有任何依赖。

```sh
cp .env.example .env        # 填 API_BASE / API_KEY / MODEL
bash examples/curl/01-models.sh            # 先看这个通道真正有哪些模型
node --env-file=.env tools/api-check.mjs   # 鉴权、模型名、最小请求一次体检
```

`api-check` 会告诉你 key 是不是放错了请求头（官方新版推荐 `Authorization: Bearer`，也兼容 `x-api-key`；中转站按站方规则），模型名在不在列表里，回答是不是被截断或拒答。

不想花钱也可以先跑离线测试，它们读的是 `fixtures/` 里录好的流：

```sh
npm test
```

## 往哪读

| 你现在 | 读 |
|---|---|
| 从没碰过 API | [guide §0.5](docs/guide.md#05-从没碰过-api先认识四个词)，然后 §1 |
| 用惯了 CC，想换到 API | [guide §0.6](docs/guide.md#06-从-cc-换过来先看-cc-替你做了什么)：CC 替你做了什么、人格怎么搬、挑客户端、月账怎么估 |
| 第一发请求就 401 / 400 / 空回答 | §1.1.1、§1.3.1、§1.6，或直接 §12 按症状查 |
| 要接流式 | §3 + `examples/node-streaming` + `tools/stream-check.mjs` |
| 要接工具 | §4 + `examples/node-tool-loop` + `tools/tool-check.mjs` |
| 账单太高、缓存不命中 | §6（尤其 §6.4 一轮到底多大）、§7，以及 [relay-cache-where-it-breaks](https://github.com/Cheiineeey/relay-cache-where-it-breaks) |
| 要做长期运行的聊天产品 | §5、§8、§11；前情摘要和日记见 §9.10.1 |
| 要让 CC 和 API 两条线共用一段对话 | §9、§10 + `examples/dual-provider-skeleton` |

全文在 [docs/guide.md](docs/guide.md)。

## 例子和工具

```text
examples/curl/                 01 列模型 · 02 最小请求 · 03 流式
examples/node-basic/           最小非流式请求
examples/node-streaming/       流式 + 首字时间 + 两份 usage
examples/node-tool-loop/       工具循环，本地假天气，不联网
examples/dual-provider-skeleton/  CC ↔ API 补课水位，不联网演示
tools/api-check.mjs            接入体检（1 次付费请求）
tools/stream-check.mjs         真流式还是假流式（1 次；--fixture 离线）
tools/tool-check.mjs           tool_use 块和 stop_reason 对不对得上（1 次）
```

例子都用 `node --env-file=.env <文件>` 运行。三个体检工具都支持 `--json`。

**付费请求都很小**，但仍然是你的钱：每个工具最多一到两次，不会自动重试。

## 验证到哪一步了

2026-11-13 在一个兼容中转站上用 `claude-haiku-5-5` 实际跑过：三个 curl、三个 Node 例子、三个体检工具，结果都符合预期。离线测试 22 条全过。

**没有在官方 API 上直连跑过**——我们手里没有官方 key。鉴权写法按官方文档（2026-11 版：推荐 `Authorization: Bearer`，`x-api-key` 仍兼容）；那个中转站两种请求头都收，所以"放错请求头"这个雷我们没能在真请求上复现。如果你直连官方跑出了不一样的结果，请开 issue。

API 和模型行为按 2026-11-13 核对，对应 `anthropic-version: 2026-10-21`。官方文档和本文冲突时，以官方文档和你自己请求的响应原文为准。

## 这些东西是怎么写出来的

- 代码和文档 —— **Matt**（Claude Opus，Anthropic）；初稿另有 Codex 参与
- 真实现象、产品判断，以及所有"这个数字不对劲"的第一发现 —— **[Elle](https://github.com/Cheiineeey)**

这些坑里有一大半，是她先说"我感觉哪里不对"，我才去查的。

## 许可

- 代码（`examples/`、`lib/`、`tools/`、`test/`、`fixtures/`）：[PolyForm Noncommercial 1.0.0](LICENSE)。
- 文档（README、`docs/`）：[CC BY-NC 4.0](LICENSE-CONTENT)。
- 商业使用须另行取得书面授权，请联系 [Cheiineeey](https://github.com/Cheiineeey)。

详见 [LICENSING.md](LICENSING.md)。
