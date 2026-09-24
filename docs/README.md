# 项目文档索引

当前说明按 2026-09-24 的 main 代码复查，源码版本为 0.0.66。早期版本曾从 0.8.0 重置到 0.0.1，因此不能按版本号大小推断文档的新旧；发布背景见 [发布流程](releasing.md)。

使用指南描述当前代码，历史验收只证明当次执行的范围，方案记录保留当时的取舍。文档中的“本轮”“已通过”和构建产物路径均应结合该篇日期阅读，不代表本次重新验收。此次修正与代码依据见 [文档复查](documentation-review-2026-09-24.md)。

## 常用入口

| 需要了解什么 | 当前说明 |
| --- | --- |
| 安装、开发、部署与更新 | [项目首页](../README.md)、[开发](development.md)、[部署](deployment.md)、[当前 DEV 更新](updating.md)、[发布](releasing.md) |
| 采集、隐私和上传 | [统一行为](collection-and-sync.md)、[macOS](desktop.md)、[Android](android.md)、[文字审查与中央感知](central-perception.md)、[同步恢复](sync-recovery.md) |
| 本地 OCR / ASR 与文件 | [运行时和模型安装](ocr-asr-implementation-plan.md)、[文件归档](files.md)、[文件处理](file-processing.md)、[类型策略](file-processing-policies.md) |
| 数据、权限、协议 | [架构](architecture.md)、[正式资料](material-architecture.md)、[协议](protocol.md)、[内容加密](content-storage.md)、[资产存储](asset-storage.md) |
| Agent、记忆和行动 | [Agent](agent.md)、[模型配置](model-providers.md)、[生命周期](memory-lifecycle.md)、[记忆更新](memory-updates.md)、[日程](calendar-actions.md)、[行动更新](action-updates.md) |
| 当前界面、对话和运行状态 | [Slate 导航](ui-slate.md)、[对话](conversations.md)、[Operations](operations.md)、[执行器](execution-engine.md)、[排错](troubleshooting.md) |

端侧 Qwen 文档是保留运行时的历史说明，当前截图不调用 VLM。旧版充电补 OCR、默认加密、签名在线更新及 Memory 的周期 AND 数量门槛不能当作当前默认。现行入口分别见上表。

## 专题与实现说明

下表按文件名索引；部分专题同时保留历史测试章节，其结果不等于当前全量验收。

| 文档 | 内容 |
| --- | --- |
| [action-updates](action-updates.md) | Evidence-backed action updates |
| [agent-prompt-and-startup](agent-prompt-and-startup.md) | Bounded prompts and startup measurements |
| [agent](agent.md) | Agent 配置与权限 |
| [android-bulk-dedupe](android-bulk-dedupe.md) | Android local bulk image deduplication |
| [android-capture-recovery](android-capture-recovery.md) | Android capture recovery and central navigation |
| [android-library-performance](android-library-performance.md) | Android 大资料库性能与可选内容加密 |
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
| [client-scheduling-and-status](client-scheduling-and-status.md) | Client scheduling and status validation (0.0.61 worktree) |
| [client-settings-and-storage](client-settings-and-storage.md) | 客户端设置与图片保存位置 |
| [cloudflare-tunnel](cloudflare-tunnel.md) | Cloudflare Tunnel 部署 |
| [coding-agent-memory](coding-agent-memory.md) | 编码 Agent 对话与经验记忆 |
| [collection-and-sync](collection-and-sync.md) | 采集、保存与上传 |
| [combined-backup-recovery](combined-backup-recovery.md) | Combined upgrade and restore fixture |
| [community-extensions](community-extensions.md) | 社区扩展：接入既有处理链 |
| [configuration-ownership](configuration-ownership.md) | 配置归属与执行快照 |
| [connections](connections.md) | 设备配对与独立连接 |
| [connectors](connectors.md) | 中央连接器 |
| [content-storage](content-storage.md) | 内容存储与一次性批量解密 |
| [context-architecture](context-architecture.md) | 通用上下文架构 · 0.0.54 |
| [context-layers](context-layers.md) | 资料分层与渐进式记忆 |
| [conversations](conversations.md) | 对话历史与继续提问 |
| [deployment](deployment.md) | 独立中央节点部署、备份与迁移 |
| [desktop](desktop.md) | Mote 电脑采集器 |
| [development](development.md) | 开发与测试环境隔离 |
| [evidence-reader](evidence-reader.md) | Shared evidence reads |
| [execution-engine](execution-engine.md) | Common execution engine migration |
| [execution-protocol](execution-protocol.md) | Execution protocol |
| [file-processing-policies](file-processing-policies.md) | 中央文件类型策略 |
| [file-processing](file-processing.md) | 中央文件处理：Cordis 插件与本地多人录音 |
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
| [mixed-load-stability](mixed-load-stability.md) | Fixed-data mixed-load stability |
| [model-budgets](model-budgets.md) | Model budgets |
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

