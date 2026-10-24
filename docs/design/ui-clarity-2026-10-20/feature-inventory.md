# Mote UI 功能与旅程基线（只读代码盘点）

基线：`utopiafar/mote` main `2c78ca8d52a7d17fae20962cf68d09a717ffc73a`。

本报告于 2026-10-20 从本会话此前已经完成的代码盘点记录恢复。此前阅读了实际源码、根目录 AGENTS.md 和相关产品/架构文档，没有运行产品、模型或设备；本文的代码观察指向上述基线，未对恢复中的新 checkout 重新核对。GitHub parity integration 草稿 PR 170–182 不计入本基线。发现性风险需由独立评估 Agent 在对应真实构建上复核。

## 1. 当前边界和可以复用的资产

- 有三个产品 UI：Central Web（React）、macOS collector（Electron）、Android（原生 View/Activity）。当前仓库没有 iOS App 或浏览器扩展 UI。macOS Swift 文件是采集/更新 helper。
- 当前导航决定是 `docs/adr-ui-presentation-packs.md`（2026-10-15）：**资料库 / 问一问 / 来源 / 活动**；原生资料库叫“内容”；Today/Home、Settings、全部功能为辅助目的地。默认无深链时进入资料库/内容。更早的 action-first 默认首页决定已经被替代。
- Web 当前完整功能目录在 `apps/web/src/feature-guide-catalog.ts`：**4 大区、16 组、78 个单元（42 core、36 advanced）**。这是 authored directory，可作为待核对母表；其 `target/otherTargets/setupTargets` 已承载路由和入口说明。
- Web 页面注册：`apps/web/src/features/entries.ts`；集合注册：`apps/web/src/features/collections.tsx`；导航：`WorkspaceSidebar.tsx`、`WorkspaceNavigation.tsx`、`navigation.ts`、`workspace-route.ts`。实际能力可用性由 FeatureRegistry、`DiscoveryLink.tsx`、`discovery-availability.ts` 和 `/api/features` 共同控制。
- 两套 Web 身份展示必须分开核对：**正常用户名密码登录 `connection.mode === 'web'` 使用 scoped 组件**；旧 owner-token 路径用原组件。尤其 Today 的 `ScopedOverview` 和旧 `Overview` 内容差别很大。
- 共享 dark/light tokens：`packages/shared/design-tokens.json`、`design-tokens.light.json`；生成消费者：`apps/web/src/design-tokens.css`、`apps/desktop/src/design-tokens.css`、`packages/shared/src/ui-theme.generated.ts`、Android `res/values*/design-tokens.xml`。当前风格是暖石墨表面、紫色强调、低容器重量；桌面 32px 控件、移动 48px 控件。
- 主题和布局契约：`packages/shared/src/ui-contracts.ts`、`ui-presentation.ts`；平台消费：`apps/web/src/presentation.tsx`、`apps/desktop/src/presentation.ts`、Android `NativeUiPacks.kt`、`NativeAppShell.kt`。本次优化应复用这些角色和槽位。
- 必须保留的产品约束：端侧采集/授权/本地保存与中央处理分工；原始证据和来源；资料接收、正文发布、索引、Memory 就绪分别显示；三种暂停范围分别生效；编辑草稿、返回上下文、任务离页继续；中英与 Light/Dark/Auto。

## 2. 首屏与导航的实际代码

