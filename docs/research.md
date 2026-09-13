# 参考项目调研

调研日期：2026-09-13。已读取三个仓库的当前源码、README 与关键实现。以下是 Mote 的设计依据，不把参考项目已具备的能力算作 Mote 已交付功能。

| 项目 | 阅读快照 | 许可证 |
| --- | --- | --- |
| [ScreenMemo](https://github.com/2977094657/ScreenMemo) | `2f57da1a43c55ff97c0e90e9b20885e9c3757ea3` | [AGPL-3.0](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/LICENSE) |
| [Memex](https://github.com/memex-lab/memex) | `1b186376320584464eb343ef224ce8837a5e7dac` | [GPL-3.0](https://github.com/memex-lab/memex/blob/1b186376320584464eb343ef224ce8837a5e7dac/LICENSE) |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `c291e7961a515f6d7af9304e7fd1d257929aef26` | [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/LICENSE) |

ScreenMemo 与 Memex 用于研究设计，没有直接复制其实现。Mote 的 Agent 使用 npm 发布的官方 DeepSeek Harness，而不是另写一个同名循环。

## ScreenMemo：可借鉴的采集工程

[README](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/README.md) 显示其 Android 采集依赖 Android 11 以上无障碍截图能力，Flutter 提供界面、Kotlin 负责平台服务；桌面入口主要处理大备份合并，并非完整桌面采集器。因此 Mote 需要独立实现电脑端。

[采集服务](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/android/app/src/main/kotlin/com/fqyw/screen_memo/capture/ScreenCaptureAccessibilityService.kt) 检查屏幕亮起、设备解锁与被选中的前台应用，再调用无障碍截图 API。它也支持较新系统的窗口截图接口。采集和后处理分离，避免压缩阻塞下一次截图。

[去重实现](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/android/app/src/main/kotlin/com/fqyw/screen_memo/capture/ScreenshotDedupeHelper.kt) 组合精确摘要、dHash、缩略图像素变化、局部块及行列差异，并提供多档敏感度。适合借鉴的是分层比较与明确可调的工程策略；不应只靠一个激进哈希阈值删除资料。Mote 可以先做精确去重与保守变化检测，将复杂近似策略放在可替换组件后面。

[截图后处理](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/android/app/src/main/kotlin/com/fqyw/screen_memo/capture/ScreenCaptureScreenshotProcessing.kt) 支持 JPEG、PNG、WebP，按目标大小调整压缩质量，部分压缩延后处理。截图清晰度应以 OCR 可读性验收；存储估算应使用真实采集张数与平均字节数，不把一分钟一张的估算用于一秒一张设置。

[数据库实现](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/android/app/src/main/kotlin/com/fqyw/screen_memo/database/ScreenshotDatabaseHelper.kt) 使用分片 SQLite 与应用/年月目录。[搜索索引](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/lib/data/database/screenshot_database_search.dart) 有 FTS5 与 BM25。Mote MVP 不必先照搬分片复杂度，应将原始对象与可重建索引分开，使用稳定记录 ID，后续可换对象存储与索引服务。

README 描述 ZIP manifest、覆盖或合并导入、排除缓存、诊断和修复。这提示 Mote 的备份必须包含可移植元数据、对象校验与版本；备份和采集增量同步是两种不同操作。中央节点摄取更适合持久化上传队列、幂等记录 ID 和重试确认，不能每次上传完整 ZIP。

其 [NSFW 偏好服务](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/lib/features/nsfw/application/nsfw_preference_service.dart) 与 [截图显示组件](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/lib/features/gallery/presentation/widgets/screenshot_image_widget.dart) 主要控制查看时的遮罩。UI 模糊不能当作落盘或上传前脱敏。Mote 的过滤要在客户端采集链路生效：用户明确排除应用、固定遮挡区域，或可替换的本地隐私模型；敏感原图不能先上传再决定是否遮挡。

[开机恢复](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/android/app/src/main/kotlin/com/fqyw/screen_memo/service/BootReceiver.kt) 恢复之前启用的服务和后台任务，[OEM 指引](https://github.com/2977094657/ScreenMemo/blob/2f57da1a43c55ff97c0e90e9b20885e9c3757ea3/android/app/src/main/kotlin/com/fqyw/screen_memo/diagnostics/OEMCompatibilityHelper.kt) 尝试打开小米自启动与电池设置并准备失败回退。这些做法改善可恢复性，不能保证 K90 Pro Max 最新 HyperOS 永不杀后台；OEM 设置路径和长期运行仍必须在目标真机验证。需要在中央显示最后心跳、最后截图、待传数量和异常原因，不能悄悄漏采。

## Memex：从原始记录到可追溯洞察

[当前 README](https://github.com/memex-lab/memex/blob/1b186376320584464eb343ef224ce8837a5e7dac/README_CN.md) 描述本地文件系统与 SQLite、原始事实、卡片、Markdown 知识库以及 Agent 按需调用技能。源码已演进为 [SuperAgent harness](https://github.com/memex-lab/memex/blob/1b186376320584464eb343ef224ce8837a5e7dac/lib/agent/super_agent/super_agent_harness.dart) 与技能协同；旧 `docs/agent_overview.md` 中若干独立 Agent 路径已经不存在，不应按旧架构图机械实现。

[KnowledgeInsightSkill](https://github.com/memex-lab/memex/blob/1b186376320584464eb343ef224ce8837a5e7dac/lib/agent/skills/knowledge_insight/knowledge_insight_skill.dart) 支持趋势、汇总、对比等可视化卡片，并要求新增洞察拥有非空 `related_facts`。适合 Mote 的重点是把洞察与来源记录绑定，让用户能回到原始时间、应用和证据，而非只保存无法核验的总结。

[持久化任务执行器](https://github.com/memex-lab/memex/blob/1b186376320584464eb343ef224ce8837a5e7dac/lib/data/services/local_task_executor.dart) 处理任务依赖、并发策略、失败重试和失效任务恢复。中央摄取、OCR、索引、模型总结应有可观察的任务状态；串行化需要写同一知识资源的操作，避免重试造成重复对象。

[搜索服务](https://github.com/memex-lab/memex/blob/1b186376320584464eb343ef224ce8837a5e7dac/lib/data/services/search_service.dart) 通过数据变更事件维护索引，并组合全文检索、关联记录和文件读取。Mote 保留“确定性检索原语由 Agent 选择”的边界：模型可以生成文本检索条件，程序不能把自然语言问题硬编码为某种意图。[资源检查](https://github.com/memex-lab/memex/blob/1b186376320584464eb343ef224ce8837a5e7dac/lib/data/services/asset_safety_service.dart) 主要控制媒体大小、像素和解码成本，也不能误称内容隐私脱敏。

参考项目中的旧规则卡片 fallback、关键词记忆注入和应用语义分类，不属于 Mote 要继承的设计。用户已明确要求 AI 原生：无模型时显示不可用，不能悄悄切到硬编码语义答案。

## DeepSeek Harness：已落实的集成

[官方介绍](https://deepseek.com/harness/en/) 和仓库确认这是 DeepSeek 官方的插件式 Agent harness；模型、工具、会话、执行循环均可组合。TypeScript SDK 通过 stdio JSON-RPC 驱动独立运行时，另有 Python SDK。

Mote 采用独立 home 的 SDK 运行时，禁用默认 shell，只安装五个只读上下文工具。模型自己决定查询和取证次序，服务校验输出引用。接入步骤、精确版本、数据边界与已执行的 fixture 验证见 [agent.md](agent.md)。Harness 官方 [开发预览状态](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/README.md) 意味着后续升级必须重新验证插件和 SDK 契约。

## Mote MVP 的取舍

第一条完整链路是手机与电脑采集，先在端点执行用户过滤和脱敏，再持久化排队、压缩和上传，中央存储对象与元数据，最后由 Agent 查询证据、解释时间分布并生成洞察。NAS、本地文件和智能硬件接入都通过相同记录与对象协议扩展，不需要更换 Agent API。

暂不追求全量分片、高强度近似压缩、自动知识库大范围重组或复杂角色陪伴。优先保证可恢复、可移植、可追溯，以及过滤真正发生在上传之前。用合成数据验证自动化链路，再对真实模型质量和 K90 Pro Max 后台行为分别验收，明确区分已经跑过的测试与尚需真机的结果。
