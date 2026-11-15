# 个人助理大专项 · Q3 交付复核

本文第 1–8 节保留 2026-11-13 的历史复核结论；后续修复与真实运行证据见第 9 节。历史缺口不能直接当作当前版本仍存在的缺陷，卡内 PASS 也不能代替当前运行验证。

- 日期：2026-11-13（Asia/Shanghai）
- 复核基线：`origin/main` `5482ebd6b`（#855，Q2）。本卡只审查已合入的 53 张卡和本工作树。
- 复核范围：`06 - 实施拆解与验收方案` 的 54 张卡、第 2 节约束、第 7 节最低证据、第 8 节需求映射。
- 证据约定：合入提交/PR 在 Git；每张卡的开发自述与独立验收记录在仓库外 `acceptance/PA-<卡号>/DONE.md`、`ACC.md`。本文件不复制个人资料、截图、密钥或真实 profile。
- 本文件是复核记录，不是发布说明，也不是对 J1/J2/Q1 整组、Q2 或 J3–J7 整组、54 卡整体的通过声明。各卡 ACC 的 PASS 只按其卡内范围成立。

## 1. 结论摘要

1. **卡数可核对**：`e34ac9929..5482ebd6b` 共 54 个提交，其中 53 个是 06 的已合入卡（#802–#855），另 1 个是无文件变化的空提交 `5613c367f`，不构成第 54 张卡；第 54 张是本卡 Q3。`merged.txt` 的 53 条 PA 记录与 PR 一一对应。
2. **验收内容与合入内容一致**：53 张卡的 squash diff 与验收分支 diff 的 `patch-id` 全部一致；没有发现“ACC 通过但合入内容被替换/漏合”的情况。
3. **54 张卡均有可审阅依据**：53 张有合入提交、PR、DONE/ACC（ACC 结论均为 PASS）；Q3 的依据是本文件和本卡提交。没有只靠口头“完成”的卡。
4. **没有新增迁移、租户、account host、Host runtime 概念或 delegation 扩展**：新增表在现有 schema 中以 `CREATE TABLE IF NOT EXISTS` 建立，schema fingerprint 随当前格式更新；没有迁移脚本、旧读器、双写或兼容层。delegation 只改既有 run/receipt 的缺陷路径（2 个文件、+45/−9），没有新 lease、ledger、binding 或 commit fence。
5. **没有真实数据进入 Git**：53 张卡变更的 468 个文件均为代码、测试、文档、生成 fixture 或文本型原生补丁；没有图片、PDF、数据库、`.env`、证书、密钥、用户主目录绝对路径或 acceptance/profile 文件。本卡的 docs-only 提交未引入数据。
6. **发现 1 个具体交付缺口和 2 个需要明确写入说明的边界**：
   - Android U6 的动态/建议/事项页面只有组件和 ViewModel，生产源码没有挂载点、没有构造 `AssistantFeedViewModel`/`AssistantMatterViewModel`；J7 的 Android 动态入口没有运行证据。
   - K2/C6 的 source-only 会话选择仍是显式 400；要按来源问答必须同时给出精确原件 ID，或使用空选择。
   - A14 在旧卡被 `never_remind` 后遇到资料换版会返回 409，可能暂时阻止同一 scope 的新问题分析。
7. 其余风险集中在真实模型语义、真机/系统通知、真实 NAS/SAF、OCR 质量、外部发送和并发启动；均按“受影响行为”列在第 6 节，不笼统写成“未测”。

## 2. 复核方法

- 通读 06 的 Q3、第 2 节、第 3 节完成条件、第 7 节矩阵/命令和第 8 节映射；对照仓库根 `AGENTS.md` 与相关 app 约束。
- 用 `merged.txt` 建立 53 张卡的 PR、squash 提交映射；逐项检查提交是否为 `origin/main` 祖先、是否为空提交、改动文件数。
- 对每张卡，把 squash 提交的 diff 与验收分支（本地 `plan/PA-*` 或 ACC 中记录的最终提交）相对其 merge-base 的 diff 做 `git patch-id --stable` 比较；53/53 一致。
- 逐份读取 `acceptance/PA-*/ACC.md` 的结论、范围、未跑项与风险，并与 DONE 的旧哈希/旧基线差异区分；以 ACC 的最终树为准。
- 静态检查约束：新增表/迁移、tenant/account、lease/ledger/binding/fence、scheduler/event bus、delegation diff、新增依赖、二进制/个人数据路径、绝对 home 路径和密钥模式。
- 只做 docs-only 的 `check:affected -- --dry-run` 和 `git diff --check`；没有重跑卡内测试、全量测试、重型 E2E、真机、真实模型或外部发送。已有结果按 ACC 记录复用，不把文档结论当作正确性测试。

## 3. 54 卡覆盖清单

“依据”列给出合入 PR/提交和仓库外验收记录；“复核边界”列只写本卡实际核对到的内容或具体缺口，不重复 ACC 的全部断言。