| 端 | 实际首次着陆 | 用户首先接触到的内容 | 主导航和辅助入口 |
| --- | --- | --- | --- |
| Web 未登录 | `#/library` | “登录后查看资料库”，有汇集手机/电脑/文件、浏览、提问和出处的解释 | 资料库、问一问、来源、活动；侧栏底部今天/全部功能/设置；窄屏更多菜单 |
| Web 用户名密码登录 | `#/library?view=materials` | “资料库”“按来源浏览已发布资料，上传与处理状态单独查看”；左侧分类、来源/设备/日期筛选、内容列表/详情、导入资料 | 主导航同上；随手记在任务页顶栏；资料库工具是下拉菜单，含随手记/导入/洞察等 |
| Mac | `DesktopNavigation.page = 'records'` | “内容”“文件、屏幕和想法，在同一处阅读”；本机与已发送/本机保留/中央已收到范围选择、内容列表、添加 | 内容/问一问/来源/活动；侧栏底部首页/设置；顶栏中央工作台/添加 |
| Android | `MoteNavigation.initialLocalPage() = LIBRARY` | “内容”；本机保留/中央归档；“本机保留的记录，离线也能查看”，类型下拉和本机记录列表 | 内容/问一问/来源/活动；顶栏添加/设置；辅助首页及中央更多目录 |

代码锚点：Web `main.tsx:397–452`、`Archive.tsx:67–78`、`LibraryBrowse.tsx:126–164`；Mac `navigation.ts:9–10`、`index.html:32–67,98–115`；Android `MainActivity.kt:240–252,465–505`。行号对应原基线。

用途说明最充分的既有页面在旧 Web `Overview.tsx`、Mac Home 和 Android Home；它们不是默认着陆页。正常新 Web session 的 Today 走 `ScopedSummary.tsx:ScopedOverview`，也没有旧 Overview 的完整用途说明和输入目录。

## 3. 用户功能 × 端 × 主入口 × 完整旅程

“直接”指该端有实现界面；“中央界面”指 Mac 打开中央 Web、Android 打开 native CentralActivity。P0 为基础闭环，P1 为必须保留的进阶业务/管理能力；两者都进入发现性检查，仅展示优先级不同。这里的唯一主入口是信息归属建议，允许 Home/Add/错误恢复中的上下文快捷入口。

