# 兼容清理实施记录（2026-10-04）

> 历史实施记录。2026-10-09 的 [MVP 基线](../adr-mvp-baseline.md) 已将 Central 提升至 epoch 4，并移除后续增加的迁移与双版本分支；本文保留当时的处理和验证结果。当前操作与本轮验证见 [清理审计](mvp-baseline-cleanup-2026-10-09.md)。
本记录对应原始审计的 **83 条分模块记录**。按用户授权采用 MVP 破坏升级：可清理的旧入口已退役，先重构的当前写方、消费者和任务契约同步改为新形状；授权、隐私、幂等 ACK、删除防重建和合法测量等当前边界保留。旧资料没有自动迁移，也没有在本次测试中读取或重置真实用户目录。

原始逐文件扫描、风险及旧链路见 [审计快照](compatibility-audit-2026-10-04.md)，它基于改动前的 `8d68aef`，不能当作当前代码清单。当前逐项处理和验证见 [结构化实施记录](compatibility-cleanup-2026-10-04.json)。

## 主要链路与重构原因

| 链路 | 当前实现 | 为什么需要联动重构 |
|---|---|---|
| 启动与持久存储 | 中央 `backend_epoch=3`、Android/Desktop 本机与队列格式 3，完整新建 schema；旧配置、队列、密文及无 marker 的非空数据拒绝，原文件保留 | 直接删除旧 reader 而不建立新写方/格式边界，会把旧文件当成新资料读取。新版本现在只建立当前格式，不隐式认领、回填或重放旧内容 |
| 模型及文件处理配置 | 模型持久 registry version 2、完整 profiles/defaults/defaultModels，实际 `primary` / `env:deployment` 身份；文件显式 policy；请求期限与 Agent 总期限独立 | 当前 UI、模块路由与任务先前仍依赖旧 default/flat 配置，需同步保存、选择、重启与重试路径，才能删除默认合成和参数别名 |
| 捕获、来源与上传 | 本机 raw bytes、统一 appRules、当前原生隐私 OCR、Ingress 2 严格 ACK；Desktop/中央来源 SQLite 行存储、Android 严格 JSON 状态与当前 checkpoint/adapter 版本 | 旧 OCR 补做、bundle 降级、缺字段补值与自动清队列共用了上传恢复；删除旧路径后仍需保证当前重试不丢资料、不改目标、不给错误收据放行 |
| 任务、Memory 与对话 | 当前任务显式输入版本/产物 pins/contextTime，统一 execution 投影；当前自动/人工激活边界与 lease 恢复保留；旧 Memory/default admission/历史 bootstrap 退役 | 单删兼容分支会破坏当前 Coding、自动记忆与恢复任务。所有写方先固定输入与版本，读取端只消费完整当前形状，删除/修订后继续阻止重建 |
| 查询工具、证据与 UI | 公开引用 `capture:UUID` / `memory:UUID`，Material/Artifact 使用固定版本引用；声明为资源 ID 的 URL 和 ContextRecord 原件 record.id 使用 UUID；分页统一对象 | 裸 ID 原先同时用于导航、资源访问和内部 grants。同步改生产方、工具桥和 Web/Android 消费者，避免把类型前缀带进资源 URL，或把公开引用降回裸 ID |
| 发布、MCP、下载与恢复 | 组件身份/tag 必填；MCP 当前嵌套连接；模型独占 PID+UUID partial；只接受完整当前便携包；离线备份和恢复只接受 epoch 3/chunks 与完整校验的当前备份 | 删除旧入口时保留当前签名、哈希、路径、授权和并发保护；旧配置/备份显式拒绝，不通过“回退”继续运行 |

## 升级操作和风险