| 卡 | 合入 | 依据 | 复核边界 |
|---|---|---|---|
| K1 | #802 `3607ed19f` | ACC PASS | 冻结 scope、证据引用/版本、任务/消息幂等与状态 DTO；共享契约往返和拒绝未知模板有测试。 |
| K2 | #803 `cc4a64bb4` | ACC PASS | 时间/设备/证据范围、目录可见性和披露前复查已验收；source/root 的通用选择未交付，source-only 会话选择仍为 400（见 6.2）。 |
| K3 | #804 `5ba509542` | ACC PASS | `task_records`/`task_evidence`、输入/结果/证据依赖和删除清理；删除 A 保留 B、晚到写入拒绝有测试。 |
| K4 | #816 `d889fdf94` | ACC PASS | 既有执行器上的持久 item/checkpoint/reduce、取消和重启恢复；验收时为组件级，后续 Q1 已把生产 batch 接到真实预算/模型装配。 |
| K5 | #811 `6dcece83a` | ACC PASS | 模型只产出受约束草稿，宿主校验并分派产品命令；伪造能力、越界来源、过期草稿拒绝。真实开始归 A2/Q1。 |
| C1 | #806 `71751d1fc` | ACC PASS | context window、输出上限、计数策略与历史占比分离；小预算阈值/比例/单条超长有测试。 |
| C2 | #805 `7f7f07077` | ACC PASS | 用户输入先持久接收、稳定 seq、`clientRequestId` 幂等；去掉 200 轮/4 MiB 总量上限，205 条分页有测试。C6 负责执行接线。 |
| C3 | #821 `73da4ca46` | ACC PASS | 稳定 seq/游标分页、跨页定位、删除后正文/附件名/搜索摘要不泄漏；历史工具的 time/device 组合未直接测试（ACC 已记录）。 |
| C4 | #826 `dc09294a2` | ACC PASS | `coveredThroughSeq`、前缀指纹、摘要依赖和删除失效；压缩失败/超时/重启保留原文。完整请求预算归 C5。 |
| C5 | #853 `31967feb6` | ACC PASS | 稳定前缀/动态字段分离、HTTP/import/Codex 原生发送前完整预算、一次有界缩减和 `processing_limit`；无 live-model/tokenizer/缓存收益证据。 |
| C6 | #812 `f9957a765` | ACC PASS | C2 消息按服务端 seq 进入真实查询、丢响应/重启/取消/晚到结果；source-only 选择仍拒绝，未把来源列表变成批量正文提示。 |
| C7 | #839 `d11439719` | ACC PASS | Web 主对话、分页、accepted/queued/running/failed、幂等重发和草稿按钮；anchor 回退分支只有代码审查证据，ACC 已记录。 |
| C8 | #840 `fa816054f` | ACC PASS | Android 主对话状态机、进程重建后的请求 id、分页合并、失败重试和 scope；无真机后台恢复证据。 |
| C9 | #825 `686370fc4` | ACC PASS | 多对话默认关闭、主对话选择、上下文配置和默认 Ask；关闭不删除侧对话；`contextWindowSource` 只接受 configured/conservative。 |
| F1 | #807 `a1d2d1922` | ACC PASS | 扫描代次、根身份、完整性和最后成功时间；空目录、拔盘、权限失败、分页中断和 watcher 丢失有生成目录测试；无真实 NAS。 |
| F2 | #815 `941f2fa3c` | ACC PASS | `entryId`/locator/`contentVersion`/`contentHash` 分离，改名/同名替换/同内容副本/重挂载/读中替换；仅已验证 APFS 卷，旧 registry 明确拒绝。 |
| F3 | #818 `7f1cc31d3` | ACC PASS | 同 scope 已有对象复用、受限 collector 探测不泄漏存在性、上传中撤回、GC 交错；无多进程 GC 实测。 |
| F4 | #830 `d3800a90f` | ACC PASS | 增量上传、不可靠元数据重核、reference 零正文、spool 重试和模式选择；无真实 NAS/外接盘，atime 规则边界已记录。 |
| F5 | #833 `9999aae02` | ACC PASS | SAF provider document ID/URI、持久授权、移动/替换/重授、撤权、列举中断和重启重传；JVM 证据，不证明真实 provider/WorkManager。 |
| F6 | #835 `0dd2ef1f4` | ACC PASS | 内容+处理器/版本/配置缓存键、独立出处、删除一处不影响另一处；未证明 exactly-once，部分保留模式/附件边界未单测。 |
| F7 | #819 `6d6be4a0d` | ACC PASS | 扫描 PDF 逐页渲染、页坐标、有限并发、失败页重试和缺 OCR 能力明确失败；OCR 质量未测，页检查点只在单次调用内有效。 |
| F8 | #820 `7d72a70a1` | ACC PASS | pending/partial/ready/failed/unsupported、页/段/单元格坐标、提取与 embedding 覆盖；未验证真实损坏 PDF 和真实 OCR。 |
| F9 | #829 `13085f487` | ACC PASS | FTS5/向量/RRF、目录与正文命中分明、多位置可用性、受控原件打开；不执行模型给定路径/URL。 |
| F10 | #841 `a4935ef10` | ACC PASS | 文件覆盖、保留方式和原始状态展示；未跑真实浏览器；单独打开 local-files 连接页时专用 retention 样式不会注入（ACC 已记录）。 |
| F11 | #827 `81becf8ab` | ACC PASS | 重扫/重处理预览、范围、取消和恢复；Desktop 按钮链路只有函数级 UI 测试和 smoke 语法检查，未执行真实 Electron 交互。 |
| F12 | #824 `601c0844b` | ACC PASS | 版本化文件观察、变更游标、墓碑/归属和 A4 输入；Lark 短快照与普通文件 item 形状不同，附件墓碑未覆盖（ACC 已记录）。 |
| A1 | #810 `0da7ac3dd` | ACC PASS | 事项对象、revision、类型化产品命令和条件更新；不把到期/Todo 完成写成履行。 |
| A2 | #828 `7d949f7cb` | ACC PASS | 从接受建议到真实任务、结果回链、丢响应/重启/撤回和唯一性；Q1 用真实上传/HTTP/队列复核 J1。 |
| A3 | #813 `233d49d2f` | ACC PASS | 卡片正文/版本/反馈/已读、范围过滤、解决和删除失效；唯一已读事实，通知只是投影。 |
| A4 | #822 `f78183bab` | ACC PASS | 持久变更发现、游标、队列、去重和删除优先；不重复分析无新有效输入。 |
| A5 | #817 `4e0f33120` | ACC PASS | 读取已有理解产物与原文证据，按范围/lineage 过滤；A5 不写卡、不生成建议。 |
| A6 | #846 `4ba0127a0` | ACC PASS | 初次认识的范围、进度、增量补齐和旧资料安静补入；fixture 用受控 32k 窗口，生产预算由 Q1/Q2 接线复核。 |
| A7 | #823 `65c108989` | ACC PASS | 承诺、期限、进展时间线、人物关联和条件写入；模糊期限保持 unknown，同名人物不硬合并。 |
| A8 | #809 `f74e889c3` | ACC PASS | IANA 时区、本地时刻、revision、`nextDue`、DST 跳空/重复；下游 occurrence/准入归 A9。 |
| A9 | #834 `73904acb9` | ACC PASS | 周期 occurrence 唯一、自动准入、停机漏期合并、规则改版/暂停/stop/off；不把定时当手动授权。 |
| A10 | #836 `fb40b697e` | ACC PASS | 需要补充的信息、revisioned owner question、两端答复一次生效和任务恢复；未答不当同意。 |
| A11 | #837 `8f4fb2fdd` | ACC PASS | 助理草稿接既有 Todo/Action 工作流、确认/回执/uncertain/同事项回链；`byMatter` 仍用调用方统一 scope，混合 scope 事项是后续风险。 |
| A12 | #831 `057c3875b` | ACC PASS | 通知偏好、资格判断、安静时段、卡片版本投影和已读/解决/忽略失效；不承诺系统投递或跨端 exactly-once。 |
| A13 | #838 `e8e2c92e5` | ACC PASS | Coding 会话同时服务技术/个人助理，保留用户请求、agent 报告、未决项和归属；Q2 修复了失败尾页继续进入消费者。 |
| A14 | #832 `60164c1d0` | ACC PASS | 结合背景生成建议、简报、更新已有卡片 revision；不重复提醒、零 Memory 候选可运行；被 suppress 的旧卡遇换版会 409（见 6.3）。 |
| A15 | #814 `753e3d5a1` | ACC PASS | 当前 Memory 读取、owner 纠正、遗忘、主题范围和删除失效；旧理解不能覆盖当前纠正。 |
| U1 | #842 `8c5353cab` | ACC PASS | Web 首页动态、今日简报、建议、开始/稍后/忽略和已处理分组；stale 任务未归入已处理，开始入口可能重现后由 A2 拒绝（ACC 已记录）。 |
| U2 | #847 `525442cb2` | ACC PASS | Web 事项、承诺和规则详情、revisioned 命令和回链；消费 A7/A9/A10 的真实 DTO。 |
| U3 | #843 `1433e6087` | ACC PASS | Web 记忆、人物和主题聚合；人物浏览只由 A7 显式 `personMemoryId` 驱动，不是全部人物 Memory 的完整目录。 |
| U4 | #850 `5eda78c75` | ACC PASS | Web 连接价值、覆盖和可恢复初次认识；本卡为组件/HTTP fixture 证据，Q2 的 Web 构建/入口检查未单独覆盖该面板的真实浏览器路径。 |
| U5 | #844 `4dd7ba4aa` | ACC PASS | 共享工作台投影和四个固定模板，真实服务端输出由 TS/Kotlin 消费；外部 Memory provider 路径未在本卡覆盖。 |
| U6 | #849 `f38394eff` | ACC PASS（组件） | Android 动态/建议/事项 ViewModel 与状态机通过 JVM/真实 DTO 测试；**生产源码没有挂载 `AssistantFeedView`/`AssistantMatterView` 或构造对应 ViewModel**，J7 的 Android 动态入口缺失（见 6.1）。 |
| U7 | #852 `1ebf00d4f` | ACC PASS | Android 文件可用性、连接、初次认识和记忆人物页；pending 本机文件的生产投影未复制 `pending` 字段，可能显示“仅目录信息”（呈现级，ACC 已记录）。 |
| U8 | #851 `f5c6b4e18` | ACC PASS | Android 工作台、四模板、受控命令和行动深链；JVM/真实 HTTP 契约，未跑模拟器/真机原生布局。 |
| U9 | #845 `ab597d1b2` | ACC PASS | Mac/Android 在线原生通知适配，读取真实 Central 投影；不证明 macOS/Android 系统实际投递、权限或后台准点。 |
| U10 | #808 `3a1f2c808` | ACC PASS | 导航、插件 manifest、深链 registry、capability 禁用和六语言接入；最终全入口核对由 J7/Q2，Android U6 入口仍缺。 |
| Q1 | #854 `d777c9ca0` | ACC PASS | J1 真实上传→accepted→草稿→开始→受限检索→持久结果；J2 文件版本→A4/F12/A5/A14→同一卡 revision；生产预算接线。SQLite 双进程启动锁 3/17 未修复（见 6.9）。 |
| Q2 | #855 `5482ebd6b` | ACC PASS | 跨压缩/分页删除闭包、owner 纠正无新文件、Coding 尾页、旧资料批量初识、隐藏浏览器；J1/C6 与 F4/F5 模块证据按文件未变复用，未重跑整组 J1–J7。 |
| Q3 | 本卡 | 本文件 + 仓库外 DONE | 只做交付复核、覆盖清单和风险说明；没有新增产品行为，不把文档结论当正确性测试，不宣布整组收口。 |

