# 0.0.61 验证记录

本版按共享对话的 [55 项验收清单](implementation-backlog.json) 逐项收尾：53 项完成所列验收，COL-03 与 OPS-04 因真机条件保留部分验证状态；没有把模拟器或有限质量样本写成真机/普遍质量保证。这里记录最终批次与明确边界；以前各次迭代的数量、当时尚未迁移的模块和失败记录保存在 [历史日志](validation/0.0.61/development-history.md)，不代表本版当前状态。

## 最终验收

- 所有工作区与脚本的 TypeScript 检查、完整构建、5,391 条中英文及 Android 目录同步检查通过。
- 本地统一工作区回归：Desktop 291、Server 546、Web 101、Agent 118、Diagnostics 5、Local inference 13、Shared 69 项。首次有两项失败：Indexer 迁移遗漏诊断计时，以及新 Web 夹具仍断言旧文案。前者恢复诊断并改用真实 transport mock 后，相关 31 项通过；后者按最终文案修正，3 项通过。Agent 有 1 个需显式指定本机 Codex 的可选方法，实际安装版的合成 Responses 兼容验证已在专项阶段执行。完整初次结果和定向修正见 [工作区回执](validation/0.0.61/final-workspaces.json)。不把初次失败写成全绿。持续负载随后暴露长超时定时器未释放；9 步最小复现由遗留 9 个定时器变为 0 个，新增 2 条回归，相关 23 项通过，最终源码含 548 项 Server 测试。
- 32 组真实 Electron/Web/桌面界面验收通过（29 组初次通过，3 组夹具修正后定向通过）。12 组集成中 11 组初次通过，profiles 的实际恢复/升级通过后仅末尾日志负载超时；减少已脱敏日志的同步写入后，同负载及退出/错误专项通过，完整 profiles 仍由最终 CI 再验。结果见 [集成回执](validation/0.0.61/final-integration.json) 与 [界面回执](validation/0.0.61/final-ui.json)。所有初次失败保留，修正只重跑受影响组。
- Release workflow 仅在最终提交通过 GitHub Checks 和各平台验收后发布；门槛包含本机没有运行环境的 Docker、Compose 备份恢复/回滚、Mac 打包与原生 UI、Android 签名及版本核验。发布门槛没有用旧提交的绿色结果代替。

## 生成数据、归档和持续负载

测试全部使用生成资料，不采集个人屏幕或真实邮件。

- 480 条跨六个月记录走逐条和批量 API，覆盖版本、相同时间戳分页、作用域、删除与重启；480 个二进制原件走分片导入、重放、冲突、过期、恢复和附件关联。
- 480 封跨 480 天的生成 Gmail 邮件验证 OAuth 模拟、分页、429、增量历史、修改/改回、删除、history 过期、重扫、撤权和备份恢复。按用户要求免做真实 Gmail 账号测试。
- 400 条跨 400 天资料分别逐条和批量入库，Web、实际 MCP SDK 客户端和 Agent 读取相同范围；400 次 Operations、800 个 Memory 批次和 400 文件 ZIP 中断恢复检查精确 ID、检查点、不漏分页和不复活删除内容。
- 100,000 条目录与 20,000 个观察的顺序规模测试保留在 [架构规模](validation/0.0.61/architecture-benchmark.json)。另一个实际 Desktop SourceSync → Central FileStore 混合测试同时运行采集、后台步骤、浏览与问答，并注入丢 ACK、断网、429、容量满、SIGKILL、租约过期和迟到删除，详见 [混合负载原始报告](validation/0.0.61/mixed-load.json) 与 [稳定窗口说明](mixed-load-stability.md)。传输在同一进程中，不含网络 RTT；模型工作为有界生成回复。旧 12 分钟尾窗功能全过，但 heap 斜率 2.052 MiB/min 略高于自定 2 MiB/min 门槛，原 false 保留。其后通过 9→0 定时器最小断言和同参数 10,000 次查询/后台自然 GC 对照，确认并修复长 deadline 滞留；新版 major GC 后 heap 约 15–16 MiB 稳定。额外低速小窗按最小样本原则提前停止，不标成完整 12 分钟通过。
- 400 条历史笔记与新笔记、大原件的传输轮转，真实 loopback HTTP 的 401 文件/20 MiB 分片，以及 Android 2,000 图片的扫描/删除验证历史积压不会吞掉新的 ACK。详见 [上传公平性](validation/0.0.61/upload-fairness.json)。