1. 停止中央、采集器及导入任务，用旧版本工具或停机后的完整目录副本备份各自数据目录、模型设置、凭据与所需密钥；新备份工具只接受本代格式。尚未 ACK 的端侧队列和草稿也在旧目录中；中央/Desktop 回滚需旧二进制配完整旧备份。Android 的 Keystore 私钥不可随目录备份导出，清除存储/卸载后不能保证用旧目录恢复加密凭据、私有草稿或 ledger；重置前先在旧版本完成必要归档或支持的内容导出，之后重新授权。
2. 中央优先选择一个新空目录。若明确放弃旧资料，可在备份后执行 `npm run reset:mvp-vault -- --data-dir <旧中央数据目录> --confirm-clear`。脚本检查目录与运行 PID，清除 SQLite、原件/导入暂存和旧模型/文件处理配置；保留 access-token、content-key、connectors、模型和日志。它不会自动改写连接凭据。若 `client-connections.json` 含已退役 `collector` scope，必须单独备份并显式移走该文件、重新配对；当前 owner/MCP 凭据可保留。
3. Desktop 可选择全新的命名 profile。普通 profile 名改为 `default`，仍使用原 Electron userData 路径；`legacy` 参数已拒绝，该路径上的旧格式也不会被采用。Android 先备份需保留内容，再在系统中明确清除应用存储或使用拥有全新空数据目录的独立开发安装（已有 Dev 旧数据同样拒绝），重新设置与授予所需权限；本次没有执行这些真实设备操作。
4. 显式移走旧 CLI ingress spool；浏览器旧 session 需重新登录，旧 `mote.notes.v1` outbox 需先保存草稿再明确移走。配置文件只通过 `MOTE_ENV_FILE` 显式读取，根 `.env` 不再自动加载。重新配置当前模型 profiles、模块分配、文件 policy、来源及采集规则。
5. 所有端使用本次同一代实现再恢复采集。旧便携包和旧 schema 不能跨代导入；重新导入原始文件或重新扫描来源须由用户选择。重置会永久放弃未备份资料、草稿、任务历史与未上传内容；同一来源重新导入会形成新的本代归档身份。旧链接/参数失效，模型旧 `.part` 不续用可能增加下载量。

## 明确保留的当前边界

- protocol 范围校验、Ingress 2 幂等与冲突 ACK、节点绑定、凭据撤销、MCP 独立限权；当前邀请本来就签发 owner 权限，删除的是旧 collector 权限升级别名。
- 用户设置的精确隐私规则与原生 OCR、当前单条上传/413 分批、来源合法 adapter 升级后的重新扫描、离线保留与安装事务恢复。
- current `.aes` 中央对象与受控策略解密、Desktop safeStorage、Android SecretBox 凭据、私有中央草稿、操作 ledger 与连接恢复状态；退役的是旧内容包装和客户端可选加密迁移。
- lease/owner 崩溃恢复、版本/原件 grants、修改/删除后依赖撤销；缺少完整披露依赖时仍保守失效。
- 当前 Markdown/文字视图、未知用量/归属和 OCR 的保守显示、合法单次活动采样。它们由当前产品和测量边界产生，不应删除或编造默认事实。

## 回归验证

最终检查结果如下，并已与 JSON 同步。所有自动端到端素材为程序生成的图片、笔记、来源、媒体和临时资料库，未读取真实个人截图。

| 验证 | 结果 |
|---|---|
| `npm run check:local` | 通过（exit 0）；启用安装型 Codex fixture 和 macOS 沙箱 opt-in，2029 项全部通过，零失败/跳过；6064 条翻译、全仓构建库/类型检查与 supervisor 通过 |
| Web | 218/218 fixture tests；生产 build 通过 |
| Shared / local inference | 90/90、14/14 fixture tests |
| Agent | 220/220；安装型 Codex + synthetic Responses provider 的 opt-in 工具链也通过 |
| Desktop | 53 文件 / 388 tests；完整 TypeScript、UI、C++、Swift helper/updater 构建通过；最终 transport 收尾后 388 项再次通过；真实 Electron 生成 profile 重启与本机内容 UI 回归通过 |
| Android | 54 suites / 245 JVM tests；instrumented Kotlin 源码编译与 debug APK 组装通过；未运行设备 instrumentation / 真机采集 |
| 中央 / 脚本 | 中央 1040/1040，含实际 macOS sandbox 隔离；脚本 50/50、CLI 4/4（含备份安全 9/9）；真实进程 profile/update/回滚/MCP 通过 |
| 端到端 | Mac/Android 生成截图 + 笔记 → 加密去重中央 → 实际 Harness + fixture provider → Material/原件引用/图片 → 当前便携包往返通过；锁屏媒体 → 受限查询/计时/引用 → 便携包往返通过 |
| 真实模型（单独） | 本地 Codex Server `gpt-6.1-sol`：8 模型目录、工具调用 probe、复制 profile 的模块选择、search_context/evidence 查询及 1 条核验引用通过；仅使用生成记录 |

