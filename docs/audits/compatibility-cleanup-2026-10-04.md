# 兼容清理实施记录（2026-10-04）

本记录对应原始审计的 **83 条分模块记录**。按用户授权采用 MVP 破坏升级：可清理的旧入口已退役，先重构的当前写方、消费者和任务契约同步改为新形状；授权、隐私、幂等 ACK、删除防重建和合法测量等当前边界保留。旧资料没有自动迁移，也没有在本次测试中读取或重置真实用户目录。

原始逐文件扫描、风险及旧链路见 [审计快照](compatibility-audit-2026-10-04.md)，它基于改动前的 `8d68aef`，不能当作当前代码清单。当前逐项处理和验证见 [结构化实施记录](compatibility-cleanup-2026-10-04.json)。

## 主要链路与重构原因

| 链路 | 当前实现 | 为什么需要联动重构 |
|---|---|---|
| 启动与持久存储 | 中央 `backend_epoch=3`、Android/Desktop 本机与队列格式 3，完整新建 schema；旧配置、队列、密文及无 marker 的非空数据拒绝，原文件保留 | 直接删除旧 reader 而不建立新写方/格式边界，会把旧文件当成新资料读取。新版本现在只建立当前格式，不隐式认领、回填或重放旧内容 |
| 模型及文件处理配置 | 模型持久 registry version 2、完整 profiles/defaults/defaultModels，实际 `primary` / `env:deployment` 身份；文件显式 policy；请求期限与 Agent 总期限独立 | 当前 UI、模块路由与任务先前仍依赖旧 default/flat 配置，需同步保存、选择、重启与重试路径，才能删除默认合成和参数别名 |
| 捕获、来源与上传 | 本机 raw bytes、统一 appRules、当前原生隐私 OCR、Ingress 2 严格 ACK；来源 SQLite 行存储与当前 checkpoint/adapter 版本 | 旧 OCR 补做、bundle 降级、缺字段补值与自动清队列共用了上传恢复；删除旧路径后仍需保证当前重试不丢资料、不改目标、不给错误收据放行 |
| 任务、Memory 与对话 | 当前任务显式输入版本/产物 pins/contextTime，统一 execution 投影；当前自动/人工激活边界与 lease 恢复保留；旧 Memory/default admission/历史 bootstrap 退役 | 单删兼容分支会破坏当前 Coding、自动记忆与恢复任务。所有写方先固定输入与版本，读取端只消费完整当前形状，删除/修订后继续阻止重建 |
| 查询工具、证据与 UI | 公开引用 `capture:UUID` / `memory:UUID`，Material/Artifact 使用固定版本引用；声明为资源 ID 的 URL 和 tool record.id 使用 UUID；分页统一对象 | 裸 ID 原先同时用于导航、资源访问和内部 grants。同步改生产方、工具桥和 Web/Android 消费者，避免把类型前缀带进资源 URL，或把公开引用降回裸 ID |
| 发布、MCP、下载与恢复 | 组件身份/tag 必填；MCP 当前嵌套连接；模型独占 PID+UUID partial；只接受完整当前便携包 | 删除旧入口时保留当前签名、哈希、路径、授权和并发保护；旧配置/备份显式拒绝，不通过“回退”继续运行 |

## 升级操作和风险

1. 停止中央、采集器及导入任务，完整备份各自数据目录、模型设置、凭据与所需密钥。尚未 ACK 的端侧队列和草稿也在旧目录中；只有旧二进制配完整旧备份可以回滚。
2. 中央优先选择一个新空目录。若明确放弃旧资料，可在备份后执行 `npm run reset:mvp-vault -- --data-dir <旧中央数据目录> --confirm-clear`。脚本检查目录与运行 PID，清除 SQLite、原件/导入暂存和旧模型/文件处理配置；保留 access-token、content-key、connectors、模型和日志。它不会自动改写连接凭据。若 `client-connections.json` 含已退役 `collector` scope，必须单独备份并显式移走该文件、重新配对；当前 owner/MCP 凭据可保留。
3. Desktop 可选择全新的命名 profile。普通 profile 名改为 `default`，仍使用原 Electron userData 路径；`legacy` 参数已拒绝，该路径上的旧格式也不会被采用。Android 先备份需保留内容，再在系统中明确清除应用存储或使用独立开发安装，重新设置与授予所需权限；本次没有执行这些真实设备操作。
4. 显式移走旧 CLI ingress spool；浏览器旧 session 需重新登录，旧 `mote.notes.v1` outbox 需先保存草稿再明确移走。配置文件只通过 `MOTE_ENV_FILE` 显式读取，根 `.env` 不再自动加载。重新配置当前模型 profiles、模块分配、文件 policy、来源及采集规则。
5. 所有端使用本次同一代实现再恢复采集。旧便携包和旧 schema 不能跨代导入；重新导入原始文件或重新扫描来源须由用户选择。重置会永久放弃未备份资料、草稿、任务历史与未上传内容；同一来源重新导入会形成新的本代归档身份。旧链接/参数失效，模型旧 `.part` 不续用可能增加下载量。