## 4. 需求追踪（06 第 8 节）

| 需求 | 实现卡 | 已核对依据 | 仍未覆盖/缺口 |
|---|---|---|---|
| 长期主对话、较大有效上下文、历史回读、可选多对话 | C1–C9、K2/K5 | C2/C3/C4/C5/C6 的存储/分页/压缩/预算；C7/C8 两端；C9 配置 | source-only 会话选择 400；C3 历史工具 time/device 组合无直接测试；百万窗口未测。 |
| 本地/NAS/手机文件、增量扫描、版本/身份/位置 | F1–F5、F10/F11 | F1 根完整性、F2 逻辑身份、F4 增量、F5 SAF、F10/F11 状态/重处理 | 真实 NAS/SMB、真实 SAF provider、拔盘/权限失败和手机后台未测。 |
| 三种保留方式、内容检索、扫描 PDF、覆盖/原件打开 | F3–F10、K2 | F3/F4/F5 模式与零正文、F6 复用、F7 OCR、F8 覆盖、F9 检索/打开、F10 状态 | OCR 质量、真实损坏 PDF、真实 NAS/SAF 原件未测。 |
| 动态、今日简报、可执行建议、接受/稍后/忽略 | A2–A5、A9/A14/A15、U1/U6 | A3 卡片、A14 建议/简报、A2 接受、U1 Web 首页；Q1 J2 真实链路 | U6 Android 动态页未挂载；真实模型语义质量未测。 |
| 长期事项、承诺、期限、进展、会前/会后 | A1/A2/A7/A9–A11、U2/U6 | A1/A7 事项/承诺、A9 周期、A10 问题、A11 Actions、U2 Web 详情 | U6 Android 事项入口缺失；真实外部发送未测。 |
| 记忆、人物/主题、纠正/忘记、初次认识 | A6/A7/A15、U3/U4/U7 | A15 当前 Memory/纠正/遗忘、A6 初识、A7 人物关联、U3/U7 页面 | 人物页只列 A7 关联人物；真实模型人物识别质量未测。 |
| 一句话长期服务、时间/范围、暂停/修改/恢复 | K5、A8/A9、U2/U6 | K5 草稿/命令、A8 时间、A9 occurrence/准入、U2 规则详情 | U6 Android 规则入口缺失；真实定时后台未测。 |
| 需要补充的信息、Todo/消息/日历 Actions | A10/A11、U2/U6/U8 | A10 问题恢复、A11 确认/回执/uncertain、U2/U8 回链 | 真实 Todo/日历/消息连接器未发送；U6 入口缺失。 |
| 项目/人物/旅行/阅读工作台、插件和深链 | U5/U8/U10 | U5 四模板、U8 Android 工作台/深链、U10 导航/capability | 外部 Memory provider 未覆盖；Android 真机布局未测。 |
| 跨端入口、持久待看、在线原生通知 | C7–C9、A12、U6–U10 | C7/C8 对话、C9 设置、A12 投影、U7/U8/U9/U10 页面/通知 | U6 Android 动态/事项页未挂载；系统通知实际投递未测。 |
| 统一授权、删除/撤回、恢复、当前格式 | K1–K5、各领域 lifecycle、Q1–Q3 | K2/K5 范围/命令、K3/C4/A3/A7/A15/Q2 删除闭包；本轮格式扫描 | A14 suppress 后换版 409；source-only 会话选择 400；无整组声明。 |
| 文件变化产生主动帮助 | F12、A4/A5/A14、U1/U6、Q1/Q2 | F12 观察、A4 入队、A5 读取、A14 卡 revision、Q1 J2、Q2 交叉失效 | U6 Android 建议入口缺失；真实模型“是否值得提醒”质量未测。 |
| Coding 同时用于技术背景和个人助理 | A13/A14/A15、K2、Q2 | A13 尾页/归属、Q2 尾页消费者、A14 卡片、A15 纠正 | 真实 Codex/真实模型执行未测；只证明受控 provider 和协议。 |
| 工作与生活共用记忆和跟进 | A6/A7/A14/A15、U3/U7、Q2 | A15 同库 Memory、A7 同 schema 承诺、A14 工作/生活卡、Q2 混合范围 | 真实模型语义/人物/冲突判断未测；U6 入口缺失。 |