| ID / 优先级 | 用户要完成的事情 | Web / Mac / Android 实际实现 | 唯一主入口归属 | 最小完整旅程和实质完成点 | 实现锚点 |
| --- | --- | --- | --- | --- | --- |
| F01 P0 | 理解 Mote，知道如何放入资料、找回和提问 | 三端有解释，首屏覆盖不一致 | 首次进入的资料库/内容，补充 Home/全部功能 | 从空白新用户状态说明是什么、列出可加入内容、选择一个入口到真正操作页 | Web `main.tsx/Overview.tsx/ScopedSummary.tsx`；Mac `index.html`；Android `MainActivity.buildLibrary/buildToday` |
| F02 P0 | 登录中央、连接设备、恢复连接 | Web 账号；Mac 账号/浏览器批准/设备凭据；Android 账号与连接流程 | 设置 → 账号/连接；来源 → 连接设备为快捷路径 | 登录→看自己资料→退出/失效→重登；设备批准后有正确权限和状态；返回原 Ask/内容 | Web `web-auth.ts/AccountSettings.tsx/ClientLoginApproval.tsx/PersonalConnections.tsx`；Mac `account.ts/login-session.ts/connection-pairing.ts`；Android `CentralContent.kt/ConnectionActivity.kt` |
| F03 P0 | 保存随手记、保留草稿、离线恢复 | Web 文字+已有附件；Mac 本地文字，附件按钮转中央 Web；Android 本地文字+中央笔记入口 | 添加 → 随手记；历史归资料库 | 输入→离页/返回草稿→保存→看到本地/同步状态→从列表打开同一原文；失败可重试且不会生成重复记 | Web `Notes.tsx/notes-state.ts/web-notes.ts`；Mac `note-draft.ts/ui.ts`；Android `QuickNotes.kt/NoteDraftStore.kt/CentralNotes.kt` |
| F04 P0 | 导入已有文件、文件夹、ZIP、音频或图片 | Web 多文件/文件夹/ZIP/中央目录导入；Mac/Android 本机文件任务 | 添加 → 导入文件/导入资料 | 选择→范围/保存方式→提交→进度→需要确认时核对→回到已发布正文/原件；未配置模型去配置后返回同一任务 | Web `Imports.tsx/ImportQueueEntry.tsx/import-queue.ts`；Mac `ui.ts/source-files.ts`；Android `FileTaskActivity.kt/CentralImports.kt` |
| F05 P0 | 持续同步一个文件夹或文件 | Mac/Android 真正本机来源；Web 提供导入和设备说明，中央目录导入是一次任务 | 添加 → 同步文件夹；后续管理归来源 | 选择本机范围→首次同步与持续选项→保存→查看来源→更改文件→看到同来源新版→暂停/恢复 | Mac `source-manager.ts/source-sync.ts/source-files.ts`；Android `FileTaskActivity.kt/SourcesActivity.kt/LocalSources.kt` |
| F06 P0 | 记录屏幕、页面、应用活动、通知/媒体状态 | 采集在 Mac/Android；Web 浏览和设备状态 | 添加 → 记录屏幕；范围管理归来源 | 选择范围→需要的权限→明确开始→查看记录→暂停→历史仍可读；拒绝屏幕权限后笔记/文件继续 | Mac `index.html screen/privacy`、`collector.ts/capture-stages.ts`；Android `MainActivity.buildCapture/buildPrivacy`、`CaptureRecordsActivity.kt` |
| F07 P0 | 管理隐私和三个不同暂停范围 | Mac/Android 本机权限/按应用/遮挡/过滤；Web 来源暂停和授权撤销 | 来源 → 对应来源；设备隐私归本机设置 | 暂停屏幕、暂停一来源、暂停所有发送各自呈现当前范围→恢复→等待数据不丢 | Mac `ui.ts/upload-gate.ts/privacy.ts`；Android `SendPauseControl.kt/MainActivity.kt`；Web `Sources.tsx` |
| F08 P0 | 浏览完整资料、原始记录、文件/录音，并核对来源 | Web 完整；Mac 内容以本机/接收数据为中心，详情可跳中央；Android 本地内容/中央归档切换 | 资料库/内容 | 筛选/选择→正文→来源/时间/版本→证据原件→关闭回同列表位置；空/过滤无结果/读取失败有清楚下一步 | Web `Archive.tsx/LibraryBrowse.tsx/ReferenceDetail.tsx/Files.tsx`；Mac `content-library-ui.ts/content-library.ts`；Android `CentralLibrary.kt/CaptureRecordsActivity.kt/FileContentActivity.kt` |
| F09 P0 | 根据资料提问，查看依据和历史 | 三端直接 Ask；Mac 引用详情转中央；Web 有图片提问 | 问一问 | 输入→发送→看真实工作状态→离页后回到同对话→完成答案→点引用回原文；停止/失败/未配置时恢复 | Web `Ask.tsx/ConversationShell.tsx/Conversations.tsx`；Mac `ask.ts/ask-presentation.ts/ui.ts`；Android `CentralScreens.kt/CentralConversationPresentation.kt` |
| F10 P0 | 看后台正在做什么，处理失败或等待确认 | Web Activity；Mac 本机发送+中央工作；Android 嵌入 CentralContent Activity | 活动 | 从来源/导入/问答跳相关活动→辨认目标/状态/待自己动作→有效重试/取消/补充→打开结果 | Web `Activity.tsx/WorkProgress.tsx/WorkIssueNotice.tsx`；Mac `work-activity-ui.ts/work-activity.ts`；Android `CentralWorkActivity.kt` |
| F11 P0 | 配置必要模型，随后继续原任务 | Web 完整，普通用户 scoped settings；Mac 中央 Web；Android native CentralModels | 设置 → 模型与服务 | 未配置提示→对应模型页→配置/保存→返回原提问或导入→继续原草稿；直接进设置不伪造返回任务 | Web `ModelStartGuide.tsx/ScopedModelsForm.tsx/ModelAssignments.tsx/ServerSettings.tsx`；Android `CentralModels.kt` |
| F12 P0 | 找到所有已支持输入来源，不漏掉重要来源 | Web SourceCatalog 完整目录；Mac 本机来源+中央；Android 本机 Sources+中央多个入口 | 来源 → 新增数据源；本机 Add 使用同一来源定义 | 从“我有某类资料”找到合适来源→看到授权与处理所在端→完成设置→看到已接入来源 | Web `SourceCatalog.tsx/Sources.tsx/DiscoveryLink.tsx`；Mac `ui.ts/index.html sources`；Android `MainActivity.buildSources/SourcesActivity.kt` |
| F13 P1 | 接入飞书文档/日历、Google 日历、Gmail、厂商录音、MCP资料、外部/NAS引用 | 中央 Web 和 Android native Central connectors；Mac 经中央 Web；Mac 另有本机 Calendar | 来源 → 新增数据源 → 指定来源 | 选提供方→准备 CLI/OAuth（若需要）→授权→选择内容范围→同步→回来源或资料；单独错误重试/断开 | Web `LarkSettings.tsx/ScopedGmail.tsx/RecordingsSettings.tsx/ScopedMcpImport.tsx/Sources.tsx`；Android `CentralLark*/CentralRecordings.kt/CentralConnectors.kt/CentralMcp.kt` |
| F14 P1 | 接入 Coding Agent 会话并回看经验依据 | Mac 发现 Claude Code/Codex/Kimi 并同步；Web/Android 阅读和同步状态 | Mac 来源 → 连接 Coding Agent；正文归资料库 | 发现本机 Agent→选择历史/过滤→保存→接收状态→已发布会话正文→核对工具记录/来源→可选记忆 | Mac `coding-agents.ts/source-manager.ts/ui.ts`；Web `CodingUploads.tsx/LibraryBrowse.tsx`；Android `CentralLibrary.materials/codingStatus` |
| F15 P1 | 浏览、纠正、删除、导出和手动提取记忆 | Web 和 Android native central；Mac 中央 Web | 资料库 → 记忆；配置归设置 | 记忆→当前/历史/证据→核对→修正或手动提取→任务→新结果；待澄清问题从 Ask/相关活动回答 | Web `Memories.tsx/MemoryProgress.tsx/OwnerQuestions.tsx/ScopedMemoryControl.tsx`；Android `CentralLibrary.memories/memory`、`CentralAdmin.memoryJobs` |
| F16 P1 | 生成阶段洞察并回看证据 | Web 和 Android native central；Mac 中央 Web | 资料库 → 洞察；Ask/Home 可有入口 | 选时间/设备与问题→提交→离页进度→结果→原文引用→历史 | Web `Insights.tsx/InsightReport.tsx/InsightProgress.tsx`；Android `CentralLibrary.insights` |
| F17 P1 | 管理普通待办，审核日程建议再写日历 | Web 有 Todos 和 Actions；Mac 已授权日历执行；Android native Actions | 今天 → 行动（待办/日程建议两个可区分区域） | 创建普通待办→完成；日程建议→原文核对→选真实设备/日历→固定预览/确认→设备写入/核对结果 | Web `Actions.tsx/Todos.tsx/ActionReview.tsx`；Mac `calendar-actions.ts/ui.ts`；Android `CentralAdmin.actions` |
| F18 P1 | 给其他 Chatbot/MCP 与设备授予或撤销权限 | Web/Android central；Mac 中央 Web | 来源 → 对外授权 | 新建指定用途授权→查看连接方式→检索或设备接收→列出/撤销→确认状态 | Web `PersonalConnections.tsx/Connections.tsx/DevicePairing.tsx`；Android `CentralAdmin.connections/CentralMcp.kt` |
| F19 P1 | 自动记忆暂停、选择记忆方案、可信插件安装/启停 | Web PluginCenter 和 scoped 分支；Android CentralPlugins；Mac 中央 Web | 设置 → 自动记忆与插件 | 发现/已安装→详情/依赖/授权→准备→明确激活→确认当前方案；暂停/恢复自动处理 | Web `PluginCenter.tsx/scoped-plugin-center.ts/ScopedMemoryIntegration.tsx/FeatureInventory.tsx`；Android `CentralPlugins.kt` |
| F20 P1 | 存储/保留/备份/导出/删除、用量、诊断、语言与外观 | 三端各自本机设置+中央管理；Web 中央存储；费用在中央 | 设置 → 对应维护项 | 查看当前范围→编辑草稿→保存/取消；导出生成文件→恢复确认；诊断筛选/下载；切换主题和语言保持草稿/位置 | Web `Vault.tsx/ScopedVault.tsx/ContentStorage.tsx/Usage.tsx/Diagnostics.tsx/AppearanceSelector.tsx`；Mac `ui.ts/config.ts/appearance.ts`；Android `BackupActivity.kt/MainActivity.kt/MoteAppearance.kt` |

