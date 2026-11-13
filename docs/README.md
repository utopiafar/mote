# 项目文档索引

当前方向（2026-10-23）：[单 Owner MVP](adr-single-owner-mvp.md)。
Central（server + web）、macOS、Android 使用各自产品版本；当前版本分别记录在 app package.json 与 Android version.properties。拆分架构与发版操作见 [独立发布架构](release-architecture.md) 和 [发布流程](releasing.md)。早期版本曾从 0.8.0 重置到 0.0.1，旧发布记录应结合日期阅读。

本目录保留描述当前代码的使用指南、仍有效的设计说明和 ADR；ADR 与方案记录保留当时的取舍。历史验收记录、审计和工作台账已移出仓库，需要时从 Git 历史查阅，历史结果不是当前证据。文档中的“本轮”“已通过”等表述应结合该篇日期阅读。测试分层与触发规则以 [testing](testing.md) 为准，当前基线见 [MVP 决策](adr-mvp-baseline.md)。

## 常用入口

| 需要了解什么 | 当前说明 |
| --- | --- |
| 安装、开发、部署与更新 | [项目首页（中文）](../README.zh-CN.md)、[English](../README.md)、[Agent 安装](agent-install.md)、[开发](development.md)、[部署](deployment.md)、[当前 DEV 更新](updating.md)、[发布](releasing.md) |
| 测试分层、定向命令与 CI | [测试规则](testing.md)、[回归测试设计](testing.md#regression-test-design)、[测试操作手册](testing-runbook.md)、[CI 入口](ci.md)、[多模块协作](agent-development-workflow.md) |
| 采集、隐私和上传 | [统一行为](collection-and-sync.md)、[macOS](desktop.md)、[Android](android.md)、[文字审查与中央感知](central-perception.md)、[同步恢复](sync-recovery.md) |
| 本地 OCR / ASR 与文件 | [运行时和模型安装](ocr-asr-implementation-plan.md)、[文件归档](files.md)、[文件处理](file-processing.md)、[类型策略](file-processing-policies.md) |
| MVP 基线与断代 | [基线 ADR](adr-mvp-baseline.md)、[单 Owner MVP](adr-single-owner-mvp.md)、[升级与回退](deployment.md#升级与回退) |
| 数据、权限、协议 | [架构](architecture.md)、[正式资料](material-architecture.md)、[协议](protocol.md)、[内容加密](content-storage.md)、[资产存储](asset-storage.md) |
| Agent、记忆和行动 | [Agent](agent.md)、[模型配置](model-providers.md)、[生命周期](memory-lifecycle.md)、[记忆更新](memory-updates.md)、[日程](calendar-actions.md)、[行动更新](action-updates.md) |
| 结构化页面与自动 Memory | [采集范围和字段](ui-page-capture.md)、[接入 ADR](adr-ui-page-automatic-memory.md) |
| 每天看了什么、做了什么 | [日常事件 Memory](adr-daily-event-memory.md) |
| 飞书文档与个人活动 | [接入](lark-integration.md)、[已确认决定](adr-feishu-document-context.md)、[生成场景验收](testing-feishu-document-context.md) |
| 浅色 / 深色 / 跟随系统 | [外观决定](adr-cross-platform-appearance.md) |
| 当前界面、对话和运行状态 | [Slate 导航](ui-slate.md)、[对话](conversations.md)、[Operations](operations.md)、[执行器](execution-engine.md)、[排错](troubleshooting.md) |
| 当前用户旅程与三端 UI 定稿 | [三端定稿与源清单](design/ui-final-three-clients-2026-10-29.md)、[定稿 ADR](adr-ui-final-three-clients.md)；原对话最终决定优先。历史 [UI IA v1](adr-ui-ia-v1.md)、[模块与完整旅程](ui-user-journeys.md) 保留未被替代的合同 |
| 2026-10-10 系统改造 | [系统改造 ADR](adr-system-refactor.md) |
| 插件中心与可替换记忆一期 | [插件中心](plugin-center.md)、[已确认实施方案](design/plugin-center-phase-one-2026-10-12.md)、[架构决定](adr-plugin-center-memory-replacement.md)；一期控制与固定适配器已实现 |

## 专题与实现说明

下表按文件名索引；部分专题同时保留历史测试章节，其结果不等于当前全量验收。

| 文档 | 内容 |
| --- | --- |
| [assistant-delivery-review-2026-11-13](assistant-delivery-review-2026-11-13.md) | 个人助理大专项 Q3 交付复核、54 卡覆盖清单与遗留风险 |
| [action-updates](action-updates.md) | Evidence-backed action updates |
| [agent-prompt-and-startup](agent-prompt-and-startup.md) | Bounded prompts and startup measurements |
| [agent](agent.md) | Agent 配置与权限 |
| [android-bulk-dedupe](android-bulk-dedupe.md) | Android local bulk image deduplication |
| [android-library-performance](android-library-performance.md) | Android 大资料库性能与当前格式 4 存储 |
| [android-local-state](android-local-state.md) | Android shared local state |
| [android-power-optimization](android-power-optimization.md) | Android 采集与同步开销优化 |
| [android-system-events](android-system-events.md) | Android 通知、设备事件与采集记录 |
| [android](android.md) | Android 采集端 |
| [architecture](architecture.md) | Mote 架构 |
| [asset-storage](asset-storage.md) | 原件资产与观察记录 |
| [calendar-actions](calendar-actions.md) | 日程建议与行动平台 |
| [capture-albums](capture-albums.md) | Screenshot sessions and App albums |
| [central-memory](central-memory.md) | 中央导入、记忆与洞察 |
| [central-perception](central-perception.md) | 上传审查与中央感知 |
| [client-navigation](client-navigation.md) | 原生客户端导航与设置 |
| [client-settings-and-storage](client-settings-and-storage.md) | 客户端设置与图片保存位置 |
| [cloudflare-tunnel](cloudflare-tunnel.md) | Cloudflare Tunnel 部署 |
| [coding-agent-memory](coding-agent-memory.md) | 编码 Agent 对话与经验记忆 |
| [collection-and-sync](collection-and-sync.md) | 采集、保存与上传 |
| [combined-backup-recovery](combined-backup-recovery.md) | Current-format combined backup and restore fixture |
| [community-extensions](community-extensions.md) | 社区扩展：接入既有处理链 |
| [configuration-ownership](configuration-ownership.md) | 配置归属与执行快照 |
| [connections](connections.md) | 设备配对与独立连接 |
| [connectors](connectors.md) | 中央连接器 |
| [content-storage](content-storage.md) | 内容存储与一次性批量解密 |
| [context-layers](context-layers.md) | 资料分层与渐进式记忆 |
| [conversations](conversations.md) | 对话历史与继续提问 |
| [deployment](deployment.md) | 独立中央节点部署、备份与迁移 |
| [desktop](desktop.md) | Mote 电脑采集器 |
| [development](development.md) | 开发与测试环境隔离 |
| [evidence-reader](evidence-reader.md) | Shared evidence reads |
| [execution-engine](execution-engine.md) | Current durable execution engine |
| [task-execution-policies](task-execution-policies.md) | Central task defaults, admission waiting and failure recovery |
| [delegation-and-activity](delegation-and-activity.md) | 自主委派、逐输入覆盖与活动界面 |
| [execution-protocol](execution-protocol.md) | Execution protocol |
| [file-processing-policies](file-processing-policies.md) | 中央文件类型策略 |
| [file-processing](file-processing.md) | 中央文件处理：Cordis 插件与本地多人录音 |
| [file-sync-design](file-sync-design.md) | 文件同步与中央处理设计 |
| [files](files.md) | 文件归档与中央处理 |
| [format-workers](format-workers.md) | Bounded format work |
| [gmail](gmail.md) | Gmail 只读来源 |
| [internationalization](internationalization.md) | Interface languages |
| [lark-integration](lark-integration.md) | 飞书文档与日历（服务端只读） |
| [material-architecture](material-architecture.md) | 接入与正式资料架构 |
| [media-context](media-context.md) | 锁屏、前台与后台媒体上下文 |
| [memory-admission](memory-admission.md) | 资料、理解产物与精选记忆（0.0.44） |
| [memory-lifecycle](memory-lifecycle.md) | Memory lifecycle |
| [memory-review-policy](memory-review-policy.md) | Bounded memory review reuse |
| [memory-updates](memory-updates.md) | Unified extraction and versioned memory review |
| [processing-throughput](processing-throughput.md) | Continuous processing, usage accounting and budget removal |
| [model-providers](model-providers.md) | 中央模型服务 |
| [ocr-asr-implementation-plan](ocr-asr-implementation-plan.md) | 中央 OCR 与录音转写：方案与实施 |
| [operation-import-insight-closure](operation-import-insight-closure.md) | Operation, import, document, and insight closure |
| [operations](operations.md) | Operations read model |
| [persona-memory-evaluation](persona-memory-evaluation.md) | Reproducible medium-horizon memory evaluation |
| [privacy-and-metadata](privacy-and-metadata.md) | 应用分级与元数据 |
| [protocol](protocol.md) | Mote protocol v1 |
| [provider-failures](provider-failures.md) | Provider failures and host retry |
| [query-output-budget](query-output-budget.md) | 回答截断与输出预算 |
| [raw-logs](raw-logs.md) | 原始日志与日志中心 |
| [release-architecture](release-architecture.md) | Monorepo 内独立发布边界、协议与验证 |
| [releasing](releasing.md) | 发布版本与签名 |
| [server-configuration](server-configuration.md) | 服务端配置参考 |
| [sqlite-concurrency](sqlite-concurrency.md) | SQLite process locks |
| [sync-recovery](sync-recovery.md) | 同步机制与恢复设计 |
| [troubleshooting](troubleshooting.md) | 中央节点诊断与排错 |
| [ui-page-capture](ui-page-capture.md) | 页面内容采集与规则贡献 |
| [ui-slate](ui-slate.md) | Slate UI 与开发版发布 |
| [updating](updating.md) | 保留设置地更新 Mote |
| [upload-scheduling](upload-scheduling.md) | Cross-client upload scheduling |
| [usage-and-query-progress](usage-and-query-progress.md) | 对话进度、用量和模型目录 |
| [web-login-and-pairing](web-login-and-pairing.md) | 中央网页登录与设备配对 |

## 决策记录

常用的跨模块决定如下；其他决定见各专题文档链接的 `adr-*.md`。

| 文档 | 内容 |
| --- | --- |
| [系统改造 ADR](adr-system-refactor.md) | 已确认的统一查询、滚动 Memory 合批、审核恢复与前后台隔离决定 |
| [任务恢复与执行预算 ADR](adr-task-recovery-and-execution-budgets.md) | 按任务类型注册宽松期限、资源等待、模型反馈修正和失败分类原则 |
| [范围评估与模型选取 Memory ADR](adr-memory-range-evaluation.md) | 完整原件、逐范围评估、独立审核、模型选取、资源恢复与旧任务契约边界 |
| [问答证据与简化上下文决定](adr-ask-evidence-quality-and-simple-context.md) | 模型覆盖、移除近似预算与二分、录音时间/正文、质量实验与实际恢复边界 |
| [Memory 证据送达与失败状态决定](adr-memory-evidence-delivery-and-failure-state.md) | 整合 A、独立图片证据、真实失败和有界回执；保留历史执行授权边界 |

## 发布记录与 Agent Skill

[release/notes](../release/notes/) 按发布版本保留变更记录，不是当前使用手册；[Agent Skills](../packages/agent/skills/) 是运行时任务说明，受代码的只读工具、范围及宿主提交校验约束。[AGENTS.md](../AGENTS.md) 是仓库开发约束，[第三方说明](../THIRD_PARTY_NOTICES.md) 标明依赖与许可证来源。
