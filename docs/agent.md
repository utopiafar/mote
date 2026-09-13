# Agent 集成与验证

Mote 的查询和洞察由真正的 DeepSeek Harness 执行。程序提供读取资料的能力，模型决定读什么、如何继续查询、如何解释证据。没有“待办”“工作”“娱乐”等关键词分支，也没有未配置模型时的规则回答。

## 运行配置

服务器读取以下环境变量后传入 `createAgent`：

```dotenv
MOTE_MODEL=你的模型 ID
MOTE_MODEL_BASE_URL=https://api.deepseek.com
MOTE_MODEL_API_KEY=你的模型服务凭据
```

没有模型或凭据时 `configured=false`，`query()` 抛出带 `statusCode=503` 的 `AgentNotConfiguredError`。采集、存档和普通数据浏览可以继续使用。测试与源码不读取用户现有模型凭据。

模型服务需要支持 Chat Completions、SSE 流式输出和 function tools。Harness 的 DeepSeek 适配器接受自定义 `baseURL` 和模型 ID；Mote 关闭默认 thinking，避免假定所有本地模型都支持 DeepSeek 推理字段。不同兼容服务仍需独立验证。调用包 API 时，可显式设置 `allowUnauthenticatedLocal=true` 来使用不需要凭据的 loopback 服务；这个选项不能放行远端无凭据地址。

## 锁定版本

直接依赖准确锁定 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-sdk-client` 和 `@deepseek-ai/dsh-tools` 为 `0.1.5-rc.2`，Cordis 为 `4.0.2`。2026-09-13 查阅时部分包的 npm `latest` 标签仍停在 `0.0.1-rc.1`，因此不要省略版本或拿最新文档配旧包。根目录 lockfile 负责锁定传递依赖。

这是官方开发预览框架；升级需要重新执行下面的真实运行时测试。参考 [SDK 接口](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/sdk/client/README.md) 和 [工具插件契约](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cookbook/adding-a-tool.md)。

## 调用接口

```ts
import { createAgent } from '@mote/agent';

const agent = createAgent({ reader, model, baseUrl, apiKey });
const result = await agent.query({
  question: '我最近的时间主要花在了哪里？',
  after: '2026-09-01T00:00:00+08:00',
  before: '2026-09-14T00:00:00+08:00',
});
// result: { answer, citations, trace, runId }
await agent.close();
```

`ContextReader` 是可替换的数据读取接口：

```ts
interface ContextReader {
  search(args: { query?: string; after?: string; before?: string; deviceId?: string; limit?: number }): Promise<ContextRecord[]>;
  timeline(args: { after?: string; before?: string; deviceId?: string; limit?: number }): Promise<ContextRecord[]>;
  evidence(args: { ids: string[] }): Promise<ContextRecord[]>;
  activity(args: { after?: string; before?: string; deviceId?: string; limit?: number }): Promise<unknown>;
  devices(): Promise<unknown>;
}
```

一条 `ContextRecord` 至少包含 `id`、`capturedAt`、`appName`、`ocrText`。可增加 `summary`、`deviceId`、`sourceType`；这些字段之外的内部路径、对象位置和凭据不会投影到上下文工具结果中。`activity` 和 `devices` 的实现必须返回已经去除凭据的公共统计、设备状态对象。

`search.query` 是模型生成的检索表达式。数据库可以做全文匹配、向量搜索与排序，但不能在 query 外部硬编码用户的语义分类。`activity` 提供确定性测量；模型解释这些测量时应同时指出采样空缺，不能把两个截图之间的所有时间自动视作连续工作。

## 运行与权限边界

每次查询创建独立临时目录、独立 Harness home、独立会话和带随机 256-bit secret 的 loopback HTTP bridge。子进程环境只包含此次显式提供的模型凭据及运行必需字段，不继承用户其他密钥或已有 Harness home。

运行时采用 `sdk-minimal` 并在启动前禁用其 shell 工具及 shell 进程提供者。模型只能看见：

| 工具 | 能力 |
| --- | --- |
| `search_context` | 检索上下文，可由模型改写查询 |
| `timeline` | 按时间读取记录 |
| `evidence` | 展开本次已发现的记录 |
| `activity` | 读取采样活动统计 |
| `devices` | 读取设备采集与上传状态 |

插件额外注册最终拒绝守卫，阻止这些工具之外的执行。插件向 bridge 验证完整工具清单后，才提供 SDK 启动所需的 `moteReady` 服务。整个链路没有模型可调用的文件写入、shell 或任意 URL 工具。这里的边界是工具能力限制及独立运行环境，不把 Harness 自己的 `sandbox-policy` 误称为完整操作系统沙箱。

用户选择的时间范围在 bridge 再次收紧；模型不能通过更宽时间参数扩大范围。`evidence` 只接受本轮检索已经发现的 ID。每次读取有结果数量和字符预算，默认一轮最多 24 次工具调用、120 秒总时限。SDK 无中途取消协议，超时后关闭子进程。结束后清理 bridge、子进程和包含此次临时会话的目录。

捕获内容始终带 `untrusted_personal_context` 来源标记并作为工具结果传入，系统提示要求将其视为证据而非指令。这个安排降低提示注入影响，但 fixture 测试不等于真实模型抵抗所有注入的保证。即使模型被内容诱导，它仍没有归档写入或 shell 工具。

## 回答与洞察

模型产出结构化回答和 `citationIds`。服务只接受本轮实际读取过的 ID，并从记录生成时间、应用与原文摘录。无效 JSON 或虚构引用会报错，不转成规则摘要。`trace` 记录真实工具名、实际参数及数量，便于诊断查了什么。

洞察也通过同一个 Agent 执行入口产生。调度器或用户提供问题与时间范围，模型选择工具并综合记录；对主题、待办、习惯的判断属于模型推理。生产系统将返回结果保存成洞察卡片时，应保存 `runId`、`citations`、时间范围和模型版本，便于回溯。

## 已执行测试与限制

```bash
npm run test -w @mote/agent
```

当前测试覆盖：未配置模型的 503、拒绝虚构引用、禁用 shell 的配置、bridge 鉴权与时间收紧、证据发现限制、内部字段投影，以及真实 `0.1.5-rc.2` Harness 子进程完成 `search_context → evidence → final` 三轮调用。

三轮测试使用本地 synthetic SSE 模型服务及合成记录；逐轮检查模型可见工具恰好为上述五个、采集文本只进入证据消息、返回引用对应真实 fixture 记录。它验证真实 SDK、Cordis 插件、工具调用、传输和引用整条链路，没有将 mock 假称真实 LLM。尚未使用用户模型凭据进行真实模型质量验证，模型检索质量、成本和不同本地服务兼容性需要分别验收。
