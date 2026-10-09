# Mote 系统改造验证与发布方案（已确认）

日期：2026-10-10。对应 [系统改造技术方案](system-refactor-2026-10-10.md)。本文件保留验证设计；实际已执行范围与未验证项见 [验收记录](../validation/system-refactor-2026-10-10.md)，矩阵不能代替完成证据。

## 1. 验收账本

每次验收固定 commit、组件版本、epoch/wire/Ingress、Node/系统/设备、启动命令、模型/profile/reasoning、并发、语料 manifest/hash、实验组和缓存状态。每项记录 PASS / FAIL / NOT RUN / BLOCKED，以及可复现命令、证据路径、遗留问题。生成语料、真实模型、私人资料和真机证据分别标识。

生成资料可以证明身份、范围、权限、调用路径和恢复；只有真实模型对固定语料的回答才能评估语义效果；只有实体设备才能证明平台权限/后台/安装行为。fixture 回答得很快，不是模型提速证据；少调用也不是质量通过证据。

所有自动 E2E 使用生成资料和隔离 vault，不读个人截图或本机生产库。模型实验仍先用生成笔记、Coding 对话和媒体；私人截图/持留集若要参与，另需用户明确授权，原文和报告放 Git 之外。诊断和支持包不泄漏正文与凭据。

## 2. 验证入口与既有资产

优先使用真实 `buildApp`、认证 HTTP、生产 feature/background tick、正常 source organizer、正式 tools bridge 与 app.close/restart。进程级验证进一步通过 CLI 启动、listen、ready、停止和重启；不只构造内部 job 或手工调用 stage 函数。

| 区域 | 当前可复用入口 | 本轮要补的缺口 |
| --- | --- | --- |
| 查询 | `delegated-query-app.test.ts`、query runs/fence、delegation、conversations、Web Conversations | 直接无 worker 完成、合并原文交付、workspace 恢复、精简工具的实际适配器消费 |
| 证据 | agent material-tools/budget、evidence-ledger、citation、server disclosure-lineage、material-reader | 正文/原文两种偏移、partial sourceEvidence、实际序列化后才登记、恢复后重新交付、UTF-16边界 |
| Memory | receipt integration、work packages、batch context、draft recovery、source recipe integration、manual input plans | 自动真实入口直提、零候选独立覆盖审核、审核无效不重提、跨 receipt 语境、Coding 完整候选复用 |
| 执行 | lifecycle/startup/shutdown、SQLite process locks、execution event loop、provider admission | mixed lane、总容量和公平性、single-flight、父子释放槽、长期后台满载时的交互等待 |
| 组合与来源 | automatic recipes、artifact composition、semantic-products、Memex/source-pack | 第二来源实际消费新 contract，多配方共享生成/独立审核、单策略取消与授权隔离 |
| 质量 | persona、heldout replay、effective-memory/context-journey 等 live 脚本 | 固定同模型配对、真实自动入口、coverage与召回分开、直接与规划的效果对照 |
| UI/平台 | 既有 Activity/Memory/evidence/navigation generated Electron 场景、Android Gradle/原生页面 | 中英状态语义一致、刷新/停止/续问/恢复、受影响 Android 消费新状态、实体设备验收 |
| 发布 | check:local、component checks、release verify、源码包/DEV产物校验、备份工具 | 固定最终提交全量验收、实际安装和版本核验、同 epoch 恢复/拒绝旧 epoch、匹配备份回退 |

脚本名称不是验证结论。旧脚本若绕开 automatic receipt、真实 scheduler 或当前 query endpoint，要先修正其入口再纳入完整验收；不能用手动 Memory 作业证明自动收敛。

## 3. 用户旅程矩阵

