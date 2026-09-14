# Agent 配置与权限

Mote 的查询和洞察由官方 DeepSeek Harness 执行，通用模型协议通过其 pi-ai 适配层接入。程序提供读取资料的能力，模型决定读什么、如何继续查询、如何解释证据。自然语言问题原样进入 Agent，不按“待办”“工作”“娱乐”等关键词分发。

## 配置模型

在中央网页 **设置 → 问答与回顾 → 模型服务** 选择服务，填写模型 ID 和 API key，保存后立即用于后续问答、回顾和记忆提取；正在执行的请求继续使用原配置。预设、协议、只写凭据和合成连接测试见[模型服务配置](model-providers.md)。

也可以在所选私有 `mote.env` 中提供启动默认值；修改文件需要重启，页面已保存的模型覆盖值仍优先：

```dotenv
MOTE_MODEL_PROVIDER=deepseek
MOTE_MODEL_PROTOCOL=deepseek
MOTE_MODEL=你的模型ID
MOTE_MODEL_BASE_URL=https://api.deepseek.com
MOTE_MODEL_API_KEY=你的模型服务凭据
MOTE_MODEL_REASONING_EFFORT=auto
MOTE_MODEL_HEADERS={}
MOTE_MODEL_EXTRA_BODY={}
MOTE_MODEL_MAX_TOKENS=8192
MOTE_MODEL_TIMEOUT_MS=120000
```

使用 `MOTE_ENV_FILE` 选择独立配置文件，或通过 [环境 CLI](deployment.md) 启动。没有模型或凭据时 `/api/status` 返回 `agent.configured=false`，问答返回 503；采集、笔记、存档与时间线仍可使用。

模型服务需要支持所选协议的流式输出和工具调用，不能把“兼容 OpenAI”理解成支持每个模型及参数。可选 DeepSeek、Chat Completions、Responses、Anthropic Messages、Google 原生 Gemini 五种协议。推理强度通常用 `auto` 交给模型决定；DeepSeek 预设保留既有的 `high` 默认，也可改成 `auto`。其余 `off`、`low`、`high`、`max` 需模型支持。输出预算默认 8192 token，范围 1–128000，实际不得超过所选模型限制；提高预算可能增加耗时和费用。

显式设置 `MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL=1` 可使用无需凭据的 loopback 模型服务。它不允许远端免密地址；容器内的 loopback 指容器自身。

可选 `MOTE_EMBEDDING_MODEL`、`MOTE_EMBEDDING_BASE_URL`、`MOTE_EMBEDDING_API_KEY` 在中央节点启用向量索引。未启用时仍有本地全文/文本检索。问答向所选模型发送检索到的文本证据；embedding 则向其独立配置的服务发送待索引文本。原始截图不在只读 Agent 工具的返回内容中。

## 检索与证据

| 工具 | 行为 |
|---|---|
| `search_context` | 使用模型生成的查询表达式检索，可带时间、设备和数量范围 |
| `timeline` | 按事件时间分页读取，返回后续游标与范围内记录总数 |
| `evidence` | 展开本次已经发现的记录，长文按字符偏移继续读取 |
| `activity` | 读取实际采样时间的覆盖统计 |
| `devices` | 读取设备采集与上传状态 |

用户在界面选择的时间与设备范围在工具桥再次收紧，模型不能扩大范围。问题的时区随查询传入，用于解释“今天”“这周”等相对时间。时间线区分当前页和总记录数；长文显示已返回片段与完整长度，模型需要继续调用工具才能读完。

`evidence` 只接受当前查询实际发现的 ID。失败或超过预算的读取不会将其结果变成允许引用的证据。工具结果只包含公共记录字段、时间和统计，不包含内部磁盘位置或凭据。

采样统计按设备合并重叠区间，并裁剪到查询窗口。采样空缺不填充为活动；跨设备同时存在的记录也不意味着独立的人小时。模型根据这些测量解释趋势，而不是由程序判断行为价值。

## 回答与回顾

模型返回结构化回答和 `citationIds`，服务校验引用确实属于本轮读取的记录，再生成时间、来源与原文摘录。正文中的引用也需要对应有效证据，界面点击后可展开原文。

输出格式错误时，可在同一会话内有限地要求模型修复格式；无效引用或最终仍无法验证的回答会报错。程序不会把失败回答改写成规则摘要。`trace` 是当前运行的实际工具名、参数与结果数量，`runId` 用于追踪该次回答。