## 明确保留的当前边界

- protocol 范围校验、Ingress 2 幂等与冲突 ACK、节点绑定、凭据撤销、MCP 独立限权；当前邀请本来就签发 owner 权限，删除的是旧 collector 权限升级别名。
- 用户设置的精确隐私规则与原生 OCR、当前单条上传/413 分批、来源合法 adapter 升级后的重新扫描、离线保留与安装事务恢复。
- current `.aes` 中央对象与受控策略解密、Desktop safeStorage、Android SecretBox 凭据及私有中央草稿；退役的是旧内容包装和客户端可选加密迁移。
- lease/owner 崩溃恢复、版本/原件 grants、修改/删除后依赖撤销；缺少完整披露依赖时仍保守失效。
- 当前 Markdown/文字视图、未知用量/归属和 OCR 的保守显示、合法单次活动采样。它们由当前产品和测量边界产生，不应删除或编造默认事实。

## 回归验证

最终提交前检查结果将与下表及 JSON 同步。所有自动端到端素材为程序生成的图片、笔记、来源、媒体和临时资料库，未读取真实个人截图。

| 验证 | 结果 |
|---|---|
| `npm run check:local` | 最终整仓检查进行中 |
| Web | 218/218 fixture tests；生产 build 通过 |
| Shared / local inference | 90/90、14/14 fixture tests |
| Agent | 220 项，219 通过，1 项原有 live Codex opt-in 测试跳过 |
| Desktop | 53 文件 / 388 tests；完整 TypeScript、UI、C++、Swift helper/updater 构建通过；真实 Electron 生成 profile 重启与本机内容 UI 回归通过 |
| Android | 54 suites / 245 JVM tests；instrumented Kotlin 源码编译与 debug APK 组装通过；未运行设备 instrumentation / 真机采集 |
| 中央 / 脚本 | focused 契约回归与真实进程 profile/update/MCP 通过；中央 full suite 进行中 |
| 端到端 | Mac/Android 生成截图 + 笔记 → 加密去重中央 → 实际 Harness + fixture provider → Material/原件引用/图片 → 当前便携包往返通过；锁屏媒体 → 受限查询/计时/引用 → 便携包往返通过 |
| 真实模型（单独） | 本地 Codex Server `gpt-6.1-sol`：8 模型目录、工具调用 probe、复制 profile 的模块选择、search_context/evidence 查询及 1 条核验引用通过；仅使用生成记录 |

真实模型检查只覆盖上述配置和查询链路，不能替代未执行的真机、真实屏幕或长期后台采集验证。回归暴露并修复了公开引用在桥中降回 UUID、LibraryBrowse/文件 retry URL 混用类型引用，以及 Agent 记忆详情 UUID 到 typed reader 的连接问题。

## 逐项处理

“保留当前边界”表示条目中属于现行功能或安全校验的部分保留，不表示继续读取旧持久数据。共享跨端条目按原审计编号逐一列出。

### 共享、Agent、Web 与脚本

