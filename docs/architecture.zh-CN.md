# 当前架构地图

[English](architecture.md) · **简体中文**

职责分组映射当前代码。[产品](product.zh-CN.md)与[设计](design.zh-CN.md)说明长期方向。

Central 维护共享归档、处理与检索，以及已提交的对话、任务和行动状态。客户端负责本机采集、隐私处理、离线保存同步和授权设备能力。

```mermaid
flowchart LR
  I[采集与接入] --> A[归档与处理]
  A --> R[原文与记忆检索]
  R --> P[应用与 Agent]
  P --> X[授权行动]
  X --> P
```

资料可直接检索，Memory 和理解结果在授权下形成。插件、模型、配置、执行与诊断支撑整条路径。

## 六组职责与入口

| 职责 | 当前主要内容 | 代码入口 |
| --- | --- | --- |
| 采集与接入 | Mac / Android 采集、主动记录、来源同步和中央接收 | [desktop](../apps/desktop)、[android](../apps/android)、[ingress.ts](../apps/server/src/ingress.ts)、[sources.ts](../apps/server/src/sources.ts) |
| 归档与处理 | 原件与版本、Material、文件解码、图片与音频处理 | [materials.ts](../apps/server/src/materials.ts)、[evidence-archive.ts](../apps/server/src/evidence-archive.ts)、[plugins](../apps/server/src/plugins) |
| 记忆与检索 | Memory 提取、审核与发布，资料、记忆和原文读取 | [memory-pipeline.ts](../apps/server/src/memory-pipeline.ts)、[context-query.ts](../apps/server/src/context-query.ts)、[evidence-reader.ts](../apps/server/src/evidence-reader.ts)、[agent](../packages/agent) |
| 助理应用 | 主对话、任务、事项、建议、反馈与通知 | [web](../apps/web)、[assistant-tasks.ts](../apps/server/src/assistant-tasks.ts)、[assistant-notifications.ts](../apps/server/src/assistant-notifications.ts) |
| 行动执行 | 已接入的待办、日历与消息等产品命令、授权、目标和结果 | [assistant-actions.ts](../apps/server/src/assistant-actions.ts)、[assistant-drafts.ts](../apps/server/src/assistant-drafts.ts)、[actions.ts](../apps/server/src/actions.ts) |
| 共用基础 | 插件合同与宿主、模型、配置、执行、共享类型与诊断 | [plugin-sdk](../packages/plugin-sdk)、[plugin-host](../packages/plugin-host)、[plugin-api](../packages/plugin-api)、[model-agent.ts](../apps/server/src/model-agent.ts)、[execution-engine.ts](../apps/server/src/execution-engine.ts)、[shared](../packages/shared)、[diagnostics](../packages/diagnostics) |

中央装配入口为 [host.ts](../apps/server/src/host.ts)；具体领域与插件从现有 assembly、features 和 plugins 接入。扩展复用现有 SDK、模型与任务基础，接口和实现按实际需求迭代。

## 技术底座

- Central 使用 Node.js / TypeScript 与 Fastify，Web 使用 React；Mac 使用 Electron 与原生辅助程序，Android 使用 Kotlin 原生客户端。
- MVP 默认使用 SQLite 与文件归档，全文检索使用 FTS5，语义检索可选。原件、正式 Memory 和任务状态与可重建索引分开；保留现有存储和检索扩展边界。
- DSH 与 Codex 通过运行时适配接入，共用 Mote 的上下文与授权原则。DSH 生态兼容优先原包直接使用，其次通用配置和装配适配；原生应用可保留内部会话与流程，由 Mote 连接授权上下文、可见状态和产物。
- 插件使用现有 Cordis、PluginHost 与 SDK。能力按实际平台与依赖装配；涉及新系统原语的设备能力随客户端构建发行。

## 当前边界