## 5. 约束与不变量复核

### 当前格式、租户与迁移

- 没有新增 `tenant`、`accountHost`、`account_host` 或多 owner 分支；仍是单 owner。
- 没有新增迁移脚本、`user_version` 步骤、旧格式 reader、双写或兼容层。新增领域表在现有 schema 初始化中以 `CREATE TABLE IF NOT EXISTS` 建立，`schema-fingerprint.json` 随当前格式整体更新。
- 新增依赖只有 `@js-temporal/polyfill`（A8 的 IANA/DST）和 `@napi-rs/canvas`（F7 的 PDF 页渲染）；没有新解析服务、远程视觉外发或第二套布局语言。
- F2 对旧 registry 明确拒绝而不是提供旧读器；旧资料的清理/重建仍需 owner/协调者决定，这是“一个当前格式”的保守取舍。

### 权限与外部效果

- 查询侧仍是只读上下文工具；模型输出只形成受约束草稿（K5），任务创建/接受关联归 A2，Todo/日历/消息等外部效果经 A11 的既有 Actions 授权和确认。
- K2/C3/A15/F9/U5 的范围过滤贯穿正文、标题、路径、计数、Memory、历史和附件；空 `evidenceIds` 保持空，未回退成 `all`。
- A2/A10/A11/Q1 的测试覆盖丢响应、重启、撤回、未答、uncertain 和重复接受；没有把模型文本当授权。
- 明确的失败关闭：source-only 会话选择返回 400；A14 被 suppress 的旧卡遇换版返回 409；F2 旧 registry 拒绝。它们不是泄漏路径，但都是产品边界，见第 6 节。