## 历史验收、调查与设计记录

`local-inference`、`memory-trigger-options`、`file-sync-design` 保留早期运行时或方案；现状以关联的操作指南为准。验证材料保留原始通过、失败、未执行与生成素材/真实模型/真机范围，不追溯改写历史结论。

| 文档 | 内容 |
| --- | --- |
| [0.0.13-validation](0.0.13-validation.md) | 0.0.13 验证记录 |
| [0.0.2-validation](0.0.2-validation.md) | 0.0.2 验收记录 |
| [0.0.3-validation](0.0.3-validation.md) | 0.0.3 验收记录 |
| [0.0.4-validation](0.0.4-validation.md) | 0.0.4 验收记录 |
| [0.0.5-validation](0.0.5-validation.md) | 0.0.5 验收记录 |
| [0.0.6-validation](0.0.6-validation.md) | 0.0.6 Android 升级无响应修复 |
| [agent-context-validation](agent-context-validation.md) | Agent 上下文与任务架构验证（0.0.43） |
| [central-memory-validation](central-memory-validation.md) | 中央 Memory 工作流验证 |
| [client-background-audit](client-background-audit.md) | Android / mac 客户端 UI 阻塞盘点 |
| [client-feedback-validation](client-feedback-validation.md) | 客户端状态反馈复查 |
| [coding-agent-validation](coding-agent-validation.md) | Coding Agent 验收记录（2026-09-17） |
| [connection-validation](connection-validation.md) | 0.6.0 连接与统计验证 |
| [context-architecture-validation](context-architecture-validation.md) | 0.0.56 架构升级验证 |
| [file-sync-design](file-sync-design.md) | 已实现的处理扩展 |
| [file-sync-validation](file-sync-validation.md) | 0.0.18 Cordis 与录音处理增量验收 |
| [issue-2-validation](issue-2-validation.md) | Issue 2 验收工作记录 |
| [issue-3-validation](issue-3-validation.md) | Issue #3 / 0.0.38 |
| [issue-4-client-settings](issue-4-client-settings.md) | Issue #4: client settings and central archive |
| [live-validation](live-validation.md) | Mote 0.2.1：真实模型与复杂链路验收 |
| [local-inference](local-inference.md) | 本机千问视觉审查与通用任务运行时 |
| [media-validation](media-validation.md) | 媒体上下文验证记录 |
| [memory-admission-validation](memory-admission-validation.md) | Memory admission validation — 0.0.44 |
| [memory-trigger-options](memory-trigger-options.md) | Memory 整理与洞察触发：决策备忘 |
| [memory-validation-0.0.31](memory-validation-0.0.31.md) | Memory 生命周期验收（0.0.31） |
| [memory-validation-diagnostics](memory-validation-diagnostics.md) | Memory validation diagnostics |
| [operations-validation](operations-validation.md) | 0.3.0 部署、环境隔离与诊断验证 |
| [privacy-metadata-validation](privacy-metadata-validation.md) | 0.7.0 分级采集与元数据验证 |
| [review-2026-09-23](review-2026-09-23.md) | 项目复查、修复与场景验证（2026-09-23） |
| [review-upload-sync-2026-09-23](review-upload-sync-2026-09-23.md) | Upload and synchronization review — 2026-09-23 |
| [session-preview-validation](session-preview-validation.md) | Session 与压缩预览验证 |
| [sources-validation](sources-validation.md) | Mote 0.4.0：来源与记忆验收记录 |
| [testing-0.0.61](testing-0.0.61.md) | 0.0.61 验证记录 |
| [tunnel-validation](tunnel-validation.md) | 0.3.1 服务端配置与 Tunnel 验证 |
| [ui-page-research](ui-page-research.md) | 页面采集：实践调研与实现决策 |
| [update-validation](update-validation.md) | 0.5.1 发布与更新验证 |
| [0.0.59](validation/0.0.59.md) | 0.0.59 分层上下文与响应性能验证 |
| [0.0.60](validation/0.0.60.md) | 0.0.60 分层上下文与响应性能验证 |
| [development-history](validation/0.0.61/development-history.md) | 0.0.61 验证记录（发布前工作记录） |
| [persona-memory-results](validation/2026-09-23/persona-memory-results.md) | Persona 长周期记忆评估 |
| [validation](validation.md) | Mote 0.2.0 基线验收记录 |
| [web-login-validation](web-login-validation.md) | 0.0.9 登录、页面职责与配对验证 |

## 发布记录与 Agent Skill

[release/notes](../release/notes/) 按发布版本保留变更记录，不是当前使用手册；[Agent Skills](../packages/agent/skills/) 是运行时任务说明，受代码的只读工具、范围及宿主提交校验约束。[AGENTS.md](../AGENTS.md) 是仓库开发约束，[第三方说明](../THIRD_PARTY_NOTICES.md) 标明依赖与许可证来源。