| 编号 | 原审计项 | 最终处理 |
|---|---|---|
| R01 | 握手缺协议元数据默认接受 v1 | 握手必须有 protocol 元数据；TS/Kotlin 校验范围、中央完整响应及 fixtures 联动更新。 源码：`packages/shared/src/protocol.ts`。 |
| R02 | 旧任务状态映射与 execution 双表示 | 移除历史 materialization 脚本、未知/缺状态默认值与 canceled 别名；当前领域阶段到 execution 调度状态的投影继续保留。 源码：`packages/shared/src/execution.ts`。 |
| R03 | 统一 v 标签和无 component 发布清单 | 组件身份与组件发布 tag 必填；删除统一 v 标签、无 component 清单及容器执行版本探测回退。 源码：`packages/shared/src/release.ts`。 |
| R04 | 旧根目录 env 与 legacy profile 直接启动 | 普通 profile 命名 default，拒绝 legacy；只在显式 MOTE_ENV_FILE 时读取配置文件，不自动读取根 .env。 源码：`packages/shared/src/environment.ts`。 |
| R05 | Agent timeoutMs 旧 SDK 参数 | SDK 仅接收 requestTimeoutMs / agentTimeoutMs；删除 timeoutMs alias。两种期限独立，Codex 当前 null 整体期限语义保留。 源码：`packages/agent/src/types.ts`。 |
| R06 | DeepSeek 旧官方根地址重写 | 删除用户显式 DeepSeek 根地址重写；未填地址时由当前 provider preset 选择官方入口。 源码：`packages/agent/src/model-runtime.ts`。 |
| R07 | Codex 旧缺速度值补 Standard 与 off 字段映射 | 当前 Codex 预设必须显式有 serviceTier；保留 Codex 当前协议 off/none、fast/priority 参数翻译。 源码：`packages/shared/src/model-providers.ts`。 |
| R08 | 网页旧会话 url 校验和缺 viewScope 补身份 | 持久 session 必须有合法 viewScope；含旧 url 字段的身份拒绝，期限与跨节点缓存隔离继续保留。 源码：`apps/web/src/session.ts`。 |
| R09 | 旧资料页导航转 archive collection 与路由别名 | 删除旧 captures/files/memory/materials 页面与旧路由别名；使用 library 的显式 collection 查询。当前插件 collections 保留。 源码：`apps/web/src/workspace-route.ts`。 |
| R10 | 旧网页随手记缺 client 身份与当前 prepared 幂等重试共用 | 笔记 outbox 升为 mote.notes.v3，要求 web client 身份；旧键拒绝并保留原值，已准备提交的固定ID和安全重试保留。 源码：`apps/web/src/notes-state.ts`。 |
| R11 | UUID裸证据引用和注入reader不透明旧ID | 公开证据引用仅 capture:UUID / memory:UUID（以及固定版本 Material/Artifact）；重构所有生产方、工具桥与UI消费者。声明为 resource ID 的接口与原件 record.id 继续使用 UUID，不推断裸ID命名空间。 源码：`packages/shared/src/evidence-ref.ts`。 |
| R12 | 注入 ContextReader 同时接受数组和分页对象 | ContextReader timeline / sourceItems 只返回显式分页对象，不接受数组；全部注入 reader fixtures 同步。 源码：`packages/agent/src/types.ts`。 |
| R13 | 旧洞察 Markdown 读取与现行文字模式共用 | 保留当前产品支持的 Markdown / 文字呈现；后端 epoch3 拒绝旧持久库，无需把现行文字视图当作旧数据读取器删除。 源码：`apps/web/src/InsightReport.tsx`。 |
| R14 | 历史费用缺 attribution 与 usage 保守展示 | 测量缺失与未标记 attribution 继续保守显示未知，不能默认零成本或捏造归属；此情况仍可能由当前 provider 正常产生。 源码：`packages/shared/src/usage.ts`。 |
| R15 | 旧截图缺 OCR 字段和 charging pending 读取 | 删除 charging OCR pending 类型与旧text/ocrEnabled推断。当前缺测量显示 unknown、activity无图显示 not_applicable。 源码：`packages/shared/src/metadata.ts`。 |
| R16 | 无 stateSeries 的单次采样回退 | 当前单次合法采样不必有 stateSeries；保留单次 duration 测量，完整活动统计继续去重裁剪，缺口不推断活跃。 源码：`packages/shared/src/state-series.ts`。 |
| R17 | 缺 inputPlans 的 Memory 批次进度同时服务当前自动任务 | 当前 Memory 写方固定 inputPlanVersion/contextTime/materialInputs；UI只消费必有 inputPlans/recipeProgress/memoryCount，不再用缺字段旧批次分支。直接原件任务的合法空物料计划仍可显示。 源码：`apps/web/src/MemoryProgress.tsx`。 |
| R18 | 模型下载旧固定 .part 临时文件恢复 | 忽略并保留旧固定 .part；所有新下载用 PID+UUID 独占文件，当前实例可续传，仅认领已退出写者的部分文件。 源码：`packages/local-inference/src/index.ts`。 |
| R19 | MCP stdio 支持旧私有 flat connection JSON | MCP stdio 只接受当前嵌套连接导出；删除 flat 私有 JSON 读取入口，保留只读scope验证。 源码：`scripts/mcp-connection.mjs`。 |

