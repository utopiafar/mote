# 对话进度、用量和模型目录

问答现在通过 `POST /api/query-runs` 提交 `{id, input}`。客户端生成 UUID；相同 ID 和相同输入只执行一次，相同 ID 配不同输入返回 409。接口立即返回 202。`GET /api/query-runs/:id` 提供持久化进度，网页每秒刷新，连接失败后自动重连。切页、刷新、关闭标签页不会取消已接收的运行；中央节点进程重启则把未完成运行标为 interrupted，不自动再次消费模型。

`GET /api/query-runs` 用于恢复最近运行。进度包括启动、模型请求步骤、工具开始/结束、返回项数、回答校验，以及 Agent 通过 `progress_update` 主动生成的简短公开状态。内部 reasoning delta 不会流向网页。进度消息只是展示内容，不进入系统指令或后续检索。它们随关联对话删除，资料删除也会清除已保存消息并阻止在途运行重新写入。任务只保存完成回答的 conversationId/turnId，正文仍从对话存储读取。原同步 `POST /api/query` 保留兼容。

## 计量与费用

`model_usage` 在每次问答、洞察、记忆查询、文件分析、导入 Agent 准备开始时创建记录。Harness 的 `session.event` 提供 step/attempt 生命周期与服务商 usage：同次请求的结算样本覆盖，重试和 JSON 修复累加；未知用量不会按零处理。统计 inputTokens 包含缓存读取/写入；reasoningTokens 是输出的子集，不能再加到总量。DeepSeek 缺失的缓存读取保持未知；pi-ai 适配器明确省略零缓存字段，只有总量一致时还原这些零值。

每轮回答附带 usage 收据。`GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&timeZone=Asia/Shanghai` 按指定时区分天汇总（日期两端均包含，最多 366 天跨度），并按 page/pageSize 返回运行明细（默认每页 20、最大 100）。输入输出、加权缓存命中率、失败次数、数据缺失数与费用按币种分别展示。缓存率 = 已上报缓存读取 / 同一批已上报缓存数据的输入，不平均各请求的百分比。

在“用量与费用”页面为精确的 provider/model 填写每百万 tokens 的未缓存输入、输出、缓存读取、缓存写入单价，可选 USD/CNY。每次运行开始时保存价格快照，修改价格只影响后续请求。价格或必要计量缺失时显示“未估算”，不是免费；已计量的失败调用也保留。费用是估算，不是服务商账单或付款系统；套餐、税费、阶梯价、工具附加费需要以账单为准。历史未记录的用量不能补算。当前范围包含文件处理的独立语言模型和导入专用 Agent（含格式修复）；嵌入的执行、预算与 Operation 归属另由 Indexer 接入，见 [embedding 执行](operation-import-insight-closure.md#embedding-execution-follow-up)；语音转写、连接探测或绕过受控入口的外部请求不应当作已完整计量的 Agent 用量。导入统计是模型分析运行的结果，不代表用户确认后资料入库成功。

## 按归属聚合

每笔记录在实际执行入口写入 `attribution: {agentId, moduleId, skillId}`，不读取或推断问题、证据内容。上下文查询 Agent（`context-query`）服务问答、洞察、记忆三个模块；文件分析 Agent（`file-analysis`）服务文件模块；导入 Agent（`document-import`）服务资料导入模块。同一收据有一个 Agent、一个模块、一个主 Skill，不在不同维度重复入账。

Skill 表示入口指定的主流程：个人洞察 `personal-insight`、记忆提取 `memory-extraction`、文档导入 `document-import`。普通问答/文件分析未指定主 Skill，显示“未指定 Skill”；模型执行中动态加载的子 Skill 不分摊成本。旧收据缺少 attribution 时显示“历史未标记”，不按旧 operation 字段猜测归属。

统计接口增加 `groupBy=agent|module|skill|model`（默认 agent），支持 `agentId`、`moduleId`、`skillId`、`provider`、`model`、`status` 的精确交集筛选。`__none__` 表示未指定主 Skill，`__unknown__` 表示历史归属未知。响应包含同一筛选下的 total、days、groups、分页 items 与完整 itemsTotal；facets 为所选日期范围的归属选项。改变分组保持总额不变，点击分组会应用其 filter 下钻到明细。所有聚合使用完整符合范围的记录，不受明细上限影响。

运行次数是一次 Agent 运行，模型请求次数包括该运行内的工具循环、重试、格式修复。成功率 = completed / (completed + failed)，不含进行中运行；均值/P95 取已结束运行的总耗时（包含工具执行，P95 采用 nearest-rank）。失败运行已上报的 token 和费用仍计入。无已结束运行时比率/耗时为 null；未知计量单独列出。页面显示已知 token 占比，不声称代表未上报的消耗。

## 模型目录

模型设置会根据当前草稿的服务地址/协议/凭据自动拉取目录，提供下拉选择和手动部署 ID。读取目录不保存草稿，也不消耗生成 tokens。

- DeepSeek / OpenAI-compatible: `/models`；Anthropic: `/v1/models`；Gemini: `/models`，仅显示支持 generateContent 的条目。
- 凭据仅由中央节点发送，复用凭据到改变后的目标沿用既有显式确认规则。禁止重定向，限制读取时长、响应体和分页数，错误不回显原始响应。
- “本机 Codex App Server”调用中央节点 PATH 上的 `codex app-server`，只执行 initialize / initialized / model/list（含分页），不创建 thread/turn、不执行模型。需要中央节点本机已安装并登录 Codex。
- Codex 是额外的目录来源，选择仅填写模型 ID，**不会把当前 API/Harness 运行时切换成 Codex 登录态推理**。目录可见性不保证当前 API 凭据可调用该模型，仍可使用既有“测试连接”。原生 Codex 问答执行适配不在本次变更范围。

协议参考：[Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server#list-models-modellist)。Harness 事件字段对照仓库锁定的 `@deepseek-ai/dsh-sdk-client` / `dsh-session` / `dsh-token-meter` 0.1.5-rc.2 类型和实现。

所有接口沿用 owner 权限和 no-store 响应。计量、目录及任务测试使用合成记录与本地模拟服务；浏览器检查同样使用独立临时资料库。