后端已存在对应用户作用域路由：`apps/server/src/scope/ask-routes.ts`（问答/洞察）、`memory-routes.ts`、`processing-routes.ts`（导入）、`private-data-routes.ts`（来源/资料目录/统计）、`action-routes.ts`、`todos.ts`、`configuration-routes.ts`、`activity.ts`。入口缺失和后端能力缺失要分别判断；端到端成功状态需要实际运行确认。

## 4. 当前 12 项具体遗漏、重复、隐蔽风险

### R01 正常 Web 账号失去用途与业务发现首页

`apps/web/src/features/system.tsx:15` 按 `mode === 'web'` 使用 `ScopedOverview`。`ScopedSummary.tsx` 只画 Today/账号、captures/materials/sources 计数、随手记/Ask/处理任务、后台工作；旧 Overview 的用途说明、导入/新增来源目录、洞察和行动入口不呈现。用 owner-token 截图会掩盖这个真实分支差异。

### R02 默认空资料库的信息层级偏实现

`Archive.tsx` 默认解释“按来源浏览已发布资料”；`LibraryBrowse.tsx` 空状态指向“上传与处理中查看”。用户先遇到“发布/处理”等内部阶段，而介绍产品用途的内容在辅助 Home。Android `buildLibrary()` 只讲本机和中央，没有文件夹、屏幕、笔记及提问闭环介绍。

