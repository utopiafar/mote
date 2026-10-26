# Android 上传历史扩展验收（2026-10-26）

范围：P3-A 来源条目、文件、随手记附件的传输历史，接在 #252 的日期/批次 UI 上。当前分支 `codex/android-upload-history-items`，不覆盖协调已集成的 #252 分支，也不自行合 main。

设计审批：`docs/design/android-upload-history-extension.md` 的 SHA256 为 `6024f897d9b4ab981ef4455dd5c324c0d5dbbcf89c790b47624d5c3a1ab79e97`；独立技术审查批准规范 ACK ID 修订。真实上传接入的写入曾被自动审批拒绝；收到用户 07:35:54「确认同意」的原始授权后，对已确认未执行的修改重试一次获批。

## 实现和自主工程决策

- 来源与捕获两条执行通道分别恢复，来源单独重试也复用双库恢复入口，成功后清除全局错误提示。真实请求分为条目、清单、分块、完成确认；一次执行一个批次，重试不增加同一身份条目数。分块成功不计作原件已确认。首次 receipt 时间不被重放刷新。
- 加密独立 SQLite 只存白名单身份、版本、摘要及传输元数据。确认与最小完成标记同事务写入，再在原队列锁内核精确目标/版本/摘要并完成；历史写失败不丢原件。恢复标记不随历史过期。
- 文件 begin/commit 使用已验证 `ack.id == receipt.id`，存在 `captureId` 时必须相等。新传及续传分块都核索引、长度、摘要；规范 ID 用于历史、恢复、文件队列与附件 ACK 映射。
- 沿用已授权 7/30/90/365 天、默认30天。设置、周期维护、启动恢复均尝试两个历史库的清理；只清历史，不改变资料、待传原件、草稿或 Central 规则。
- 原件页从历史身份重新解析，不存历史正文。来源正文须匹配完整指纹；附件核本地摘要；文件使用精确待传 spool。中央原件核当前节点/会话、设备、来源、外部 ID 和 revision；二进制另核可用性、摘要与长度。旧版本不可用就显示可重试状态，不拿新版本代替。二进制复用系统保存入口，不自动上传或启动模型。
- #252 审查问题独立提交 `4875bd6559ae6cff9ffa9728948c7149b03c97c3`：附件 note 的 attempt 分开保留 queueVersion 与 transport version。前者打开本机原件，后者用于历史去重。供协调挑取，未向 #252 推送。

## 本轮实际证据

| 边界 | 实际执行与结果 |
|---|---|
| Android 候选 | `:app:testDebugUnitTest` 通过；开发 APK 与 instrumentation 包构建通过。读者随后新增中央文件可用性校验，针对 `UploadHistoryModelTest` 6项重新通过；未再次跑全量 |
| 原件版本 finding | `AttachmentAttemptOriginalTest` 真实 DurableQueue：503 与抛异常丢 ACK 的附件 note 均能用 queueVersion 打开，传输去重身份保持不同 |
| 新库 | `ItemUploadHistoryInstrumentedTest` 真实 SQLite：首次时间/重放、加密非明文、事务第二次写失败回滚、过期保留标记/不复活历史、进程与通道隔离4项通过；后来新增123项同时间戳分页和节点隔离1项单独通过 |
| 来源/文件/附件 | `ItemUploadFlowInstrumentedTest.realCentralLostRepliesRecoverFileAttachmentAndSourceWithoutLosingOriginals` 通过。真实 Central buildApp + SQLite，经 47890 loopback 代理在实际提交后返回503；生产 FileUpload、RecordAttachmentSync，及来源队列/CollectorHttp/ItemUploadSession 重放确认。附件草稿原件保留，三类各1份 receipt；另模拟网络异常和条件取消并核状态 |
| 重启与原件 | 专用5584强停后 `restartRestoresItemsAndOriginalNavigation` 通过：三类历史持久化、原件读取/实际导出字节、原生批次到附件原件点击。新增中央文件校验后相关测试重跑通过；合成截图人工查看，无截图入库 |
| 保存取消/保留期 | 原件页重建、系统保存取消返回通过。双库设置从30改7天，核旧历史删除但两类恢复标记、待传原件、附件草稿保留；使用现有配置锁隔离启动恢复时序，随后恢复30天 |
| 协议与本地完成 | 定向 JVM + 候选覆盖真实附件客户端 begin/commit 异常 captureId、新/续传块、文件精确完成拒绝后 spool 保留、来源目标/正文变化不清新项、附件摘要/目标不符不写 ACK |
| UI 基础复用 | #252 已有日期、整批分页、过滤/滚动返回、重建、空态/存储故障恢复、30天改7天原生证据。本轮不无关重跑；#252 旧CI不用于证明本扩展 |

