# 三端 UI 定稿：来源、决定与验收范围

2026-10-29。代码核对基线：`5846a09b240594cb6dc1237299ab435c95048b44`。本文记录本轮 UI 目标和未决边界，**不是实现完成或视觉验收通过报告**。规范决定见 [三端 UI 定稿 ADR](../adr-ui-final-three-clients.md)，测试分层仍以 [testing](../testing.md) 为准。

## 1. 来源与优先级

唯一新增设计依据是所有者指定的 [「评审各端 UI 用户旅程」原始对话](codex://threads/01a17d84-94a3-7382-b12a-5c656106f534)。使用本机受支持的 `read_thread` 完整分页读取了 39 轮；[第 8 节](#8-原讨论逐轮索引)保留 turn ID、用户 message ID 和产物。下文 `S00`—`S38` 对应该索引，不能将助手建议单独当成所有者决定。

来源顺序为：主对话中较后的明确用户取舍 → 对应获认可/按要求修正的原型 → 最新收尾 HTML 中已有能力的 UI 补全。此前仓库 ADR 用于核对现有合同与冲突，不替代新对话。2026-10-29 当前任务授权纯 UI 实现、严格验收及 PR 合入，不自动授权新增功能、扩展业务执行策略或后端架构。

本轮执行授权另有明确追加：[执行协调对话](codex://threads/01a1767c-d428-715a-8055-60970a2a00c5)，助手提问 `Sentinel_6409e67a4e0481918ccb06bb1688db5a`、用户回复 `Sentinel_257460f132848191881fe64393bba4c5`：“可以就这么搞，然后第四条的自动依赖什么的也都一起做完。”该回复批准第 5 节 H01–H04 所列四项有界变更，并将第四项扩大为完整一键依赖准备、模型下载、启动及失败恢复。它是本轮执行/后端授权来源，不替代前述 UI 设计来源；状态为**已授权、待实现和验证**，不能再当作待批准事项。

源目录为 `/Users/utopiafar/.codex/visualizations/2026/10/27/01a17d84-94a3-7382-b12a-5c656106f534/`，本轮只读。原型包含生成数据，示例日期、数量、设备、账号、成功结果、模型和版本号不是产品常量。顶部客户端、旅程、安装包、示例回执/结果选择器是**评审工具**，不移植到产品。

`mote-final-workspace.html` 是最后收尾稿；其作者元数据仍写 `candidate-awaiting-owner-review`，主对话没有更晚的单独验收发言。当前实施授权覆盖其中对应现有能力的 UI，不能据此批准其隐含的新能力。也不能只看此文件：已接受的首次使用页并未完整并入其路由，`mote-first-use.html` 等前代获认可页面仍属于最终源集合。

S09 引用的 [更早分享对话](https://chatgpt.com/share/6aded7e7-8e04-83ea-86ed-fa36a31fc8e5) 已通过获准的公开页面只读下载，解析其 `linear_conversation` 可见正文，并复读 56 条实际用户发言；另一个 user 记录仅为不可用自定义指令占位。未执行页面脚本。它补充确定性记录与对话分开、输入与输出分开、结果与异常优先、共享用户状态与本机权限/草稿分开、功能就近与专业设置分层等早期原则。主对话较晚的 Android 轻首页、既有只读 MCP 接入、手动 Memory 操作和历史保留取舍优先；较早分享中的通知算法、iOS、模型路由、隐私生命周期等未定事项不能自动成为本轮新功能。

| 最终源集合 | 用途与接受关系 | SHA-256 |
| --- | --- | --- |
| `mote-final-workspace.html` | S38 既有能力集中收尾；保留已接受框架；新策略仍需第 5 节核对 | `d6ae147fbb0b2b9df08b52bc8ee60a85e02c4340c7872e45c4878fdb0592819e` |
| `mote-recovery-workspace.html` | S37 恢复/中断，S38「大体 OK」 | `58bedf951b124128d7853246e2d3b967e28bdd8e66a6468fc0d3d3a19473bde2` |
| `mote-continuity-workspace.html` | S36 跨端/副本，S37 明确覆盖其删除历史分支 | `15f899ce90dd79d6058f322bdfc8b34b940a7dec4fa31c04476c57af7eba61b3` |
| `mote-first-use.html` | S35 首次使用，S36「大体 OK」；不能被最终文件遗漏 | `01b1f22269645d40af80957731b6ecae8f7169e31942bee2c31f60dc0889d7af` |
| `mote-mac-role-exploration.html` | S34 Mac 对照，S35 接受轻落点/保留侧栏方向 | `64739e25469d468b981a055d05865e04915e38e8c586be6f4a06f7a0620ff113` |
| `mote-android-assistant.html` | S33 手机轻入口，S34 接受并要求新用户承接 | `361fd91595477797a77059df9bd243b8b005f4ac8e9582499f5f2a2a88fe259b` |
| `mote-ui-owner-decisions.json` | 作者整理的辅助索引；与用户原话冲突时不优先 | `27fd2c6061b667123bd33f0de7f05b7cb3fc7f6837033f717b999ec79422a6f7` |
| `audit-features.json` | S00 既有 78 项 Central/33 项原生能力审计；A01 后来被删除，旧导航不再规范 | `cbef62f58de8aeb802611657bc9c56d570490414c0d3a388b8d1672d480499d2` |

## 2. 已确认的原则与取舍

| ID | 最终要求 | 被替代或未选方案 | 直接出处 |
| --- | --- | --- | --- |
| D01 | 默认只显示内容、必要状态和操作；说明留在首次引导、帮助、错误和重要选择 | 日常页面堆满无谓说明；把调研中间结果放进产品页 | S01、S04、S25 |
| D02 | 局部迭代保留未讨论的侧栏、顶栏、视觉框架和功能 | S04 资料页整体重做、侧栏消失 | S05 驳回，S06 接受恢复稿 |
| D03 | 先盘完整功能、用户旅程、实体与现有 ADR；参考同类产品熟悉的路径 | 为突出新入口挤掉旧能力；未核实能力先画可用按钮 | S12、S13、S14、S25、S28 |
| D04 | 阅读原文、原图和已有正文；预览截取已有正文、图片用缩略图 | 为 UI 新增摘要实体/生成任务 | S02、S07 |
| D05 | 我的资料内按资料找、按时间回看；同一资料可从不同入口找回 | 按主动/自动、是否有主题硬分「记录与文件/采集记录」 | S03 质疑；S06、S07 接受恢复后的整合 |
| D06 | 原文预览为默认；无正文引用如实显示位置/状态 | 默认只见紧凑元数据，或引用假装有正文 | S07 |
| D07 | Central 全局顶栏一处随手记，保存回原页，收起保留草稿与阅读/提问位置 | 只有资料页内入口；每个页面重复强调创建；自动复制当前资料到独立笔记 | S08、S09；Android 后由 D21 收敛 |
| D08 | 资料库、来源、引用进入同一份资料详情；返回位置跟随来路 | 来源内再做一套不同正文/提问页；丢失来源上下文 | S10、S11 |
| D09 | Memory 独立详情、来源依据、状态；搜索在前，筛选按需展开并保留可移除条件 | 独立视图库/成员管理；新增视图管理功能 | S11 建议，S12 明确收回，S14 接受精修 |
| D10 | 文件/文件夹/ZIP 导入、预览、恢复保留；服务器目录导入移除 | Central 服务器路径输入及相应入口 | S15 明确删除；S16 接受 |
| D11 | 原件归档、记录发布、记忆整理分别表达；可靠解析自动保存，含糊解释再确认 | 上传成功直接称处理完成；取消处理即删除已归档原件 | S14、S15 |
| D12 | 来源配置按真实能力区分；资料说明/内容归属按需展开，显式保存，返回保留草稿 | 所有来源一套虚构范围；重授权/保存配置自动解除暂停 | S15、S16 |
| D13 | 输入来源与对外 AI 接入分开；已有只读 MCP 配置生成、复制/下载、凭据只显示一次、撤销 | 配置生成等同客户端连通；不存在的使用明细/最近访问；新增权限预设或 MCP 扩权 | S16、S17 |
| D14 | 首页前置搜索/提问、最近资料与对话、有限既有发现；发现结论可回原文 | 以后台管理指标占据日常首页；新建自动精选/推送算法 | S17、S18；S33、S34 |
| D15 | 发现默认排版结果；「排版结果/标准阅读」收更多，保留现有 HTML/Markdown 输出 | 显眼「报告/文字」双 Tab；因布局改造后端输出架构 | S19 明确确认 |
| D16 | 活动按进行中/需要处理/已结束，原因与成果优先；导入确认/重试回原操作页 | 日常直接暴露运行树/技术步骤；复制一套导入流程 | S19、S20 |
| D17 | 「模型与服务」聚合语言模型、OCR、语音：服务连接/模块与模型/资料处理 | 只管 LLM 的「模型与 AI」；把采集权限、来源接入、外部 AI 授权混在 Provider 内 | S21—S26 |
| D18 | 后台授权为资料处理中的「自动处理新资料」；首次/服务或资料范围变更说明确认，日常开停；更多中范围和立即停止 | 独立后台授权 Tab/权限勾选页；把全局授权假装成每功能独立授权 | S24、S25；保存连接仍不自动授权 |
| D19 | 本机 OCR/语音一键安装依赖、下载模型并启动；分别显示准备与可用，技术地址端口深藏 | 要用户逐个填写 loopback/worker 接口；文件下载完成即称可用 | S25、S26；实装能力缺口见 H04 |
| D20 | 设置总页保留自动记忆/插件、用量、存储备份、诊断；定期发现就近配置且总页同入口 | 设置只通模型；复制两套定期发现配置 | S25、S26 |
| D21 | Android 单日常首页，记录/问一问两个主动作；资料与记忆、采集与同步等到次级菜单 | 原四 Tab、再加 Record Tab、各页面重复记录主按钮；正常采集仪表盘常驻首页 | S32 候选，S33 改方向，S34 接受 |
| D22 | Android 必须有首次使用承接，允许先记录后连接，不强迫权限/模型就绪 | 极简空白页；必须先接 Central 或全开权限才能记录 | S34、S35、S36 |
| D23 | Mac 菜单栏轻入口＋完整主窗口；保留侧栏和工作区，首页突出提问/最近内容，正常状态紧凑 | 将 Mac 压成手机同款布局；原工作台大采集/发送面板占优先位置 | S34 探讨，S35 接受 |
| D24 | 每次保存/导入/来源同步可填独立、选填资料说明；区分单条/来源作用域，续传沿用 | 把说明混入原文、心情或本人陈述；每次后台续传打断；自动付费重跑历史 | S31 明确要求；缺失传输见 H03 |
| D25 | 采集、来源暂停和发送暂停保持各自语义；来源暂停保留待发内容 | 授权后自动开始；保存规则即开始；暂停发送同时停记录 | S30、S31、S35—S37 |
| D26 | 日程默认生效，不再逐项审批；保留缺时间、等设备、待核实/失败与真实回执 | S26 逐条核对/确认日程队列 | S27 明确纠正，S28 完成修正，S29 接受；非 create 执行见 H02 |
| D27 | 设备在来源中，生成邀请/扫码/导入；只展示上报和 Central 接收；本机采集权限留本机 | Web 远程启停/改设备隐私；连接成功等于原文可读或 AI 可用 | S28、S29、S35—S36 |
| D28 | 录音以转写阅读/时间回听为主，局部命名说话人、逐段校正，保留原转写；导出/关联/处理收更多 | 把无音频的厂商转写画成可回听；跨录音自动统一说话人身份 | S29、S30 |
| D29 | 同一已提交对话跨端继续，未提交草稿留原端；引用打开精确原文并可返回 | 暗中同步草稿或切对话丢稿；Mac 本机重造 Web 引用阅读器 | S36、S37 |
| D30 | 资料修改或删除后，已提交问题、回答和引用身份始终可见；轻提示、继续提问、不可用原文如实说明 | S36 删除资料后清空/隐藏历史回答；把旧引用指向新正文 | S37 明确覆盖；执行范围见 H01 |
| D31 | 本机副本清理不等于 Central 删除；Android 记录保留期、文件暂存、Mac ACK 释放各自区分 | 三端强行一套副本保留策略；移除来源时不说明未发送暂存会清除 | S36、S37 |
| D32 | Android ZIP/配置 JSON、Mac 队列 JSON 按现有格式恢复；显示校验失败、部分结果、重试/未知，验证后切存储位置 | 统一备份格式、原子全部恢复、无条件取消迁移、假造 Mac 节点绑定/成功 | S37、S38；Mac 失败结果见 H07 |
| D33 | 图片提问/本次模型/对话更多、Memory 手动反馈和历史、澄清问题、特殊资料、插件失败恢复、本机维护、全部功能入口归各自位置 | 新一级导航、无对应实现的能力、目录 ID 存在即宣称可用 | S38 受当前纯 UI 落地授权覆盖；见第 3/4 节与 Q01 |
| D34 实施偏差 | 次要文字保留4.5:1检查，在下列既有浅色背景上将 `#777066` 微调为 `#6f695f`；原型截图仍保留原色 | 放宽既有可读性门槛；改色后仍宣称像素完全无差 | 本轮执行协调的UI实现细节，非主设计对话中的原色，也非用户逐色批准 |

D34 是明确披露的视觉差异：按原色 HSL 色相/饱和度保持、以 0.0001 亮度步进减小后的首个满足所检查五背景门槛的 8-bit 结果。独立审查补查了已选发现摘要与 Mac 记录时间实际使用的 `tint` 背景，因此进一步调整了初稿的 `#706a60`；现有对比度测试已包含此配对。以下为公式核对值，不能替代真实产品画面及其他色彩组合验收；如实际背景不同，应重新核对。深色源色不因这一调整自动变化。

| 背景 | 原次要文字 `#777066` 对比度 | 实施次要文字 `#6f695f` 对比度 |
| --- | --- | --- |
| `#eeebe5` | 4.110509 | 4.570485 |
| `#f7f5f1` | 4.491462 | 4.994067 |
| `#fffdfa` | 4.816706 | 5.355706 |
| `#f0ede7` | 4.185602 | 4.653981 |
| `#eee7f5` | 4.048589 | 4.501635 |

## 3. 逐端逐页、弹窗与状态清单

以下是源清单，建立于实现前，不按实施结果倒推。W/M/P 是验收旅程组，不是精确页面总数；一组可包含多个页面、弹窗和状态。每行均需核对布局、文字、控件、导航及列明状态。`未测` 表示尚无相应**产品**运行截图与实测；静态代码存在不改成通过。H01–H04 在基线实现列描述的是旧代码缺口，其新目标已获追加授权，仍待实现验证。原型定位为文件名/可检索标识，不把累计文件里残存的旧候选路由都算成选中页面。

### Central Web

`最终` 指 `mote-final-workspace.html`，此前原型名称见第 8 节。现有实现路径相对 `apps/web/src/`。

| ID | 入口 → 页面或弹窗 | 必须覆盖的内容、状态与返回 | 源/定位 | 基线实现与差异入口 | 产品验收 |
| --- | --- | --- | --- | --- | --- |
| W01 | 首次打开 → 首次使用 | 未连接采集器、已连接无资料、待发送/未核实、原文可读/不可用；模型可跳过 | S35–36；`mote-first-use.html` | `shell-components.tsx`、`DeviceOverview.tsx`；须逐状态比对 | 未测 |
| W02 | 首页 | 搜索/提问、精选既有发现、最近资料/对话、必要异常；真实空态 | S17–19；最终首页 | `Overview.tsx`、`features/system.tsx` | 未测 |
| W03 | 全局搜索 → 搜索结果 | 显式搜索/提问模式，结果回原文；返回保留输入 | S09–10；搜索/问一问 | `Ask.tsx`、`ConversationShell.tsx` | 未测 |
| W04 | 全局顶栏 → 随手记编辑器 | 文字/已有附件，保存/收起/失败，草稿及原页滚动保留；独立资料说明见 H03 | S09、S31；`recordButton` | `Notes.tsx`；原全局入口/弹层比对 | 未测（H03已授权待实现） |
| W05 | 资料库 → 我的资料 | 搜索/类型/来源筛选、标签、翻页、默认原文预览、空/加载/失败 | S06–07；`mote-library-complete.html` | `Archive.tsx`、资料投影组件 | 未测 |
| W06 | 我的资料 → 按时间回看 | 既有截图/通知/活动关系展开；不按每个底层事件塞一行；回原范围 | S03、S07；时间回看 | `Archive.tsx`、集合视图 | 未测 |
| W07 | 列表/来源/引用 → 统一资料阅读 | 原文、原图/OCR、来源/位置/状态；无正文/原件不可用；原路返回 | S07、S10–11；`openRecord` | `Materials.tsx` 内联详情、`ReferenceDetail.tsx`、`main.tsx` 原始记录详情 | 未测 |
| W08 | 资料阅读 → 更多/关系/提取 | 内容归属与说明、下载、原件、提取当前资料；单条原始记录删除确认/取消/失败保留，显式目标不误处理另一项 | S15、S31、S38；`record-more`/`extract-current` | `SourceContextEditor.tsx`、`ManualMemoryRecipes.tsx`；字段缺口另列 | 未测（H03已授权待实现） |
| W09 | 阅读/搜索 → 完整问答 | 对话/历史、证据范围、发送/生成/错误/离线、引用→原文→原位，草稿不丢 | S01、S09、S36；`ctCompose` | `Ask.tsx`、`ConversationShell.tsx` | 未测 |
| W10 | 问答 → 图片/本次模型 | 选择/取消、上传中/失败/重试/移除，文字附件保留、忙碌禁重复、模型默认 | S38；`finStartImages` | `Ask.tsx`、`ModelSelector.tsx` | 未测 |
| W11 | 对话 → 更多/本轮详情/保存/删除 | 本轮模型、检索、费用未估价与已读依据；整段对话删除→确认/取消→失败保留；保存时已提交原文与本人补充分离，失败回对话且不覆盖全局草稿 | S09、S38；最终6173、对话更多 | `Conversations.tsx`、`SaveConversationRecord.tsx`、`NoteOrigin.tsx` | 未测（H03已授权待实现） |
| W12 | 对话 → 中断/停止/继续澄清 | 结果未确认、检查/同请求重试、失败再编辑、停止待回执、依据不足 | S37；恢复稿提问场景 | `Ask.tsx`、请求状态模块 | 未测 |
| W13 | 历史 → 资料已更新/已删除 | 问答、引用身份与继续入口留存；原文不可用提示、不静默转向新版本 | S37；连续稿修正 | `Ask.tsx`、`AnswerMarkdown.tsx`；服务器删除冲突 H01 | 未测（H01已授权待实现） |
| W14 | 资料库 → 我的记忆 | 搜索、筛选展开/收起、已选条件可清、依据数量/来源/更新状态、空/失败 | S12–14；精修稿 | `Memories.tsx`、`MemoryTopics.tsx` | 未测 |
| W15 | 记忆 → 详情/依据 | 判断/范围/状态、相关记忆、依据→统一阅读→返回原搜索筛选；不可用依据 | S12–14；Memory 详情 | `Memories.tsx` 内联详情 | 未测 |
| W16 | 记忆更多 → 纠正/历史/有效时间/导出/删除 | 编辑草稿、保存/取消/失败、原列表/详情同步、删除确认、历史只读 | S38；`fc-memory*` | `Memories.tsx`、现有记忆操作；无自动传播新策略 | 未测 |
| W17 | 资料/记忆 → 手动提取/继续整理 | 固定被选实体、配方、工作状态/失败/结果/返回；不扩大到全量资料 | S38；`fc-memory-extract`/`fc-memory-integrate` | `ManualMemoryRecipes.tsx`、`MemoryIntegration.tsx` | 未测 |
| W18 | 首页/资料 → 需要你补充 | 问题详情、回答/稍后/“我也不知道”、历史、失败保留输入、资料变化提示、回原资料 | S38；`fc-owner-questions`，最终5918、5930 | `OwnerQuestions.tsx`、`features/owner-questions.tsx`；历史H01 | 未测（H01已授权待实现） |
| W19 | 资料库/来源 → 导入列表 | 全部/需处理/已完成、原件/记录/记忆状态分别显示 | S14–16；`openImports` | `Imports.tsx`；服务器目录入口当前仍存在，需删除 | 未测 |
| W20 | 导入 → 添加资料 | 文件/文件夹/ZIP、选填说明、取消/空/限制、图片方案；无服务器目录 | S15；导入新增 | `Imports.tsx`、`ImportQueueEntry.tsx` | 未测 |
| W21 | 导入详情 → 预览/确认/恢复/删除 | 拆分及说话人核对，改说明重算预览，可靠结果自动保存，取消保原件、重试同请求、删除说明共享资料 | S14–16；导入详情 | `Imports.tsx`、队列/预览组件；删除历史 H01 | 未测（H01已授权待实现） |
| W22 | 来源 → 列表/添加来源 | 类型/需处理筛选、状态、添加目录、已有连接；不以配置已存代替连接成功 | S15–16；`showAddSource` | `Sources.tsx`、`SourceCatalog.tsx` | 未测 |
| W23 | 来源 → 详情/已有资料/连接与范围 | 概览与配置分层，说明与归属，保存草稿/暂停/恢复/断开/重授权、实际同步时间 | S15–16；来源详情 | `Sources.tsx`、`SourceContextEditor.tsx` | 未测 |
| W24 | 来源 → 飞书文档/日历 | CLI/账号授权、范围/首次回溯/排除/预览/保存；取消授权、失败重试、暂停不自动解除 | S15–16；飞书 | `LarkSettings.tsx` | 未测 |
| W25 | 来源 → Google Calendar / Gmail | 独立授权、日历选择、同步/续页/断开/失败；只读与归档限制真实 | S15–16；Google/Gmail | `Sources.tsx`、来源配置组件 | 未测 |
| W26 | 来源 → 录音供应商 | 历史范围、转写归档/音频归档分开、授权取消/失败/单项重试 | S15–16、S29；录音 | `RecordingsSettings.tsx`、`RecordingAuthorization.tsx` | 未测 |
| W27 | 来源 → MCP 资源 / NAS 引用 | MCP 列表→选择→一次导入；NAS 保存位置元信息不假装已抓正文；取消/失败 | S15–16；MCP/reference | `Sources.tsx` | 未测 |
| W28 | 来源 → 设备详情 | Mac/Android最近上报、实际Central资料→原文→设备；不上远控按钮 | S28–29；设备 | `DeviceOverview.tsx` | 未测 |
| W29 | 添加设备 → 邀请/连接管理 | 客户端选择、邀请/扫码/导入、过期/取消/错误、撤销/重连；归档仍可看 | S28–29；设备接入 | `Connections.tsx`、`ClientLoginApproval.tsx` | 未测 |
| W30 | AI 接入 → 授权列表/详情 | 有效/历史授权、凭据标识；无捏造最近使用/连通状态 | S16–17；AI access | `Connections.tsx` | 未测 |
| W31 | AI 接入 → 新建/生成/撤销弹窗 | 名称/节点、复制/下载/复制失败、完整凭据一次展示、隐藏/离开不可回显、撤销确认 | S16–17；AI 配置 | `Connections.tsx` | 未测 |
| W32 | 首页 → 发现详情/历史 | 默认排版结果；更多中标准阅读；依据→原文/追问→原位、空/不可用 | S17–20；发现 | `Insights.tsx`、`InsightReport.tsx`；现为显眼双 Tab | 未测 |
| W33 | 发现 → 生成/自动生成设置 | 方向/范围、进行中、取消/重启、失败/历史结果；设置就近且总页同入口 | S17、S25–26 | `Insights.tsx`、`AutomaticActivitySettings.tsx` | 未测 |
| W34 | 活动 → 列表/详情 | 进行中/需处理/结束、原因/成果；导入确认或重试、结果/依据→返回；运行信息折叠 | S19–20 | `Activity.tsx` | 未测 |
| W35 | 首页/阅读 → 待办列表/详情/编辑 | 原文记为待办，保存/取消留原文；完成/重新打开/筛选/依据 | S26–29 | `Actions.tsx` | 未测 |
| W36 | 日程 → 列表/详情/设置 | 默认生效、缺时间、等设备、写入成功/失败/待核实、依据变化；无逐项审批目标 | S27–29；自动日程稿 | `Actions.tsx`、`ActionCapabilitySettings.tsx`；H02 | 未测（H02已授权待实现） |
| W37 | 录音 → 正文/回听/局部纠正 | 时间跳转、原转写对照、命名说话人仅当前录音；无音频状态、失败/取消 | S29–30 | `Files.tsx` 内联 FileDetail、`ArchivedAudio.tsx` | 未测 |
| W38 | 录音更多 → 导出/关联日程/处理设置 | 原始转写、导出、关联/返回、重处理排队/失败不称完成 | S29–30 | 文件/录音详情、`FileProcessingSettings.tsx` | 未测 |
| W39 | 资料库/全部功能 → 特殊资料 | 截图片段/应用相册及展开原图；应用测得时长；媒体观测；Coding同步状态/原对话 | S38；`fc-segments`/`fc-activity`/`fc-media`/`fc-coding` | `Archive.tsx`、集合视图；四类分别验收 | 未测 |
| W40 | 设置 → 设置总页 | 模型服务、自动记忆/插件、用量、存储备份、运行诊断、偏好/全部功能完整可达 | S25–26、S38 | `WorkspaceNavigation.tsx` SettingsLanding、`features/system.tsx` | 未测 |
| W41 | 模型与服务 → 连接列表/新建/详情/复制/删除 | LLM/OCR/语音、部署只读、协议参数折叠、凭据不回显、改地址显式处理旧密钥、保存/失败/草稿返回 | S20–26 | `ModelProfiles.tsx`、`ModelSettingsEditor.tsx` | 未测 |
| W42 | 模型与服务 → 模块与模型 | 问答/Memory/回顾/导入/文件分析分配，默认跟随，保存/失败/缺连接 | S20–26 | `ModelAssignments.tsx` | 未测 |
| W43 | 资料处理 → 图片/录音/文档/服务详情 | 处理方案、原图授权、OCR/理解区分、转写/分离区分、服务往返保草稿、历史重处理显式 | S21–26 | `PerceptionSettings.tsx`、`FileProcessingSettings.tsx` | 未测 |
| W44 | 资料处理 → 自动处理配置/首次确认/更多 | 全局范围，首次/范围或服务改变确认、取消、暂停/恢复、立即停止；不保存Provider即授权 | S24–26 | `ModelAuthorizationSettings.tsx`；组织层级需改，合同保留 | 未测 |
| W45 | 图片/录音 → 本机准备 | 一键依赖准备/模型下载/启动/可用/失败恢复与安全重试；远程方案收起本地卡，未准备和不可用状态真实 | S25–26；本机识别；本轮追加授权H04 | 基线处理器安装/运行入口仍需补齐完整链路 | 未测（H04已授权待实现） |
| W46 | 自动记忆与插件 → 开停/方案/插件 | 当前方案、节奏折叠；可信插件核验/安装、准备失败/待核实/重试/明确应用；失败保原方案 | S25–26、S38；`fc-plugin-recovery` | `MemorySettings.tsx`、`PluginCenter.tsx`、`MemoryRecipeSelection.tsx` | 未测 |
| W47 | 插件/诊断 → 实际能力/Agent输入 | 仅实际注册能力、已记录模型输入/工具读取；缺记录/不可用，按需深入 | S38；`fc-plugin-capabilities`/`fc-agent-trace` | `AgentInspector.tsx`、`features/agent-view.tsx`、`PluginCenter.tsx` | 未测 |
| W48 | 设置 → 用量/存储备份/运行诊断 | 结果先行；费用/保留/并发/部署/日志展开；导入导出、失败/取消、支持包真实范围 | S25–26、S38 | `Usage.tsx`、`Vault.tsx`、`RuntimeSettings.tsx`、`Diagnostics.tsx`、`features/diagnostics.tsx` | 未测 |
| W49 | 设置 → 外观语言与会话/退出/重登 | System/light/dark，中英，草稿不丢；session/1d/7d/30d沿用合同，退出后私有导航禁用，空令牌/失败 | S38；`web-preferences`/`web-signin` | `session.ts`已有四选项；仅UI不扩持久政策 | 未测 |
| W50 | 设置/帮助 → 全部功能/版本反馈 | 检索/分组/空结果、77保留项到既有入口、返回目录；版本未知/不一致、外链反馈 | S38；`guide`/`web-about` | `FeatureGuide.tsx`、`feature-guide-catalog.ts`；A01去除 | 未测 |

### Mac

来源以 S30–31 的本机工作区、S34–35 的轻量落点、S35–36 的首次使用、S36–37 的连续性/恢复和 S38 收尾为准。下表引用的行号均对应第 1 节最终 HTML 的 hash，首次使用须另看 `mote-first-use.html`；各项与第 8 节原消息可追溯。实现路径相对 `apps/desktop/src/`。PNG 只表示原型已有画面，所有产品状态仍未测。

| ID | 页面/入口与源定位 | 必须覆盖的控件、状态与连续路径 | 基线实现映射与差异 | 源证据/产品验收 |
| --- | --- | --- | --- | --- |
| M01 | Mac shell；CSS 296；macRender 4914、6192 | 208px 侧栏：工作台/内容/来源/问一问；底部同步与活动/设置/中央工作台、设备连接；顶部面包屑＋全局随手记。子页返回、窄窗侧栏折叠。 | index.html 32–49 当前首页/资料库/活动，顶部“添加”和中央；缺侧栏设备状态。保留快捷键、窗口身份与导航。 | 6 PNG；窄窗源码；产品未测 |
| M02 | home；5271、5436 | 提问 textarea、空文本禁用、最近对话→历史/同一对话、最近内容→详情/全部、底部采集/发送真实摘要→设置。 | index.html 54–68 当前 status/onboarding/actions/content/sources/guide；没有首页 Ask 与最近对话。可复用现有 Ask，不能伪造样例。 | home.png；产品未测 |
| M03 | first-use/role onboarding；5265、first-use 累计段 | 初次未连接/已连接未保存；写第一条/选文件/开始采集；本机已存/等清点/等回执/原文不可用；稍后、取消、返回草稿。 | connection + home-onboarding + note draft 已有能力，呈现不同；需保留目标核对/权限边界。 | 源码；产品未测 |
| M04 | 菜单栏/收起/退出；5290–5308 | 打开 Mote/随手记/Central/设置；开始/停止采集；立即发送随真实状态禁用；关闭主窗继续后台；退出是退出。 | 现有 Electron tray/独立窗口能力保留；不要把 prototype 的“收起主窗”模拟页面加入产品。 | 源码；产品未测 |
| M05 | 全局随手记；4924、4985 | 独立编辑入口、正文/选填资料说明；关闭保留草稿、空值禁用、保存中防重复、失败原文保留、保存回原页；发送暂停时仍可本机保存。 | ui.ts 54、575–598 已开独立 quick note 与持久草稿；contracts/note.ts 无 description（H03）。顶部当前“添加”应改直接随手记。 | 源码；产品未测 |
| M06 | 内容列表；4904；收到内容链接 | 标题“内容”、副题本机记录；搜索；全部/本机待发送/中心已接收三个按钮；图标/标题/来源时间/真实状态/箭头；空/无匹配/加载/错误/更多。 | content-library-ui.ts 有本机+Central分页与失败；select 过滤没有搜索。不能把“本机保留”误等同“待发送”，也不能只搜索已加载却称全量搜索（Q02）。保留记忆主题/刷新/更多入口。 | content.png；产品未测 |
| M07 | 内容详情；4906、5420 override | 本机正文/资料说明/来源状态；已接收时到对应 Central 原文；副本释放后解释并打开 Central；离线/不存在、回到来处及滚动位置。 | 当前 #content-detail-dialog/阶段结果/原始正文丰富，源为页面。能力都保留，不从截图删掉阶段/附件/媒体入口。 | 源码；产品未测 |
| M08 | Ask 历史；5364、5437–5441 | “对话历史”列表、右上“新对话”；同一会话标题/轮数/时间；空历史、刷新/分页、离线、登录/未连接。 | index.html 151–156 当前历史与聊天同时双栏；需要历史 landing→选中聊天，保留 pagination 与 scope。 | ask.png（仅历史）；产品未测 |
| M09 | Ask 会话；5364–5390 | 返回历史、问题/回答、继续提问、草稿、来源范围、引用、对话更多；已提交跨端一致，原端草稿不自动跨端。 | ask-controller/ask-conversation/ask-presentation 已有服务；当前 scope、登录、revision、分页不能丢。 | 源码；产品未测 |
| M10 | 引用/原文/保存回答；5385–5396 | Mac→Central 精确原文→原对话/位置；资料变更轻提示、历史原文不可用不重定向；删除原文保留问答；保存原问答与自己的补充分开。 | 引用 URL/安全 Markdown 已有；历史保留依赖后端 H01；保存回答若无 Mac API 不加假按钮。 | 源码；产品未测 |
| M11 | Ask 中断/澄清；5503、5518、5557 | 发送中/结果不明/检查/同请求重试/失败重新编辑/停止待确认/已停止仍可历史看见/无依据澄清；禁止重复新请求。 | 现有 Ask controller run/id/revision/timeout 等可复用。不得 UI 改业务执行策略。 | 源码；产品未测 |
| M12 | 来源列表；4880 | 标题、副题、添加来源；已有来源一行；屏幕与应用组；云来源→Central。空列表、清点中/暂停/失败均真实。 | 当前 sources 页是管理表单+选择控件，需逐行与导航；Coding、日历、筛选等入口不丢。 | sources.png；产品未测 |
| M13 | 添加来源弹窗；4924 add-source | 文件夹、单文件、Coding Agent、本机日历、云端来源 Central；取消，选后进入原入口。 | #add-dialog 当前 folder/file/screen/note/lark 混合通用“添加”。定稿来源弹窗不能吃掉仍有的本机日历/Coding。 | 源码；产品未测 |
| M14 | 文件夹/单文件/编辑来源；4868–4879 | 来源返回；选择/更换本机路径；模式；说明 scope；首次 all/new_only；retention snapshot/archive/metadata；allowRead；目标；高级名称/间隔/扩展/排除/遮盖/删除跟踪；取消/保存/禁用/格式错误。 | SourceOptions 有范围/保留等，未有 authored description H03；UI 不得增加后端不支持同步方式。选原已存在来源保持说明草稿。 | 源码；产品未测 |
| M15 | 选择文件/文件夹；4920、选择 handler | macOS picker；取消不清原配置；同来源不重复添加；更换选择保持填写草稿。 | main native dialog、SourceSelectionController/UI beginSourceSelection 已有。需 fixture cancel + retry。 | 源码；产品未测 |
| M16 | 来源详情；4882、5408、5438 | 暂停/恢复、编辑、资料说明/待同步；已清点/待发/跳过；首次清点中；保留/发送/上次清点；待发详情；跳过原因；暂停不移除。 | 当前 source-controls/summary、SourceStatus 有真实 facts；资料说明 H03；Mac removal 不新增。 | 源码；产品未测 |
| M17 | 来源/采集资料说明弹窗；4924 | 单来源已有/后续或单条；保存待同步；采集 duration/screenshot/structured 各来源可选说明应用到草稿；取消不保存。 | Mac note/source/capture metadata transport 缺口 H03，不能只有 toast。 | 源码；产品未测 |
| M18 | Coding；4924 coding/codex-source；最终 Coding 源入口 | 本机 provider 发现/未发现/会话同步；打开真实 source；Central 专页入口。 | 已有 coding-agents/source manager；保留 UI 列表与状态，无新增 provider 自动恢复策略。 | 源码；产品未测 |
| M19 | 本机日历；4924 calendar；收尾日历范围 | 系统权限→已授权日历选择→资料说明→连接同步；过去/未来范围为实际现有实现；取消；选择为空禁用。 | SourceOptions/calendar APIs 已有，说明H03待补；追加授权H02允许现有设备/日历范围内更新、取消、完成，不扩大范围。 | 源码；产品未测 |
| M20 | 屏幕记录；4850–4867 | 已暂停/运行状态与开始/暂停；默认范围折叠；应用搜索/全部/单独/需留意；app列表+规则；三个独立通道；默认继承；不支持结构化真实提示；dirty save/reset。 | 当前 screen/privacy 分离，app-capture-ui 有通道与真实能力；不能把默认样例 Chrome/微信“已连接/可用”固定化。 | 源码；产品未测 |
| M21 | 开始复核＋系统权限；4919、4924 | 保存规则后复核；dirty 时先保存/还原；确认后真实权限检查；拒绝/取消/设置回来仍需明确开始；权限随通道需求。 | 现有 capture-confirm-dialog、permissions page 和 request/inspect API；保留原未保存保护。 | 源码；产品未测 |
| M22 | 隐私与过滤；4924 privacy | 应用规则入口、固定遮挡、确切文字过滤、锁屏/休眠；新增仅后续；返回应用范围。 | 当前 privacy 页完整配置、masks/edit/native editor 等不能被 prototype 摘要删掉。 | 源码；产品未测 |
| M23 | 同步与活动 pending；4892、5410、5439 | 待发送/接收历史 tabs；真实发送模式/暂停/等待回执；本机 rows；PauseAll/Resume、SendNow；队列空/paused source/重复点击。 | 当前 work/activity/upload/sync-history 分散。可整合呈现，不改变 gate/policy；sync.png 的“按设置发送”只是样例，不能硬编码。 | sync.png（pending 默认）；产品未测 |
| M24 | 接收历史/同步回执；4892、4898 | 历史列表/筛选/回执详情：已接收、未确认、时长大小、具体记录；重试同记录；未知不说未收到；回执≠解析完成；返回。 | sync-history-ui 有真实 time/source/outcome filters、pagination、receipt detail，必须保留。累计 ctMacSync 演示 singleton 不构成删此能力授权（Q02）。 | 源码；产品未测 |
| M25 | 发送设置；4903 | batch/interval/realtime/manual；按模式字段；save/cancel；保存保持 pause；立即发送不改变策略。 | #sync/SyncPolicy 已有；只重排控件、真实文本。 | 源码；产品未测 |
| M26 | 设置 landing；4912、6190 | 屏幕记录/发送/隐私/系统权限/连接与存储；Central 模型服务自动处理；此Mac偏好维护。 | index.html 133–150 当前 inline 外观语言+tile/统计/高级；移至子页仍保留全部原入口。 | settings.png；产品未测 |
| M27 | 连接与存储；5406、5697；首次连接系列 | 连接实际目标、待发量、已确认释放、原件保留；待发送/Central；连接目标预览确认，取消；备份恢复、存储位置。 | 当前 connection 单页 + storage 藏 capture；拆呈现可复用 API，不改 binding/sync semantics。 | 源码；产品未测 |
| M28 | 备份恢复 landing；5668 | Mac 待传数量、导出队列 JSON/恢复；详情准确包含范围；元数据 JSON另入口；storage/Central 导出。 | exportQueue/importQueue/exportJSON存在；需保留 profile/真实选择路径，不将 JSON当设置或AndroidZIP。 | 源码；产品未测 |
| M29 | 恢复 picker/working/result；5670、5700 | 选择JSON/取消；说明目标与当前发送；暂停入口；工作进度；invalid/partial/retry same/imported/local/queue；Mac不先切manual。 | importQueue API仅 {canceled,imported} 或 reject，部分结果和同文件retry H07；不得声称失败时零导入。 | 源码；产品未测 |
| M30 | 导出 picker/working/result；5678、5701 | 保存位置/取消；working；success/失败重试；不清队列；元数据非完整附件备份。 | main.ts 601 exportQueue 与真实结果路径；失败不能跳success。 | 源码；产品未测 |
| M31 | 存储位置及迁移确认；5679、5702 | 原/新目录、实际path/容量；复制验证；cancel/working/moved/space error/旧副本待清理/切换待恢复/磁盘离线/重启核对；Central和来源原件不迁。 | 现有 queue-storage/storage flags/API；需原有状态和重启行为，不借 UI 改策略。 | 源码；产品未测 |
| M32 | 此 Mac 设置；5813 | 外观语言、采集高级、Chrome、帮助诊断、关于版本；返回原设置。 | 当前偏好/采集/developer/about 分散；仅增加导航呈现，不新增一级端。 | 源码；产品未测 |
| M33 | 外观语言；5821 | system/light/dark，system/zh/en；显式 apply；保存/取消/失败保留草稿；runtime profile/path/credential信息只读。 | 现有 preferences立即应用语义需核对是否支持显式 draft/save；UI可按现有 config保存。翻译共享 parent协调。 | 源码；产品未测 |
| M34 | 采集高级；5823 | sample/idle/login/battery/lowpower；质量/边长/dedupe；队列MiB/数量；reset/save范围校验、失败保留、保持running；命名profile不注册登录项。 | 当前 capture页已全部有；数值边界必须用实际 config contract，不能随演示增加范围。 | 源码；产品未测 |
| M35 | 图片压缩预览；5824 | quality/maxside→更新真实比较→apply draft；未生成禁用；失败/取消；回到原设置仍需save；不改已有图片。 | compression-preview API/UI已存在；保留实际图像来源权限，fixture用生成图。 | 源码；产品未测 |
| M36 | Chrome 页面采集；5825、5845–5850 | prepare native bridge→browser install/grant→recheck真实权限；origins保存；实验规则草稿/load确认/save；取消/拒绝/缺权限/断桥不可成功。 | setupChromeCapture只返回directory/id/manifest，当前采集bridge状态不能证明所列origin授权；独立check接口缺口 H09。已有准备和编辑能力保留。 | 源码；产品未测 |
| M37 | 帮助与诊断；5822、5837–5839 | enable/interval、save、refresh数值、1h/24h/7d logs/export diagnostics/support；pick位置/cancel/error/retry；不自动发给任何人。 | 当前 developer/support已有，不删性能数值/阶段日志入口；真实export结果。 | 源码；产品未测 |
| M38 | 关于/Dev/Prod更新；5814、5831–5835 | 实际build/profile/version；Dev手动artifact；Prod channel/check/download/verify/reveal/install；未保存输入guard；cancel/error/rollback/新启动确认；feedback external。 | updater/ui已有完整真实状态；样例版本0.1.0和fake success不能抄。本任务不执行安装/部署。 | 源码；产品未测 |
| M39 | 全部功能/低频内容 | 收尾 T38“全部功能”；Central功能目录包括活动/媒体/Coding/Memory等。 | 当前 home features、content memories、work/upload/statistics 等必须可发现；源六图省略不代表授权删去。放到既有设置/低频页需协调明确归属（Q02）。 | 源码；产品未测 |

### Android

来源以 S31 的原生页能力、S33–34 选中的轻首页、S35–36 的独立首次使用、S36–37 连续性/恢复、S38 收尾为准。`final` 是最终 HTML，`first` 是首次使用 HTML。下表 P 编号只用于本轮验收，不能与第 7 节历史 Android A 编号混用。实现路径相对 `apps/android/app/src/main/java/`；类名须按实际包定位，未指定行号不代表已完成界面核验。

| ID | 页面/入口 | 必须覆盖的控件、状态与连续路径 | 源/定位 | 基线实现映射与差异 | 源证据/产品验收 |
| --- | --- | --- | --- | --- | --- |
| P01 | 日常首页 | Mote + 右上菜单；“想问什么？”；最近对话；底部仅“记录 / 继续草稿”和“问一问…”；记录保留本机回执；只有可处理采集错误显现；离线不丢草稿；已有发现可展示，不制造发现。 | final 5159–5249、ct 覆盖 5364–5434；轻首页接受 turn `01a18367…` | `MainActivity.buildToday` 常驻问答按钮/状态/首次使用/本机笔记/发现；无最近对话；四 Tab + 中间全局记录。应换布局，recent 使用已有 conversations 接口。 | 首页原型PNG；产品未测 |
| P02 | 菜单“我的 Mote” | 回看：资料与记忆、发现历史、日程与待办；这台手机：采集与同步、设置；Central；采集开关与发送开关独立。返回首页且草稿不丢。 | final `liteManage` 5174 | `MainActivity` / `PrimaryNavigation` / `NativeUi.MotePrimaryNavigation` 分散入口；需所有次级入口保持可达，不能简单删除 Tab 丢页面。 | 源码；产品未测 |
| P03 | 首次启动/首条记录 | 欢迎→先记下一件事；文字/照片/语音；本机先保存并可读原文；连接可后做，采集可后开，模型非前置条件。正常用户不重复承接卡。 | first `onPhoneHome` 5350；turn `01a1838f…` | `firstUseState` 有真实首次使用判定，现卡文案/层级不同；必须保留该行为，final 缺本页合并。 | 源码；产品未测 |
| P04 | 初次连接/连接管理 | QR / 邀请文件 / 粘贴；预览 Central、设备名、owner 权限、本机旧记录绑定；明确连接；取消/格式错/失效/连接失败保留输入；返回；连接后采集/发送仍独立。 | first `onConnection` 5385；final settings/connection routes | `ConnectionActivity` / `ConnectionScanActivity` 既有流程；`MainActivity.buildConnection` 仍显长手工参数。UI 入口/分层待改，不能改变旧目标绑定规则。 | 源码；产品未测 |
| P05 | Central 安装帮助 | 复制安装提示/文档；“现在先记下来”；离开/返回保留本机内容。UI 不实际安装 Central。 | first `onHelp` 5390 | 现帮助路径需逐入口核对，属于首次使用缺图项。 | 源码；产品未测 |
| P06 | 随手记编辑器 | 顶栏返回/标题/保存；文字与图片、语音、文件；引用原文与自己补充分开；可选说明；空内容/录音中不能保存；附件移除/播放；picker 取消；权限拒绝；离开停止录音留草稿；外部分享遇已有草稿继续/替换确认；保存回原入口。 | final `pEditor` 5022、light header 5190、actions 5081–5149 | `RecordEditorActivity` 已有耐久草稿/分享/附件/录音/引用；保存仍底部、2×2附件按钮；独立说明无 `RecordDraftStore` 契约，H03。 | 源码；产品未测（对应合同变更已授权） |
| P07 | 文件一次导入 | picker→已选项；可选说明只作用当前文件；一次导入/明确持续同步；模式、类型、大小限制等高级展开；取消保留此前草稿；校验错不提交。 | final `pFileForm` 5031 / file actions | `FileTaskActivity` 已有说明、durable draft、目标与 context ACK；布局/高级参数/入口需对齐。 | 源码；产品未测 |
| P08 | 文件夹来源 | picker→已选目录；说明作用整个来源当前与后续内容；支持/音频/自定义过滤、all/new initial；snapshot/archive/reference；扫描间隔15–1440、上限1–512、扩展名/排除/allowRead；返回/取消/错误。 | final `pFileForm` 5031 | `FileTaskActivity` / `SourcesActivity` 既有契约；不可省掉真实处理同意或范围语义。 | 源码；产品未测 |
| P09 | 来源列表/添加 | 本机来源列表；添加文件/文件夹/屏幕/云端；final 补本机日历；采集、通知/设备信息、同步；其他来源到 Central；空列表；返回。 | final `pSources` 5037、6188 | `MainActivity.buildSources` 扁平按钮+`SourcesActivity`列表，与最终单层列表入口不同。 | 源码；产品未测 |
| P10 | 来源详情/暂停/移除 | 当前状态/待发送/说明；待发本机条目、Central 已归档条目区分；编辑；暂停/恢复；删除连接前警示未发暂存与原件/中央保留边界；取消不删；移除后为空/返回来源。 | final `pSourceDetail` 5038 / source actions | 现 `SourcesActivity` 编辑弹窗 neutral 直接删除，需明确确认；暂停保存现有待发；不改 LocalSourceStore 既有筛选变化导致暂存清理策略。 | 源码；产品未测 |
| P11 | 资料与记忆 | 我的资料/我的记忆；本机/Central 区分；原文预览；无本机副本可去 Central；Central 离线/无资料/空记忆真实显示；不假定本机有副本。 | final base library、ct library overrides | `CentralLibraryViews` / 本机记录列表等分散；需入口/阅读边界对齐，不能伪造逐原件已接收，H06仅约束新增接收/统计政策。 | 源码；产品未测/H06 |
| P12 | 本机原文阅读 | 原文/引用/图片音频文件；说明独立；来源与存储信息渐进；本机可用不等于 Central ACK；来源/资料到同一详情且返回原位。 | final `pItem` 5045、ct reader | `CaptureRecordsActivity` / `FileContentActivity` / `LibrarySourceReaderActivity` 等现页，需要原文身份和 back 复用检查。 | 源码；产品未测 |
| P13 | 屏幕/应用采集 | 应用时长、截图、结构化三项默认范围；按应用搜索/继承/自定义/全关；结构规则支持提示；保存→预览→明确开始；暂停；拒绝权限/恢复权限仍不自动启动；OCR 与设备事件入口；来源说明弹窗。 | final `pCapture` 5052、`pCaptureStart` 5121、light override | `MainActivity.PRIVACY/CAPTURE` 既有独立状态、系统授权；布局需整理；采集 source description 契约未找到，H03。 | 源码；产品未测（对应合同变更已授权） |
| P14 | 按应用详情 | 默认继承/自定义；时长/截图/结构三项；支持与不支持结构化不同；保存/取消/返回保留范围；未知应用不推定支持。 | final phone app route / capture actions | 现 CaptureRules / per-app UI；不得改真实采集能力。 | 源码；产品未测 |
| P15 | 同步与上传 | 当前/上传历史；发送暂停与采集独立；立即发送待真实回执；数量有范围；日志 request 不冒充每条原件 ACK；离线/失败/待发/重复点击/返回。 | final `pSync` 5056 / log route | `SyncQueueActivity` / `UploadHistory` 有真实 ledger；旧 Android 数量/状态 hold 仍存在，H06。 | 源码；产品未测/H06 |
| P16 | 同步恢复 | 核对两端已有保留记录；准备重放前确认；取消/停止；缺原件、被删、冲突明确排除；真实执行状态。 | final `pRecovery` 5060 | `SyncRecoveryActivity` 已有机制；不通过 UI 编造重新接收成功。 | 源码；产品未测 |
| P17 | 问一问/会话 | 顶栏返回/历史/新建/更多；消息区与底部输入；scope chips strict/anchor/none；scope 改变/切换已有会话遇未发草稿确认；离线/未连接/模型不可用分别处理并留草稿；返回菜单不丢输入。 更多→本轮模型/检索/费用未估价/已读依据；整段对话删除有确认/取消/失败保留（S38，最终6173）。 | final ct functions 5364–5434；first ask readiness | `CentralScreens.ask` 现所有参数、按钮与历史一起纵排；底部输入/历史次页/More 需重组；已有接口可用。 | 源码；产品未测 |
| P18 | 历史/继续对话 | 已提交问题和回答跨端读取；选中原 conversation ID；新会话；空/加载/错误；离线仅已加载快照；源修改/删除轻提示，历史问答必须完整可见并可继续。 | final ctHistory 5364–5365；turn `01a183b0…` | `CentralConversationPresentation.read` evidenceDeleted 返回 result=null；后端也删除答案。H01。不能仅改文案当成功。 | 源码；产品未测（对应合同变更已授权） |
| P19 | 引用与保存问答 | 点击 citation→对应原文；返回原对话与滚动位置；历史/已删原文不可用不能重定向成新原文；保存问答→引用+自己的补充+独立说明；本机先保存。 | final ct evidence/reader + editor origin | 既有引用身份/记录编辑功能需 UI 对齐；说明同 H03。 | 源码；产品未测（对应合同变更已授权） |
| P20 | 提问执行异常 | 等受理/流式/停止待确认；同一请求重试；编辑后重新发送；证据不足；取消/重复操作；失败保留问题与附件；不造成功。 | final recovery `ra*` 5503–5580 | 已有 run/retry/stop 状态，需布局与文案核对；执行策略不改。 | 源码；产品未测 |
| P21 | 提问图片与单次模型 | More 下选择模型；最多既有 API 允许的图片数；选择/移除/上传进度/上传失败/重试；保留文本与附件；发送中禁重复。 | final `fi*` 6159–6177 | `CentralScreens` 已有模型和图片参数，现常驻参数需收起；原型演示图片不是真实数据。 | 源码；产品未测 |
| P22 | 发现历史/详情 | 从菜单进入；空/已有结果；默认一份排版内容，更多里切格式；返回；引用转原文；不新增发现生成机制。 | final lite-insights / lite-insight 5174+；turn `01a180e5…` | `HomeDiscoveryView` / Central native discoveries 已有；需保留可达，首页常驻大块移除。 | 源码；产品未测 |
| P23 | 日程与待办 | 从菜单到现有 Central 页面；导航/返回/空/错误；创建及已追加授权的更新/取消/完成默认生效，仍按现有设备/日历范围和真实回执呈现。 | final lite-manage / Central calendar；本轮追加授权H02 | `CalendarActionsActivity` / central route；H02已授权，须实现及验证完整执行链路。 | 源码；产品未测（H02已授权） |
| P24 | 设置与“这台手机” | 采集/权限/同步/连接/本机存储/备份等保留；外观语言、关于更新、权限后台、图像质量、本机日历、本机统计、日志保留、诊断分组。 | final `pSettings` 5065 + `device-options` 5750 | `MainActivity.buildSettings` 过长扁平清单/参数；现高级能力必须保持次级可达。 | 源码；产品未测 |
| P25 | 外观与语言 | system/light/dark；语言切换；已有输入/附件/授权保留；返回。原型只演示中文/英文，不能删除产品既有其他语言。 | final `fp-appearance` 5753 | `MoteI18n` 已有8语言，`NativePresentationStyles`/`NativeAppShell` 保持组件和草稿；现对话框与整页不同。 | 源码；产品未测 |
| P26 | 关于/更新/反馈 | build/profile/version 真实；PROD 检查/下载/系统安装确认/失败/取消/删除下载包；DEV 手动 Actions；仓库/channel 高级；反馈明确外部浏览器，不自动发送。 | final `fp-about`/`fp-update` 5751–5752 | `AppUpdatesActivity` / ABOUT/DEVELOPER 已有；不从示例0.1.0取产品版本。 | 源码；产品未测 |
| P27 | 权限/后台运行 | accessibility、通知使用权与通知提醒分开、usage、projection会话、电池/自启动/受限设置、HyperOS帮助；返回后核对；授权不自动开始采集。 | final `fp-permissions` 5760 | 现 `MainActivity.PERMISSIONS` / 平台 capability 有；需布局/入口改，不能假定已授予。 | 源码；产品未测 |
| P28 | 图像质量/采集去重 | JPEG40–95；off/exact/near；保存；预览；对比诊断默认关、20条/32MiB/24h边界；关后保存清理；批量去重入口；无权限/未保存状态。 | final `fp-images` 5756 | `MainActivity.PROCESSING` 已有；集中 form 与详情需对齐。 | 源码；产品未测 |
| P29 | 压缩预览 | 质量/最长边；真实尺寸/bytes；刷新；原图/结果放大比较；无图/加载/失败；返回保留配置。 | final `fp-preview` 5757、5797 | `CompressionPreviewActivity` 已有生成/比较；原型 fixture 不复制为真实指标。 | 源码；产品未测 |
| P30 | 去重诊断/批量去重 | 诊断空/对比/清空；批量扫描/结果/待决定区；候选和保留图对比；隔离/恢复/删/永久删确认；只删本机副本；取消/失败不误报。 | final `fp-dedupe-log`5758、`fp-bulk`5759、`fpCompare`5764 | `ImageDedupeDiagnosticsActivity` / `BulkDedupeActivity` 已有；执行边界保留。 | 源码；产品未测 |
| P31 | 本机日历来源 | 读日历权限→真实日历 picker；前0–365/后1–365天；首次all/new；可选说明；保存后等待本机扫描，不能立即报 Central 接收。 | final `fp-calendar` 5761 | `SourcesActivity` 支持日历、`LocalSource` description/`SourceContextSync` 对所有kind有效；缺说明控件，可纯UI接现有契约。 | 源码；产品未测 |
| P32 | 本机统计 | 当前记录/待发送/图片bytes/其他bytes，与累计保存/隐私拦截独立；未知不补；无伪造按天计数。 | final `fp-statistics` 5762 | `StorageStatisticsActivity` / `ActivityStatsActivity` 已有；显示范围需明确；H06适用。 | 源码；产品未测/H06 |
| P33 | 上传历史时长/日志 | 7/30/90/365天；只清历史不删原件/草稿/待发；日志all/failed、请求状态/bytes/耗时；不当原件 ACK。 | final `fp-history`5763、`fp-logs`5755 | `UploadHistorySettingsActivity` / `LogViewerActivity` 已有；选择与真实存储绑定。 | 源码；产品未测 |
| P34 | 诊断与支持 | 数值/事件诊断开关；最多1440；整机电量声明；1/24/168h；日志；导出不含敏感原文/令牌/图片；取消/失败。 | final `fp-diagnostics`5754 | `MainActivity.DIAGNOSTICS` 有既有本地导出；不能后台发反馈。 | 源码；产品未测 |
| P35 | 备份 | 记录/配置tab；Android ZIP只本机记录，不含Central、文件来源原件、草稿/模型；元数据导出；Central导出独立入口。 | final `mtBackup`5668 | `BackupActivity` 已有相应功能；现平铺说明/按钮，需分组。 | 源码；产品未测 |
| P36 | ZIP恢复 | 选ZIP→错误Central/非法包→预览条数/当前匹配目标→明确恢复；取消；进行中；部分成功保留已完成，重试不重复；完成只是本机，手动同步。 | final `mtRestore`5670 | `BackupActivity` 已有校验/partial/resume；需展示逐阶段真实结果。 | 源码；产品未测 |
| P37 | 导出/配置导入导出 | 导出中/失败清不完整文件/成功；记录/元数据/配置分开；凭据选项警示；配置import当前新值比较，保留资料/设备/系统权限；取消/错包保留旧配置。 | final mt export/config 5675–5689 | `BackupActivity` 已有；不把导出动作变成云发送。 | 源码；产品未测 |
| P38 | 本机位置迁移 | 当前真实路径在详情；内部/外部位置；迁移确认→复制核验；失败保留原位置；存储不可用保留选择并可刷新；处理中不提供伪取消；projection会话可能需重授权。 | final `mtLocation`5679、`mtLocationConfirm`5702 | `StorageActivity` 已有复制核验/回滚；长路径/说明当前常驻，可渐进。 | 源码；产品未测 |
| P39 | Central入口/已有原生消费者 | 来源、飞书、导入、文件、后台工作、插件、模型、用量、存储、诊断等已有页面继续可达；逐一核对返回/错误/权限/草稿，不能删Tab后遗失入口 | S00能力审计、S38“不遗漏”；只保留已有消费者，不推定每个Central能力都有Android原生版 | `CentralContent.kt` 与 `CentralScreens.kt`；沿真实已注册路径核对 | 源码；产品未测 |

## 4. 基线差异与实现分界

本节是 `5846a09b` 的静态核对，不替代各行实际 UI 比对。

| 范围 | 已有实现/明显差异 | 可以独立推进的 UI | 不可通过假显示补齐 |
| --- | --- | --- | --- |
| Android 导航 | `NativeAppShell.kt`/`PrimaryNavigation.kt`仍按四主目的地；新稿为单首页两个动作 | 轻首页、次级菜单、入口与返回、原生组件/文案/间距 | 新主动推送、自动精选、把不存在的资料统计当成果 |
| Mac 落点 | `index.html`/`ui.ts`仍有采集/发送管理块；全工作区存在 | 首页层次、紧凑正常状态、侧栏/完整工作区保留 | 新远控、新Mac来源移除、捏造本机说明已传递 |
| Web 导入 | `Imports.tsx`含服务器目录方式，`feature-guide-catalog.ts`保留其目录项 | 移除服务器目录 UI 与目录入口，保文件/文件夹/ZIP | 擅自扩展或删除后端API/权限/数据行为 |
| Web 发现 | `InsightReport.tsx`显眼「报告/文字」两按钮，默认已为report | 收更多并改为排版结果/标准阅读，详情和依据布局 | 改生成/存储格式、增加摘要生成 |
| Web 设置 | 服务、授权、处理组件存在；默认暴露层级需按最终目标整合 | 入口、配置归位、渐进披露，保实际范围/暂停语义 | 简化为保存Provider即授权、自动恢复或扩大数据范围 |
| Web 会话 | `session.ts`已有session/1d/7d/30d，并受serverExpiresAt约束 | 展示现有选择、退出/重登/错误与返回 | 延长服务端授权、跨来源复用凭据、改变自动恢复策略 |
| 历史 | 普通更新已标stale且保留；删除等分支仍替换回答并清引用 | 已保留历史的轻提示/返回，与真实可读原文区分 | 把后端已抹除内容“显示回来”，或撤掉权限校验；H01 |
| 资料说明 | Web导入/来源、Android文件任务及本机日历已有说明合同；Mac NoteDraft仅text/mood等，SourceOptions无独立说明 | 复用已有字段的入口/作用域提示 | 新字段只留前端却声称会用于解析；H03 |
| 日程 | `managed-calendar.ts`自动路径只选calendar.create；`actions.ts`拒绝其他managed种类且要求变化新确认 | 真实状态、布局/帮助归位；按追加授权H02补齐既有范围的更新/取消/完成 | 只删确认而未实现执行链路却显示生效，或扩大设备/日历范围 |
| Mac恢复 | `main.ts`导入IPC成功返回imported；`ui.ts`主要是统一成功/异常反馈 | 真实取消/成功/错误文案、忙碌状态及回原位置 | 没有回执却显示逐阶段/部分成功数或新增恢复策略；H07 |

## 5. 已授权合同变更与仍需核实的边界

已确认的 UI 原则不重复请求批准。H01–H04 保留原问题 ID 便于追溯，现已获本轮所有者明确授权，需实现后验证，不能用纯 UI 假显示代替。H06–H09 与 Q01/Q02 中未被授权扩展的边界仍单独核实。实现授权不等于在用户现有部署、服务或设备上执行安装、写日历或调用付费模型；测试仍使用本轮可控资源，不部署/发行。

| ID | 旧/当前场景 | 源目标与未定处 | 可供所有者决定的范围；当前处置 |
| --- | --- | --- | --- |
| H01 历史删除边界：已授权 | 普通修改已保留；明确capture删除、保留到期、source tombstone、Material forget/retirement、撤权仍可能抹除/阻断历史；`evidence-store.ts`删除分支替换answer并清citations/trace | 普通资料修改/删除后保留已提交问答及引用身份；不可用原文诚实提示。隐私擦除、忘记、撤权继续原清除/限制合同 | 实现普通删除与隐私擦除的分流、服务端保留与各端展示，验证后再报通过；已抹除文本无法恢复。此授权不扩大原文访问、模型上下文或到期保留范围；若需要改变这些未选政策另行报告 |
| H02 非create日程：已授权 | 基线scoped自动执行仅calendar.create；update/cancel/complete现需确认及关联版本/设备回执 | 更新、取消、完成纳入既有授权范围内自动执行；不扩展设备或日历范围 | 实现并核对目标/证据版本、幂等、真实设备回执及条件变化处理，保留现有权限和宿主保护；不再逐项确认这些已授权种类，不伪造生效 |
| H03 说明传递：已授权 | 三端笔记独立description缺失；Mac来源/采集、Android采集缺持久context通路；Android文件及本机日历已有LocalSource context | 补齐独立说明的字段、存储、传输与解析上下文；保持单条/来源作用域，不混正文或本人补充 | 优先复用已有source context，补齐当前统一格式的字段和消费者，不新增旧读者/双写/迁移；验证保存、恢复、同步、覆盖/清除及解析可见，历史不自动付费重跑。已有字段只缺控件的路径直接做UI |
| H04 本机识别准备：已授权 | 已有模型包/处理服务能力，但完整依赖准备/下载/启动/恢复链路尚有缺口 | 本轮完成一键OCR/ASR依赖准备、模型下载、启动及失败恢复；不能只封装当前已有能力后停留于缺依赖 | 实现完整受管理链路，分别验证安装、下载、启动、可用、失败和可安全重试；不得以文件下载完成代替服务可用。用本轮可控测试资源验证，不操作用户现有部署 |
| Q01 收尾稿能力核实（非批准项） | S38是最后原型，作者仍标候选；目录里有低频既有能力，不代表每端同等原生支持 | 当前任务允许这些既有能力的UI归位；对话更多、手动Memory和维护不应引出新策略 | 逐项映射真实消费者。已有可用功能直接做UI，不再批准整份原型；仅确实新增的持久化/权限/自动化选择单列窄范围缺口 |
| H06 Android数量/接收 | 请求HTTP结果、本机存量/累计量、原件接收/正文可读不同；源明确不凭日志给逐记录ACK | 页面的数字/状态应忠于实际数据；原型12/3等是fixture | UI名称、展示层次可改；新增逐条接收账本或计数政策须单独决定。只在有现存回执时显示已收，不补虚构批次 |
| H07 Mac恢复失败 | 导入实际可能已发生部分工作；目前IPC成功仅返回imported，异常通过现有错误处理 | 源包含校验/部分导入/未知/重试，不等于授权新恢复事务或进度协议 | 可改善真实已有反馈；若需新的部分结果回执、持久checkpoint、恢复策略或回滚语义，单独决定并做合同验证 |
| H08 Web恢复/凭据 | 现有会话期限已支持；Provider/source暂停及授权受现有合同约束 | 新稿只允许界面归位，服务变更要重核范围，暂停不能被保存/重授权悄悄解除 | 旧hold的纯UI部分可做；自动恢复/故障切换/凭据重用/后端会话政策不因本轮授权解除 |
| H09 Mac网页权限核验 | `setupChromeCapture`只提供bridge准备和扩展目录，bridge ready不证明每个origin已授权 | 收尾稿Chrome页含权限重新检查；不能把准备完成画成网页权限已获准 | 现有准备、范围编辑和“待核实”UI可做；若无真实浏览器授权查询合同，单列是否新增该检查能力，不编造检查结果 |
| Q02 Mac内容搜索/筛选核实（非批准项） | 既有列表分页与本机保留、Central事实不等于源演示“本机待发送”；未核实全量搜索合同 | 源要求内容搜索与范围按钮，但累计演示不得删掉现有回执筛选/分页/详情 | 先映射真实查询与状态；只搜索已加载子集必须诚实命名。只有确需新增全量检索或统计语义时提窄范围功能选择；原有能力入口保留 |

## 6. 验收矩阵及证据边界

每个 W/M/P 行的完成证据至少包括：实现 revision、真实运行的端与入口、屏幕或视口/DPR/主题/语言、源原型文件与状态、产品截图、逐项差异、通过/失败/未测/Hold、测试资源与清理结果。页面的空、加载、错误、权限拒绝、取消、返回和重复操作按该行源状态逐项记录。表里未列的状态若源代码/画面确有，补充到相应行后再验收，不能由实现者单方面删掉。

| 验收层 | 要证明什么 | 当前证据/状态 |
| --- | --- | --- |
| 源完整性 | 39轮主对话、被替代候选、获接受独立原型及收尾补充没有漏 | 主对话已读；首次使用独立稿必须保留；更早分享可见用户正文已复读，仅作次级依据 |
| 功能不丢 | 第7节77项Central目录与33项历史原生能力在各端最终入口得到正确承接 | 静态目录已核；所有产品路径未逐项实测，不据ID数量宣称无遗漏 |
| 视觉 | 真实产品逐屏对照相同源状态，含布局/文字/控件/导航/窄屏/深色 | 0个产品状态完成本轮视觉验收；不能宣称一比一 |
| 交互 | 草稿、返回、重复请求、取消/失败/权限状态使用真实产品入口 | 尚未执行；单测/DOM/原型脚本不替代 |
| 边界 | 四项追加授权实现有界变更；现有权限、回执与未授权政策不被扩展 | H01–H04已授权待实现/验证；H06–H09仅未授权的扩展仍需核实；Q01/Q02为能力核实，普通UI不因此停做 |
| 独立审查 | 审查者按源清单检验实现，而非按代码反推清单 | 来源审查与实施者分离；代码/设计验收尚未完成 |
| 发布 | Draft PR→独立审查→最终head相关检查→合main→核远端commit | 本文不构成PR或合并完成证明；不部署/发版 |

原工具引用中共有156个去重图像路径，2026-10-29读取时104个存在、52个不存在。S38的 `/tmp/mote-final-phone.png`、`mote-final-mac.png`、`mote-final-central.png`、`mote-final-phone-320-dark.png`、`mote-final-memory.png` 均缺失；前代PNG存在不等于最后原型所有状态已看图。

本轮通过受支持CUA隐藏浏览器打开最终 `file://` URL 被明确拒绝：只允许 `http:`/`https:`，未获得网络出口权限，且策略明确禁止间接执行、原始CDP、替代浏览器或其他绕过。拒绝后未继续该动态读取操作；需要可获准的源交付方式后再补全面视觉核对。

在拒绝通知前，实施者已生成、独立审查者随后用 `view_image` 看过10个**源原型默认状态**：Web首页/全部功能（1440×1000，fullPage）与需要你补充列表（1440×1064 PNG）；Android首页（390×844）；Mac首页/内容/来源/对话历史/同步/设置（1440×1000视口，`#mac-app`元素高度可变）。均浅色、DPR1、源hash为上表最终HTML。它们不是产品运行截图，不覆盖空/加载/错误/深色/权限等分支，Mac设置截图中的评审控制条不计产品UI。这些既有截图不构成后续动态渲染的许可。

既有源图已归档至 [来源截图目录](../validation/ui-final-source-2026-10-29/README.md)，[manifest](../validation/ui-final-source-2026-10-29/manifest.json) 保留精确 hash、视口/图片尺寸、UTC、生成者、独立审查者和拒绝原文；只复制原有图像字节，未再次渲染。38个直接引用HTML均可只读访问，其hash及引用轮次也在manifest中，原始私人对话全文未加入仓库。

## 7. 保留能力的逐项对账

下面复用源 `finCatalog` 的77个ID，唯一从78项源审计中移除的是 **Central A01：服务器目录导入**（D10）。Central的A编号与Android历史能力A编号是两套命名，不能混用。目录只是防漏项对账，行数不代表页面数，也不代表功能已实测。最终跳转以 `finOpenEntry`/`fin.entryAliases` 为准，旧 `page` 字段只作定位线索。

| Central ID | 源能力 | 最终源定位（不是最终跳转合同） | 基线实际目标 | 验收组 |
| --- | --- | --- | --- | --- |
| C12 | 随手记下文字 | `notes` | `#/library/notes` | W04；未测 |
| C13 | 上传已有图片或音频附件 | `notes` | `#/library/notes` | W04；未测 |
| C09 | 导入已有文档、文件夹和媒体 | `imports` | `#/library/import` | W19–21；未测 |
| C10 | 查看并处理导入进度 | `imports` | `#/library/import` | W19/W21；未测 |
| C11 | 删除整次导入 | `imports` | `#/library/import` | W21；未测 |
| A02 | 选择导入解析器和图片处理方案 | `imports` | `#/library/import` | W20–21；未测 |
| A03 | 恢复被中断的本地上传 | `imports` | `#/library/import` | W21；未测 |
| C07 | 选择要加入的来源 | `sourceCatalog` | `#/connections/add` | W22；未测 |
| C08 | 管理来源接收与内容关系 | `sources` | `#/connections` | W23；未测 |
| A04 | 保存外部或 NAS 引用 | `sources` | `#/connections?setup=reference` | W27；未测 |
| A05 | 只读归档 Google 日历 | `sources` | `#/connections?setup=google` | W25；未测 |
| A06 | 只读归档 Gmail 邮件 | `sources` | `#/connections?setup=gmail` | W25；未测 |
| A07 | 从远程 MCP 选择资源导入 | `sources` | `#/connections?setup=mcp` | W27；未测 |
| A09 | 连接飞书文档和日历 | `lark` | `#/connections/lark` | W24；未测 |
| A10 | 归档厂商录音和转写 | `recordings` | `#/connections/recordings` | W26/W37–38；未测 |
| A11 | 查看来源版本和原位置 | `archive/sources` | `#/library?view=sources` | W23/W07；未测 |
| C03 | 从今天开始整理资料 | `overview` | `#/today` | W01–02；未测 |
| C04 | 查看设备上报的采集与同步状态 | `devices` | `#/connections/devices` | W28；未测 |
| C05 | 连接或重新授权设备 | `deviceConnections` | `#/connections/pair` | W29；未测 |
| C06 | 检查和撤销已发出的连接权限 | `deviceConnections` | `#/connections/pair` | W29；未测 |
| A08 | 让其他 Chatbot 使用 Mote MCP | `connections` | `#/connections/access` | W30–31；未测 |
| C14 | 浏览已经发布的资料正文 | `archive/materials` | `#/library?view=materials` | W05；未测 |
| C15 | 核对资料正文、来源与处理状态 | `archive/materials` | `#/library?view=materials` | W07；未测 |
| C16 | 说明单份资料关系并提取记忆 | `archive/materials` | `#/library?view=materials` | W08/W17；未测 |
| C17 | 查看原始采集证据 | `archive/records` | `#/library?view=records` | W06–08；未测 |
| C18 | 删除一条原始记录 | `archive/records` | `#/library?view=records` | W08；未测 |
| C20 | 围绕归档资料提问 | `ask` | `#/ask` | W09；未测 |
| C21 | 回看和管理对话历史 | `ask` | `#/ask` | W11–13；未测 |
| C22 | 随问题提交图片 | `ask` | `#/ask` | W10；未测 |
| C23 | 浏览有证据的记忆 | `archive/memories` | `#/library?view=memories` | W14–15；未测 |
| C24 | 纠正、删除或导出一条记忆 | `archive/memories` | `#/library?view=memories` | W16；未测 |
| C25 | 手动提取记忆 | `archive/memories` | `#/library?view=memories` | W17；未测 |
| C26 | 回答需要你澄清的问题 | `ask` | `#/ask` | W18；未测 |
| A16 | 核对记忆的历史和有效时间 | `archive/memories` | `#/library?view=memories` | W16；未测 |
| A17 | 从一条当前记忆继续整理 | `archive/memories` | `#/library?view=memories` | W17；未测 |
| A18 | 调整记忆策略和回顾节奏 | `settings/model` | `#/system/models?category=model` | W46；未测 |
| C27 | 生成并回看有证据的洞察 | `insights` | `#/library/insights` | W32–33；未测 |
| C28 | 查看正在做的工作和结果 | `activity` | `#/activity` | W34；未测 |
| A25 | 检查技术步骤并恢复可重试工作 | `processing` | `#/system/processing` | W34/W48；未测 |
| C29 | 记录和完成普通待办 | `actions` | `#/actions` | W35；未测 |
| C30 | 查看已生效日程和设备写入状态 | `actions` | `#/actions` | W36；未测 |
| C19 | 按内容类型查看资料库 | `archive/materials` | `#/library?view=materials` | W05；未测 |
| A12 | 按截图片段或应用相册回看 | `archive/segments` | `#/library?view=segments` | W39；未测 |
| A13 | 查看测得的应用活动时间 | `archive/activity` | `#/library?view=activity` | W39；未测 |
| A14 | 查看媒体播放观测 | `archive/media` | `#/library?view=media` | W39；未测 |
| A15 | 查看 Coding 会话接收与同步状态 | `archive/coding-status` | `#/library?view=coding-status` | W39；未测 |
| C39 | 导入导出归档并找到完整备份 | `vault` | `#/system/storage` | W48；未测 |
| C40 | 查看保留、容量和内容存储政策 | `vault` | `#/system/storage` | W48；未测 |
| C41 | 核对模型用量和估算费用 | `usage` | `#/system/usage` | W48；未测 |
| A31 | 把已有加密文件转为明文 | `vault` | `#/system/storage` | W48；未测 |
| A32 | 查看运行状态与空间 | `statistics` | `#/system` | W48；未测 |
| A33 | 维护估价并追查用量明细 | `usage` | `#/system/usage` | W48；未测 |
| C31 | 配置或检查模型连接（Provider） | `settings/providers` | `#/system/models?category=providers` | W41；未测 |
| C32 | 检查或分配功能使用的模型 | `settings/model` | `#/system/models?category=model` | W42；未测 |
| C36 | 控制新图片识别与原图授权 | `settings/images` | `#/system/models?category=images` | W43–44；未测 |
| C37 | 查看文件或录音的内容提取和恢复 | `archive/files` | `#/library?view=files` | W37–38；未测 |
| C38 | 配置文件与语音处理 | `settings/file-processing` | `#/system/models?category=file-processing` | W43；未测 |
| A19 | 调整模型性能和协议细节 | `settings/providers` | `#/system/models?category=providers` | W41；未测 |
| A20 | 复制或删除模型预设 | `settings/providers` | `#/system/models?category=providers` | W41；未测 |
| A21 | 补处理或重算历史图片 | `settings/images` | `#/system/models?category=images` | W43；未测 |
| A22 | 配置文件规则、方案和处理服务 | `settings/file-processing` | `#/system/models?category=file-processing` | W43；未测 |
| A23 | 预览文件规则并重新处理已有原件 | `settings/file-processing` | `#/system/models?category=file-processing` | W43；未测 |
| A24 | 纠正转写并确认说话人 | `archive/files` | `#/library?view=files` | W37；未测 |
| A29 | 设置执行并发和查看等待名额 | `settings/model` | `#/system/models?category=model` | W42/W48；未测 |
| A30 | 配置检索和外部连接的部署草稿 | `settings/embedding` | `#/system/models?category=embedding` | W48；未测 |
| C33 | 暂停或立即停止自动记忆 | `extensions` | `#/system/plugins?tab=memory` | W46；未测 |
| C34 | 核对和替换整套记忆方案 | `extensions` | `#/system/plugins?tab=memory` | W46；未测 |
| C35 | 管理可信记忆插件 | `extensions` | `#/system/plugins` | W46；未测 |
| C01 | 登录并管理当前会话 | `about` | `#/preferences` | W49；未测 |
| C02 | 找到常用页面和所属工具 | `overview` | `#/today` | W02/W50；未测 |
| C42 | 找到帮助、版本和维护方式 | `help` | `#/help` | W50；未测 |
| A26 | 查看 Agent 当前能读取的上下文 | `agentView` | `#/agent` | W47；未测 |
| A27 | 查看已记录的实际模型输入和工具读取 | `agentView` | `#/agent` | W47；未测 |
| A28 | 核对实际注册的插件能力 | `extensions` | `#/system/plugins` | W47；未测 |
| A34 | 查阅运行日志并导出支持包 | `developer` | `#/system/diagnostics` | W48；未测 |
| A35 | 设置诊断记录并查看部署生效值 | `developer` | `#/system/diagnostics` | W48；未测 |
| A36 | 切换界面语言 | `about` | `#/preferences` | W49；未测 |

历史原生 33 项是保留能力对账，旧首页位置不继续约束新导航；同一能力可由多个验收组共同承接。

| 历史平台/ID | 已有能力 | 本轮验收组 |
| --- | --- | --- |
| Mac M01 | 菜单栏：打开/记录/Central/设置/采集开停/立即发送/退出 | M04；未测 |
| Mac M02 | 随手记与已有图片/语音附件、草稿 | M05；未测 |
| Mac M03 | 本机+中央内容、原文/原件与处理阶段 | M06–07；未测 |
| Mac M04 | 按日期/Session/应用浏览截图/页面内容 | M06–07/M39；未测 |
| Mac M05 | 文件/目录一次导入或持续同步 | M14–15；未测 |
| Mac M06 | Claude Code/Codex/Kimi本机对话与项目 | M18；未测 |
| Mac M07 | 系统日历只读来源、写入能力声明 | M19；未测 |
| Mac M08 | 来源保存模式、首次范围、过滤、metadata、开停/同步 | M14–17；未测 |
| Mac M09 | 屏幕记录/按应用通道/遮挡/文字审查/页面规则 | M20–22；未测 |
| Mac M10 | Chrome扩展与本机桥接、站点授权 | M36；未测 |
| Mac M11 | 应用测得时间、中央后台工作 | M23/M39；未测 |
| Mac M12 | 发送策略、暂停/恢复、当前任务、历史/回执 | M23–25；未测 |
| Mac M13 | 统一问答、历史分页、scope与引用 | M08–11；未测 |
| Mac M14 | 记忆主题与原文依据 | M06/M39；未测 |
| Mac M15 | 配对/归属/登录与Central窗口 | M03/M27；未测 |
| Mac M16 | 存储位置/保留/压缩预览/图像去重/支持包/日志/更新/语言外观/profile | M28–38；未测 |
| Mac M17 | 关闭窗口后台采集、退出停止 | M04；未测 |
| Android A01 | 统一文字/拍照/图库/录音/文件草稿、系统分享 | P06；未测 |
| Android A02 | 本机与Central稳定身份资料阅读、类型/位置/日期筛选 | P11–12；未测 |
| Android A03 | 文件/来源版本/整理资料读取与原件 | P10–12；未测 |
| Android A04 | 屏幕/页面/通知/应用活动/媒体/设备事件的按通道采集 | P13；未测 |
| Android A05 | 应用继承/覆盖、字段规则/预览、遮挡、确定性文字隐私 | P13–14；未测 |
| Android A06 | 文件/SAF目录/系统日历、范围与保存模式、来源metadata | P07–10/P31；未测 |
| Android A07 | 设备邀请/扫码/导入、节点目标绑定、上传网络与条件 | P04/P15；未测 |
| Android A08 | 采集与同步两行状态、等待/暂停/重试、当前任务 | P02/P15；未测 |
| Android A09 | 上传日期/批次/单条原件/接收回执、历史保留设置 | P15–16/P33；未测 |
| Android A10 | Central原生问答/共享历史/引用/澄清、设备草稿 | P17–21/P39；未测 |
| Android A11 | 记忆主题与原文、发现精选与历史/详情 | P11/P22；未测 |
| Android A12 | 日程建议、授权设备写入与结果核实 | P23；未测 |
| Android A13 | 系统权限、电池优化、自启动与后台运行 | P27；未测 |
| Android A14 | 本机存储、备份恢复/配置迁移、空间/采集统计、压缩与去重 | P28–32/P35–38；未测 |
| Android A15 | 诊断/日志/脱敏支持包、更新、语言/外观、profile | P24–26/P33–34；未测 |
| Android A16 | Central管理原生消费者：来源/飞书/导入/文件/后台工作/插件/模型/用量/存储/诊断等 | P39；未测 |

## 8. 原讨论逐轮索引

以下条目全部来自指定主对话。每轮用户消息决定其**上一轮**原型是否被认可，不能把当轮新生成的建议立即当作获确认。S27的停下随后由S28继续，不能解释为取消当前实施任务。源对话的“HTML-only”边界是当时设计阶段的执行范围，当前用户已明确另行授权产品UI实现和PR合入。

| 序号 | Turn ID / 用户 message ID | 本轮用户取舍（摘要） | 本轮文本提及的原型 |
| --- | --- | --- | --- |
| S00 | `01a17d84-96f6-7570-a2a5-66c2513e84db`<br>`01a17d84-a175-7593-84b5-0a46e3261efa` | 完整功能/用户旅程审计，设计阶段只通过HTML交互 | `mote-ui-review.html` |
| S01 | `01a17d98-df92-74a0-995f-e95ea9a2dd17`<br>`01a17d98-dfa6-72e3-a539-f0b593dc8231` | 逐旅程评审；减少无谓文字；产物可独立使用 | `mote-material-ask.html` |
| S02 | `01a17e18-eb22-77c2-a0fb-a04f39b07d4e`<br>`01a17e18-eb36-7bd1-8e44-f4aa231af77b` | 只用已有正文/缩略图，不为UI引入摘要架构 | `mote-material-ask.html`、`mote-library-content.html` |
| S03 | `01a17e26-7341-7540-9a0d-3903ccc4d6b5`<br>`01a17e26-7351-79a0-96f0-4e6cb059bd15` | 质疑记录与采集的硬分；先审计数据含义 | `mote-library-content.html`、`mote-library-data-audit.html` |
| S04 | `01a17e34-2d22-74f0-9f94-235ca1852ba9`<br>`01a17e34-2d33-7ee0-b176-ed113156b1da` | 要求从用户旅程完善资料页 | `mote-library-data-audit.html`、`mote-library.html` |
| S05 | `01a17e42-3fb6-7532-89e1-30edf64de23f`<br>`01a17e42-3fd4-71c2-82d0-6c8d90a35052` | 否决未经讨论整体重做、侧栏消失 | `mote-library.html`、`mote-library-restored.html` |
| S06 | `01a17e4a-ccb9-74c3-ab1b-7ea7dce4c611`<br>`01a17e4a-ccc9-7690-ab41-e4c9d869e49e` | 认可恢复框架，继续列表内容 | `mote-library-restored.html`、`mote-library-list.html` |
| S07 | `01a17e55-28c9-7b82-9b78-0dcefa1d2085`<br>`01a17e55-28db-7332-bcff-52aff105fe4c` | 认可预览方向；原文预览为默认 | `mote-library-list.html`、`mote-library-complete.html` |
| S08 | `01a17e68-57a3-7572-b75a-b03c107c5e7b`<br>`01a17e68-57b5-7320-8f94-5904dcf8b498` | 要求全局随手记而非资料页专属 | `mote-library-complete.html`、`mote-note-global.html` |
| S09 | `01a17e91-9449-73b3-a1ad-5c8ebc553954`<br>`01a17e91-9476-7032-bdcd-3f68cdee551f` | 认可记笔记方向；参考早期原则，下一旅程 | `mote-note-global.html`、`mote-workspace-next.html` |
| S10 | `01a17eac-71c7-7852-8b2e-4d51e611e363`<br>`01a17eac-71d9-7cf1-95c2-ce78f5311099` | 资料库与来源进入同一详情，继续细化 | `mote-workspace-next.html`、`mote-detail-library.html`、`mote-detail-source.html` |
| S11 | `01a1804d-54a4-7363-8f99-95fe2df7df91`<br>`01a1804d-54cd-7ad1-a804-2c7536fb0b51` | 实体详情是建议；当前稿大体可，审查交互/ADR | `mote-memory-workspace.html` |
| S12 | `01a1805b-8851-7583-be19-3b682fb7f159`<br>`01a1805b-8860-7ec1-8c55-98f4af57a8fc` | 否决新增独立视图；尊重既有功能与实体 | `mote-memory-workspace.html`、`mote-memory-current.html` |
| S13 | `01a1806a-c977-7cd2-90bf-66babf18bfcc`<br>`01a1806a-c98f-71a3-802a-b724092b2844` | 继续收敛记忆页，不新增能力 | `mote-memory-current.html`、`mote-memory-polished.html` |
| S14 | `01a18075-840e-7960-9085-ab8abec67030`<br>`01a18075-841f-7371-8e34-bf3abd967324` | 接受记忆精修；先核实导入现状 | `mote-memory-polished.html`、`mote-import-workspace.html` |
| S15 | `01a1809e-290e-7213-9ecb-0bd938dc8e01`<br>`01a1809e-2924-7881-9a29-6deba309cd15` | 删除服务器目录导入，其余继续来源 | `mote-import-workspace.html`、`mote-source-workspace.html` |
| S16 | `01a180b2-b4f8-70b1-b121-91839c9b2c97`<br>`01a180b2-b9f8-7443-b09f-adb6905af23a` | 接受来源方向；再评AI接入 | `mote-source-workspace.html`、`mote-ai-access.html` |
| S17 | `01a180c2-751c-74d1-b4d9-a0efde45ca6f`<br>`01a180c2-752e-7d02-af59-620208ab383e` | 接受AI接入；首页与发现 | `mote-ai-access.html`、`mote-home-discoveries.html` |
| S18 | `01a180e2-d6cf-7ef0-a050-26f8cb1c716f`<br>`01a180e2-d6ed-70c2-ae27-6321197373f9` | 发现阅读形式需要收敛 | `mote-home-discoveries.html` |
| S19 | `01a180e5-3590-7921-a2a1-800e5b790198`<br>`01a180e5-35a4-7e22-927a-7c19b183a0b3` | 默认排版结果，切换进更多，不改后端 | `mote-home-discoveries.html`、`mote-discovery-refined.html`、`mote-activity-workspace.html` |
| S20 | `01a18103-f5e3-7893-84b9-e53af9a2cba8`<br>`01a18103-f5f5-7431-b070-570c763fd561` | 接受活动方向；模型设置 | `mote-discovery-refined.html`、`mote-model-settings.html` |
| S21 | `01a1819e-6849-75c0-81f9-b2ed7def8668`<br>`01a1819e-6d39-7470-a9af-49dd3db91df4` | OCR/语音与语言模型统筹服务，先盘现状 | `mote-model-settings.html` |
| S22 | `01a181a8-7fd7-7541-adc1-9ec246ba5e68`<br>`无独立用户消息` | 系统续轮；无独立用户消息，不新增所有者决定 | `mote-settings-services.html` |
| S23 | `01a181b8-bfce-7400-91f2-9c5b5d795bc0`<br>`01a181b8-bfe9-7670-954c-759ddc2d5769` | 要求后台授权合入对应功能而非独立页 | `mote-settings-services.html` |
| S24 | `01a181bb-7d46-7961-a768-bb58ff20a313`<br>`01a181bb-7d57-71d0-a29a-93667c92e8a5` | 移除后台授权单页，资料处理内开关和首次说明 | `mote-settings-services.html`、`mote-settings-automatic.html` |
| S25 | `01a1820c-4ba9-7030-919c-be4f33ef71f1`<br>`01a1820c-4bc2-7431-9fb3-41e8e256948d` | 更完整设置；本机识别一键准备；其他设置不能漏 | `mote-settings-automatic.html`、`mote-settings-complete.html` |
| S26 | `01a18227-ca9e-7091-ba17-7f6a7e6d2c41`<br>`01a18227-caaf-7d50-b08d-87ee723f8fd9` | 接受完整设置，继续待办/日程 | `mote-settings-complete.html`、`mote-actions-workspace.html` |
| S27 | `01a18260-7e10-7eb0-8115-9648f9222e2e`<br>`01a18260-7e20-7bd1-b1e6-be6569224bdc` | 明确日程默认生效不逐项确认；暂停该次执行 | `mote-actions-workspace.html`、`mote-settings-complete.html` |
| S28 | `01a1827e-0ee7-7273-b245-6dad68ff8206`<br>`01a1827e-0efa-7e13-82d4-7ecb9b2451a1` | 继续并纠正改错文件；完整盘点后做设备 | `mote-settings-complete.html`、`mote-device-workspace.html`、`mote-actions-automatic.html` |
| S29 | `01a18288-6ba9-7603-b3e1-0e898f14ead5`<br>`01a18288-6bb9-7880-84e5-82f9eefc8905` | 接受设备；继续录音 | `mote-device-workspace.html`、`mote-recording-workspace.html` |
| S30 | `01a1829b-cf34-7083-8be9-20117ff18759`<br>`01a1829b-cf4b-7db0-8597-670c9daa2ed4` | 接受录音；盘Mac和Android主旅程 | `mote-recording-workspace.html`、`mote-mac-workspace.html` |
| S31 | `01a182cc-ee54-7ad1-b955-92fe25d98e3c`<br>`01a182cc-ee65-71c3-b6ee-2ad246f88798` | 任何同步/保存都可填独立说明，其余Mac通过 | `mote-mac-workspace.html`、`mote-android-workspace.html` |
| S32 | `01a18336-5ac2-7982-a5d4-b202625207f2`<br>`01a18336-5ad3-7a53-a23a-ead1f7c6f319` | 手机记录不应每页重复；提出Tab供探讨 | `mote-android-workspace.html`、`mote-android-navigation.html` |
| S33 | `01a18351-4851-75b0-b4c4-5189f2ff11ae`<br>`01a18351-486a-7c61-9007-74d541a52bfb` | 改为轻输入/输出端；管理次级，日常只记录/提问 | `mote-android-navigation.html`、`mote-android-assistant.html` |
| S34 | `01a18367-9d7e-7881-b5a7-6b8924249ea9`<br>`01a18367-9d8e-7ab2-9a11-7913f5ddc979` | 接受Android轻首页；补首次使用；探讨Mac | `mote-android-assistant.html`、`mote-mac-role-exploration.html` |
| S35 | `01a18379-0906-7d01-a4df-d6c97abdff88`<br>`01a18379-0916-7ed3-9fe6-b9bb0f1e7bcb` | 接受Mac轻落点，保留框架；继续新用户旅程 | `mote-mac-role-exploration.html`、`mote-first-use.html` |
| S36 | `01a1838f-8d0e-7be0-a411-8898a799081c`<br>`01a1838f-8d20-7ac3-a2bd-946f23ad32b5` | 首次使用大体OK；跨端与本机清理/暂停 | `mote-first-use.html`、`mote-continuity-workspace.html` |
| S37 | `01a183b0-234a-73e0-afee-8424cc5b4c22`<br>`01a183b0-2359-7d31-95b9-b0f253900ab4` | 明确修改/删除资料不能隐藏历史问答；继续恢复 | `mote-continuity-workspace.html`、`mote-recovery-workspace.html` |
| S38 | `01a183c8-8cb8-7b51-944c-3a29607e263b`<br>`01a183c8-8cce-7b40-85d3-4a9814098458` | 恢复大体OK；全盘收尾，遗漏入口一并补齐 | `mote-recovery-workspace.html`、`mote-final-workspace.html` |