### R03 “新增数据源”有两套范围不等价的入口

Web SourceCatalog 是完整卡片目录（设备、Coding、导入、飞书、Gmail、Google、MCP、NAS、录音），Sources 顶部“添加来源”展开的是文件/引用/连接服务表单。完整目录主要通过“来源与连接”下拉、Today（正常 scoped Today 又缺此入口）或全部功能进入。盲测要检查用户是否只看完部分来源就认为已看完全部能力。

### R04 完整功能目录有旧路径残留

`feature-guide-catalog.ts` 多处 `target.path` 写“采集与设备 → …”，或把“采集与设备”列为主导航；当下实际主导航叫“来源”。C02、C04–C08、A08 等需要逐项核实。目录的 78 单元应对照实际身份和能力分支逐项验证。

### R05 正常用户的行动/待办入口很隐蔽

`Actions.tsx/Todos.tsx` 有真实业务控件，但 ScopedOverview 没有旧 Overview 的“查看行动建议”。可能只剩全部功能、旧深链或其他上下文入口。应实测从空新用户和已有建议两种状态如何发现它。

### R06 Mac 文字笔记和附件保存不是同一编辑体验

`ui.ts:535` 的 `note-attachments` 只是 `openCentral('notes')`；当前本机草稿没有在这次调用中传递。按钮会使用户期待附件加入当前笔记，实际打开另一个中央笔记编辑器。以“未保存的本地文字+选择附件”任务复核，然后选择清楚的提示或完整衔接方案。

### R07 Android 来源页与 Add/中央目录分离

`MainActivity.buildSources()` 只显示屏幕/按应用/日历与文件；飞书在 Add/Home，其他在线来源在中央更多。日历与文件进入另一个 Activity 管理。评估应记录实际点击和回退路径，不能仅凭四项导航一致判断完成。