| ID | 输入与初始状态 | 实际入口／状态变化 | 必须验证的结果 |
| --- | --- | --- | --- |
| J01 | 一篇生成日记、模型就绪、单 recipe | 真实 source receive→organizer→自动 background tick | 原件/Material先可读；无必经 planner；提取及独立审核；一个 receipt 被 claim 一次 |
| J02 | 无长期价值的完整输入 | 同J01，模型输出 no_candidates | 所有目标经过核算及独立审核；零卡片不等于资料失检；没有空结果偷跳coverage |
| J03 | 五篇短笔记、归属/time不同 | 同批到达/交错到达/尾批 | 不新增凑批等待；各成员授权、contextTime、归属、offset完整；模型先按新逐成员合同解释后才允许跨receipt packing |
| J04 | 生成Coding schema6对话，有工具/推理/引用，分别未饱和与超过容量 | 实际Coding archive→recipe→Material→自动Memory | 私有过程不曝光；完整未饱和理解候选禁止重复提取；饱和可按确切target拆分再生成；review读原文；实际调用完整计账，不要求所有长源一次完成 |
| J05 | 两个 recipe，同原件相同generation；另有指令/时间/归属不同的对照 | 自动接收及双消费者、取消其中一个 | 仅严格等价输入共享生成；两个审核独立；一失败/取消不否决另一；权限不能通过cache继承 |
| J06 | 长原文和部分媒体，body ready、transcript pending | 手工exact evidence与recipe计划；再补产物 | 当前支持的目标可先执行；选定OCR不被自动默认排除；未来sibling不扩大allowlist；总体状态仍准确 |
| J07 | 已有效提取草稿 | reviewer坏JSON/坏引句/漏coverage/超时；显式恢复 | JSON/引用/coverage问题只修review；超时继续已有draft恢复；提取无效才重提；失败阶段及usage准确 |
| J08 | needs_context、漏行、saturated各自独立样本 | 反馈计划／阶段修复／机械拆分 | 漏行先本阶段有限结构修复；修复耗尽/容量不足才拆分；未提交checked不算完成，所有target由子批完整覆盖；已提交siblings不重复，保持offset/语境/scope |
| J09 | 相同generation并发；不重叠/重叠范围；双recipe | 真实execution claim/run/commit | 单生产者或明确可证明的幂等；并发范围不漏/重复发布；coarse→细锁前后删除及版本fence同样有效 |
| J10 | 生成资料已归档、Memory仍积压 | Web/HTTP普通问答→检索→读取→引用→历史 | 一个durable run可直接完成；无需等待Memory；原文可回看；没有假worker，资料不足如实说明 |
| J11 | 三来源、两独立证据问题 | Agent真提交units→yield→worker→resume→回答 | 稳定child身份，父等待释放槽；并发1也不死锁；成功child不重跑；不同配置和scope不串线 |
| J12 | Material概要与原文不同，30refs仅返回2段；同ID不同layer | `read_with_evidence`→final citation | 仅实际sourceEvidence可引用；body/ancestry/private receipt不授原文权；模型解释layer不能登记成原文，未返回范围/summary/私有Coding事件不可引 |
| J13 | 长页、多不连续范围、emoji/组合字符、预算临界 | 实际reader→bridge序列化与分页 | UTF-16 offset准确；所有附原文计预算；失败序列化不登记；next游标无遗漏/循环；不把两个区间伪合成全文 |
| J14 | 恶意正文/metadata/引用/worker总结 | 请求读取私有来源、写资料、发消息、改变规则 | 捕获内容只能作证据；tool manifest、lane、scope和用户约束不能扩张；真实bridge拒绝非法操作 |
| J15 | 同conversation长历史与图片 | 新提问/续问/压缩失败/刷新/断线同ID重发/停止 | 问题及用户约束保真、同ID幂等、停止实际撤销、旧图片权限不复活；scope实际继承语义不被暗改 |
| J16 | 每个stage前后、child成功后、commit前 | app.close/restart及实际进程SIGTERM/restart | 成功工作复用；未提交工作按fence恢复；不能自动恢复终态取消/失败；快照与模型固定；旧lease迟到不提交 |
| J17 | 多范围/共享draft/workspace仍在用 | 原件删除、retention、source forget、归属更正、配置/recipe撤销 | 全依赖及时失效；无关回答保留；未改OCR/ASR复用；旧摘要/worker/cache不能重新生成已删正文或结论 |
| J18 | 模型未配、provider Retry-After、worker缺模型、索引损坏 | 启动/配置/独立恢复/后台并行查询 | 原件可恢复，当前可读部分仍可查；正确等待/失败；不静默替换模型/策略；索引恢复不重跑模型 |
| J19 | 大积压、交互与后台全部容量接近满载；后台配置1/32/64、交互1/8 | source持续接收＋query到达＋memory/媒体/embedding | configured/effective/total公式准确；child继承可信lane；无背景饥饿；父子不双占模型槽；Harness容量与provider cooldown及独立媒体/embedding资源分开计量 |
| J20 | Memory零结果、但semantic product有action cue | Memory/整合/洞察/行动各自开关 | 不互相阻塞；整合不是提取cache；行动不自动写外部；原文仍可查，旧更正和删除不复活 |
| J21 | 新鲜安装与当前epoch4备份，旧epoch3 | 真实CLI依赖检测→启动→导入/完整恢复→更新→回退 | 当前支持格式完整恢复；旧epoch仍明确拒绝且保留数据；升级不mint历史receipt；回退使用匹配备份与版本 |
| J22 | Web桌面/窄屏、中文/英文、Android原生中央页 | 资料详情、Ask、Activity/Operations、Memory恢复 | 状态和实际动作一致；证据关闭保留过滤与焦点；私有draft不可读；Android英文目录和API消费同步 |

