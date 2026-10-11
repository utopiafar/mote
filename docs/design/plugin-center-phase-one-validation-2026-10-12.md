# 插件中心与可替换记忆：一期验证计划

日期：2026-10-12。对应[一期实施方案](plugin-center-phase-one-2026-10-12.md)与[架构决策](../adr-plugin-center-memory-replacement.md)。

**本文件记录产品验证设计、模拟原型检查与实施后的分层证据。** 第 11 节保留设计阶段的原型结果；所有者随后授权实际实施和真实链路验收，第 12 节记录 mem0 能力与消费者检查，第 13 节记录实现后的控制面、原生构建和实际产品链路。计划矩阵尚未整体执行，未记录实际结果的项目仍为 **NOT RUN**。模拟 UI 中的状态变化和生成数据不能证明生产能力已经实现。

## 1. 已确认行为与验证边界

一期按所有者已选择的方案验证，不在测试中重新制定产品政策：

- 支持单环节替换与整体引擎；首批为 mem0 OSS CRUD/检索、Hindsight 完整引擎。独立审核环节一期保留，可替换实现，默认沿用现有实现。
- 自动记忆可以全暂停，原件继续接收、归档和按权限查询。默认暂停停止登记新任务；已登记的 queued/running/checkpointed 工作按原授权、原 generation 排空，另有“立即停止”。隐私撤权和删除立即失效，不等待排空。
- 外源插件第一期采用 GitHub 固定、受信任 release；在 Central worker/服务运行，需要重启时明确展示。能力声明和独立进程均不得描述为恶意代码权限沙箱。
- 历史迁移和索引准备需显式选择范围与费用授权，准备、校验完成后再应用；失败保留旧方案。不因安装、启用、升级、恢复或绑定自动重提取历史。
- 主入口是“设置 → 插件”；默认展示整体方案，高级设置展示模块组合。UI 操作必须对齐真实期望状态、实际运行状态、配置和功能绑定。

保留 [MaterialStore 与插件契约](../library-plugin-contracts.md)中的证据与版本权威、通用正文回退、安装不授历史权和查询 Agent 只读工具。设计基线[记忆生命周期](../memory-lifecycle.md)中的“提取不能普通关闭”已由独立自动准入控制替换；生命周期文档记录当前暂停/排空/恢复语义。废弃配置字段仍可拒绝 `false`，但这一断言不能代替暂停旅程，也不需要恢复来源 Memory 布尔值或空配方。历史验证报告仍保留当时执行结果。

自动记忆的全暂停覆盖一期方案声明的所有自动记忆入口及引擎自动任务。显式问答或所有者手工操作是否获准，沿各自的请求授权，不通过暂停/恢复补发授权。原件解析、媒体识别与资料整理保持各自处理职责，不因记忆暂停制造全局不可读状态。

## 2. 证据账本与真实入口

每轮未来验收固定并记录：Mote commit、三端组件版本、数据格式、插件 ID/version/release commit/hash、安装实例代际、binding revision、任务 generation、授权快照、外部 operation ID/receipt、上游服务版本或镜像 digest、运行平台、启动命令、配置身份、模型与 embedding/reranker、语料 manifest/hash、冷暖缓存和重试次数。

每项结果使用 PASS / FAIL / NOT RUN / BLOCKED，附可复现入口、观察日志、状态快照、调用与费用证据、报告路径和遗留问题。断言区分“请求已接受”“外部已执行”“宿主已校验并发布”“已清除确认”；没有外部 usage 时记录未知，不记零费用。

核心旅程从实际 Central CLI 启动、认证 HTTP、设置 UI、真实 plugin registry/worker、生产 source receive/organizer/background admission、正式 query bridge 和 shutdown/restart 进入。组件测试可提供故障定位，但不以手工构造内部任务代替安装、启动、自动调度、迁移和恢复证明。

自动回归使用生成笔记、虚构 Coding 对话、生成媒体与隔离 dev/test vault。所有者在 2026-10-12 另行允许真实链路参考本机运行的 Central 节点数据，并指定需要模型时使用本地 Codex Server 的 GPT 6.1 Medium；最初约束为本地设计/验证；所有者随后授权真实实现、生成回归测试的 PR 与合并。私有凭据、个人资料、临时原生数据及模型输入仍留在本地，不进入 GitHub。真实节点检查单列，优先只读验证或在隔离副本中运行，不据此授权改写现有节点。该授权不包含真实外部账户或个人截图的读取/传输；不将令牌、个人正文或完整模型输入写入源码、公开报告或版本控制。本次未使用真实节点数据；隔离生成语料的实际模型检查见第 12 节。

| 可复用资产 | 需要扩展的验证范围 |
| --- | --- |
| server `community-plugin.test.ts`、Web `feature-host.test.ts`、`test-web-feature-packs.cjs` | release 检查、真实安装目录、配置/启用/绑定、卸载和安装实例 fencing |
| source pipeline、material processing、automatic memory recipes、Memory admission/recovery | 全暂停、旧 generation 排空、新 generation 恢复、全引擎自动子任务 |
| `delegated-query-app.test.ts`、agent memory/material tools、source disclosure | 固定 binding/数据 revision、完整 reflect、证据交付、只读和删除后的返回拦截 |
| memory automatic deletion、execution recovery、lifecycle recovery | 外部未知写、late write、跨库 intent/receipt/publication、删除未完成与补偿 |
| Web settings/navigation、Electron generated UI、Android catalog/library tests | 新入口、三条完整旅程、状态消费、通用历史回退和翻译 |
| Central process lifecycle、profiles、container tests | 真实 worker/service 部署、重启、升级、备份和恢复 |

这些资产名称只说明可复用入口，不表示已有插件中心用例或本次已运行。

## 3. 安装、配置、启用与生命周期旅程