### R08 Android “上传与处理”名称范围过大

`CentralLibrary.archive()` 的按钮调用 `codingStatus()`，只分页 `/api/coding/uploads`。非 Coding 导入任务放在其他入口，用户看到名称会自然寻找所有上传和处理。可改为具体 Coding 名称，或将按钮指向真正的处理任务入口。

### R09 “活动”有三种含义

四项主导航的后台工作叫“活动”；资料库里的前台采样叫“应用活动”；Mac `data-page='activity'` 实际显示“本机统计”，`data-page='work'` 才是主导航活动。当前文案已部分区分，需要核对目录、面包屑和错误回路的术语一致性。

### R10 Memory 的阅读与配置分散且分别承担不同职责

记忆在资料库；模型/配方/节奏在模型与服务；自动记忆开停/方案替换在插件页。`SettingsLanding` 已添加解释折叠。评估任务要区分“查看记住了什么”“用哪个模型”“暂停自动记忆”，分别进入明确责任页，避免机械合并成一个巨页。

### R11 来源/原始记录/全部资料的重叠需要解释

Web 分类有全部资料、原始采集记录、片段、来源资料、文件与录音、应用活动、媒体播放、记忆；同一来源可出现在不同投影视图。去重目标应是任务责任和入口解释清楚，同时保留原件、版本、聚合和输出的真实层级。

### R12 新 scope 和旧前端合同需逐页确认

`ScopedMemory*`、`ScopedVault`、`ScopedModelsForm`、`PersonalConnections`、`ScopedRecordingsSettings` 等已存在，这些并非纯主题分支。原基线未合并的 PR 170–182 不能作为已经就绪的能力使用。普通 Web session、旧管理模式、未登录状态需明确记录。

## 5. 独立评估者的 15 项最小用户任务

首次理解评估者只拿运行中的 UI、普通新用户身份和任务，不给源码路径、路由、功能目录答案或实现者解释。先记录“第一眼认为能做什么”，然后执行目标；后续核对阶段再使用上述功能真值表判定漏项、重复和错路。

1. **首次理解：**新用户在空白资料库看完第一屏，说明 Mote 的用途，指出一个保存资料入口和一个查找/提问入口。
2. **一次导入与持续同步：**想持续保存电脑/手机某文件夹的新变化，和只导入一个文件，各自找到合适方式。
3. **笔记闭环：**写一条笔记，离开再回来，保存并读回同一全文；离线情况下重复一次。
4. **笔记附件：**从已有图片/录音文件作为笔记附件开始，判断是否与同条文字一起保存。
5. **屏幕与权限：**找到屏幕采集，拒绝一次授权，随后完成一条笔记；回到正确位置开始/暂停采集。
6. **来源覆盖：**从首次入口找到飞书文档、厂商录音、Coding 会话、邮件、日历各自的接入位置和所需设置。
7. **导入与阅读：**导入合成文档后找到它，辨别接收、解析、可阅读、记忆处理四个实际状态。
8. **问答和模型配置：**围绕合成资料提问，模型未配置时去设置，再返回原问题；配置可用时打开答案引用核对全文。
9. **后台任务恢复：**发起较长工作，离页再回来，找到进度、结果或需要处理项；失败重试不重新提交另一份资料。
10. **记忆与控制：**找到记忆列表，查看原证据，纠正一项；再找到暂停自动记忆的位置。
11. **洞察：**为某个时间段生成洞察，找到历史报告和依据。
12. **待办与日程：**创建普通待办并完成；找到日程建议核对界面，辨别确认后的执行设备和日历。
13. **暂停范围：**查看某来源的管理页，只暂停此来源，再找到暂停全端发送的位置，理解二者的作用范围。
14. **对外授权：**查看/撤销外部 Chatbot 或采集设备授权；回到之前所在内容。
15. **管理与草稿：**找到备份、诊断、用量、主题/语言，在有未保存草稿时切换页面并恢复。

