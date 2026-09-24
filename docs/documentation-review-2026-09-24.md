# 项目文档与代码一致性复查（2026-09-24）

初始复查基线：`b6afb817f70d29f5954bcafb427c4c0560d517de`；提交前合入并复核 `bd796b639c64e2623a847353ff344b2f018413b5` 的 Native OCR 启动恢复更新。源码版本 0.0.66。范围为当时 Git 跟踪的 194 份 Markdown：根说明、docs 专题与历史验证、release/notes 及 Agent Skill。检查文档目录、内部链接、配置名、协议与当前实现声明；对发现冲突的采集、存储、模型、调度、导入、行动和发布说明追到生产代码。没有把历史测试结果改写为本轮测试，也没有修改产品代码或模型 Skill。

新增 [文档索引](README.md)，区分现行指南与历史验收/方案。历史版本号经历过重置，不能按 0.8.0 大于 0.0.66 推断新旧。外部服务的实时能力、价格与历史第三方研究不属于本次代码一致性验证。

## 已修正的不一致

| 主题 | 原说明与实际差异 | 代码依据 / 当前说明 |
| --- | --- | --- |
| 截图隐私 | 把 Qwen/VLM、HTTP 视觉钩子、完整本机 OCR 当作当前必经流程 | [Mac collector](../apps/desktop/src/collector.ts)、[Android CapturePipeline](../apps/android/app/src/main/java/dev/mote/collector/CapturePipeline.kt)、[UploadGate](../apps/android/app/src/main/java/dev/mote/collector/UploadGate.kt)；现在按明确应用/遮罩/文字规则执行，异常默认隔离，完整 OCR 在中央 |
| 中央 OCR/ASR | 称没有受管理 OCR 引擎，混淆旧任务自动重跑与新上传处理 | [Perception](../apps/server/src/perception.ts)、[模型目录](../apps/server/src/media-assets.ts)；Native 启动自动准备运行时，固定模型需显式安装；Worker 就绪后恢复自动任务，历史未授权截图需显式回填 |
| 内容加密 | 称 Android 队列、草稿、缩略图总是加密，或只要配置 DATA_KEY 就开启加密 | [内容存储](content-storage.md)、[中央开关](../apps/server/src/content-encryption.ts)；默认关闭，凭据保护独立，旧密文兼容读取 |
| 资产位置 | 将 blobs 当作所有新图片的唯一存储位置 | [AssetStore](../apps/server/src/assets.ts)、[资产说明](asset-storage.md)；新原件统一为 files/objects 分片，旧格式兼容 |
| 上传默认值和回退 | 写成实时/15 分钟/20 条，或把 403 当作不支持新协议 | [Mac 配置](../apps/desktop/src/config.ts)、[Android 配置](../apps/android/app/src/main/java/dev/mote/collector/Settings.kt)、[协商](../apps/android/app/src/main/java/dev/mote/collector/UploadNegotiation.kt)；新安装 batch/1 分钟/100 条，仅 404/405 协商旧接口，413 缩小批次 |
| Memory 准入 | 写成周期与数量 AND；INSIGHT_INTERVAL_HOURS=0 被当作关闭所有自动洞察 | [生命周期](../apps/server/src/memory-lifecycle.ts)；有增量且数量达标或最长等待到达，未指定 maxWaitHours 时取 min(intervalHours,1)，停用使用 enabled |
| 记忆与导入 | 写成导入完成立刻建记忆任务、总限额 1,000、不能用户校正 | [装配入口 onImported](../apps/server/src/app.ts)、[MemoryStore](../apps/server/src/memory.ts)；自动提取独立准入，上限 100,000，支持版本绑定校正 |
| 模型协议和预算 | 只列 Harness/五种协议，协议默认预算仍为 8192 | [模型配置](../apps/server/src/config.ts)、[共享模型契约](../packages/shared/src/model-providers.ts)、[只读工具](../packages/agent/src/context-tools.ts)；补 Codex、65536 默认/1–128000 范围与受控原图披露 |
| 对话持久化 | 称普通问答不保存，详情接口一次返回完整历史 | [Conversations](../apps/server/src/conversations.ts)、[WorkingMemory](../apps/server/src/working-memory.ts)；中央保存轮次，界面分页，模型使用可配置摘要与近期上下文 |
| 文件解码 | 称 PDF 插件尚需另装、二进制文件同步仅为规划 | [文件处理器](../apps/server/src/file-processors.ts)、[类型策略](../apps/server/src/file-policy.ts)；已有原件同步与 PDF/DOCX/XLSX 内置解码，扫描件 OCR 不在该解码器内 |
| 行动 | 称仅支持 calendar.create、尚无行动目录 | [行动更新](action-updates.md)、[Actions](../apps/server/src/actions.ts)；新增修改/取消/完成提议与只读目录，原生日历变更仍限确认后的原目标 |
| 执行状态 | Slate 文档仍只指向 /api/processing，DAG 沿用旧租约 | [共享执行器](../apps/server/src/execution-engine.ts)、[Operations](operations.md)、[迁移闭环](operation-import-insight-closure.md)；区分中央执行、领域投影与客户端调度 |
| 导航和更新 | 混用旧四页导航、日常 APK、签名清单在线升级与当前 DEV prerelease | [Web 导航](../apps/web/src/navigation.ts)、[Android 主界面](../apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt)、[Release workflow](../.github/workflows/release.yml)；当前 DEV 手动覆盖安装，中央自行构建升级 |
| 真机记录 | 同一 Android 恢复文档前面记载后续安装真机验证，末尾却称从未安装 | [采集恢复记录](android-capture-recovery.md)；明确初次只读诊断与后续生成画面真机检查是不同阶段，不扩大验证范围 |
| 内部链接 | 历史文件移入子目录后 16 处相对路径失效，另有一处 Android 历史章节锚点失效 | 修复相对路径与锚点，保留原始报告内容 |

## 验证

- 检查 196 份 Markdown 的 563 个本地链接与章节锚点，零失效；核对源码路径。生成产物路径按其历史或构建说明处理，不要求提交测试产物。
- `git diff --check`：通过。
- `npm run check:local`：在合入上述 main 更新后通过，包括国际化、库构建、类型检查、工作区测试及新增媒体 Worker / 中央进程回归。
- 本次没有运行 Android/Swift 构建、真实模型、模拟器或物理设备检查；仅修正文档，不声明旧验收被重新执行。没有读取或传输真实个人截图、录音、邮件或日历。