### 依赖删除与失效闭包

- K3：`task_records`/`task_evidence` 删除 A 清理 A 的冻结输入/结果/证据，B 保留；晚到写入拒绝（`task-records.test.ts`）。
- C4/C6/Q2：工作摘要/压缩覆盖、对话分页、普通删除和“忘记文件”跨压缩边界失效；回答、摘要、任务输入、卡片、问题、通知均纳入（`assistant-context-journey.test.ts`、`conversation-lineage.test.ts`、`conversation-retirement-authority.test.ts`）。
- A3/A4/A7/A12/A15：卡片版本/反馈/已读、变更游标、承诺时间线、通知投影和 Memory 纠正/遗忘均按证据删除失效；不是只删结果行。
- A11/F3/F6/F9：Actions/内容复用/文件打开都复查当前权限、版本和证据；删除/撤回后晚到结果不能发布。
- Q3 未发现新的“删除后仍可从缓存/摘要/通知读回正文”的静态路径；但真实模型重试、外部连接器回执和真机缓存仍按第 6 节列为未测。

### 运行时与 delegation

- `e34ac9929..5482ebd6b` 没有新增 scheduler、event bus、lease、delivery ledger 或 commit fence；Host 仍使用既有执行器/队列/授权。
- delegation 变更仅 `agent-delegation-plugin.ts` 和 `delegated-query-runs.ts`（+45/−9）：补历史快照提交、失败回调带 work、request identity 和等待既有 run 的辅助方法；没有新表、没有新 wire 类型、没有迁移 delegation 的整体重写。
- Android `SourceLease` 和 `AssistantDomainBindings` 是各端既有本地状态/注入接口，不是 Host runtime 新概念。

### 数据与环境

- 新增文件扫描未发现图片、PDF、SQLite、`.env`、证书、私钥、`sk-*`/`ghp_*` 模式、用户主目录绝对路径或 acceptance/profile 内容。
- 所有卡片证据使用生成资料、临时 profile、固定时钟或本地可控 provider；真实个人 profile、截图、设备数据没有进入 Git。
- 本卡没有启动/重启/占用旅程中央 `:47852` 或个人中央 `:47862`，没有部署、推送、PR 或 CI。

## 6. 具体遗留风险

严重度只表示“对本专项承诺的影响”，不是对已通过卡的翻案。