| ID | 初始状态与用户真实入口 | 必须验证的结果与故障变体 |
| --- | --- | --- |
| I01 | 设置 → 插件 → 从 GitHub 安装；兼容包固定 release | 检查 manifest/schema、宿主与能力版本、执行位置、依赖及受信发布身份；核对 release commit 与资产 hash/声明的签名；选择引用、已下载字节和实际运行包一致。安装不会启用、绑定、扫描历史或调用模型。 |
| I02 | 输入普通仓库、没有 Mote manifest 的 release、分支或浮动引用 | 缺少兼容包或固定发布身份时不可安装；固定 Mem0/Hindsight 官方发布由宿主内置适配配方提供明确例外。不能执行任意仓库 bootstrap、npm lifecycle/install script 或自动构建。保持输入以便修改。 |
| I03 | 包名相同但 hash 不同、tag 移动、signature 不匹配或维护者变化 | 校验失败时不执行和激活；失败原因能对应实际版本。只有 hash 校验时不宣称已证明发布者身份；确认的发布信任方式按一期 manifest 契约执行。 |
| I04 | 下载包含路径逃逸、符号链接、额外执行入口、未声明依赖或恶意安装脚本的生成包 | 拒绝越过安装目录/manifest 声明的资产；脚本无运行痕迹。安装检查读取的 README/manifest 是不可信数据，不能授权 shell、文件访问或网络。 |
| I05 | 检查、下载、持久化或完成应答期间网络失败、GitHub rate limit、代理错误、磁盘满 | 显示失败阶段和可操作原因；旧插件和 binding 可用，无半包被加载。相同 install request 重试或丢 ACK 后刷新不重复安装；私有凭据不出现在 URL、日志和 UI 错误正文。 |
| I06 | 下载完成但安装提交前、提交后 ACK 前、启用前关页或 Central 进程终止 | 正常 CLI 重启后准确恢复 installed/failed/in-progress；已安装包身份可核验；无自动 enable/bind。未完成缓存按设计清理或继续，不被当作成功包。 |
| I07 | 安装成功 → 配置模型/服务地址 → 验证连接 → 选择启用 → 绑定新增来源 | 持久安装、配置就绪、期望启用、实际运行和 binding 分别可观察。未配置/未绑定显示下一步；实际未运行不能只因开关开启显示“正在使用”。配置成功不授予全部资料。 |
| I08 | 插件已启用但缺依赖、错误配置、版本不兼容，或服务 ready 后失联 | 保存选择与故障原因并存；有明确配置/重试路径；不静默换提供者、模型或方案。必需依赖失败时不得发布该插件的新结果。 |
| I09 | 需要重启的插件启用、停用或更新；用户未重启/重启失败/完成重启 | 显示当前运行版本、期望版本与待重启；真正 ready 后才更新运行状态。重启经过真实 supervisor/CLI，不以页面刷新冒充。对既有任务按冻结身份处理。 |
| I10 | 同 ID/version 卸载后重装或升级；旧 worker 稍后返回 | 新安装 instance/epoch 不继承旧提交权；旧任务不得向新实例/新 binding 提交。依赖 teardown 和重复贡献不残留。 |
| I11 | 停用、解除绑定或卸载可选插件；已有任务、记忆、引用、资料面板和历史查询 | 排空所需旧 release 不被提前移除；先完成或明确停止其工作。默认保留数据和历史；通用正文、证据和版本历史可读，无插件私有 renderer 也可回退。卸载与清除数据分开，外部服务数据未清除不显示已删除。 |
| I12 | 从 Android/desktop 管理远端 Central 或切换 Central 连接身份 | 明确动作目标节点；配置、安装和状态不跨节点串用。Central 换身份时中止旧响应合并，不将中央代码安装到采集端。 |

> 当前独立 retrieval/index-only 用户切换、任意阶段组合编辑尚未实现；下表相关设计场景为 NOT RUN/未支持，不计入已执行产品链路。

## 4. 自动暂停、排空、立即停止与恢复

| ID | 输入、时序与真实操作 | 必须验证的结果 |
| --- | --- | --- |
| P01 | 开启自动记忆 → 点击全暂停；持续上传生成资料并提问 | 暂停提交线性化后不登记新自动记忆工作；原件接收、正式资料发布、既有检索和原件问答继续。新来源、导入、UI 页面、Coding、生命周期 timer 和插件自动入口均不能绕过暂停。 |
| P02 | 暂停前已有 queued、running、checkpointed，另有准备登记的竞争请求 | 以真实任务登记边界分开新旧；已登记工作使用旧授权/旧 generation 排空，重复 tick 不补建任务，旧任务不自动扩展输入。queued 可继续启动，不误当立即取消。 |
| P03 | 旧任务排空中，产生 consolidation/独立审核/子批次 | 仅冻结任务预算和范围内的已登记或已声明子工作可完成；新一轮自动工作不得以“排空”绕过暂停。所有外部自动类型可枚举、观察并符合一期宿主管理契约。 |
| P04 | 排空时 Central close/SIGTERM/worker crash，再正常启动 | 暂停选择、原 generation、授权、检查点、queued/running 身份持久；只恢复合法未完成旧工作，不解除暂停，不重复成功批次或费用调用。 |
| P05 | 用户在排空期间点击“立即停止”，本地任务位于 model call、commit、checkpoint 前后 | 停止新的执行与发布，旧 lease/generation 的 late commit 被 fence；区分请求接受、停止中、已停止。已合法发布结果按既有历史规则保留，不伪装回滚。 |
| P06 | 外部 Hindsight pending/processing/无 checkpoint 操作响应取消；结果迟到或取消请求网络失败 | cancelled receipt 不直接证明外部停写；继续跟踪外部确认与未知状态。取消后返回的内容不发布到当前 binding，不能被查询提前看见；必要的隔离/补偿按方案执行并留下证据。 |
| P07 | 暂停或排空中，用户删除来源/撤销授权/修改隐私范围 | 隐私事件立即阻止读取、处理、费用调用和发布，即使旧任务已登记；无需等待排空。外部派生与共源结果失效；当前查询返回前再检查授权。 |
| P08 | 全暂停后点击恢复；期间到达新资料，旧暂停范围又发生删除 | 恢复创建新 generation，不追授暂停期间历史或扩大先前授权；新增可处理范围依真实入口与用户选择确定。旧结果不会覆盖新配置；已删除/撤权输入不能被恢复重放。 |
| P09 | 暂停 → 恢复 → 再暂停，并发双客户端保存、插件重装和迟到回调 | 期望状态的 revision 检查和任务 fencing 有效；最终状态与服务器事实一致；无“最后到达的旧响应”覆盖新选择。 |
| P10 | 外部定时刷新、失败自动 retry、consolidation、删除后维护触发 | 验证全部入口的处理/联网/模型权限及费用边界。纯删除维护与付费再整合分别观察；不得因安全删除隐式扩大付费授权。不能管住或观察的自动任务使完整引擎适配不通过。 |

## 5. 迁移、索引准备、切换、回退与删除