### 中央服务

| 编号 | 原审计项 | 最终处理 |
|---|---|---|
| S01 | 未显式环境名的 legacy profile / 默认 data 目录 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S02 | 模型 timeoutMs / MOTE_MODEL_TIMEOUT_MS 旧别名 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S03 | 单模型 default 预设兼容多 profile | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S04 | 旧 collector 凭据取得 owner 权限 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S05 | 无后缀加密文件与 vault-wide encryption 身份 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S06 | 旧图像/归档资产目录及 MOTE1 包装 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S07 | 旧 source-archive manifest 到 SQLite index 的惰性迁移 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S08 | 文件旧 flat settings 转 policy 和旧客户端保护 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S09 | 旧文件任务 UI revision → 新执行 fingerprint aliases | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S10 | 文件/截图旧 running projections 重置为 waiting | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S11 | 旧 processing DAG authority/依赖迁移到共享 engine | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S12 | 旧 query/insight receipts 安装 canonical execution | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S13 | 启动时 reviewed legacy Memory 自动发布、清 proposed checkpoints | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S14 | 旧 Memory 删除意图身份/来源 lineage 补齐 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S15 | OCR managed settings 和旧连接失败一次性恢复 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S16 | 不支持的旧 vault/Coding 索引启动拒绝 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S17 | 旧截图/文件任务没有自动付费处理资格 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S18 | 截图/文件/Memory 搜索、依赖与浏览读模型的历史回填 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S19 | Material anchors、可见序号及payload删除触发器升级 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S20 | Source pipeline 存量工作无storage/checkpoint/generation/recipe pins | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S21 | 共享Execution步骤/Operation生成关系和optional计数升级 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S22 | 授权账本、Memory草稿和资产储存ledger升级 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S23 | 旧无scope自动Memory工作迁移时保留物料并撤销自动重放 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S24 | 对话json.turns拆到conversation_turns历史表 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S25 | 旧 Memory batch 缺独立 pins，以及当前 Coding 无 pins 路径共用恢复 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S26 | 旧人工任务同时选择authored Material和原件的精确一次性复用 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S27 | 旧Memory版本、分类和admission元数据读取默认 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S28 | 历史缺disclosure依赖时全量保守清理，混有现行不完整依赖保护 | retained_current_boundary |
| S29 | 旧raw extraction lifecycle任务/cursor与旧Insight时间配置升级 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S30 | 旧任务没有冻结contextTime时使用持久化创建/开始时间 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S31 | 旧Coding Material schema<5含tool正文，被query和Memory读取隔离 | retained_current_boundary |
| S32 | Source pipeline旧group/organize callback扩展契约与内置重复入口 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S33 | 旧无结构化Transcript产物只允许重新提取后review | retained_current_boundary |
| S34 | 旧Import工作缺处理模式/媒体计数/phase fingerprint元数据 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |
| S35 | 升级后旧网页lazy bundle404边界 | retained_current_boundary |
| S36 | Portable archive v1新增字段缺省允许较早或精简归档导入 | 生产实现已更新；具体处理与最终 full suite 正在收敛。 |

### Desktop