| # | 风险 | 具体受影响行为 | 依据/状态 |
|---|---|---|---|
| 6.1 | **Android U6 动态/建议/事项页未接入生产** | 生产 Android 源码没有构造 `AssistantFeedViewModel`/`AssistantMatterViewModel`，也没有挂载 `AssistantFeedView`/`AssistantMatterView`；用户只能走通知 Inbox 和 U8 工作台，不能从 Android 助理动态页做反馈/接受/事项详情。J7 的“全部 C/F/U 入口”与需求“跨端入口”因此不完整。 | U6 ACC 按组件范围 PASS，并明确把接线留给 U10/协调者；U10 在 U6 之前合入，Q2 J7 的 Android 证据是 Kotlin decoder/真实 DTO 和 U8 工作台，未补 U6 挂载。静态核对：`apps/android/app/src/main` 无任何构造点，只有测试引用。 |
| 6.2 | **source-only 会话选择仍是 400** | 在主编对话里只给 `kind:'selection'` + 非空 `sourceIds`、不给精确 `evidenceIds` 时，接收返回 400；要按来源问答必须同时选原件，或使用空选择。不是把来源列表变成批量正文，但“按来源范围直接问答”尚未交付。 | K2 ACC 明确记录 source/root、`selection=[]` 未交付；C6 ACC 记录该 400；代码 `conversation-queue.ts:26,78`，测试 `conversation-queue.test.ts:170` 断言 400 且零模型请求。 |
| 6.3 | **A14 suppress 后换版会阻断同一 scope 的新分析** | 用户对旧卡点 `never_remind` 后资料出新版本，旧卡变 stale；对同一 scope 的新版本启动 follow-up 会返回 409 `Historical assistant context requires a current-evidence review`，在新卡解决/清理前，同一 scope 的其他新问题也可能被挡住。 | A14 ACC 已记录保守 409；`assistant-followup.test.ts` “superseded card context fails closed ...” 固定该行为；Q2 未覆盖“suppress + 换版”的组合。 |
| 6.4 | **真实模型语义质量未测** | 建议是否值得提醒、承诺/期限抽取、人物/主题归类、语义重复合并、`never_remind`/`later` 的理解质量都只有受控 provider/生成输入证据；fixture 只证明协议、范围、提交和失效，不证明自然语言效果。 | 全部 ACC 的 live-model 项均未跑；06 第 7 节 L3 明确本轮不默认跑。 |
| 6.5 | **真实设备/平台行为未测** | Android SAF/WorkManager 后台唤醒、系统通知实际投递、权限弹窗、进程杀死恢复、Mac watcher/通知中心、Electron 真实按钮链路和原生布局都没有设备证据；目前是 JVM/fixture/适配器证据。 | F5/C8/U6/U7/U8/U9/F11 的 ACC 均记录未跑真机/模拟器；F11 的“立即检查并上传→预览→开始”未执行真实 Electron 交互。 |
| 6.6 | **真实 NAS/外接盘行为未测** | F1/F2/F4 的根身份、改名、同 size/mtime 变化、拔盘/空挂载壳、权限失败、atime/元数据规则都在临时目录/模拟条件验证；NFS/SMB/AFP 或真实 APFS 外接盘的延迟、权限和重挂载差异未知。 | F1/F2/F4 ACC 均记录无真实 NAS；F4 还记录 atime 规则可能让定向重读等待。 |
| 6.7 | **OCR 质量与重启页检查点未测** | F7 只证明生成混合 PDF 的真实渲染/本地可控 OCR 适配、失败页重试和缺能力失败；识别准确率、真实扫描件坐标、跨重启成功页复用未证明，重启会再次渲染/发送已成功页。 | F7 ACC 明确“仅 mock OCR 不能声称质量”；页检查点只在单次 `decodePdfWithOcr` 调用内有效。 |
| 6.8 | **外部效果没有真实发送证据** | Todo/日历/消息/连接器的确认、授权、回执和 uncertain 都是本地受控适配器；真实外部服务拒绝、超时、部分成功、账户权限和回链未验证。 | A11/A2/U8/Q1 的 ACC 均记录未做真实外部发送；06 明确外部效果走既有 Actions，fixture 不能冒充。 |
| 6.9 | **双进程启动 SQLite 锁** | 两个 Central 进程同时启动时，`assistant-routines` 的双进程诊断 17 次中 3 次在构造期 `database is locked`（早于 `busy_timeout`）；影响并发启动/测试稳定性，不是本专项引入，但未修复。 | Q1 ACC 记录 3/17；Q2 的 51 项消费者套件单次通过，未复现也未重复抽样；不能据此宣布稳定。 |
| 6.10 | **U1 stale 任务分组与 all-scope 接受** | 首页把 stale 任务排除在“已处理”之外，旧的开始入口可能重新出现，最终由 A2 以 409 拒绝；首页统一用 `scope=all`，原本在 selection 下生成的建议跨 scope 接受可能 404/409。 | U1 ACC 已记录；当前 Web 使用 task 路由，A2 的 scope 校验仍是最终拒绝点。 |
| 6.11 | **U7 pending 文件标签与 F10 样式** | Android pending 本机文件的生产投影未复制 `pending` 字段，可能显示“仅目录信息”，但离线打开/导出仍可用；Web 单独打开 Sources 的 local-files 页时 `.file-retention-settings` 专用样式不注入，表单功能仍可用。 | U7/F10 ACC 记录，均为呈现级，未按最低验收失败处理。 |
| 6.12 | **历史/详情边角未测** | C3 的模型历史工具未直接测 time/device 组合；C7 anchor 回退只有代码审查；F6 未覆盖 reference 供体、source exclusion、附件父隐私、图片 understanding 关闭授权等边角；U5 外部 Memory provider 未覆盖；A11 `byMatter` 仍用调用方统一 scope。 | 分别见 C3/C7/F6/U5/A11 ACC 的“未跑/风险”节；不影响各自卡内已验收范围。 |

## 7. 本卡实跑检查