所有数据为生成 fixture，模拟器为本任务无窗口5584；没有真机或真实模型证据。测试服务禁用模型。没有访问私密偏好/令牌、部署、真实资料清理或扩大权限。第三方脚本自行联网仍是既有已知问题，本模块未实现或声称实现沙箱约束。

## PR260 独审修订：异常归类与原件迟回

冻结反例基线 `3bf853d715404db029d0024294358ac4a6a5e161`。两项均先在未修代码上观察到目标断言失败，再验证修后通过：

- `AttachmentHistoryFailureInstrumentedTest` 使用真实 WorkManager/UploadWorker、SQLite 与合成 loopback 协议对端。在附件来源登记返回时临时将本测试 ledger 路径变成目录，确保失败发生在附件内层而非启动恢复。旧代码未进入历史恢复 handler；修后明确显示存储错误，首次不发送附件上传，原件/草稿保留，恢复 ledger 后显式重试成功。仅增加 `UploadHistoryUnavailable` 特定重抛，ACK、marker、过期规则不变。
- `UploadOriginalSessionInstrumentedTest` 以合成 HTTP 响应和现有 UiTask executor 的 FIFO 屏障，证明后台读取/会话核验已经完成而页面暂停尚未投递；随后从 A 换到 B 再恢复。旧代码实际显示 A 正文；修后丢弃旧结果并重读当前历史绑定，显示不可用。修改局限原件页：页面代次、显示前节点/会话 generation、历史 batch/key/scope 校验；不改全局 UiTask。已有保存流程完成后恢复读者刷新。

本批实际执行仅两个新增原生回归（2/2）、开发/测试 APK 构建及静态翻译/差异检查；复用此前 SQLite、真实503、导出和其他 UI 证据。默认图形后端模拟器两次异常退出不计测试结果，改用工具支持的 SwiftShader 后在专用5584完成；仍非真机/真实模型证据。

## 与已合入主干的整合

在 `88d6fca1` 上整合 main `7f1d1ace`。实际冲突限于原件 Activity 注册、三个上传历史 UI/投影文件、对应投影测试及设计说明；均保留已独审的全类型扩展，既有 capture queueVersion 与远端 reader 的版本参数保持独立，main 既有投影测试全部保留。`UploadOriginalActivity`、`UploadWorker`、`UploadHistoryModel`、`UploadBatchActivity` 解冲突后与 `88d6fca1` 字节一致，未重写刚修复的两条边界。

组合验证：UploadHistoryModel 6项、CaptureUploadAttempt 5项、AttachmentAttemptOriginal 1项全部通过；Development Kotlin 编译通过，8744双语文案与调用点检查通过。两条新增原生故障/恢复反例复用 owner 的 `88d6fca1` 红绿证据，不冒称本次重新跑模拟器。最终整合 SHA 以 PR 冻结 head 为准，仍须独立增量审查与精确 CI。


## B1 integration after main fb8871d3

The actual merge with B1 preserves both exact-ACK history completion and file-library pagination. Only the two English catalogs and the test insertion in FileArchiveQueueTest required manual conflict resolution. Both parents' test names and assertions are retained; production FileArchiveQueue and the manifest merged automatically. The resulting FileArchiveQueueTest class passed 21/21 with zero failures/skips, Development Kotlin compilation passed, and 8767 bilingual keys/call sites passed. Existing original-reader and native lifecycle evidence is reused, not rerun. This new candidate still requires independent merge-delta review and exact-head CI.