| 编号 | 原审计项 | 最终处理 |
|---|---|---|
| D01 | Ingress v1 → v2 断代迁移、旧队列本地归档及重新导入 | 删除旧 capture/source 协议清空迁移、旧 OCR 上传归档状态；新 desktop/queue/notes/local-sources/storage marker 为 3，旧数据明确拒绝且不改写。 源码：`apps/desktop/src/storage-format.ts`。 |
| D02 | 来源状态 JSON → SQLite、整数组 → 单 revision 行、内嵌 catalog → 行存储 | SQLite user_version=3 新建；拒绝 JSON、旧 SQLite、嵌入 catalog/whole-array pending，不转换、不重命名。保留当前增量行表、事务和 busy_timeout。 源码：`apps/desktop/src/source-state-store.ts`。 |
| D03 | Coding evidence 字段兼容旧中央并永久固定 revision 的 wire schema | 发送完整当前 coding evidence；移除字段降级协商与 codingWireFields 持久化 pin，旧 pin 状态明确拒绝。 源码：`apps/desktop/src/source-sync.ts`。 |
| D04 | 仅为旧队列存在的本机 OCR 补做链路及旧节点 OCR 404 兼容 | 删除延迟 OCR/backlog/charging 重试与补传接口；保留每次新 capture 的本机 OCR 隐私 gate、captureAbort 和准确 ACK。 源码：`apps/desktop/src/collector.ts`。 |
| D05 | 读取历史本机加密 envelope/key；批量解密入口已无生产调用 | 删除 AES 内容 key/policy/decode/批量解密；新内容直接写普通 bytes，非原始内容拒绝旧 MOTE-CONTENT envelope；原始文件 byte-for-byte，保留凭据 safeStorage。 源码：`apps/desktop/src/local-content.ts`。 |
| D06 | 旧默认 profile 沿用原 Electron userData 和启动项语义 | 规范默认 profile=default 并复用原 userData；显式 legacy 名拒绝。不会偷偷切换新目录；原目录旧格式需要备份/重置。 源码：`apps/desktop/src/profile.ts`。 |
| D07 | 无 binding/owner marker 的旧目录安全认领 | 不再自动认领旧缺 binding/owner 的非空目录；fresh 初始化写 owner/binding。保留当前队列搬移、外置盘不可用、连接变更与事务恢复。 源码：`apps/desktop/src/connection-binding.ts`。 |
| D08 | 缺新字段的历史配置补齐及排除列表旧新两套共存 | 统一 appCollectionRules，排除按钮写 off；删除 excludedAppIds 与 localContentEncryption/ocrEnabled/ocrOnlyWhileCharging 配置旧字段、旧默认 merge；配置 envelope3 严格读当前字段。旧配置整体拒绝，避免丢失历史隐私排除。 源码：`apps/desktop/src/config.ts`。 |
| D09 | 旧 snapshot 音频索引补建独立本机处理任务 | 未修改音频采用普通 unchanged shortcut；保留新/改音频生成独立 processing job、ASR 重试、状态与源 spool。 源码：`apps/desktop/src/source-files.ts`。 |
| D10 | File manifest 未带 state 的旧 ACK 格式容忍 | 批量 manifest 必须显式 accepted/existing/rejected/missing_original；去掉无 state+ack 接受。保留现行批量上限能力协商和逐条路径。 源码：`apps/desktop/src/source-sync.ts`。 |
| D11 | 旧 support events.json 作为 NDJSON 不存在时的导出来源 | 去 support events.json 双写和回退；read/readRaw/exportRange 使用 NDJSON，保留轮转、安全清洗与当前 raw UI。旧 events.json 原样留下，不读取。 源码：`apps/desktop/src/support.ts`。 |
| D12 | CodingCheckpoint 新 catalog/counter 字段对旧持久化游标的补齐 | Coding checkpoint3 fresh 必须填齐 catalog/counter/time 和 cursor stat/hash；旧缺字段或 version 明确拒绝。保留当前第三方日志 decoder、追加/partial-line restart。 源码：`apps/desktop/src/coding-agents.ts`。 |
| D13 | 来源 adapter 版本升级检查和旧缺版本默认1 | 移除缺 adapterVersion 猜1；fresh 写 adapterVersion=1，持久化必须带 version。保留显式 adapter 版本变更重扫与未 ACK outbox。 源码：`apps/desktop/src/source-sync.ts`。 |

### Android