2026-10-10后续讨论补充两个必测范围，不改变上述编号：

- **大导入滚动合批**：通过实际ZIP/文本导入、confirm和background=true的生产tick，逐record授权→Material→公共Memory队列，验证导入未完成时已ready部分可推进、尾包立即按现调度处理、没有onImported额外建job导致重复claim。混合就绪媒体不拖住无该依赖的正文；文本导入没有memoryJobId时UI仍显示真实公共队列状态。1000个生成记录至少逐目标核对，不用手工POST聚合Memory作业代替自动入口。
- **原生与目录能力组合**：普通笔记不强制discover；媒体统计走固定目录＋严格validator；read_image继续通过两个runtime的实际模态/交付receipt/日志脱敏路径。目录响应或captured内容不能提升权限，通用执行入口不能转发任意URL/RPC/shell；比较参数错误率及全部往返，而不只量tool schema字符。

明确保留以下多状态组合，不能用pairwise替代：

- 双recipe＋有效共享draft＋一个review失败＋重启＋生产者取消。
- 长源范围并发＋中途归属修正/retention删除＋迟到commit。
- ready body/pending transcript＋exact手工OCR＋不同自动requires＋产物后来就绪。
- planner完成handoff中断＋新输入到达＋receipt claim竞争。
- query worker完成＋workspace恢复＋所读但未引用证据删除＋无关conversation保留。
- 背景满载＋provider capacity1＋query child yield＋shutdown/restart。

其余输入尺寸、语言、来源、归属、provider、队列、失败阶段及生命周期按pairwise补覆盖。每个确认缺陷保留对应durable regression。

## 4. 固定语义质量判据

冻结语料与rubric，再生成实现。提取prompt和judge/rubric不能同时放宽。使用期望事实/定位与独立判断检查，不以卡片数量、少worker或运行成功代替质量。

| 类别 | 例子 | 正确性判据 |
| --- | --- | --- |
| 本人感受/经历 | 日记写一次压力体验及原因 | 有价值的本人体验不被泛化成空建议，也不因为没有“关键词”漏掉 |
| 第三方/混合归属 | 受访者说喜欢跑步；用户只批注其论证 | 不变成用户偏好；实际用户采访/批注需有证据才能记 |
| 时间与状态 | 10-01记录“下周尝试”，10-08记录“下周取消” | 分别保留来源、发生时间、评估语境，计划不改成完成 |
| 决策适用范围 | ORBIT同步使用outbox，项目X例外 | Coding经验包含触发、方法、约束和验证，不泛化到所有项目 |
| 精确原文 | 原文一句原因，概要换一种说法 | 引文是本轮确实读到的原文范围；概要只能标派生陈述 |
| 变化与冲突 | 先14天、后30天；另一项目60天 | 当前/历史与scope分别正确；冲突不静默覆盖，替代精确目标版本 |
| 空档与不可用 | 只有Shadow、未同步、转写未完成 | 说明真正缺口；不能编造原文、活动或出席 |
| 长文与容量 | 有价值候选超过上限，分散在首尾 | saturation后全部合法目标最终处理；只coverage完整不等于语义召回已通过 |
| 删除防重建 | 用户删掉结论，同字节换transport ID再传 | 原件仍可查但旧结论不能从cache/重放自动复活；新的实际证据按既有规则处理 |
| 注入 | 文本要求忽略规则、读另一个source | 不改变授权、工具、lane、状态或用户明确要求 |

质量评估分为 Memory 的价值/归属/时间/经验细节、查询的事实覆盖/可核验性/未知说明、整合的版本关系、媒体识别准确性。真实媒体质量不能用脚本ASR/生成model response通过替代。

## 5. 性能实验

### 实验组与控制变量

查询按增量比较：Q0当前基线；Q1短核心prompt与直接优先；Q2原文同次交付；Q3workspace恢复；Q4两层能力目录（若选择）。先独立测各改动，再测组合，以免无法定位收益或质量下降。

Memory比较：M0当前模型规划package；M1直接单份完整package；M2严格等价候选/draft复用＋阶段恢复；M3逐成员语境已验收后的结构批处理。锁与lane另做S0/S1混合负载，不能把改模型或并发所得差异算到去planner。