建议客观记录：首次功能提及覆盖、关键功能成功发现、任务完成率、完成所需步数/返回次数、走错入口数、未被发现单元数、重复职责误判数、草稿/选中项丢失数。固定功能清单后分 P0/P1 报告，不能通过删除难项提高分数。设计质量、原创性、工艺、功能性和首次理解等独立量表与运行证据分别保存。

## 6. 已有验证资产和协作约束

- 脚本：`scripts/test-web-navigation.cjs`、`test-web-presentation.cjs`、`test-web-tasks-imports.cjs`、`test-ui-iterations.cjs`。
- Web 局部测试：`apps/web/test/workspace-navigation.test.ts`、`navigation-drafts.test.ts`、`evidence-navigation.test.ts`。
- Mac 局部测试：`apps/desktop/test/navigation.test.ts`。
- Android 已有 `NavigationInstrumentedTest`、`PairingNavigationInstrumentedTest`、`PrimaryNavigationTest`。
- 根 AGENTS.md 要求 PR 前执行受影响组件与消费者的 `npm run check:affected`；完整冻结候选由一位 driver 执行，其他人做模块范围内检查；生成数据、后台/headless UI；原生设备与真实模型结果单独记录。
- `docs/design/ui-feedback-evaluator-2026-10-13.md`、`ui-iterations-2026-10-13.md` 等保留历史分数。其中明确出现过设置页混入采集、原文返回父路径错误、真实 Ask→模型设置丢 returnTo、加载中截图冒充成品等失败。这些应加入本轮回归，不继承旧 8.5 分。
- 优先处理正常 Web session 中可复现的用途/发现路径差异，随后审 Mac/Android 对应职责。若修改主题 tokens，需要核对三端消费者，不在单个页面另造一套视觉系统。

## 7. 功能目录原始分组口径（供后续对照）

| 大区 | 分组 | 代表功能 |
| --- | --- | --- |
| 接入与记录 | G05 随手记与已有附件 | 文字、草稿、离线队列、图片/音频附件 |
| 接入与记录 | G04 导入文档、文件夹和媒体 | 导入、进度、删除整次导入、服务器目录、解析器、上传恢复 |
| 接入与记录 | G03 接入来源、飞书与录音 | 来源选择与管理、NAS引用、Google、Gmail、MCP、飞书、录音、版本 |
| 接入与记录 | G02 连接设备与查看采集 | Today、设备状态、设备连接、授权撤销、对外MCP |
| 阅读与使用 | G06 阅读正文与原始证据 | 已发布正文、证据、来源关系、原始记录、删除 |
| 阅读与使用 | G08 提问与回看对话 | Ask、历史、图片提问 |
| 阅读与使用 | G09 查看、纠正与整理记忆 | 记忆阅读、纠正/导出/删除、手工提取、澄清、历史与节奏 |
| 阅读与使用 | G10 生成洞察与回顾 | 洞察生成、历史、证据 |
| 跟进与管理 | G11 跟进工作与失败恢复 | Activity、技术步骤、重试 |
| 跟进与管理 | G12 待办与日程建议 | 普通待办、日程审核和设备执行 |
| 跟进与管理 | G07 按分类回看与查看时间 | 分类、片段、应用活动、媒体、Coding接收 |
| 跟进与管理 | G15 备份、存储、索引与费用 | 导入导出、保留容量、解密、空间和费用 |
| 设置与维护 | G13 模型、图片、文件与语音 | Provider、模型分配、OCR、文件/音频处理、说话人/转写纠正、并发 |
| 设置与维护 | G14 自动记忆与可信插件方案 | 自动记忆开停、替换方案、可信插件 |
| 设置与维护 | G01 登录、语言与页面入口 | 登录会话、常用页面 |
| 设置与维护 | G16 帮助、诊断与 Agent 视角 | 帮助、Agent上下文/实际工具读取、能力清单、日志、部署配置、语言 |

恢复操作只创建此中间分析报告，未修改产品 UI。