| ID | 用户旅程或故障点 | 必须验证的结果 |
| --- | --- | --- |
| M01 | 功能方案 → 更换单模块；选择仅索引已有记忆 | 范围、输入 revision、embedding/费用方式和预计/未知费用展示正确；不读取额外原件，不重提取或修改记忆正文。安装/启用本身不创建准备任务。 |
| M02 | 更换整体引擎 → 选择显式历史内容范围并授权 | 区分正文/引擎迁移、索引准备与重新理解内容；迁移保持 ID、正文、证据、修订、纠正和删除意图，不隐式重新提取/整合。确需历史模型转换时另有冻结范围、模型、审核和费用授权；不能以只处理新增作为静默 fallback。取消不隐式授权模型调用；保留已授权规范副本和旧绑定，目标不生效，精确来源删除/撤权仍清理。 |
| M03 | 迁移准备失败、费用授权不足、模型不支持、上游语义缺失 | 旧方案继续服务；明确失败阶段与未覆盖范围。不减少独立审核、吞输入、改模型或把全文重理解伪装成无费用索引准备以通过。 |
| M04 | staging 写入并建立索引；普通用户同时查询 | 未校验/未发布的新结果不可被普通检索、完整 reflect、详情或统计提前读取。旧方案可用。只在 Mote 侧过滤最终回答不足以证明外部 reflect 未见 staging。 |
| M05 | 大迁移运行中，新输入到达、来源修改/删除/撤权 | 快照范围与 delta 分开；通过同一授权/版本规则补齐合法变化。变更不能悄悄扩展历史收费范围；删除/撤权使 staging 与派生结果及时失效。 |
| M06 | 准备显示 100%，但独立审核/证据/完整性/delta 校验未通过 | 显示“准备/校验中”而非可应用；只有能力、范围、审核、可见性和必要 delta 条件均满足才进入 verified。允许零候选，但必须证明范围处理完整。 |
| M07 | verified → 用户应用；切换事务前后 crash 或丢 ACK | 一个 durable intent 对应外部 receipt 与 published binding revision；cutover 要么旧要么新，不能半套模块混用或重复应用。重启能恢复真实生效方案。 |
| M08 | 新方案生效 → 用户回退；回退期间已出现新结果 | 明确回退目标及覆盖范围；按既有授权同步必要 delta，原件、记忆正文和证据不丢失。旧索引不复活已删除内容；回退不隐式重提取或多次收费。 |
| M09 | 应用/回退同时有已开始的普通问答、委派查询与完整 reflect | 每个查询固定 binding revision 和可读数据 snapshot/revision，旧查询不混入新方案数据；工具多次调用或 child resume 不改 revision。返回前仍检查删除/撤权。 |
| M10 | 外部写入成功但 ACK 丢失、HTTP timeout、receipt 保存前进程退出 | 标记 external-write-unknown 并依据 operation/request ID 对账；不盲重试产生重复提取或支出，不直接发布。无法确认时保留准确未完成状态和旧 binding。 |
| M11 | 接收外部 receipt 后，Mote 审核失败或发布事务失败 | 外部已写与 Mote 已发布分开；未通过独立审核的派生记忆不可检索。补偿/重试保持同一 intent 身份，旧实例迟到返回不能补发发布权。 |
| M12 | 用户删除来源/记忆；外部离线、删除 partial、清除 ACK 丢失 | 本地立即停止可见与再生产；UI 区分删除已接受、外部清除未完成、已验证清除。源文、索引、observations、mental models、缓存和可恢复任务按依赖检查，不以 endpoint 200 推断所有存储已清除。 |
| M13 | 删除后外部任务重新运行、来源同内容换 transport ID 重传、旧 backup/worker 恢复 | 删除 intent、防重建规则、generation 与源 revision fencing 生效；不会由共享 cache、旧快照、上游 refresh 或回退恢复删除结论。新合法证据按既有规则处理，不按语义关键词推断。 |
| M14 | 两来源共享 observation/摘要；仅删除一个来源或撤销某个查询范围 | 含该依赖的结果失效；其余来源保持可读。重新整合仅使用仍授权的证据并经过审核；费用权限不得借共源依赖自动扩大。 |
| M15 | 修改记忆正文/不确定性/证据与源版本，随后检索、详情、导出 | 使用明确版本前提检查，冲突可解释；正文/证据/索引提交一致，历史可回看。模块更新与引擎更新语义不匹配时明确不支持，不声称无损兼容。 |

## 6. 安全、完整 reflect 与适配器能力

| ID | 场景 | 必须验证的结果 |
| --- | --- | --- |
| S01 | 查询 Agent 获取工具目录、读取恶意记忆/README/正文 | 工具表仅有批准的只读上下文能力；无安装/管理、retain、update、delete、配置、shell、外部写工具。捕获文本不能提升权限、改变 binding 或 model policy。 |
| S02 | 完整 Hindsight reflect 多轮工具选择/来源拼接，包含注入文字和跨范围请求 | 实际执行完整 reflect，不偷偷降级为 recall 或 Mote 另一轮摘要；bank/scope/snapshot 固定。无越权 facts/chunks/directives/mental models 注入，没有来源伪造；捕获正文不能升级为可信 directives，无 tag 内容与全局 directives 的上游默认行为不能扩大 Mote 授权。 |
| S03 | 记录 reflect 前后外部 DB、operation、模型网络请求及 Mote 发布账本 | 查询没有持久记忆 writeback、retain、维护/刷新任务或隐式授权更新；允许的日志/用量计量按契约区分。不以文档描述、tool name 或 mock 判断零副作用。 |
| S04 | staged/审核失败结果与旧已发布结果在同一外部部署；执行 recall 与 reflect | 查询所读证据只来自冻结的已发布可见集合；不能读取被隐藏的新事实后输出无引用结论。供应方不支持隔离或固定可见性时，全引擎适配不能通过。 |
| S05 | 原文引句、emoji/UTF-16、多片段、来源版本过期和 chunk token 截断 | 引用回到 Mote 实际授权并交付的确切范围；上游 document/chunk ID 必须映射，不作为额外原件权限。截断和未知依赖如实显示，不补造证据。 |
| S06 | 带 token 配置、上游原始错误、支持包、renderer 与导出 | 凭据只在私有配置/受控连接，默认 loopback；远程服务验证 TLS 和强认证。诊断不暴露 token、私人正文、环境变量或插件路径中的凭据。 |
| A01 | mem0 OSS 固定版本，实际配置持久 vector store、history、embedding；真实启动→CRUD→重启→检索 | `mem0ai/oss` 与 hosted client 区分；add/get/getAll/update/delete/deleteAll/history 的本次支持集合真实运行，filter/来源映射/版本/幂等/删除可核验。默认内存向量库不得误当持久化。 |
| A02 | mem0 输入更正、旧与新事实、中文同义检索、不同来源/身份 scope | 不假定 add 自动替代或删除旧事实；显式更新/删除与 Mote 已发布正文一致；检索对照保持同一授权语料和模型。声明的 operator 在选定 store 真可用。 |
| A03 | Hindsight 固定版本，真实服务和 DB；retain→独立审核→发布→recall→完整 reflect→更新/删除→重启 | 全引擎接管一期声明的提取/组织/检索/reflect；对应旧实现停用且不双消费。可观察输入范围、外部子任务、使用量/未知费用、证据、receipt 和重启恢复。 |
| A04 | Hindsight async retain 丢 ACK 后重试；带相同/冲突 operation ID | 客户端先持久生成的 ID 对应同一工作；上游相同 ID 重试不双工作，冲突明确失败。同步操作不能借 async 幂等承诺跳过未知写对账。 |
| A05 | Hindsight 自动 consolidation、refresh、删除后维护，internal 与 dedicated worker 模式 | 上游自动类型纳入宿主授权与排空/立即停止语义；真实费用可观测或明确未知。无法满足时记录适配门槛失败，不标“完整引擎可用”。 |

