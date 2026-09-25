# 中央模型服务

在中央网页打开 **系统管理 → 模型 → 模型 Provider**，点击 **新增预设**，选择服务商类型，填写连接地址、凭据并从目录选择默认模型（也可手动填写 ID），点击 **保存并应用**。一套连接预设保存一组协议、地址、凭据和默认模型；多个模块可以共享它，同时选择不同模型，无需重复保存密钥。

**系统管理 → 模型 → 模块与模型** 分别配置 Chat、Memory、个人回顾、资料导入和文件分析。每个模块选择 Provider 预设后，可以 **跟随预设默认** 或 **指定此 Provider 下的模型**。目录来自所选连接；不支持目录的服务仍可手动填 ID。换预设会清除该模块之前的模型覆盖，避免把另一个服务的模型 ID 带过去。

问答、记忆、洞察入口继续保留 **本次模型**。优先级为：本次明确指定模型 → 本次明确选择预设的默认模型 → 模块指定模型 → 模块所选预设默认模型。没有按内容、关键词或模型失败自动切换供应商的逻辑。

**部署配置** 是单独的只读预设（ID `env:deployment`），始终对应本次启动读取的配置文件或环境变量；不能在页面改写或删除。可以直接分配给模块，或通过 **复制预设** 创建可编辑副本。修改部署文件需要重启；副本不会跟随原件变动。旧版页面保存的 `default` 保留为 **旧版默认预设**，已有分配与凭据继续有效。保留旧版顶层写入 API 兼容旧客户端，但它仅编辑旧版预设，不会修改只读部署预设。

预设可以命名、编辑、复制、删除。复制默认包含凭据，也可以取消勾选；整个复制发生在服务器内部，不把密钥回传浏览器。副本独立持久化，更换地址后仍需确认凭据复用。最多 30 个自定义项，另有部署配置及可能存在的旧版默认项。仍被模块引用的预设不可删除。

新请求使用已保存的新配置，执行中的单次请求继续使用原运行时，不需要重启。问答结果保存 `modelSelection`，历史回答可查看实际使用的预设和模型。手动记忆任务保存选定预设及模块的显式模型覆盖；预设被删除时任务等待重新配置，不会静默换供应商。每个批次使用当时该预设的连接快照。文件处理器显式设置的模型与本地处理限制继续优先。