## Android 与本机运行时

[Android 最终报告](validation/0.0.61/android-final.json)：API 35 专用模拟器、DEV 包 `dev.mote.collector.dev`，单元测试 **188 通过**，100 个唯一 instrumentation 方法 **99 通过、1 明确跳过、0 未解决失败**。另有复杂笔记三个阶段各重复三轮，实际 force-stop、断网/reverse 断开、恢复和中央逐字/SHA-256 核验。文件旅程检查 205 个引用、分片与 Range。

跳过的是旧的 `versionCode 6 → 7` 系统覆盖安装夹具，不适用于本次 versionCode 72；实际签名 APK 的证书、包名、降级和损坏校验仍执行。没有在物理 Android 设备上验证系统安装/权限恢复或固定条件功耗。

已下载固定 revision 和 SHA-256 的公共 Qwen 双 GGUF，在断网模拟器中完成 **8 次真实 CPU 图像推理**，包含生成复杂图、图内指令和重载，见 [本地视觉报告](validation/0.0.61/android-final-local-vision.json)。生产截图采集的 VLM 仍按当前产品契约暂停，这些推理不意味着采集中启用了 NSFW 模型拦截；用户配置的本机文字隐私规则实际拦截另有验证。

所有 Electron 界面测试使用隔离配置与生成数据。真实 EventKit/Android 个人日历写入、个人截图、邮箱和物理设备功耗均未测试。

## 模型质量与计量

使用用户授权的本地 Codex Server `gpt-5.6-luna`。语义提取、独立 Memory 审核、模型前后对照与独立判断均只输入生成证据。详见 [Memory](memory-updates.md)、[审核复用](memory-review-policy.md) 和 [Prompt/启动对照](agent-prompt-and-startup.md)。

最终三组同模型、同证据的前后对照全部通过各自 rubric：提议与注入、人物与项目范围、部分改期与未知结果。初次部分改期回答错误推断展示时区，修正共享指令后重测该组，并在最终代码上补测另两组；失败报告保留，不混入通过结果统计。使用累计 thread token 回执，模型内部请求次数未知；没有价格的成本保持未知，不写成零。固定精确审核的六次重复请求没有新增模型调用；新候选仍需独立审核。

Harness 四个新会话的真实本地 HTTP 启动基线与跨配置隔离已测；没有复用模型会话，也不声称预热提速。小规模模型对照不构成普遍准确率保证。

## 修复方式和升级边界

- ExecutionEngine 统一资源准入、恢复时间窗、取消、版本/租约校验与事务提交；Query、Insight、Memory、Actions、导入和 embedding 使用真实 Operation 归属。对话与最终回执原子提交，另一主机取消后不得晚写入。
- 原件与版本保持事实依据；派生产物固定引用、范围与依赖，只使受影响后代失效。确定性代码用于权限、去重、配置和时间统计，模型负责证据理解。
- Model budgets 在 HTTP 尝试前事务预留，覆盖重试、审核、压缩及 embedding。未知 usage 保留预留；无法拦截 Codex 内部每次调用时明确禁止硬预算模式。
- UI 统一会话缓存、取消、可见页面轮询和 Operation 订阅，恢复入口使用固定协议码。可选向量失败保留真实原因、显示未完成步骤，不把成功问答误报为整体失败。
- SQLite 权限检查不再打开后立即关闭已有数据库/共享内存文件，避免 POSIX 锁被释放。组合备份/升级夹具保留原件、来源身份、完成步骤与 Memory 批次；恢复只清除失效执行权，不自动重发中断的交互调用。见 [组合恢复](combined-backup-recovery.md)。

升级前备份。升级后若回滚旧程序，应恢复迁移前备份，不能直接让旧程序打开新数据库。本版发布 Mac DEV ZIP 与 Android DEV APK，中央端从源码部署。npm audit 仍有 ExcelJS/间接 uuid 的 **2 项 moderate、0 high/critical**；未以强制降级掩盖报告。