| 编号 | 原审计项 | 最终处理 |
|---|---|---|
| ANDROID-01 | 读取旧 AES/GCM 内容封装，以及遗留可选加密写入开关 | 格式3本机边界与明文内容编解码；旧AES envelope/escape reader和可选内容加密设置退役 源码：`apps/android/app/src/main/java/dev/mote/collector/LocalDataFormat.kt`。 |
| ANDROID-02 | 全域旧内容批量解密工具残留，目前只有测试入口 | 删除 LocalContentDecryptor/LocalContentMigration 和各store migrateLegacyContent 入口；保留当前SecretBox凭据、中央私有草稿及ledger 源码：`apps/android/app/src/main/java/dev/mote/collector/SecretBox.kt`。 |
| ANDROID-03 | Ingress v2 一次性切换：清除旧 outbox、源检查点、上传状态 | 删除IngressV2Migration及清空旧outbox/checkpoint helper，旧app存量要求显式清除应用存储 源码：`apps/android/app/src/main/java/dev/mote/collector/MoteApplication.kt`。 |
| ANDROID-04 | 保留旧用户默认完整内容采集，新安装默认只采应用活动 | 新设置构造时保存完整configurationFormat3快照、统一activity默认；缺配置字段拒绝且不再依据interval/enabled推断content 源码：`apps/android/app/src/main/java/dev/mote/collector/Settings.kt`。 |
| ANDROID-05 | 旧独立 central-owner-session.enc 一次性导入统一登录 | 统一中央会话不再读取/导入 central-owner-session.enc；旧app根目录未标格式3时拒绝进入当前路径 源码：`apps/android/app/src/main/java/dev/mote/collector/CentralClient.kt`。 |
| ANDROID-06 | 服务器未返回 node.protocol 时按旧协商前 v1 接受 | node.protocol必有；null/undefined不是v1协商，现行协议range仍1 源码：`apps/android/app/src/main/java/dev/mote/collector/ProtocolCompatibility.kt`。 |
| ANDROID-07 | 上传 bundle -> JSON batch -> individual 老端点回退与24小时能力缓存 | 删除bundle→JSONbatch→single 404/405回退和24小时能力cache；packed=false合法单条上传保留，packed=true仅bundle；413减半与严格v2ACK保留 源码：`apps/android/app/src/main/java/dev/mote/collector/UploadWorker.kt`。 |
| ANDROID-08 | 更新器支持旧 v* 统一 release feed 和无 component 的混合清单 | 更新器仅android-v* feed与component=android签名清单；旧v*、缺component、混合组件清单拒绝 源码：`apps/android/app/src/main/java/dev/mote/collector/AppUpdateStore.kt`。 |
| ANDROID-09 | 文件 transport 索引版本不匹配时重建，兼顾旧版与新来源 | 当前FileArchiveQueue新state明确transportQueueVersion3；无版本或非3状态拒绝，不重建旧checkpoint；新state写入仍保存3 源码：`apps/android/app/src/main/java/dev/mote/collector/FileArchiveQueue.kt`。 |
| ANDROID-10 | 旧 exact 截图签名 WxH:hash 的解析 | ScreenshotDedupeHelper只接受v2 / 签名，旧WxH:hash不读 源码：`apps/android/app/src/main/java/dev/mote/collector/ScreenshotDedupeHelper.kt`。 |
| ANDROID-11 | 本机随手记旧 mood 字段隐藏读写 | 删除MainActivity隐藏mood EditText及旧草稿mood回填；本机notes界面统一空mood；中央mood产品与已prepared不可变payload保留 源码：`apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt`。 |
| ANDROID-12 | 旧本机延迟OCR及OCR补上传队列 | 删除CaptureOcrWorker、本机pending OCR字段及补上传队列/API；拒绝pending/_ocr*旧内容，中央derived OCR显示与UploadGate native OCR保留 源码：`apps/android/app/src/main/java/dev/mote/collector/CaptureOcr.kt`。 |
| ANDROID-13 | 旧未记dataOrigin的设置从server推导节点绑定 | dataOrigin成为格式3设置必有字段，不再从server或ensureDataOrigin回填；当前明确绑定、未绑定本机数据、disconnect sticky origin、retained跨节点保护保留 源码：`apps/android/app/src/main/java/dev/mote/collector/Settings.kt`。 |
| ANDROID-14 | 旧本机来源配置缺新增字段时补默认 | LocalSource.from当前完整字段使用get*，旧缺字段JSON拒绝；kind合法可选uri/calendarId保留 源码：`apps/android/app/src/main/java/dev/mote/collector/LocalSources.kt`。 |
| ANDROID-15 | AskActivity 旧入口class保留但已成为当前导航依赖 | MainActivity和NativeUi Ask导航先改CentralActivity page=ask，再移除AskActivity类及manifest声明 源码：`apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt`。 |