- Central、macOS、Android 为正式支持范围；iOS 有实验客户端，不进入正式支持矩阵。
- 原件、结构化资料、Memory、对话与任务状态分别保存。接收完成不等于解析、索引或 Memory 完成。
- 目前查询、Memory 与洞察使用只读上下文工具；外部动作经产品命令和 Actions 执行。导入等专用运行时有自己的工具边界。
- 模型由模块或本次请求配置选择。Central 保存元数据、索引和归档，依靠来源、版本与当前权限控制读取和发布。

## 产品方向与实现差距

| 产品方向 | 当前实现与差距 |
| --- | --- |
| 主对话、后台任务与授权行动 | 消息仍按对话排队，任务输出依赖归档证据的草稿。用户Steering、不依赖旧档案的当前指令、记录/认识我轻入口和授权Actions尚未统一；发消息动作仍逐条确认，外部Agent行动入口未接通。 |
| 提醒送达 | 当前MVP保留Android进程存活时轮询提醒，尚无后台推送；在线提醒不代表手机休眠后仍能及时送达。 |
| 默认保存与同步 | snapshot默认、中央/端侧配额及ACK／7天清理仍需与长期保存对齐，会议录音也有上传后删本机文件路径。大文件、清本机副本后轻量记录、阻止旧版本重试但允许新版本采集、范围收紧后的待传均需完善；当前MVP不做资料按天保留。 |
| Memory使用与生命周期 | 当前固定独立审核链需调整为模型或所选记忆方案按需复核，不增加手写语义分流。使用记忆与引用原文的要求需分清；原件清理后的记忆保留、暂停后的积压补做仍需完善。上下文与澄清支持合理判断、保留主体来源并减少打断。 |
| DSH生态兼容 | 已有原生包、Hook与Factory接口，但[官方装配](../packages/agent/src/official-composition.ts)仍选择query任务并传空原生模块列表；完整Agent、原生页面与持续应用的生产接线尚未完成。 |
| 插件生产激活 | worker/source安装和SDK开发路径已有；一般processing只验导出未实际激活，纯domain安装及已安装外部页面/主题/布局装载仍未齐，见[插件中心](plugin-center.md)。 |
| 来源连接与覆盖 | Notion/Slack/飞书会话已有后端和目录卡片，账号/范围UI仍缺。覆盖与执行状态已分开；Notion数据库枚举可持久续读并拒绝旧范围的迟到写回，正文、子块及Slack/飞书会话续页仍未齐，需如实显示部分覆盖。Google/飞书云日历在独立写授权后进入行动目录，执行还需目标日历与输入来源的明确授权，见[连接器](connectors.md)。 |
| 媒体准备 | 支持的Mac上，本地识图页面已接通依赖与模型资产准备，可选推理由插件单独启用；默认音频页面沿FunASR/CAM++，已移除不支持的WeSpeaker安装入口。完整链路、真实模型质量与平台证据仍分别说明。 |
| Android高级媒体操作 | 常用阅读、回听和文字纠正保留原生；高级说话人复核、原稿对照和模型准备通过轻入口直达同一Central的Web，对应入口尚未接通。专门手机相册自动采集列后续路线图，当前仍是手动照片/文件接入。 |
| Coding对话覆盖 | 当前普通对话投影只接纳用户发言和协议确认的最终回复；已定的用户可见中途说明仍需接入，工具正文和内部推理不开放。 |
| 执行与扩展 | 通用批处理与旧委派仍并存，按实际工作逐步复用任务基础和合并重复状态。接口按MVP需求迭代，不设置笼统的宿主、委派或接口冻结。 |

本文件随实现更新。协议、插件 SDK、配置、部署和验证使用独立的必要短参考，具体接口以代码与 schema 为准。

技术参考：[资料与来源](materials.md#publication-and-extension)、[Memory](memory.md)、[执行](agent-runtime.md#execution-state-and-recovery)、[协议](protocol.md)、[配置](server-configuration.md)、[内容存储](content-storage.md)。
