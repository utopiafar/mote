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
| 默认保存与同步 | 中央已取消资料总量配额和按天自动清理，新文件来源默认归档原件且保留已有明确选择；未完成上传与可重试处理输入不因时长删除，成功处理、显式取消及ACK传输副本仍按各自流程释放。中央历史删除阻止已删及当时在途旧版本复活，允许来源新版本继续；上传会话持久绑定中央既有范围代次，Mac二进制队列按明确410隔离旧版并继续后续版本，见[文件](files.md)。原件归档已通过安全整数、固定分块、分页收据及流式读取／备份承接原512 MiB以上文件，解析和Buffer／便携格式保留独立预算。端侧默认、配额及ACK／7天清理、本机路径范围筛除和清本机副本后轻量记录仍需对齐；会议录音也有上传后删本机文件路径。当前MVP不做资料按天保留。 |
| Memory使用与生命周期 | 额外复核由冻结的recipe显式选择独立复核器或无需复核，两条路径保留相同宿主校验，不增加手写语义分流。有效Memory可直接使用，显式standing上下文在当前权限与实际模型预算内持续提供；原话引用与来源特定论断仍需相应原件。普通暂停/恢复可跨重启保留已授权回执、任务和有限生命周期轮次；拒绝的输入与未登记间隙不补授权，立即停止会撤销自动批次尾部。普通释放原件在当前范围内保留已经发布且仍有效的Memory；明确遗忘、来源撤回与隐私撤权仍使其失效。宿主投递收据在在途查询及已保存对话中区分Memory祖先与实际原文读取。见[Memory生命周期](memory.md)。 |
| DSH生态兼容 | [官方query装配](../packages/agent/src/official-composition.ts)按需重启生效的所有者选择/授权和逐query有效Host绑定，装载已安装的原始ESM包、Hook与Factory；生成数据的所有者HTTP→配置重启→真实SDK测试覆盖工具/输出消费及撤回。持续原生应用、内部会话和原生页面仍为独立接入步骤，见[原生包配置](agent-runtime.md#installed-native-dsh-packs)。 |
| 插件生产激活 | 一般processing服务包在隔离宿主scope核验声明，明确启用后注册到现有处理器运行时；失败阻断激活，停用隔离迟到产物。纯data/domain制品可直接安装到现有PluginHost，沿typed port、精确活跃依赖与持久实例状态消费；撤回隔离旧lease及迟到写入。受支持的已安装页面/主题/布局沿activation固定的owner快照进入真实Web启动：隔离HTML与声明的实例方法、角色值和可信shell布局数据，见[插件中心](plugin-center.md)。 |
| 来源连接与覆盖 | Notion/Slack/飞书会话已接通Web目录、账号读取授权、内容与历史范围保存、同步及详情管理。覆盖与执行状态已分开；Notion数据库枚举、正文及子块可有界持久续读，并拒绝旧范围的迟到写回；正文前缀与不支持的内容在来源和正式资料中均标部分覆盖。Slack和飞书会话的历史与线程回复均已支持固定窗口内的有界持久续读，先归档再条件提交检查点，完成窗口后才推进覆盖水位。Google/飞书云日历在独立写授权后进入行动目录，执行还需目标日历与输入来源的明确授权，见[连接器](connectors.md)。 |
| 媒体准备 | 支持的Mac上，本地识图页面已接通依赖与模型资产准备，可选推理由插件单独启用；默认音频页面沿FunASR/CAM++，已移除不支持的WeSpeaker安装入口。完整链路、真实模型质量与平台证据仍分别说明。 |
| Android高级媒体操作 | 常用阅读、回听和文字纠正保留原生；上下文入口直达同一Central当前录音的Web说话人试听命名、原稿对照或原始转写，以及对应媒体准备区，不改变模型授权或处理选择。短时票据承接当前owner会话，登出、节点/对象变化和迟到结果受围栏保护。[生成Central → Kotlin → Web证据](testing-runbook.md#android-advanced-web-contract)覆盖实际消费者，不声称设备/外部浏览器启动或真实模型已验。专门手机相册自动采集仍列后续，当前为手动照片/文件接入。 |
| Coding对话覆盖 | 对话投影纳入已确认的人类消息及协议确认对用户可见的assistant文字，包括中途解释；保留原始事件顺序、主体与provider，继续排除工具正文、隐藏推理、宿主上下文和子Agent输出。 |
| 执行与扩展 | 通用批处理与旧委派仍并存，按实际工作逐步复用任务基础和合并重复状态。接口按MVP需求迭代，不设置笼统的宿主、委派或接口冻结。 |

本文件随实现更新。协议、插件 SDK、配置、部署和验证使用独立的必要短参考，具体接口以代码与 schema 为准。

技术参考：[资料与来源](materials.md#publication-and-extension)、[Memory](memory.md)、[执行](agent-runtime.md#execution-state-and-recovery)、[协议](protocol.md)、[配置](server-configuration.md)、[内容存储](content-storage.md)。