## 7. UI 与跨端消费者

模拟原型必须标“模拟数据/未连接真实服务”；模拟成功不改生产开关或安装真实代码。原型的三条主旅程应完整可演示：GitHub 检查→安装→配置→启用→绑定；全暂停→排空→立即停止/恢复；模块索引或整体内容迁移→校验→应用→失败恢复/回退。

| ID | 交互矩阵 | 必须验证的结果 |
| --- | --- | --- |
| U01 | 中文/英文，已安装/发现/功能方案，默认整体与高级组合 | 使用现有设置信息结构、间距、控件、返回行为与 terminology；配置复用已有模型/来源对象。高级模块与整体引擎的激活关系能明确理解，无无法操作的内核假开关。 |
| U02 | 320px、窄屏、桌面宽屏，亮/暗主题、长包名/错误/翻译 | 无横向裁剪、重叠和不可触达动作；版本、状态、范围和费用可读。小屏不靠横向表格才能完成流程；主题对比与禁用状态足够区分。 |
| U03 | 键盘 Tab/Shift+Tab、Enter、Space、Escape；弹窗/抽屉关闭与返回 | 正确焦点进入、限制与返回；背景不能被错误操作。输入法候选 Enter 不误提交；status/alert 可读；刷新或失败不会永久丢焦点。 |
| U04 | 连点、两窗口、关闭对话框、浏览器刷新、断线重连、Central 重启 | 服务器持久状态为事实；不重复副作用，进行中的操作可重新打开查看。UI 不因模拟定时器完成、页面刷新或开关位置显示成功。 |
| U05 | paused/draining/stopping/restart-required/missing-dependency/external-write-unknown/delete-pending | 状态和主动作准确；“已暂停”说明仍在排空的旧工作，“立即停止”区分外部确认。失败保留旧方案；未知费用/外部清除状态不藏在日志里。 |
| U06 | 引擎缺失/停用/卸载后的记忆详情、原文、会话历史和资料库 | 有通用展示与有效证据跳转；结果标明产生时的方案和可用性。不可读专有产物明确缺口，不能空白或将“插件缺失”说成资料已删除。 |
| U07 | desktop/Electron 与 Android 消费新 API、未知状态、catalog 回退 | API 新状态不被当作 completed；原生消费者支持必要动作/回退/错误。中英 moteText 与 Android 英文 catalog 同步；协议变化补测所有受影响消费者。 |

## 8. 高风险组合与覆盖方法

下列组合必须单独覆盖，不能用 pairwise 减掉：

1. GitHub 固定 release 检查成功＋下载字节被替换＋进程终止＋同 request 重试；不执行任何安装脚本。
2. 全暂停＋旧 queued/running/checkpointed＋外部 consolidation＋重启＋新输入；旧任务合法排空，新输入不补权。
3. 立即停止＋外部 batch 正在写＋取消 ACK 丢失＋worker 重启＋来源撤权；late write 不发布也不提前进入 reflect。
4. 整体迁移 staging＋新来源 delta＋共享 observation＋源删除/撤权＋apply 前 crash；校验失败维持旧方案。
5. 已开始完整 reflect＋cutover/rollback＋来源删除＋query child resume；固定 revision 且返回前拦截失效证据。
6. 外部已写＋receipt 丢失＋独立审核失败＋同版本插件重装；不双收费，不由旧实例提交。
7. delete accepted＋外部离线/partial＋旧 backup 恢复＋回退旧索引；未确认清除不能显示已清除，删除不复活。
8. 新 shared/API 状态＋Central 升级＋旧 Android/desktop＋卸载 Web renderer；通用正文和原件查询保持正确。

其他维度按 pairwise 补覆盖：来源种类、归属、中文/英文、输入尺寸、OS/CPU 架构、store/provider、network/磁盘、任务阶段、restart 时机与 UI 宽度。每个确认缺陷新增可持续运行的回归场景，并保留失败证据，不只修成功路径。

## 9. 上游能力复核与准入未知项

2026-10-12 只读复核得出：

