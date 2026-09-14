# 中央模型服务

在中央网页打开 **设置 → 问答与回顾 → 模型服务**，选择服务预设，填写该服务提供的模型 ID 和 API key，点击 **保存并应用**。保存后，新发起的问答、回顾和记忆提取立即使用新配置；正在执行的请求继续使用原配置，不需要重启中央节点。

模型名称留给用户填写，因为可用模型、地域、账户授权和工具调用能力会变化。没有配置模型时，采集、同步、笔记和资料归档仍可使用。这里配置的是中央问答模型；客户端截图审查和 embedding 索引分别使用独立设置。

## 保存、测试与凭据

API key、自定义请求头和高级请求参数只显示“已配置／未配置”，不会读取旧值回填。每项可选择不改动、填写新值或清除；请求头和高级参数按整个 JSON 对象替换。未保存的输入只保存在当前页面内存，成功保存后清空敏感输入。

更换服务商、协议或服务地址时，如果仍保留任一已有密钥、请求头或高级参数，需要明确勾选允许复用，也可以改为填写新值或清除旧值。这项确认对“测试连接”和保存都生效。

**测试连接**由中央节点向所填模型发送少量固定合成内容，并使用独立的合成记录验证工具调用和引用。测试不连接个人资料库，不上传个人截图、OCR 或笔记，也不会保存草稿；请求可能产生模型费用。测试最多采用 30 秒 Agent 期限，若设置更短则使用较短期限。测试成功表明本次连接和工具往返通过，不代表全部问题的回答质量或长期可用性。

**恢复部署配置**会删除已保存的模型覆盖值，立即使用本次中央启动时读取的环境配置。它不会编辑 `mote.env`；如果刚修改过该文件，需要重启中央才能读到新文件内容。并发修改发生版本冲突时，先重新读取当前配置，再决定是否重做修改。

## 服务预设

当前有 23 项预设，包含自定义入口、本机服务及腾讯混元原平台。预设只是填写地址和协议的起点，不表示该平台的所有模型都支持 Mote 所需的流式工具调用。地址仍可修改；模型 ID 以对应控制台为准。

表中的 Chat、Responses、Messages、Gemini 分别对应下一节的协议。正式远程 API 都需要对应服务的 API key；Azure 使用资源 API key，Ollama、LM Studio 可显式启用本机免密。

| 服务 / provider ID | 默认协议 | BaseURL | 官方接入资料 |
|---|---|---|---|
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
| `deepseek` | DeepSeek 官方适配，处理其思考与多轮工具调用格式 |
| `openai-completions` | OpenAI Chat Completions，以及实现相同消息、流式和工具格式的兼容服务 |
| `openai-responses` | OpenAI Responses 格式的文本和工具往返；Mote 固定关闭服务端会话存储参数 |
| `anthropic-messages` | Anthropic Messages 的消息块、工具调用和流式事件 |
| `google-generative-ai` | Google 原生 Gemini API，保留工具调用所需的思考签名 |

Mote 继续使用 DeepSeek Harness 管理 Agent 和只读证据工具；通用协议通过其 pi-ai 适配层接入。选择协议不增加模型工具权限。这里只支持上述协议，不是任意请求／响应 JSON 的字段映射器；使用其他协议需要新增适配代码。

BaseURL 应填写服务基址，不是具体推理方法的完整 URL。保留厂商要求的 `/v1`、`/api/v3` 等路径前缀，不要自行给所有厂商补 `/v1`。地址禁止用户名、密码、查询参数和 fragment；远程必须使用 HTTPS，仅 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP。模型请求拒绝重定向。

远程配置必须填写 API key，即使自定义请求头另有认证字段也不能省略此栏。无需密钥的本机模型必须显式允许免密；“本机”指中央节点所在机器，Docker 的回环地址指容器自身。Mote 不自动启动本地模型服务或下载模型。

推理强度通常选择 **由模型决定（`auto`）**，避免发送模型不接受的通用推理字段。也可按所选模型支持情况设置 `off`、`low`、`high`、`max`；DeepSeek 预设保留既有的 `high` 默认值，仍可改成 `auto`。这些选项不保证每个平台的含义相同，也不保证每个思考模型都能关闭推理。

自定义请求头是字符串键值 JSON 对象；高级参数是符合当前协议的 JSON 对象，例如模型支持时的 `{"temperature":0.7}`。它们可以包含凭据，因此同样只写入、不回显。Mote 拒绝用这些参数覆盖模型名称、消息、系统提示、工具、输出上限、请求目的地或受保护传输头；输出上限应在专门的设置项修改。

Chat 协议下，OpenAI、Azure 和 MiniMax 使用 `max_completion_tokens`，其余预设使用 `max_tokens`。自定义网关若要求前一种字段，可选择 OpenAI 预设后编辑服务地址。MiniMax 默认加入 `reasoning_split:true`，使思考内容与最终回答分离；可通过高级参数显式覆盖，该参数不关闭思考。