| 检查 | 结果 |
|---|---|
| `npm run check:affected -- --dry-run`（写文件前） | rc=0；无 affected scopes/checks，提示 docs-only。日志 `.mote/checks/q3/affected-before.log`。 |
| `npm run check:affected -- --dry-run`（写文件后） | 结果同上，docs-only；日志 `.mote/checks/q3/affected-after.log`。 |
| 53 卡提交祖先与空提交检查 | 53/53 为 `origin/main` 祖先；`e34ac9929..5482ebd6b` 共 54 个提交，唯一无文件变化的是 `5613c367f`。 |
| 53 卡 squash/验收分支 `patch-id` 比较 | 53/53 一致；没有“ACC 内容与合入内容不同”的卡。 |
| 约束静态扫描 | 未发现 tenant/account、迁移/旧读器/双写、lease/ledger/binding/fence、scheduler/event bus 或 delegation 新概念。 |
| Git 数据扫描 | 53 张卡变更的 468 个文件均为代码/测试/文档/文本 fixture；未发现图片、PDF、SQLite、`.env`、证书、密钥、用户主目录绝对路径或 acceptance/profile 文件。本卡提交仅新增复核文档和索引行。 |
| `git diff --check` | rc=0；本卡提交后工作树干净。 |

没有在本卡重跑卡内测试、全量 affected 计划、全量 UI、重型 E2E、模拟器/真机、真实模型、真实 NAS/SAF、OCR 质量或外部发送；这些按 06 的 L3/L4 边界和“只复核已产出证据”的要求列为未跑，不用文档结论替代。U6 缺口是静态挂载缺失，现有测试无法在不构造生产 Android host 的情况下形成有效窄检查，因此本卡只记录，不把失败测试提交为验收产物。

## 8. 收尾边界

- 本卡没有合并 main、rebase、squash、push、开 PR、部署或启动 CI。
- 没有修改 `~/mote-lanes/ACC`、旅程中央 `:47852`、个人中央数据或个人中央 `:47862`；没有启动/重启/占用这两个中央服务。
- 没有新增迁移、租户、Host runtime 概念或 delegation 扩展；没有把真实资料、截图、profile 或密钥写入 Git。
- 本文件不宣布 J1/J2/Q1 整组收口，不宣布 Q2 或 J3–J7 整组通过，不宣布 54 卡整体完成；Q3 的独立验收仍需另做。

## 9. 2026-11-15 后续修复与运行复核

本节复核原 54 卡的可达入口、实际数据链路与运行缺陷，不改写第 1–8 节的历史证据。原始资料、真实记录 ID、个人正文、截图、配置和运行回执均留在仓库外；本节只记录行为、公开代码依据和验证边界。

### 9.1 历史缺口的当前状态