- mem0 官方提供 Node OSS `Memory`，默认向量存储在内存；持久 store、history 和模型必须显式配置并验证。见[Node OSS Quickstart](https://docs.mem0.ai/open-source/node-quickstart)。
- OSS 有 CRUD/history；上游当前将 queryable graph、Temporal Reasoning、Dream、Decay 区分为 Platform 能力，不能计入 OSS 适配。选定 store 的 filter operator 覆盖仍需实测。见[Platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)。
- Hindsight 支持 retain/recall/reflect、TS 客户端与自托管；固定部署还要选择 PostgreSQL/vector、embedding/reranker、worker、模型和数据空间。pg0 适合开发；生产部署选型需核验实际依赖，不采用浮动 `latest`。见[官方安装文档](https://hindsight.vectorize.io/developer/installation)。
- Hindsight 的 cancel 为协作式；已写结果不回滚，无 checkpoint 的操作可能继续跑到底。consolidation、定时 refresh、删除后维护等自动类型不能遗漏。见[Operations](https://hindsight.vectorize.io/developer/api/operations)。
- Hindsight async retain 支持客户端 operation ID 幂等，但不返回 usage；不同操作身份冲突和费用未知需真实对账。见[Retain](https://hindsight.vectorize.io/developer/api/retain)。
- reflect 是上游完整推理接口，但公开页面没有承诺固定 snapshot 或查询无记忆 writeback。必须以实际版本和可观察外部状态证明，不从“只读”名称推断。见[Reflect](https://hindsight.vectorize.io/developer/api/reflect)。

上述设计门槛的部分已由固定供应方实测、生成回归和实际 Central 用户链路验证，见第 12–13 节。完整质量/费用基准、物理擦除、任意供应方及跨平台设备矩阵仍未证明。任何失败都记录实际缺口，不能以 mock、静默降级或放弃独立审核换取“适配成功”。

## 10. 检查门槛与分层状态

| 检查层 | 能证明什么与不能替代什么 | 当前已执行状态 |
| --- | --- | --- |
| 文档/模拟 UI | 证明设计可讨论与合成流程可演示，不证明供应方/安装能力 | 历史原型 PASS（第 11 节）；当前文档另行复核 |
| 生成 fixture/契约 | 真实 HTTP、持久 Store、ExecutionEngine、子进程与故障顺序；不证明供应方语义 | 已执行安装/控制/迁移/删除/恢复回归，见第 12–13 节；全矩阵未整体执行 |
| 实际外部服务部署 | 固定版本、原生 SDK/service、真实 embeddings、进程/原生备份；不能由 fake service 代替 | Mem0 与 Hindsight 固定部署实测已执行，范围见账本；未测试任意第三方引擎 |
| 真实模型集成 | 实际模型调用和独立审核路径；调用成功/卡片数不等于语义质量基准 | 实际本地 GPT 6.1 Medium 生成语料试验已执行；完整对照/多语种/费用矩阵 NOT RUN |
| Web/Electron 产品 UI | 实际 renderer 对持久后端的安装/控制/切换；不等于原生设备 | 实际 Chrome Web 的 Mem0/Hindsight 安装、迁移、反向切换 PASS，1360/320 与两种系统色彩偏好下布局/焦点通过；当前 Slate 保持既有浅色样式；最终完整 Electron featurepacks/navigation PASS，见第13节；未把生成 renderer 当成真实供应方/设备链路 |
| 原生消费者与物理设备 | 编译、单测、lint 可证明原生协议/UI代码可构建；不能证明现场权限/后台行为 | 最新 Android assemble/lint 与最终受影响 testDebugUnitTest 均 PASS；原生新页面现场交互与物理设备 NOT RUN |
| 最终受影响本地验收 | 当前目标 commit 的 `check:affected` 与所需旅程；旧 commit 结果不代替新修改 | 源码 `2383a8d` 上完整 `check:affected` PASS；完整 Docker 构建、认证 HTTP 与重启/替换容器持久化 PASS；范围见第13节 |

所有者已授权实际实现、验收后的 PR 和合并。最终报告区分实现、fixture、真实服务/模型、UI、物理设备和未完成项；私有凭据/模型输入/原生数据不进入提交。反向方案切换须重新迁移和核验，不承诺未实现的指针式回滚。

## 11. 历史设计原型检查

2026-10-12，使用独立 headless Chrome 和 Playwright，仅加载本地合成演示，结果为 PASS：

- mem0 与 Hindsight 都从未安装状态完成固定版本预览、安装、配置、启用、准备与接管；安装失败/重试、缺失配置校验有效。
- 正文权威替换展示正文、更正与删除意图迁移、索引和增量追平；准备失败、取消、核验成功但未生效、切换屏障排空、应用与旧代际提交拦截均可演示。
- 全暂停保留原授权任务排空；恢复产生新的准入代际且不补历史；立即停止隔离迟到结果。
- 1024、736、390、320px × 深浅主题 × 6 个页面/抽屉状态，共 48 个布局检查，无水平溢出或裁剪；无浏览器 JavaScript 错误。
- 键盘箭头切换页签、Tab 原生顺序、Enter 操作、Escape 关闭及焦点返回通过；宿主状态回声保留抽屉和焦点。
- 五份相关文档本地链接、Markdown fence、空白检查通过；三份新文档已渲染并核对表格，Mermaid 源码已审阅。

原型检查脚本与结果保存在原任务本地 visualization 附件，未进入本次代码提交。脚本针对本机预览服务，不能作为产品 E2E 使用。

该历史原型回归已覆盖空抽屉拦截点击、状态变化后焦点丢失、CRUD 替换误标为仅索引，以及接管前未核对旧任务的问题。这一历史设计阶段没有读取 Central 实际数据或调用模型，也未验证真实包/进程/持久恢复。后续实际结果在第 12–13 节单列；个人截图与物理设备仍未使用。

## 12. mem0 实施能力与消费者检查

2026-10-12，在临时私有目录与生成语料上验证；未改写现有 Central 节点，也未读取或传输个人截图、个人记忆正文。私有端点凭据、模型输入、原生 SQLite 数据和详细运行报告留在本地，不进入 Git。

固定候选为 `mem0ai@3.3.1`，官方 npm tarball integrity 为 `sha512-R+T0rB8WNU4Eh8ClfZnD2BKjk7Q4MDx3XdLZMoUZ+S7dItpkpg3xkcGrKqk0COV0dyRrul/EYzkDWTr2D6YTag==`。真实 embedding 使用 `Xenova/all-MiniLM-L6-v2` 的固定 revision `751bff37182d3f1213fa05d7196b954e230abad9` 与 q8 ONNX；模型文件 SHA-256 为 `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`。CPU 执行真实 tokenizer、ONNX、masked mean pooling 与归一化，384 维；没有使用关键词或 hash 向量替代。能力试验运行于 Node 24.19、`better-sqlite3@12.8.0`，仓库适配器使用精确锁定的 `better-sqlite3@12.10.0` 与 Node 26.11.1，分别记录，不假定跨版本无差异。

| 已执行层次 | 实际结果与范围 | 尚不能证明 |
| --- | --- | --- |
| 原生 SDK 能力试验 | PASS，23 项；literal add、完整 metadata、原生 update/history、owner/agent/run/namespace 过滤、真实 MiniLM 改写召回；两次独立进程重启后的持久读取、删除和历史残留；重复 add/update 与 op metadata 对账 | 不能证明 Mote 安装、迁移、全暂停或正式模型查询入口 |
| 真实模型试验 | PASS，隔离 staging 的 mem0 `infer:true` 实际提取生成事实，随后真实 embedding 召回；本地隔离 Codex Server `gpt-6.1-sol`、`medium`，禁用 native tools/plugins/skills/memories | 一份生成事实不是模型质量基准；没有真实个人数据、物理设备或完整产品模型旅程 |
| mem0 受控 worker fixture | PASS，4 个测试；真实固定 SDK 与实际子进程，完整不可变 Memory、版本/namespace、opId 重试/冲突、重启、删除回执、迟到重放、post-write/pre-receipt 对账、metadata 篡改拒绝及真实子进程 hung embedding 的有界关闭/未知 intent 保留 | 默认固定向量只验证传输/持久化/宿主边界，不证明语义排序；没有替代 GitHub 用户安装入口 |
| mem0 worker + 真实 MiniLM | PASS，同一 3 个测试对真实 embedding 服务重跑，包含检索前按固定 keys 过滤旧版本 | 不能替代完整产品问答、费用和多语种质量验收 |
| 正式读取消费者 fixture | PASS，5 个测试；实际 mem0 worker、HTTP Memory/Markdown/context read、外部缺失明确 503、原件继续读、导出缺失拒绝；问答固定旧 namespace/revision，切换后保留旧版本但迟到来源删除立即过滤；检索 scope/exposure、cursor 和不可变 catalog 约束；固定 A→B 谱系、隐私排除与删除输出防护 | 手工设置 fixture binding 不是插件安装/启用/迁移 E2E；尚未验证 Electron/原生 UI |
| 既有消费者回归 | PASS，8 个 ContextQuery 测试与 32 个共享 Reader/MCP/exposure/derived-context/semantic-time 测试；只使用生成 fixture | 当前结果不代替最终 `check:affected`，后续更改需重新运行受影响检查 |

仓库可复现的 fixture 入口为：

```sh
node --import tsx --test apps/server/test/mem0-memory-provider.test.ts apps/server/test/memory-provider-consumers.test.ts
node --import tsx --test apps/server/test/context-query.test.ts apps/server/test/evidence-reader.test.ts apps/server/test/evidence-exposure.test.ts apps/server/test/derived-context-permissions.test.ts apps/server/test/semantic-context-time.test.ts
```

真实 embedding 重跑通过私有 `MOTE_MEM0_TEST_EMBEDDING_CONFIG` 文件配置，包含 baseUrl/model/dimension/apiKey；不得把该文件或其内容提交 Git。原生 SDK 23 项能力试验脚本和报告仅保存在本次私有临时目录，复核者不能据上述 fixture 命令宣称已经重跑这些原生试验。

真实试验确认的限制：原生 add 不提供宿主 opId 幂等，重复 update 会再追加 history，raw ID get/delete 不自行校验宿主 scope。delete 只移除当前向量，旧 history 中仍有正文，重启后依然存在。因此适配器使用不可变 literal `infer:false` 版本与 durable identity/receipt journal，宿主保留授权和发布权；删除回执始终将物理清除记为未确认，不能把“当前不可读”标记为“已物理擦除”。外部服务失败不能回退 SQL 正文。SDK health probe 使用隔离生成 namespace，不能把内部 probe 写成已发布的用户记忆。

官方能力与模型来源：[mem0 Node OSS 文档](https://docs.mem0.ai/open-source/node-quickstart)、[OSS 与托管平台差异](https://docs.mem0.ai/platform/platform-vs-oss)、[上游 SDK Memory 实现](https://github.com/mem0ai/mem0/blob/main/mem0-ts/src/oss/src/memory/index.ts)、[MiniLM 模型](https://huggingface.co/Xenova/all-MiniLM-L6-v2)。文档用于解释候选，固定发布包的实际检查结果作为本次能力证据。

Mem0 产品安装/控制/正文迁移结果见第 13 节。固定 Hindsight 原生 factory/模型与 native volume snapshot/restore 已有独立实测；正式 Central 安装链路与 CLI 全运行备份分别记录，不能用原生 helper 的成功替代完整产品备份。


## 13. 一期实现与实际产品验收

2026-10-12，当前工作树的真实实现已接入 owner 控制面、固定适配器、公共正文读取/发布、暂停准入、正文迁移屏障、声明式 Web 与原生 Android UI。实际产品检查使用独立 loopback Central、正常 `buildApp`/background worker、私有 token、生成原件和本地 `gpt-6.1-sol` / `medium`；没有注入 fixture agent、供应方 factory 或合成计时状态。临时运行日志、截图、数据库和凭据仅保留在本地验收目录。

最终受检源码身份为`2383a8d7efb33bfe3859775a687df49473a94f06`，本验证文档随后单独记录结果；实际交付目标与合并状态由最终报告确认。

| 层次/入口 | 结果与已证明范围 | 明确限制 |
| --- | --- | --- |
| `plugin-control-journeys.test.ts` | PASS，25 项；生成固定 GitHub release + 真 Store/ExecutionEngine/worker：固定安装与丢 ACK 回放、配置/核验/启用≠绑定、owner/MCP/作用域/revision、暂停排空与恢复缺口、失败迁移/重试/尾部冻结/CAS、固定 reader、版本发布/更正及重启同ID、外部清除未知/晚到写入、卸载后旧 namespace 清除；另覆盖迁移取消与丢 ACK 后重启保留授权规范副本、精确来源删除仍清理 | 生成 transport 不是真 GitHub；生成 provider 不代表 Mem0/Hindsight 能力或语义效果 |
| `hindsight-checkpoint.test.ts` | PASS，8项；真 Store/ExecutionEngine/MemoryPipeline/MemoryPublication：native proposal 独立审查后发布失败、清理 pending 与重启，固定 provider/config/opId 只重试传输；清理 pending 可发布已合法审查正文但保留迁移/卸载引用；native cache 的 review retry 不跑 builtin pre-review admission；取消 native 等待 grant 后不审查/发布且清理授权持久；failed/stale/cancelled/blocked终态未清理草稿重启恢复 | 绑定/provider/model transport 均为生成 fixture，不证明真实 Hindsight 原生效果 |
| 正文退役与真实关闭回归 | PASS；`memory-publication-retirement`6项：来源同事务退役四类host journal、unknownwrite digest-only read/erase、lostACK重启、合法历史不误退役、迁移lateput与实际Mem0维护子进程清除/rollback/停机CLI备份；实际正常buildApp hung原生SDK关闭1项约5.7秒；StorageLedger private/control表quota/rollback/reopen1项 | 验证逻辑SQL/export退役与宿主生命周期；SDKhistory、WAL与物理擦除未证明，语义/UI按独立层记录 |
| `memory-integration.test.ts` | PASS，19 项；真实集成流程、独立审核与既有生命周期回归；新外部发布重试另由上述 journey 覆盖 | 使用生成模型结果，不证明真实模型质量 |
| `memory-review.test.ts` | PASS，12项；既有共享独立审查合同与3个新native回归：18fact原生proposal先审查再canonical校验、empty native强制独立、origin cache隔离与严格审查输出拒绝；checkpoint fixture也消费真实shared reviewer | 生成模型结果证明宿主审查边界，不是live-model质量/用量验收 |
| 停止传播与正式资料前置回归 | PASS；真实 Store/Pipeline/ExecutionEngine 的停止、原生 checkpoint 与消费者相关组合共69项通过，含旧生命周期 failed child 立即停止/重启传播、独立手工与owner后续授权保留、取消后transport未退出仍占尾部；缺正式Material的独立审核结果在新任务及旧verified envelope两种状态下等待输入，重启/手工复核不重做native或review | 语义/native/model transport为生成fixture；未重跑先前付费失败批次，不能宣称实际模型已重新产生同一归属问题 |
| Web `plugin-center.test.ts` + `manual-memory.test.ts` | PASS，13 项；真实组件/DTO消费、幂等重试、暂停/更换、owner冲突、焦点、配置首表单、解绑卸载、凭据切换隔离；删除后保留 pending 清除说明、节点变化清除旧提示；无正式Material的旧归属任务显示原因、保留审核结果/手工复核/取消，普通正式资料等待提示不变 | JSDOM 状态 fixture 不代替实际浏览器/服务 |
| Web消费者与双语补充检查 | PASS，manual-memory 4 + API 12 + resource-views 50，共66项；新增归属原因与状态2个中英文本并同步Android；`check-i18n`核对6835条双语消息，Web typecheck通过 | 这些定向结果不能替代最终全受影响检查 |
| Electron `test-web-feature-packs.cjs` + 完整 `test-web-navigation.cjs` | PASS；最终server/Web构建后独立生成Central/真实renderer：featurepacks、Coding上传、模型目录、已注册浏览器页；当前Provider实例、草稿放弃、profile API保存/探测/冲突、模块恢复部署、unused profile删除、诊断/活动、设置→插件；desktop/320布局无横向溢出 | 生成模型探测响应，不是实际供应方能力或 live-model 证明；Android现场未测 |
| 最新Android `assembleDebug` / `testDebugUnitTest` / `lintDebug` | PASS；新增2条资源同步后重新构建与lint，0 errors / 211 warnings；最终受影响检查重新执行testDebugUnitTest通过；原生设置入口、配置/动作/方案消费、删除清除回执可构建 | 未执行新原生页面现场交互、模拟器或物理设备 |
| Mem0历史凭据删除/清空 | PASS，`mem0-retained-reader`2项，相关组合11项；真实固定SDK/SQLite子进程、正常安装/配置与ModelSettings变更：cached及冷重启literal read/export/remove保留原历史，后续Embedding请求0；put/search/recover拒绝缺失/空准确预设，health不再ready，未初始化实例不能借历史回退启动 | release与embedding transport为生成fixture；证明SDK历史/授权边界，不证明语义质量、live-model或物理擦除 |
| 实际 GitHub → Mem0 Web 安装链路 | PASS；官方 `mem0ai/mem0` 的 `ts-v3.3.1`，commit `94c3fe9f238f3dbf29c9ce98643bd71eb13077cd`，源码制品 SHA-256 `38c22657708629753d4f7c0f639f20bae2069b7b50eb485065687ea0e24d48e3`；真实下载/固定安装、声明式配置引用、实际 SDK+384维 MiniLM 核验、启用不自动绑定 | 安装固定上游源码用于 provenance，执行适配器/SDK来自当前锁定宿主构建；没有运行任意上游 install script |
| 实际 Central → Mem0 正文切换与控制 | PASS；两条生成 owner 笔记通过真实 GPT6.1 Medium 与独立审核产生 Memory；正文迁移/索引核验、旧绑定保留、tail=0屏障、显式生效；暂停/新准入代次恢复/立即停止、绑定实例停用后读者保留、反向 builtin 正文迁移 | 前两条显式“虚构、非个人”输入被实际模型判为空是有效决定；卡片数量不构成质量基准。全部迁移是 Mote 保留规范正文/状态，外部原生审计历史/引擎图不保证可移植 |
| 实际 Web 渲染 | PASS；1360 与320宽度、系统浅/深色偏好（当前 Slate 保持既有浅色样式），安装预览Escape焦点返回、各阶段无横向溢出，无 pageerror | Chrome Web；未将其报告为 Electron/原生 Android 现场验证 |
| 固定 Hindsight 原生 factory | PASS；固定 v0.10.2 镜像、实际 embeddings/reranker、GPT6.1 Medium；不可变 literal CRUD/replay、固定召回、native提取/整合与谱系、私有授权 read-bank Reflect 无语义写回；自动 owned worker 与独立手工任务隔离 | Ask 当前使用 scoped recall+Mote只读 query agent，未提供原生 Reflect UI；取消协作式上游可能仍写晚到事实，由宿主 fence/owned worker处理 |
| Hindsight native volume snapshot/restore | PASS；独立原生 helper/factory验证3份精确正文/provenance、新volume、恢复不启动服务/模型、显式启动旋转凭据、worker=false | 不代替 CLI 模型/API恢复或用户完整设备链路 |
| Hindsight 历史配置的模型预设删除 | PASS；4个profile/error-class fixture；实际新native clone经真实 MemoryAdapters + 生成host registry facade 精确read/export原3份canonical正文，逻辑删除1份保留2份，语言模型请求0。只在已有冻结snapshot且确切model_profile_missing时允许literal历史读/删，语义引擎继续拒绝 | 这项实际provider入口不代替Central用户删除预设的UI旅程；非物理擦除证明 |
| 完整运行 CLI 备份恢复 | PASS，Mem0 native备份→fresh restore及退休包/配置/收据；Hindsight actual five-file snapshot、3份canonical正文通过CLI backup→restoreProfile到fresh volume，保留image/model/instance身份；恢复不启动服务/worker/model、不复制运行凭据 | Hindsight这项CLI入口验证复用独立原生archive，没有调用模型；显式启动后API/model能力由独立factory验证，不将这两层混作同一调用 |
| 实际 Hindsight Central GitHub/UI链路 | PASS；官方 v0.10.2 API source wheel实际预览/安装/配置，commit `5fc4ce20917b916240cef27c212c387a177f115b`、ZIP2084435B、SHA-256 `5f05c1017813000e8c46da941ad5cdd7b3d288d864bd985690f8c4f9555f7f64`；真实完整native核验/启用，Mem0→Hindsight 全部 Mote 保留正文迁移、冻结 tail=0、显式接管。最新源码重启后4张正文可读；正常API取消失败旧child并立即停止后，浏览器反向迁移核验/显式接管通过，4张完整正文与版本digest一致 | 首次能力check受120s总deadline中断，修复后重验通过。反向排空的旧child故障使用正常取消恢复；后续生产修复以生成持久回归验证，未重跑此前付费批次 |
| 实际 Hindsight Central原生提取/整合 | PASS；明确 native draft origin 修复后，实际原生提取产生2张独立审核卡，draft/review run身份不同、publication committed、cleanup acknowledged；原生整合读取2个正式Memory父项，独立审核合法保留现有卡片（0新卡），workflow/publication succeeded/committed、cleanup acknowledged。实际GPT6.1 Medium调用有用量记录 | 使用真实所有者API/正常background lifecycle，未将同步extract API写成Web按钮。长同步请求客户端应答未观察到，结果通过持久journal与正式正文读取核实；0新卡不是整合质量基准 |
| 最新Central重启与正常控制API | PASS；从冻结后的最新源码重启同一隔离生成vault：固定安装库存及4张不可变正文digest保留；pause关闭准入、resume产生新admission generation、stop关闭自动工作且保留读者/当前方案；随后4张正文digest仍一致。该控制验收的model_usage增量为0 | 未重新check/prepare/extract，不是供应方语义或模型质量复测；现生效方案为builtin，已安装外部实例保留 |
| 最终 `npm run check:affected` | PASS，exit0；源码 `2383a8d`，受影响范围为Central/desktop/Android/protocol/tooling：check:local包含6835条双语检查、共享库构建、全部workspace与scripts typecheck、workspace及tooling测试；另执行Android testDebugUnitTest | fixture与本地集成通过不证明物理设备、任意外部服务或完整语义质量矩阵 |
| 最终 `npm run test:container` | PASS，exit0；冻结生产源码真实Docker构建，runtime SQLite及bundled worker/skills可用；health、Web、401认证、生成note创建/读取和duplicate ACK、同容器重启、替换容器named-volume恢复全部通过 | 本次容器基础入口与持久化验证未重跑容器内Hindsight模型/多平台服务；独立供应方证据另记 |

最终宽检查计数：Desktop 54文件、433 PASS；Server 1524项中1523 PASS、1 SKIP、0 FAIL；Web 282 PASS；Agent 268项中267 PASS、1 SKIP、0 FAIL；Shared 177 PASS；根scripts 63 PASS、CLI 4 PASS。跳过项不计为通过。双语检查6835条，Android最终单测20秒完成、BUILD SUCCESSFUL。

最终 renderer 验收从仓库根目录运行完整脚本，前置条件是当前 server/Web 构建完成：

```sh
node_modules/.bin/electron scripts/test-web-feature-packs.cjs
node_modules/.bin/electron scripts/test-web-navigation.cjs
```

这两项使用隔离生成 Central 与真实 Electron renderer，截图/结果写入已忽略的 `.mote/feature-packs` 和 `.mote/web-navigation`；完整 navigation 不使用 `--library-only` 缩小范围。该检查不调用真实模型或外部账户，也不能替代实际供应方与物理设备验收。

最新 Android 构建使用 Java 17、已有 Android SDK 和离线依赖，从仓库根目录执行：

```sh
apps/android/gradlew -p apps/android :app:assembleDebug :app:lintDebug --offline --no-daemon
```

本轮APK为58518893字节，SHA-256为`f97cbdb72313d57bae18f3f1df30b0227214e1ee3ca9f3cda192ba6dfb470836`；构建/lint不替代原生页面现场操作或设备验证。

Hindsight官方仓库zipball实测186037135B、展开240254917B、5512entries，超过通用64MiB压缩预算。受控固定配方改选同一release的官方API source wheel（实际展开7307878B、346entries），不扩大通用下载/展开/单文件预算；下载验证选定release内的asset origin，再通过官方asset API固定实际字节，缓存重用继续核验digest和展开文件。对应回归拒绝跨origin asset、禁止下载大仓zipball和缓存篡改。

实际原生提取曾返回 502：共享 reviewer 在独立审查前误将未审查原生提案按规范 Memory 合同校验。明确 native-engine 草稿 origin 后，真实重验和共享 review 回归均通过；正式输出及缓存输出仍完整校验。另有自动生命周期 child 产生合法 `needs_owner_input`，但缺少 published Material 引用，owner-question 提交失败回滚，publication 保留 verified、旧方案继续读；反向迁移正确等待该尾部。实际验收通过正常取消该具体 child 和立即停止完成迁移，未修改数据库或重跑模型。随后生产guard将此结构性缺口变为`memory_owner_material_required` / `waiting_for_input`，保留审核结果并阻止自动继续；立即停止与重启沿生命周期checkpoint撤销旧自动child。相关真实Store/Pipeline/ExecutionEngine生成回归及UI说明已通过，未重新执行此前付费批次。手工重新检查既有缓存和取消仍保留，不新增所有者操作限制。

新发现的实际 Web 全局 `allowedActions` 缺少 verified preparation 的 activate，已修复并形成持久回归；真实浏览器从持久已核验准备继续生效通过。晚到外部写入/清除竞态及卸载后旧历史清除均在生成真实子进程和重启下回归，不将“当前记录移除”描述为物理擦除。

固定 Hindsight 镜像digest是OCI multiarch index，含linux/amd64与linux/arm64 manifest；实际服务/volume恢复在Mac Docker的Linux ARM64执行，AMD64实际运行NOT RUN。失败初始化的cached promise、稳定relay port、有界close释放lease/relay、不触碰外来container及显式新实例零语言模型请求的启动均有实际证明。

受控 Hindsight 最新 literal read/export 启动与实际 crash recovery 均为零语言模型请求：旧 host 进程终止后，同3份规范正文恢复、dead-PID lease 回收、竞争者拒绝，未持有 lease 的关闭不会停止当前 owner。此前付费启动 ping 试验属于历史路径，已被跳过 startup LLM verification 的行为取代；显式 native 能力 probe 仍有真实 GPT6.1 Medium 正向调用证据。原生 Reflect 在独立 factory 实测，当前 Ask 产品入口仍是 scoped Recall + Mote 只读 QueryAgent。

最终源码`2383a8d`的`check:affected`及完整Docker构建/HTTP/持久化验收均已PASS。独立实际Node24缓存镜像层的runtimeSQLite构建也通过；完整容器验收另行证明基础用户入口和两种重启的持久化。此前并行中间源码容器构建的参数不匹配失败保留为历史故障，不计为最终冻结源码结果。

剩余未验证范围：原生插件页面现场交互、物理设备、AMD64实际Hindsight运行、完整多语种/费用/质量矩阵，以及SDKhistory/PostgreSQL volume/WAL的物理擦除。独立retrieval-only切换、任意阶段组合编辑和原生Reflect UI尚未提供。最终target commit与PR状态由交付报告记录；这里不预先宣称发布或合并完成。
