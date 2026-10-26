# Android 上传历史扩展：独立合同审查

基线：7f3f17b1；实现分支 codex/android-upload-history-items 从独立 UI PR252 的 a0ed9f1a 起步。独立审查已 APPROVE 持久化/完成顺序/恢复标记/双库过期边界（reviewer task-13/mote-ui-technical-review.md，已审 SHA 7a7c9de6f37c1cbeb415b087a962a24abfe6835a3141f12f70d98b1787583857）。本次仅规范 ACK 定位符 delta 待快速确认；其余已批部分可实施。

## 保留与改变

KEEP：CaptureUploadHistory/CaptureReceiptFinalizer 已合合同；现有发送条件、目标绑定、权限、来源说明/原件、草稿、队列重试、文件协议、删除与资料保留语义。捕获通道不迁移、不改格式。所有历史均仅本机当前节点/设备，私有定位符由已有 cipher 加密，noBackupFilesDir。操作统计保留，上传历史 UI 不再使用统计日志冒充回执。

CHANGE：新增独立当前格式的 ItemUploadHistory SQLite 文件（不是旧数据库迁移、兼容读或双写），接入 source-item、file、attachment 三类真实传输。表为 attempts、received、pending_completion；索引仅随机/哈希标识、时间和固定状态。payload 不保存原文、文件名、路径、图片、令牌、响应全文。存储白名单为 kind、scope、sourceId、externalId、revision/content hash、local record/attachment ID、Central capture ID、batchId、requestId、固定 phase、请求体字节、耗时、HTTP状态、状态与固定原因码。原件标题在打开已有 reader 时读取，不进入历史。

## 身份与状态

每次 worker execution 有独立 batch UUID；文件同一 execution 的 manifest/parts/commit、记录附件与父 capture 共享该 execution batch。每次真实 HTTP 写请求之前保存独立 attempt UUID；不能保存则不发送。GET/注册/配置请求不算资料上传。

- source-item 去重键：规范化 origin + device + sourceId + externalId + revision。仅现有 SourceRules.validAck 通过后确认；Central ID 来自已验证 ACK。
- file 去重键：上述 source identity + manifest revision + SHA256（无 blob 的 revision 同样明确）。只有现有 FileArchiveQueue 的完整最终 ACK 校验通过才确认；begin 已返回最终 ack 可走相同完成器。parts 与 manifest 接收仅标记请求完成/文件未确认，不能增加已收资料数。保留 snapshot recovery 与 head 检查。
- attachment 去重键：origin + device + parent note ID + attachment ID + content SHA256；CentralAttachments 现有稳定 identityScope/source/revision 保留；只读核查发现目前 begin/commit 只取 captureId，未做完整 ACK 身份校验。本批须在返回成功前用 IngressV2Protocol.validFile 校验 sourceId/externalId/revision 与 ACK，并核 sha256/sizeBytes；part ACK 核 part/bytes/hash，不能把外来或格式不全的 ACK 写入历史或草稿 map。此补强属于本方案待审范围。上传后的 Central capture ID 进入历史与现有草稿 ACK map；草稿附件不被历史过期删除。

有效最终 ACK 为 received；部分批次按独立 identity 计数。HTTP 5xx/丢包/格式错/不匹配 ACK 为 unknown，不能推断 Central 未收。取消发送条件为 cancelled；已发送后条件变化不得伪造未送达。文件块请求成功标为 transferred，最终资料仍须最终 ACK。进程重启把旧 sending 变 unknown；同进程恢复只由各独占 worker 对所属 lane 执行，避免误伤并发通道。

## ACK 规范 ID 修正（独审 delta）

最终 ACK 必须先经现有 receipt 校验，明确 ack.id == receipt.id 且为合法 UUID。历史 Central 定位符、最小 completion marker、本机文件完成、附件草稿 ACK map 全部只使用这个已验证的 ack.id。若响应含 captureId，必须为相同字符串；不同合法 UUID、缺少规范 id/receipt 或任何身份/hash/size 不匹配都在 received 与本机完成之前拒绝。begin 返回最终 ACK 与 commit 返回最终 ACK 共用同一验证/完成入口。不会保留或使用未验证的 captureId。