设计参考了 [Open WebUI 的连接管理](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/)与[模型预设复制](https://docs.openwebui.com/features/workspace/models/)。Mote 采用“可复用连接 + 模块模型绑定”，不在连接预设里加入提示词、资料权限或 Agent 工具权限。

模型名称留给用户填写，因为可用模型、地域、账户授权和工具调用能力会变化。没有配置模型时，采集、同步、笔记和资料归档仍可使用。这里配置的是中央模型服务；客户端截图审查和 embedding 索引仍使用独立设置。

## 保存、测试与凭据

API key、自定义请求头和高级请求参数只显示“已配置／未配置”，不会读取旧值回填。每项可选择不改动、填写新值或清除；请求头和高级参数按整个 JSON 对象替换。未保存的输入只保存在当前页面内存，成功保存后清空敏感输入。

更换服务商、协议或服务地址时，如果仍保留任一已有密钥、请求头或高级参数，需要明确勾选允许复用，也可以改为填写新值或清除旧值。这项确认对“测试连接”和保存都生效。

**测试连接**由中央节点向所填模型发送少量固定合成内容，并使用独立的合成记录验证工具调用和引用。测试不连接个人资料库，不上传个人截图、OCR 或笔记，也不会保存草稿；请求可能产生模型费用。测试最多采用 30 秒 Agent 期限，若设置更短则使用较短期限。测试成功表明本次连接和工具往返通过，不代表全部问题的回答质量或长期可用性。

**恢复部署配置**是旧版默认预设的兼容操作：清除 `default` 覆盖并回到启动配置，保留自定义预设与模块分配。该项立即使用本次中央启动时读取的环境配置。它不会编辑 `mote.env`；如果刚修改过该文件，需要重启中央才能读到新文件内容。并发修改发生版本冲突时，先重新读取当前配置，再决定是否重做修改。

## 服务预设

当前有 24 项预设，包含自定义入口、本机服务及腾讯混元原平台。预设只是填写地址和协议的起点，不表示该平台的所有模型都支持 Mote 所需的流式工具调用。地址仍可修改；模型 ID 以对应控制台为准。

表中的 Chat、Responses、Messages、Gemini 分别对应下一节的协议。正式远程 API 都需要对应服务的 API key；Azure 使用资源 API key，Ollama、LM Studio 可显式启用本机免密。

| 服务 / provider ID | 默认协议 | BaseURL | 官方接入资料 |
|---|---|---|---|
| 本机 Codex / `codex` | Codex App Server | 无 HTTP 地址 | [官方 App Server](https://developers.openai.com/codex/app-server) |
| 自定义 / `custom` | Chat | 用户填写 | 选择下列已支持协议 |
| DeepSeek / `deepseek` | DeepSeek | `https://api.deepseek.com` | [API](https://api-docs.deepseek.com/) |
| 阿里百炼 / `qwen` | Chat | `https://dashscope.aliyuncs.com/compatible-mode/v1` | [OpenAI 兼容](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) |
| 火山方舟 / `ark` | Chat | `https://ark.cn-beijing.volces.com/api/v3` | [接入说明](https://www.volcengine.com/docs/82379/1795150) |
| 智谱 GLM / `glm` | Chat | `https://open.bigmodel.cn/api/paas/v4` | [工具调用](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling) |
| Kimi / `kimi` | Chat | `https://api.moonshot.cn/v1` | [Chat API](https://platform.kimi.com/docs/api/chat) |
| MiniMax / `minimax` | Chat | `https://api.minimax.cn/v1` | [OpenAI 兼容](https://platform.minimax.cn/docs/api-reference/text-chat-openai) |
| 百度千帆 / `qianfan` | Chat | `https://qianfan.baidubce.com/v2` | [Chat API](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb) |
| 腾讯 TokenHub / `tencent-tokenhub` | Chat | `https://tokenhub.tencentmaas.com/v1` | [接入说明](https://cloud.tencent.com/document/product/1823/130058) |
| 腾讯混元原平台 / `hunyuan` | Chat | `https://api.hunyuan.cloud.tencent.com/v1` | [兼容接口](https://cloud.tencent.com/document/product/1729/111007) |
| 硅基流动 / `siliconflow` | Chat | `https://api.siliconflow.cn/v1` | [Chat API](https://docs.siliconflow.cn/docs/api/chat-completions-post) |
| 讯飞星火 / `spark` | Chat | `https://spark-api-open.xf-yun.com/x2` | [Spark-X2 HTTP](https://www.xfyun.cn/doc/spark/X1http.html) |
| 阶跃星辰 / `stepfun` | Chat | `https://api.stepfun.com/v1` | [Chat API](https://platform.stepfun.com/docs/zh/api-reference/chat/chat-completion-create) |
| OpenAI / `openai` | Responses | `https://api.openai.com/v1` | [Responses](https://developers.openai.com/api/docs/guides/text) |
| Anthropic Claude / `anthropic` | Messages | `https://api.anthropic.com` | [API](https://platform.claude.com/docs/en/api/overview) |
| Google Gemini / `gemini` | Gemini | `https://generativelanguage.googleapis.com/v1beta` | [工具调用](https://ai.google.dev/gemini-api/docs/function-calling) |
| Azure OpenAI / `azure-openai` | Chat | `https://资源名.openai.azure.com/openai/v1` | [v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/latest) |
| xAI Grok / `xai` | Responses | `https://api.x.ai/v1` | [Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses) |
| Mistral / `mistral` | Chat | `https://api.mistral.ai/v1` | [Chat API](https://docs.mistral.ai/api/endpoint/chat) |
| Groq / `groq` | Chat | `https://api.groq.com/openai/v1` | [OpenAI 兼容](https://console.groq.com/docs/openai) |
| OpenRouter / `openrouter` | Chat | `https://openrouter.ai/api/v1` | [快速开始](https://openrouter.ai/docs/quickstart) |
| Ollama / `ollama` | Chat | `http://localhost:11434/v1` | [兼容范围](https://docs.ollama.com/api/openai-compatibility) |
| LM Studio / `lm-studio` | Chat | `http://localhost:1234/v1` | [工具调用](https://lmstudio.ai/docs/developer/openai-compat/tools) |

阿里提供按 Workspace ID 和地域区分的地址，例如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；原 DashScope 地址仍可使用，密钥必须与地域匹配。[地域说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)

方舟的模型栏可填写模型 ID 或推理接入点 ID。Azure 的模型栏填写部署名称，Mote 将填写的 API key 放入 `api-key` 请求头。千帆使用新版 Bearer API Key，不使用旧版 OAuth `access_token`。[方舟](https://www.volcengine.com/docs/82379/1795150)、[Azure](https://learn.microsoft.com/en-us/azure/foundry/openai/latest)、[千帆认证](https://cloud.baidu.com/doc/qianfan-api/s/ym9chdsy5)

腾讯建议新接入使用 TokenHub；从原混元平台迁移需要同时更换地址和新建的 API key。MiniMax 当前官方地址为 `api.minimax.cn`；使用其 Messages 接口时，将协议改为 `anthropic-messages`，地址改为 `https://api.minimax.cn/anthropic`。[腾讯迁移](https://cloud.tencent.com/document/product/1823/131382)、[MiniMax Messages](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)

星火的 API key 栏填写 HTTP 服务的 **APIPassword**，通过 Bearer 认证；预设地址对应 X2，其他版本按控制台选择地址。阶跃星辰的按量 API 与 Step Plan 套餐地址不同，使用套餐时改为 `https://api.stepfun.com/step_plan/v1` 并选择套餐可用模型。[星火认证](https://www.xfyun.cn/doc/spark/X1http.html)、[阶跃接入](https://platform.stepfun.com/docs/zh/api-reference/chat/chat-completion-create)

## 协议与高级选项

| 协议值 | 用途 |
|---|---|
| `codex-app-server` | 通过服务器本机 Codex CLI 的 App Server stdio 协议与本机登录调用 Codex |
| `deepseek` | DeepSeek 官方适配，处理其思考与多轮工具调用格式 |
| `openai-completions` | OpenAI Chat Completions，以及实现相同消息、流式和工具格式的兼容服务 |
| `openai-responses` | OpenAI Responses 格式的文本和工具往返；Mote 固定关闭服务端会话存储参数 |
| `anthropic-messages` | Anthropic Messages 的消息块、工具调用和流式事件 |
| `google-generative-ai` | Google 原生 Gemini API，保留工具调用所需的思考签名 |

HTTP 模型协议使用 DeepSeek Harness 和 pi-ai；Codex 使用独立 App Server 适配器。两者共享证据工具定义、宿主范围限制与最终引用校验。选择协议不增加模型工具权限。这里只支持上述协议，不是任意请求／响应 JSON 的字段映射器；使用其他协议需要新增适配代码。

BaseURL 应填写服务基址，不是具体推理方法的完整 URL。保留厂商要求的 `/v1`、`/api/v3` 等路径前缀，不要自行给所有厂商补 `/v1`。地址禁止用户名、密码、查询参数和 fragment；远程必须使用 HTTPS，仅 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP。模型请求拒绝重定向。

远程配置必须填写 API key，即使自定义请求头另有认证字段也不能省略此栏。无需密钥的本机模型必须显式允许免密；“本机”指中央节点所在机器，Docker 的回环地址指容器自身。Mote 不自动启动本地模型服务或下载模型。

推理强度通常选择 **由模型决定（`auto`）**，避免发送模型不接受的通用推理字段。也可按所选模型支持情况设置 `off`、`low`、`high`、`max`；DeepSeek 预设保留既有的 `high` 默认值，仍可改成 `auto`。这些选项不保证每个平台的含义相同，也不保证每个思考模型都能关闭推理。

自定义请求头是字符串键值 JSON 对象；高级参数是符合当前协议的 JSON 对象，例如模型支持时的 `{"temperature":0.7}`。它们可以包含凭据，因此同样只写入、不回显。Mote 拒绝用这些参数覆盖模型名称、消息、系统提示、工具、输出上限、请求目的地或受保护传输头；输出上限应在专门的设置项修改。

Chat 协议下，OpenAI、Azure 和 MiniMax 使用 `max_completion_tokens`，其余预设使用 `max_tokens`。自定义网关若要求前一种字段，可选择 OpenAI 预设后编辑服务地址。MiniMax 默认加入 `reasoning_split:true`，使思考内容与最终回答分离；可通过高级参数显式覆盖，该参数不关闭思考。

模型能力仍需分别确认，尤其是工具调用与流式能否同时使用、思考内容是否需要在多轮工具中保留、输出 token 的计数方式，以及采样参数是否支持。例如部分 Qwen 思考模型要求流式，MiniMax 的 `reasoning_split` 只改变输出格式，千帆的两种输出 token 上限统计范围不同。[Qwen 思考](https://help.aliyun.com/zh/model-studio/deep-thinking)、[MiniMax 参数](https://platform.minimax.cn/docs/api-reference/text-chat-openai)、[千帆参数](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)

## 本机 Codex

选择 **本机 Codex** 预设，填写服务器账户可用的准确模型 ID，保存后即可分配给 Chat、Memory、回顾、导入或文件分析。它是调用官方 `codex app-server --listen stdio://`，不是访问桌面应用内部接口，也不是本地离线推理；选中的上下文仍会交给 Codex 上游模型。[官方 App Server 协议](https://developers.openai.com/codex/app-server)

前提是 **运行中央节点的系统用户** 已安装 Codex CLI，并有文件形式的 Codex 登录凭据。网页不填写 Codex API key。只有桌面应用已登录、凭据仅在系统钥匙串时，还需要为服务器用户设置 CLI 的文件登录存储并登录：

```sh
codex -c 'cli_auth_credentials_store="file"' login
```

默认从服务器进程的 `CODEX_HOME` 或该用户的 `~/.codex` 获取登录文件。可用服务器环境变量 `MOTE_CODEX_BIN` 指定可信 Codex 可执行文件，`MOTE_CODEX_HOME` 指定已有登录目录。这两个宿主配置不接受网页输入、模型参数或模型工具修改。Docker 部署需要容器内有 CLI 与受保护的可访问登录文件；宿主桌面程序的存在本身不够。

每次请求启动独立进程和临时 home，只链接登录文件，不继承个人 MCP、插件、hooks、历史会话或用户指令。查询使用只读沙箱、关闭环境访问与原生执行工具，动态工具仅调用 Mote 已有证据桥。当前验证过的 Codex 0.154.0 还会提供仅修改临时运行计划的 `update_plan`，不访问或修改用户资料。导入有单独的可写临时工作区，不接入归档查询工具；仍须经过原有预览、确认和宿主校验。

App Server 的动态工具接口为实验接口，兼容性取决于安装的 CLI。配置警告、额外审批请求、未知执行工具和错误返回会终止请求；不会降级为另一个服务商。设置中的“单次模型请求超时”对 Codex Server 不适用：App Server 不把内部模型生成作为 Mote 可见的单次 Provider 请求；Mote 只可选择是否设置“Agent 总运行超时”，它覆盖整个 `turn` 及其中的工具循环，留空则不设置 Mote 总期限。响应字节预算仍由 Mote 限制，输出 token 上限由 Codex 管理，页面的 HTTP 输出预算不传给 Codex。设置页从本机 `model/list` 读取所选模型的 `supportedReasoningEfforts` 和 `defaultReasoningEffort`；`auto` 不指定推理强度，旧设置 `off` 对应 App Server 的 `none`，其余挡位按原值传给 `turn/start.effort`。目录不可用或手动填写目录外模型时，页面仍显示通用选项，具体支持情况须通过测试连接验证。

## 环境配置与保存位置

也可以在所选私有 `mote.env` 中设置默认值。修改环境文件后重启中央；部署配置保持只读；页面自定义预设与模块分配独立持久化。旧版默认预设的覆盖仅用于兼容旧版入口。

```dotenv
MOTE_MODEL_PROVIDER=qwen
MOTE_MODEL_PROTOCOL=openai-completions
MOTE_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MOTE_MODEL=填写控制台提供的模型ID
MOTE_MODEL_API_KEY=填写该地域的API密钥
MOTE_MODEL_REASONING_EFFORT=auto
MOTE_MODEL_MAX_TOKENS=65536
MOTE_MODEL_REQUEST_TIMEOUT_MS=300000
MOTE_AGENT_TIMEOUT_MS=600000
MOTE_MODEL_HEADERS={}
MOTE_MODEL_EXTRA_BODY={}
MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL=0
```

`MOTE_MODEL_PROVIDER` 使用上表 ID，未设时为 `deepseek`；`MOTE_MODEL_PROTOCOL` 未设时采用该预设协议。`MOTE_MODEL_HEADERS` 和 `MOTE_MODEL_EXTRA_BODY` 必须是 JSON 对象，每个环境变量最多 16 KiB。不要用 shell 的 `source` 执行配置文件；不要将真实密钥放进命令参数或提交到仓库。完整默认值见[服务端配置参考](server-configuration.md)。

页面保存的值位于 `<MOTE_DATA_DIR>/model-settings.json`，文件权限为 `0600`。该文件沿用 version 1，包含可选 `profiles`、`defaults` 和 `defaultModels`，旧文件无需迁移。`defaults` 保存模块的预设 ID，`defaultModels` 保存模块显式指定的模型 ID；缺省跟随预设默认。只读部署预设不把环境凭据额外写入此文件；仅在主动复制时持久化副本。保存多个配置后不要直接降级到不认识这些字段的旧服务端。文件包含每套配置的真实 API key、请求头和高级参数；权限限制不等于文件内容加密。若自行复制或备份此文件，副本也包含密钥，需作为私有凭据管理。HTTP 资料导出、安全支持包和标准 CLI 归档备份不包含该文件；迁移模型设置需单独保护并转移该文件，或在新节点重新填写。

保存先验证配置并准备新运行时，再原子替换文件、同步目录，最后切换后续请求。恢复部署配置仍保存递增 revision 的空覆盖标记，防止旧页面覆盖新状态。文件损坏或不可读时不会静默恢复成另一套模型凭据；若写入结果无法确认，页面提示重新读取或检查服务状态。

## 所有者 API

这些接口仅允许中央所有者认证，采集凭据和 MCP 凭据不能使用。读取结果设置为不缓存，成功与错误响应均不回传密钥或底层模型错误文本。

| 方法与路径 | 行为 |
|---|---|
| `GET /api/model-settings` | 返回 `version:1`、`revision`、`source:environment\|saved` 和默认项的公开设置、新增 `profiles`（含 `readOnly/source`）、`defaults`、`defaultModels`；所有配置的敏感字段只有 `apiKeyConfigured`、`headersConfigured`、`extraBodyConfigured` |
| `PUT /api/model-settings` | 接受 `{revision, settings, allowCredentialReuse?}`；基础模型参数完整提交，敏感字段可省略或设为 `null` |
| `POST /api/model-settings/test` | 与 PUT 相同的草稿和确认规则；返回固定 `ok/code/message/durationMs`，不修改持久配置 |
| `DELETE /api/model-settings` | 接受 `{revision}`；恢复本次启动的环境模型配置并递增 revision |
| `PUT /api/model-settings/profiles/:id` | 接受 `{revision,name,settings,allowCredentialReuse?}`；创建或更新一套独立配置 |
| `DELETE /api/model-settings/profiles/:id` | 接受 `{revision}`；正在被功能默认值引用的项不能删除 |
| `POST /api/model-settings/profiles/:id/test` | 接受 `{revision,settings,allowCredentialReuse?}`；仅使用该项的凭据和合成记录 |
| `POST /api/model-settings/profiles/:id/copy` | 接受 `{revision,id,name,includeCredentials?}`；目标必须为新 ID，在服务器内部复制，默认包含凭据 |
| `POST /api/model-settings/profiles/:id/models` | 接受与测试相同的草稿，以该预设的凭据加载目录；Codex 自动调用本机 `model/list` |
| `GET /api/model-settings/profiles/:id/models` | 使用已保存连接加载目录；模块选择器与本次模型入口共用 |
| `PUT /api/model-settings/defaults` | 接受 `{revision,defaults:{chat,memory,insight,import,file},defaultModels?:{chat?,memory?,insight?,import?,file?}}`；预设与模型覆盖整组原子保存 |

配置 ID 为 1–80 个字母、数字、下划线或连字符，以字母或数字开头；`default` 保留给原始默认项。所有修改共用一个 revision，防止并发页面互相覆盖。`POST /api/query`、`/api/insights`、`/api/insight-runs`、`/api/memories/extract`、`/api/memory-jobs` 支持可选 `modelProfileId`；不存在的 ID 会返回错误，省略时采用相应功能默认值。每次问答的显式选择只影响这一轮，不修改功能默认值。

`settings` 的基础字段为 `provider`、`protocol`、`baseUrl`、`model`、`reasoningEffort`、`maxTokens`、`modelRequestTimeoutMs`、`agentTimeoutMs`、`allowUnauthenticatedLocal`。`provider` 必须是注册预设 ID，未列出的服务使用 `custom`。模型名称可留空关闭 AI；HTTP 协议只允许在模型也为空时省略实际地址内容；Codex 的地址必须为空，不能设置 HTTP 密钥、请求头或高级参数。非 Codex 的 `modelRequestTimeoutMs` 为 5000–600000 毫秒整数，`agentTimeoutMs` 为 5000–3600000 毫秒整数；Codex 的 `modelRequestTimeoutMs` 为 `null`，`agentTimeoutMs` 可为 `null`。

在「系统管理 → 模型 → 高级设置」调整输出预算。默认值为 **65,536 tokens**，提供 8,192、16,384、32,768、65,536、128,000 档位和自定义输入；保存后立即生效，重启后保留。已显式保存或在环境文件设置的旧值不会因软件升级被覆盖。单次响应预算包含正文、HTML 和服务商计入的推理 token，不是整个 Agent 任务的累计用量，也不等于字数、图片尺寸或文件大小。达到输出上限时会尝试一次更简短的完整回答；仍失败会显示明确的输出超限提示。

预算选择与真实模型复现记录见[回答截断与输出预算](query-output-budget.md)。

`apiKey`、`headers`、`extraBody` 省略表示保留当前值，`null` 表示清除，提供新值表示整体替换。修改 provider、protocol 或 baseUrl 后，任何保留的非空敏感字段都需要 `allowCredentialReuse:true`。协议和地址改变不自动复用凭据，不自动尝试其他厂商。

无效参数返回 400，revision 冲突或缺少凭据复用确认返回 409，准备／保存失败返回 503。`model_settings_commit_uncertain` 表示需要重新读取实际生效值；不能假定请求失败就一定未保存，也不能用旧 revision 自动覆盖。

预设地址来自上面的官方资料；项目自动化验证使用本机 HTTP 服务、合成凭据和合成模型响应。本轮未逐一调用厂商实网，协议 fixture 通过不等于所有服务和模型已经完成在线认证或质量验收。

## 验证

自动化覆盖配置持久化、凭据隔离、默认路由、逐次选择、热切换、旧文件兼容和授权。`scripts/test-model-profiles-ui.cjs` 使用独立临时资料库与生成答案验证前端操作、凭据不回显、桌面及窄屏布局。

Codex 测试分为协议模拟进程和真实 CLI + 本机合成 Responses 服务。后者验证 `initialize → thread/start → turn/start`、两轮动态工具、引用和查询工具清单：

```sh
npm run build:libs
MOTE_TEST_CODEX_BIN=/可信路径/codex node --test packages/agent/test/codex.test.mjs
```

这些测试不使用真实截图、个人资料或真实模型登录凭据。未执行线上模型质量验证或物理设备验证。

## 本次重构验证

2026-09-17，本机 Codex CLI **0.154.0**，从 `model/list` 读取 5 个可用模型，选择 **gpt-6-astra**。使用临时独立资料库和合成笔记执行：

- 真实连接测试通过（约 20 秒）：模型、证据工具与引用格式校验。
- 创建 Codex 预设 → 复制 → 将副本默认模型设为未使用的测试 ID → 为 Chat 显式指定目录模型 → `POST /api/query`。实际结果记录 `profileId=codex-copy`、`model=gpt-6-astra`，调用 `search_context`、`evidence`，返回正确时间及 1 条有效引用（约 21 秒）。
- 未连接个人资料库、未采集个人截图；真实推理由 Codex 上游完成。未进行物理移动设备验证。

可重复执行的真实测试：`node --import tsx scripts/test-codex-provider-live.ts`（需要服务器用户的 Codex 文件登录；可通过 `MOTE_TEST_CODEX_MODEL` 指定目录内模型）。这是显式运行的网络测试，不纳入普通 fixture 测试。