| 历史项 | 后续代码依据 | 当前结论与证据边界 |
|---|---|---|
| 6.1 Android 动态与事项未挂载 | [#859](https://github.com/utopiafar/mote/pull/859)，`e029af028` | 生产导航、插件入口、动态与事项容器已接线；复用该 PR 的生成 DTO、JVM 和真实 HTTP 契约结果。本轮未把静态挂载缺口继续列为现存缺陷，也未补充真机系统行为证据。 |
| 6.2 source-only 主对话选择被拒绝 | [#858](https://github.com/utopiafar/mote/pull/858)，`49e5a1ff8` | 已支持按指定来源查询，范围过滤继续作用于正文与关联上下文；空选择仍为空。复用该 PR 的受影响范围与会话回归结果。 |
| 6.3 never-remind 的旧卡阻断新版本分析 | [#857](https://github.com/utopiafar/mote/pull/857)，`f40ddd37e` | 旧问题的抑制约束可继续参与判断，历史卡片正文不能冒充当前证据；新资料仍可分析。复用其旧红新绿与失效闭包回归。 |
| 6.10 首页统一 all 范围无法接受局部建议 | [#957](https://github.com/utopiafar/mote/pull/957)，`fa608e917` | 首页先展示建议的完整证据范围，开始命令采用当前卡片的固定范围。显式小范围任务不再扫描全库；扩大范围或过期卡片仍被拒绝。已用实际建议完成开始、持久结果和引用回原文。stale 任务的完整分组呈现没有新增独立视觉证据。 |

### 9.2 已验证的实际链路

真实运行使用 Codex App Server 的 `gpt-6.1-terra`、`reasoning=auto`、`serviceTier=fast`，五个模型模块保持同一选择；模型请求与 Agent 总时限均未设置任意短截止时间。运行资料不是自动化测试 fixture，模型结果与生成数据回归分别记录。

| 链路 | 实际观察 | 仍不能据此声称的内容 |
|---|---|---|
| 原始导入与来源信息 | 本地导入、Obsidian、飞书妙记和钉钉录音通过既有导入/连接器入口进入中央；复核原始时间、时区、作者或说话人声明、文件名和附件关系。音频目标经过完整处理步骤。 | 归档成功不代表全库 Memory、助理分析或向量索引全部完成；来源属于主人不代表每位参与者都是主人。 |
| 首页固定入口 | [#945](https://github.com/utopiafar/mote/pull/945) 将个人助理入口固定到首页，提供主对话、初次认识、活动、事项、记忆与工作台。实际隐藏浏览器经公开域名读取成功。 | 该证据不代替 Android/macOS 原生布局、系统通知或前台权限验证。 |
| 初次认识 | 在明确选定的已导入日记范围完成正文与语义处理；没有强制凑出 Memory 或建议。模型正确保留历史观点的时间与归属边界。 | 该范围的完成不代表所有旧运行或所有来源已完成；仍有未解决的归属、图片授权等待及失败恢复。 |
| 主对话到内部任务 | 实际主对话生成可核对草稿，开始后创建唯一内部任务，最终返回引用明确的核对清单；实际结果中的引用能打开原始记录，完成后没有重复开始入口。 | 不证明模型每次都会给出同样语义质量，也没有执行外部待办、邮件、消息或日历。 |
| 建议到内部任务 | 首页实际建议经过范围核对、目标编辑和开始，补充其起始背景后得到持久清单；结果明确保留身份、接收状态与提交状态等未知项，引用可打开原文。 | 手动补足缺失卡片背景不能替代产品修复。相关 [#959](https://github.com/utopiafar/mote/pull/959) 已合并；按本轮收口要求，不再部署或发起新的真实模型任务，因此该修复上线后的正常新开始仍未验证。 |
| 事项与持续控制 | 将已完成的真实核对清单关联到内部事项；实际界面暂停与恢复后，原任务、引用与完整资料范围均保留。 | 暂停/恢复不是“未来新增资料已正确更新同一卡片”的语义证据；该边界仍与 J2/J3 的生成数据证据分开。 |

### 9.3 本轮暴露的运行问题

- [#953](https://github.com/utopiafar/mote/pull/953) 补齐助理消费端的原始归属声明，并允许未解决问题以外的独立结果继续；合法空结果可在受保护的完成阶段恢复，不重复模型请求。
- [#956](https://github.com/utopiafar/mote/pull/956) 修复长提问在首页和来源页的换行。生成布局验证覆盖长文本与窄屏；本轮后续首页快照没有出现可用于重验该特定长提问的当前问题，不能把“无整体横向溢出”当作该长提问已通过的视觉证据。
- [#958](https://github.com/utopiafar/mote/pull/958) 保留 Provider 启动失败的安全原因和可信的未执行事实。早期真实 `provider_failed` 的具体原因仍未知；该 PR 是诊断修复，不等于证明原失败已恢复。
- [#959](https://github.com/utopiafar/mote/pull/959) 将准确的起始建议正文、引用、来源声明与完整范围传入任务，补充续跑和重启沿用同一版本。建议仍是不可信背景，不能扩大读取或 Actions 权限；所有上下文都计入既有请求预算。
- [#960](https://github.com/utopiafar/mote/pull/960) 修复停机清理期间把暂不可用的依赖判为已撤回，导致未答问题过期、任务误显完成的缺陷。整合 #959 后定向回归 76 项、服务端类型检查和构建通过；13 项 lifecycle/shutdown 结果按未变范围复用。生成数据验证“为什么问、影响是什么”不会形成身份声明；原问题已经退休的私有内容不复活，部署后应从当前资料发起新评估。
- [#961](https://github.com/utopiafar/mote/pull/961)，`286c651d7`，修复自动 follow-up 的完整请求预算。已知 Codex 容量的路径使用选定精确原文作为初始输入，完整原文仍可分页读取；业务装箱计入完整请求、native 输出预留与缓冲，native 继续校验每次实际发送。原 HTTP 路径保持既有装配。新增 owner HTTP 重试入口检查原 scope、revision、允许动作及当前权限，恢复同一 task/batch 和触发记录，不通过改库重跑。
- #961 的集成检查曾发现两项 J2 回归，已在合并前修复：完整上下文来源被排除后进入授权等待并保留原任务身份；已参与同一次审查的精确 Material 版本和完整证据集合原子合并认领，避免 quiet timer 到期后重复分析。原断言、输入规模和时限保留。本轮停止前没有执行该修复的生产恢复，也不宣布后台处理已经收尾。

### 9.4 检查与交付边界

原 53 张功能卡及 Q3 的提交映射已重新核对，按原卡职责审查其入口和相互依赖；没有把“提交存在”当作行为通过。后续 PR 的窄检查按各 PR 的受测树、实跑与复用说明使用，没有在每次部署后无差别重跑所有卡内测试。

收口产品提交的受测树为 `c07ae93d2988766d9d5fc43c162c95f4b30e5d7b`，与 #961 合并树一致。J1 最终窄检查 1/1 通过；J2 7/7、follow-up 认领回归 24/24、新增 native/HTTP 预算与恢复回归 5/5 通过。J1 在两项 J2 修复后重跑，不复用修复前的通过结果。相关检查使用生成资料与隔离 profile，不连接个人资料作为测试 fixture。

本轮的实际数据、真实模型、隐藏浏览器、第三方已登录连接器，以及生成资料的 HTTP/SQLite/Batch/Provider 回归分别成立。没有重跑完整 J1–J7 整组；真实 NAS、物理设备后台、系统通知实际投递、外部发送和未授权原始图片理解仍未验证。本节不是 54 卡整体发布通过声明。

### 9.5 用户要求停止后的状态

用户要求结束本轮运行，只收口已在进行的改动并合入 `main`。自动模型处理已关闭，当前自动模型调用已结束；飞书与钉钉录音自动同步已关闭，连接、来源可用性和已归档资料保留。本轮巡检已停止。

本地部署仍为 `fa608e917`（R16），后续合入的修复没有继续部署。未执行已准备的失败任务重试、新初次认识或新建议任务；部分 Memory 与自动分析仍待后续恢复。保留这些未完成状态，不通过改库、伪造回答或清空数据宣布完成。