生成回归：分别在 begin/commit 返回正确 source/externalId/revision/hash/size、正确 receipt.id==ack.id，但 captureId 为另一个合法 UUID；历史、marker、文件状态与附件草稿 map 均不被确认。匹配 ID 的两条路径照常完成。恢复也只能使用已验证白名单里的规范 ID，不从任意响应补读 locator。

补充实现约束（已批合同的落地）：恢复/完成必须在各本机存储的锁内重新读取并比对 exact target/version/hash；LocalSourceStore 的静默 target mismatch 和 RecordDraftStore 单纯 UUID 写入不能当作完成证明。恢复的 part entries 和新 part ACK 都核 expected part/bytes/hash。此处不新增产品政策。

## 完成顺序与恢复

1. 有效最终 ACK 后，在一个 SQLite 事务写 received 与最小 pending_completion（精确身份、目标和安全完成需要的白名单 ACK 字段）。首次 receivedAt 不被重试更新。
2. 再调用原来的 localSources.acknowledge / fileArchives.acknowledge / recordDraftStore.acknowledge；必须仍匹配目标、source/externalId/revision、当前文件 manifest 或当前附件 hash。失败保留 marker 与原队列。
3. 本机完成后删 marker。新进程及该 lane 下次发送前按同样精确身份恢复；找不到或已经变更的项不能清掉新版本。已完成的同身份只清 marker；目标改变不跨目标恢复。
4. 故障显示历史不可用并保留待传原件；不跳过其他无关启动维护。普通重试能恢复，不新增自动重置数据库或清数据路径。
5. 现有 30 天默认和 7/30/90/365 API 扩展为 prune 两份历史；只删 received/attempts。未完成 marker 保留到安全完成。历史过期后 marker 仍阻止重试复活旧历史/重置时间。每份数据库事务独立，失败需可见并可重试，不声称跨库原子。

## UI 与原件

同步与上传保留当前任务；上传历史按本地日期展开真实批次，独立详情展示本批实际请求与确认/未确认数量。去重是精确 identity，不能把重试次数当资料数。按日期/结果筛选；分页不拆散批次；返回恢复筛选、展开日期、列表滚动，Activity/进程重建恢复导航状态。原件跳转复用 CaptureRecordsActivity/Central reader 或文件 reader；来源配置只作来源入口，不能充当原件。已过期/不可读明确显示，不取消现有权限检查。离线仍能读本机历史与保留原件。

设置放“本机存储”下独立“上传历史保存时长”，复用现有 duration API，默认30天；明确只影响历史，不删资料/待传/草稿。UI 不新增生命周期政策。

## 针对性验收

纯 JVM：日期/筛选/批次不拆分、精确计数、结果状态、各类 ACK 身份不匹配/缺失/部分/重复、发送取消/未发送、设置有效值。真实 SQLite：事务故障、重开、旧/新版本、目标隔离、首次确认时间、过期只清历史、marker 断点恢复。真实隐藏模拟器+生成 Central：来源一项、文件多块/缺块重试、附文字附件一项，到 ACK/原件可读；503 在提交后/离线重试不重复；保存/详情返回、筛选滚动、重建/强停恢复、空/错误页面。旧已过 capture 场景复用；只重跑被改路径。无真机/真实模型冒称，无部署/真实数据清理。

## 请求独审

请对本基线和本文件 SHA 明确 APPROVE / 修改要求：
1. 新独立三类 metadata 库与精确身份/最小 completion marker 是否足够，是否允许上述 lane 完成顺序？
2. 文件传输 phase 与最终资料确认分开、附件与父 note 同 batch、重放只保留首次确认时间是否符合既定合同？
3. 双历史库的非原子 prune 可见失败/可重试、marker 到完成才删除是否保持已批保留边界？

Hold 项全部不动；不改第三方脚本联网策略，不扩凭据权限。