真实模型检查只覆盖上述配置和查询链路，不能替代未执行的真机、真实屏幕或长期后台采集验证。回归暴露并修复了公开引用在桥中降回 UUID、LibraryBrowse/文件 retry URL 混用类型引用、Agent 记忆详情 UUID 到 typed reader 的连接问题，以及等待显式激活的 Memory 恢复任务被误标完成的问题。最终备份/恢复复核也删除了旧资产 reader，同步更新当前路径白名单和安全 fixture；这部分联动纳入 S05/S06/S07/S16 的格式边界。

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
| S01 | 未显式环境名的 legacy profile / 默认 data 目录 | 移除隐式 legacy 环境；默认 profile=default，启动要求显式设置 MOTE_ENV_FILE 或 MOTE_DATA_DIR 之一。数据目录可以相对路径，按当前 baseDir 解析；保留命名环境隔离。 源码：`apps/server/src/config.ts`。 |
| S02 | 模型 timeoutMs / MOTE_MODEL_TIMEOUT_MS 旧别名 | 删除模型 timeoutMs 和 MOTE_MODEL_TIMEOUT_MS 旧别名，仅保留 requestTimeoutMs、agentTimeoutMs 及其明确的 null 语义；文件与执行引擎自身的超时不受影响。 源码：`apps/server/src/config.ts`。 |
| S03 | 单模型 default 预设兼容多 profile | 模型持久配置统一为 version 2 的 profiles/defaults/defaultModels，primary 为正常命名预设，部署预设明确绑定；拒绝旧单模型文件。保留 view.settings 作为当前默认模型的展示投影。 源码：`apps/server/src/model-settings.ts`。 |
| S04 | 旧 collector 凭据取得 owner 权限 | 删除 collector 自动取得 owner 权限的别名，旧 collector 凭据拒绝；当前配对仍明确签发独立可撤销 owner 凭据，具有中央管理与浏览权限。MCP 读/指定来源写凭据继续单独限制，native 同步 owner-only 校验。 源码：`apps/server/src/connections.ts`。 |
| S05 | 无后缀加密文件与 vault-wide encryption 身份 | 只读写明确 content-key 身份及 .plain/.aes 后缀资产，删除无后缀密文与旧全库加密身份推断；保留当前混合明文/AES、密钥验证和备份恢复。 离线备份/恢复也只接受真实 epoch 3 与当前分片/来源归档，旧布局在写入目标前拒绝。 源码：`apps/server/src/content-encryption.ts`。 |
| S06 | 旧图像/归档资产目录及 MOTE1 包装 | 删除 image-legacy/archive-legacy、旧 blobs/files 读取与 MOTE1 包装迁移，当前资产统一 chunk store；保留原件、去重、分段读取、GC、导入导出和隐私边界。 离线备份/恢复也只接受真实 epoch 3 与当前分片/来源归档，旧布局在写入目标前拒绝。 源码：`apps/server/src/assets.ts`。 |
| S07 | 旧 source-archive manifest 到 SQLite index 的惰性迁移 | 删除旧 source-archive manifest 到 SQLite 的惰性转换，直接创建当前索引并由 receive 写入；保留当前版本寻址、快照、checkpoint 与受控原件读取。 离线备份/恢复也只接受真实 epoch 3 与当前分片/来源归档，旧布局在写入目标前拒绝。 源码：`apps/server/src/source-archive.ts`。 |
| S08 | 文件旧 flat settings 转 policy 和旧客户端保护 | 删除 flat settings 自动生成 policy 的兼容路径；新安装与更新都保存显式规范 policy。默认内置 ASR 服务/方案在插件初始化前正确绑定，保留当前凭据保护和插件不可用时的执行阻断。 源码：`apps/server/src/file-processing.ts`。 |
| S09 | 旧文件任务 UI revision → 新执行 fingerprint aliases | 删除界面 revision 到执行 fingerprint 的别名映射，当前任务直接冻结真实执行配置 fingerprint；保留配置变化失效、fence 和显式重试。 源码：`apps/server/src/file-processing.ts`。 |
| S10 | 文件/截图旧 running projections 重置为 waiting | 删除没有规范 execution step 的旧 running 投影启动恢复。保留当前 lease 恢复与备份恢复；修复 Memory 等待显式激活时被误标 completed，恢复保持 queued，激活后能原子写入 Memory/checkpoint。 源码：`apps/server/src/file-processing.ts`。 |
| S11 | 旧 processing DAG authority/依赖迁移到共享 engine | 删除旧 processing DAG authority、依赖表与迁移 marker 重放，最终 schema 直接使用 execution_steps 作为唯一执行权威；保留当前依赖就绪、输出缓存与重试。 源码：`apps/server/src/processing-runtime.ts`。 |
| S12 | 旧 query/insight receipts 安装 canonical execution | 删除旧 query/insight receipt 补装 canonical step；缺规范步骤的历史任务明确拒绝且不改原 JSON。保留真实当前 owner 心跳、deadline、lease 中断与崩溃恢复。 源码：`apps/server/src/run-execution.ts`。 |
| S13 | 启动时 reviewed legacy Memory 自动发布、清 proposed checkpoints | 删除启动时自动发布旧 reviewed Memory 和清理旧 proposed checkpoint；当前提取必须通过 admission、精确原件 proof 和规范发布事务。 源码：`apps/server/src/memory.ts`。 |
| S14 | 旧 Memory 删除意图身份/来源 lineage 补齐 | 删除 Memory 删除记录的身份/来源 lineage 补列回填；新 schema 与记录明确包含 origin、lineage、derivationSourceIds 和完整性标记，保留当前防复活与保守删除。 源码：`apps/server/src/memory-deletions.ts`。 |
| S15 | OCR managed settings 和旧连接失败一次性恢复 | 删除旧 managed OCR 配置转换和连接失败的一次性 attempts 重置，废弃 charging reason；保留当前 worker readiness、限次重试、取消/fence、显式重试与 OCR 未知状态。 源码：`apps/server/src/perception.ts`。 |
| S16 | 不支持的旧 vault/Coding 索引启动拒绝 | 采用 backend_epoch=3/user_version=3 的完整新库 schema；旧或不明确的非空库在修改前拒绝，测试证明旧数据不变。保留异常 raw Coding vault 的安全拒绝，不自动转换或清空用户目录。 离线备份/恢复也只接受真实 epoch 3 与当前分片/来源归档，旧布局在写入目标前拒绝。 源码：`apps/server/src/evidence-store.ts`。 |
| S17 | 旧截图/文件任务没有自动付费处理资格 | 删除历史截图/文件 eligibility 补列迁移，新任务由当前明确的授权写者生成；保留付费处理授权、preview、原件 disclosure grant、本地隐私与模型 admission。 源码：`apps/server/src/file-schema.ts`。 |
| S18 | 截图/文件/Memory 搜索、依赖与浏览读模型的历史回填 | 删除截图/文件/Memory 搜索、依赖、浏览及来源 catalog 的历史扫描回填，完整新表和当前写删触发器直接维护读模型；保留当前分页、索引更新与明确 embedding rebuild。 源码：`apps/server/src/read-models.ts`。 |
| S19 | Material anchors、可见序号及payload删除触发器升级 | 删除 Material anchor/可见序号补列、回填和旧触发器替换；直接创建最终表及 payload 删除触发器，capture 删除仅使用规范 typed 引用；保留稳定引用、版本和原件授权。 源码：`apps/server/src/materials.ts`。 |
| S20 | Source pipeline 存量工作无storage/checkpoint/generation/recipe pins | Source work 直接保存当前 storage/checkpoint/generation/recipe/component pins 和 fingerprint，删除存量任务升级默认；保留当前来源变化失效、append、规范 recipe 更新重建与组件执行。 源码：`apps/server/src/source-pipelines.ts`。 |
| S21 | 共享Execution步骤/Operation生成关系和optional计数升级 | 共享 Execution/Operation 直接创建最终列、成员关系和投影触发器，删除旧关系与 optional 计数补建；保留当前调度、资源、依赖、lease/fence、公平性和 optional 终态统计。 源码：`apps/server/src/execution-engine.ts`。 |
| S22 | 授权账本、Memory草稿和资产储存ledger升级 | 授权账本、Memory 草稿和 storage ledger 使用最终 schema/触发器，删除旧列缺失跳过与历史身份转换；保留当前插件新增表的实际存储计量、quota、授权 revision 和原子发布。 源码：`apps/server/src/memory-input-authorization.ts`。 |
| S23 | 旧无scope自动Memory工作迁移时保留物料并撤销自动重放 | 删除旧无 scope 自动 Memory 工作的迁移与回放适配；新请求明确冻结 scope、来源/recipe pins 和授权信息，保留当前撤权、原件披露权限与幂等自动工作。 源码：`apps/server/src/material-memory-work.ts`。 |
| S24 | 对话json.turns拆到conversation_turns历史表 | 删除对话 json.turns 拆表历史转换；新对话直接向标准 conversation_turns 表写入，保留当前历史分页、连续性和隐私 lineage 清理。 源码：`apps/server/src/conversations.ts`。 |
| S25 | 旧 Memory batch 缺独立 pins，以及当前 Coding 无 pins 路径共用恢复 | 每个当前 Memory batch 独立保存 materialInputs/materialRefs，缺字段拒绝，不再借用 job pins 或恢复无 pins Coding 输入。所有 job 明确版本、激活字段；概要仍有 inputPlans/recipeProgress/memoryCount，内部 pin 明细不在概要展开。 源码：`apps/server/src/memory-pipeline.ts`。 |
| S26 | 旧人工任务同时选择authored Material和原件的精确一次性复用 | 删除旧 authored Material 与原件重复选择任务的已完成结果复用；当前显式 recheck 必须重新解析已冻结原件，并执行受授权查询/review，保留当前选择去重与精确 proof。 源码：`apps/server/src/memory-pipeline.ts`。 |
| S27 | 旧Memory版本、分类和admission元数据读取默认 | 删除 Memory version/domain/tier/kind/admission 的旧读取默认与 legacy layer；只接受规范 schema、admission、精确原件证明。当前概要和完整 detail 使用各自明确结构，不用缺字段 fallback。 源码：`apps/server/src/memory-schema.ts`。 |
| S28 | 历史缺disclosure依赖时全量保守清理，混有现行不完整依赖保护 | 保留当前不完整披露依赖的保守隐私清理，未从旧引用伪造依赖或做历史回填；模型中断、部分读取或 complete=false 时删除必须撤销相关 prose，这是当前安全边界。 源码：`apps/server/src/evidence-store.ts`。 |
| S29 | 旧raw extraction lifecycle任务/cursor与旧Insight时间配置升级 | 删除旧 raw lifecycle 任务/cursor 转换、layered journal 和 legacyInsightHours 适配；当前时间配置直接初始化，新 stream 不匹配明确拒绝，保留截图/主动原件 artifact intake 与当前 recipe 工作。 源码：`apps/server/src/memory-lifecycle.ts`。 |
| S30 | 旧任务没有冻结contextTime时使用持久化创建/开始时间 | 所有新 Memory job 创建时冻结并保存 contextTime，普通/手动任务也完整写入；删除读取时以 createdAt/startedAt 代替缺失时钟，当前 lifecycle window 缺冻结时间拒绝。 源码：`apps/server/src/memory-pipeline.ts`。 |
| S31 | 旧Coding Material schema<5含tool正文，被query和Memory读取隔离 | 不读取/转换旧 schema<5 Coding 工具正文；当前 recipe 生成干净对话并按版本重建。保留最低安全 schema 校验，避免不可信或错误插件物料泄露工具正文。 源码：`apps/server/src/evidence-reader.ts`。 |
| S32 | Source pipeline旧group/organize callback扩展契约与内置重复入口 | 删除 Source pipeline group/organize callback 扩展入口，archive pipeline 必须提供显式 recipe 与组件 pins；保留现行 Coding 分组/组织算法并注册为 recipe 组件，fixtures 同步规范契约。 源码：`apps/server/src/source-pipelines.ts`。 |
| S33 | 旧无结构化Transcript产物只允许重新提取后review | 删除旧无 Transcript 产物的 review 特殊 fallback/文案，只允许标准结构化 Transcript；缺布局/时轴/精确 chunk 的产物拒绝，保留当前校正安全校验。 源码：`apps/server/src/file-reviews.ts`。 |
| S34 | 旧Import工作缺处理模式/媒体计数/phase fingerprint元数据 | 新 Import 工作从创建起明确保存 processing、recordsProcessed、preparationRevision，删除旧进度推算和 phase fingerprint sentinel；保留准备前合法缺 manifestHash、确认 hash、取消和当前恢复。 源码：`apps/server/src/imports.ts`。 |
| S35 | 升级后旧网页lazy bundle404边界 | 保留缺失 hashed lazy bundle 的通用 404/no-store 边界；这是每次当前发布和错误静态资源均需要的行为，不能将 JavaScript 请求回退成 SPA HTML。 源码：`apps/server/src/app.ts`。 |
| S36 | Portable archive v1新增字段缺省允许较早或精简归档导入 | Portable archive 使用 version 2，所有集合和当前来源时间字段必有；旧 v1/精简归档原子拒绝，不填空集合或伪造时间，保留完整导入导出及加密原件 roundtrip。 源码：`apps/server/src/evidence-store.ts`。 |