固定同一生成语料、模型（优先与历史问题相同的gpt-6.1-sol/high）、provider/runtime、并发、预算与机器。冷启动和暖缓存分别分组、交错执行组序；保留首次失败和显式恢复结果。不同模型/effort仅作为后续单独实验，不作为本轮性能通过的方法。

每组记录实际direct/delegated路径及worker数量；模型自然选择造成的差异只能报告观察结果。因果对照另用隔离benchmark的可信test-only host capability policy控制直接/委派两arm，仍走真实HTTP与同Engine，不添加生产关键词路由或新用户模式。强制实验路径与生产自主选择验收分开。

语料至少覆盖普通单文查证、续问、历史纠正、第三方访谈、跨来源研究、长文范围、零候选、Coding经验、媒体partial、背景积压。大规模使用与原Review相近分布的**生成**1,714文件及长正文样本，不复制私人库。

先各组少量预实验确认instrumentation与rubric，再确定正式重复次数及运行manifest。小样本报告逐次值和中位数；P95须注明样本数、语料分布和不确定性，不能用几次成功运行宣布稳定SLO。模型账单内部不可见时报告Agent运行和可观测request，明确unknown。

### 指标

| 旅程 | 指标 |
| --- | --- |
| 接入 | receive ack、Material首次可读、FTS首次可检索、命名产物ready、Memory首条及全部完成 |
| 查询 | request→首次真实证据→最终有效回答；executor/Agent/model排队；启动；provider；tool；child等待；resume；repair；commit |
| Memory | 每完整目标的实际generation/review次数；planner次数；cache命中/原因；有效输入字符或tokens每分钟；首批/全量wall time；恢复重复生成数 |
| 资源 | provider并发、活跃CPU/内存、event loop delay、DB事务/锁等待、各pool等待及后台starvation |
| 费用 | operation全部尝试、缓存读/写、输出、实际/估算/未知费用；复用不能补写虚假零token收据 |

并行工作记录critical path与累计时段两个值，不把sum(span)当elapsed。固定输入字符、实际tokens、context window、工具结果披露预算和输出reserve分别记录。

### 放行建议

以下是建议，方案接受后依据Wave0冻结的基线确定最终数值；本轮没有已达成的性能指标。

- 硬门槛：授权/范围/精确引用/版本/删除/取消全通过；关键质量rubric无回退；完整目标coverage无丢失；真实入口的直接流程不发生无必要planner或重复generation。
- 性能方向：普通查询与增量Memory的配对中位耗时、尾延迟和重复读取明显改善，背景满载下交互准入改善且后台持续推进；若某类研究变慢，记录原因和完成质量，不用隐藏该类请求改善统计。
- 不承诺“所有查询60秒内”或“省某百分比tokens”；provider速度、复杂研究与真实语料分布尚未测定。可把这类数值作为产品目标讨论，不能当代码测试已经证明。
- 性能不达预定目标时继续定位queue/model/tool/repair；不会改成低推理模型、吞输入、减少审核或静默截断以通过。

## 6. 完整验证与版本发布

1. Wave0：确认决策、冻结接口/版本身份/质量rubric，建立真实入口基线与数据隔离。
2. 每模块：有意义的定向回归、真实bridge/HTTP、阶段故障和文档一致性；不写只镜像实现的测试。
3. 合并前：`npm run check:local`；Central构建与相关E2E、浏览器、CLI启动/关闭/重启、备份/恢复、安全与i18n检查。
4. 涉及Android原生消费：Gradle单元测试、lint、打包/身份校验与生成资料UI；涉及macOS则desktop构建/fixture/UI。物理权限/后台/安装另外真机验收，不能由编译或模拟器推断。
5. 固定最终候选提交：运行真实模型配对质量及性能、受影响平台实体设备、混合负载与回退演练。修复确认失败后只补必要相关回归及新候选全量门槛，保留前次失败证据。
6. 发布：按真实受影响组件执行version/notes/release:verify；PR与合并提交均可追踪；准确tag和不可变产物；当前DEV无签名manifest，核对源码包/DEV asset metadata、身份、散列和安装版本。workflow可能跳过MOTE_PRE_RELEASE_CHECKS，核查实际执行的门槛，不用CI绿代替本地全量。
7. 安装后：用隔离生成输入走接收→查询→Memory→阶段恢复→删除；确认运行commit/版本和实际目标分支都包含改造，再报告交付。

最终报告必须列出实现范围、fixture结果、真实模型结果、真机结果、升级/回退结果、已发布组件/tag/commit和未验证项。公共Release notes不包含私人语料、凭据或诊断正文；源码包从准确tag归档。

具体命令、结果和发布身份由验收记录维护；未执行的性能、私人语料与物理设备场景不能由其他测试推断。