个人回顾使用相同的 Agent 入口。`MOTE_INSIGHT_INTERVAL_HOURS=0` 默认关闭周期回顾；设为非零后由中央节点调度，使用已配置模型。主题、习惯和待办判断属于模型推理，不是检索关键词的固定映射。

遇到问题可在 [运行诊断](troubleshooting.md) 用 HTTP 请求编号检查 Agent 开始、完成、耗时与错误类别。诊断日志不保存模型对话或工具参数；界面中的“检索过程”属于有访问权限的回答详情。

## 隔离与能力边界

每次查询创建独立临时目录、Harness home 和会话，通过带随机 256-bit secret 的 loopback bridge 读取中央资料。子进程环境只包含显式提供的模型配置和运行必需字段，不继承其他模型密钥或已有 Harness home。

运行时使用 `sdk-minimal`，启动前禁用 shell 工具和 shell 进程提供者，并核对工具表只包含本文列出的 Mote 只读能力。插件守卫拒绝其他工具。模型没有归档写入、删除、文件系统、shell、对外发消息或任意 URL 请求能力。这是工具权限和会话环境隔离，不等同完整操作系统沙箱。

捕获内容带 `untrusted_personal_context` 来源标记，通过工具结果提供，始终作为证据。该安排不能保证模型绝不受提示注入误导，但其工具权限不能因此扩大。

每轮默认最多 24 次工具调用、120 秒运行期限，并限制工具返回数量和字符数。`MOTE_MODEL_TIMEOUT_MS` 可设置为 5000–600000 毫秒整数，查询、洞察与记忆提取共用；页面保存后立即生效，直接改环境文件则需重启并确认没有页面覆盖值。Web 从 `/api/status.agent.timeoutMs` 读取生效值，为这些模型操作预留额外 60 秒用于传输和清理，普通请求保持原期限。反向代理仍可能在更短时间断开，延长 Agent 期限不等于延长公网入口限制。超时关闭子进程；结束后清理 bridge、会话目录与子进程。客户端超时、模型容量、输出预算和源记录完整性需要一起考虑，不能仅凭 HTTP 200 判断答案语义完整。

## 扩展与验证

`@mote/agent` 暴露 `createAgent({reader, provider, protocol, model, baseUrl, apiKey, headers, extraBody, reasoningEffort, maxTokens, timeoutMs})`。`ContextReader` 提供 `search`、`timeline`、`evidence`、`activity`、`devices`，实现见 [类型定义](../packages/agent/src/types.ts)。存储或检索引擎可替换，工具权限与证据 ID 保持稳定；关闭时调用 `agent.close()`。

`@deepseek-ai/dsh`、SDK 和工具包固定为 `0.1.5-rc.2`，Cordis 固定为 `4.0.2`，通用协议使用同版本 `@deepseek-ai/dsh-llm-pi-ai`，传递依赖由 lockfile 锁定。升级框架时需重新验证工具清单、只读限制、会话清理和引用校验。官方契约见 [SDK](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/sdk/client/README.md) 和 [工具插件](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cookbook/adding-a-tool.md)。

```sh
npm run build:libs
npm run test -w @mote/agent
```

自动化测试使用合成记录与模型响应，运行真实 Harness 子进程，验证工具循环、权限和协议；本轮多厂商预设未逐一执行厂商实网调用。真实 DeepSeek 调用、复杂日记输入和答案质量的结果另见 [真实模型验证](live-validation.md)；其中仍有部分语义覆盖不完整的案例，不能把协议测试或格式修复等同于回答质量保证。

## 分层发现与原始证据

Agent 额外拥有只读的 `sources`、`source_items`、`source_history`、`memories`：先发现来源、当前版本或 Memory 标题，再按需读取详情与原始证据。日历工具的时间范围按计划时间匹配，普通时间线按观察时间；取消或移除的来源记录可以显式包含在查询中。历史工具允许比较旧稿，不会把旧稿当作当前版本。

Memory 提取使用同一 Harness 只读运行时生成结构化候选；每条记忆的正文引用还要与自身证据列表一致。模型结果无法新增工具或执行被采集内容中的指令。外部 MCP 的受限写回是独立认证入口，不属于内部查询 Agent 的工具集。