### Desktop

| 编号 | 原审计项 | 最终处理 |
|---|---|---|
| D01 | Ingress v1 → v2 断代迁移、旧队列本地归档及重新导入 | 删除旧 capture/source 协议清空迁移、旧 OCR 上传归档状态；新 desktop/queue/notes/local-sources/storage marker 为 3，旧数据明确拒绝且不改写。 源码：`apps/desktop/src/storage-format.ts`。 |
| D02 | 来源状态 JSON → SQLite、整数组 → 单 revision 行、内嵌 catalog → 行存储 | SQLite user_version=3 新建；拒绝 JSON、旧 SQLite、嵌入 catalog/whole-array pending，不转换、不重命名。保留当前增量行表、事务和 busy_timeout。 源码：`apps/desktop/src/source-state-store.ts`。 |
| D03 | Coding evidence 字段兼容旧中央并永久固定 revision 的 wire schema | 发送完整当前 coding evidence；移除字段降级协商与 codingWireFields 持久化 pin，旧 pin 状态明确拒绝。 源码：`apps/desktop/src/source-sync.ts`。 |
| D04 | 仅为旧队列存在的本机 OCR 补做链路及旧节点 OCR 404 兼容 | 删除延迟 OCR/backlog/charging 重试与补传接口；保留每次新 capture 的本机 OCR 隐私 gate、captureAbort 和准确 ACK。 源码：`apps/desktop/src/collector.ts`。 |
| D05 | 读取历史本机加密 envelope/key；批量解密入口已无生产调用 | 格式3内容直接原样写读普通字节，包括碰巧以旧magic prefix开头的合法原文；旧格式由storage marker/schema拒绝，不做内容嗅探、AES读取或批量解密。凭据保留safeStorage。 源码：`apps/desktop/src/local-content.ts`。 |
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
| ANDROID-10 | 旧 exact 截图签名 WxH:hash 的解析 | ScreenshotDedupeHelper只接受v2\|签名，旧WxH:hash不读 源码：`apps/android/app/src/main/java/dev/mote/collector/ScreenshotDedupeHelper.kt`。 |
| ANDROID-11 | 本机随手记旧 mood 字段隐藏读写 | 删除MainActivity隐藏mood EditText及旧草稿mood回填；本机notes界面统一空mood；中央mood产品与已prepared不可变payload保留 源码：`apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt`。 |
| ANDROID-12 | 旧本机延迟OCR及OCR补上传队列 | 删除CaptureOcrWorker、本机pending OCR字段及补上传队列/API；拒绝pending/_ocr*旧内容，中央derived OCR显示与UploadGate native OCR保留 源码：`apps/android/app/src/main/java/dev/mote/collector/CaptureOcr.kt`。 |
| ANDROID-13 | 旧未记dataOrigin的设置从server推导节点绑定 | dataOrigin成为格式3设置必有字段，不再从server或ensureDataOrigin回填；当前明确绑定、未绑定本机数据、disconnect sticky origin、retained跨节点保护保留 源码：`apps/android/app/src/main/java/dev/mote/collector/Settings.kt`。 |
| ANDROID-14 | 旧本机来源配置缺新增字段时补默认 | LocalSource.from当前完整字段使用get*，旧缺字段JSON拒绝；kind合法可选uri/calendarId保留 源码：`apps/android/app/src/main/java/dev/mote/collector/LocalSources.kt`。 |
| ANDROID-15 | AskActivity 旧入口class保留但已成为当前导航依赖 | 删除AskActivity类及manifest声明；合并origin/main后保留MainActivity内嵌Ask主导航与CentralContent共享页面，CentralActivity保留当前中央深链入口；新导航和草稿/会话恢复fixture不再依赖已删除类。 源码：`apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt`。 |