模型能力仍需分别确认，尤其是工具调用与流式能否同时使用、思考内容是否需要在多轮工具中保留、输出 token 的计数方式，以及采样参数是否支持。例如部分 Qwen 思考模型要求流式，MiniMax 的 `reasoning_split` 只改变输出格式，千帆的两种输出 token 上限统计范围不同。[Qwen 思考](https://help.aliyun.com/zh/model-studio/deep-thinking)、[MiniMax 参数](https://platform.minimax.cn/docs/api-reference/text-chat-openai)、[千帆参数](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)

## 环境配置与保存位置

也可以在所选私有 `mote.env` 中设置默认值。修改环境文件后重启中央；页面已经保存的模型配置会继续覆盖环境中的模型字段，直到在页面恢复部署配置。

```dotenv
MOTE_MODEL_PROVIDER=qwen
MOTE_MODEL_PROTOCOL=openai-completions
MOTE_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MOTE_MODEL=填写控制台提供的模型ID
MOTE_MODEL_API_KEY=填写该地域的API密钥
MOTE_MODEL_REASONING_EFFORT=auto
MOTE_MODEL_MAX_TOKENS=8192
MOTE_MODEL_TIMEOUT_MS=120000
MOTE_MODEL_HEADERS={}
MOTE_MODEL_EXTRA_BODY={}
MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL=0
```

`MOTE_MODEL_PROVIDER` 使用上表 ID，未设时为 `deepseek`；`MOTE_MODEL_PROTOCOL` 未设时采用该预设协议。`MOTE_MODEL_HEADERS` 和 `MOTE_MODEL_EXTRA_BODY` 必须是 JSON 对象，每个环境变量最多 16 KiB。不要用 shell 的 `source` 执行配置文件；不要将真实密钥放进命令参数或提交到仓库。完整默认值见[服务端配置参考](server-configuration.md)。

页面保存的值位于 `<MOTE_DATA_DIR>/model-settings.json`，文件权限为 `0600`。文件包含真实 API key、请求头和高级参数；权限限制不等于文件内容加密。若自行复制或备份此文件，副本也包含密钥，需作为私有凭据管理。HTTP 资料导出、安全支持包和标准 CLI 归档备份不包含该文件；迁移模型设置需单独保护并转移该文件，或在新节点重新填写。

保存先验证配置并准备新运行时，再原子替换文件、同步目录，最后切换后续请求。恢复部署配置仍保存递增 revision 的空覆盖标记，防止旧页面覆盖新状态。文件损坏或不可读时不会静默恢复成另一套模型凭据；若写入结果无法确认，页面提示重新读取或检查服务状态。

## 所有者 API

这些接口仅允许中央所有者认证，采集凭据和 MCP 凭据不能使用。读取结果设置为不缓存，成功与错误响应均不回传密钥或底层模型错误文本。

| 方法与路径 | 行为 |
|---|---|
| `GET /api/model-settings` | 返回 `version:1`、`revision`、`source:environment\|saved` 和公开设置；敏感字段只有 `apiKeyConfigured`、`headersConfigured`、`extraBodyConfigured` |
| `PUT /api/model-settings` | 接受 `{revision, settings, allowCredentialReuse?}`；基础模型参数完整提交，敏感字段可省略或设为 `null` |
| `POST /api/model-settings/test` | 与 PUT 相同的草稿和确认规则；返回固定 `ok/code/message/durationMs`，不修改持久配置 |
| `DELETE /api/model-settings` | 接受 `{revision}`；恢复本次启动的环境模型配置并递增 revision |

`settings` 的基础字段为 `provider`、`protocol`、`baseUrl`、`model`、`reasoningEffort`、`maxTokens`、`timeoutMs`、`allowUnauthenticatedLocal`。`provider` 必须是注册预设 ID，未列出的服务使用 `custom`。模型名称可留空关闭 AI；只允许在模型也为空时省略实际地址内容。`maxTokens` 为 1–128000 的整数，`timeoutMs` 为 5000–600000 毫秒整数；厂商模型限制可能更低。

`apiKey`、`headers`、`extraBody` 省略表示保留当前值，`null` 表示清除，提供新值表示整体替换。修改 provider、protocol 或 baseUrl 后，任何保留的非空敏感字段都需要 `allowCredentialReuse:true`。协议和地址改变不自动复用凭据，不自动尝试其他厂商。

无效参数返回 400，revision 冲突或缺少凭据复用确认返回 409，准备／保存失败返回 503。`model_settings_commit_uncertain` 表示需要重新读取实际生效值；不能假定请求失败就一定未保存，也不能用旧 revision 自动覆盖。

预设地址来自上面的官方资料；项目自动化验证使用本机 HTTP 服务、合成凭据和合成模型响应。本轮未逐一调用厂商实网，协议 fixture 通过不等于所有服务和模型已经完成在线认证或质量验收。
