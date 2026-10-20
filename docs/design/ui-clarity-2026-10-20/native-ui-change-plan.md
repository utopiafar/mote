# Mote 原生 UI：可实施的清晰度改进清单

## 0. 范围、基线与结论

- 整理时间：2026-10-20。
- 代码基线：`2c78ca8d52a7d17fae20962cf68d09a717ffc73a`。
- 当前读取目录：`/workspace/scratch/580b4cdfd36e/mote-ui-work`。下文代码路径均相对此目录；行号为基线定位提示，实施时按符号定位。
- 本文件是只读代码核对和实施建议。没有修改产品，没有运行构建、原生界面、模拟器或全量检查；没有给当前 UI 打分。**R0 及计划中的 15 轮 UI 迭代仍未运行。**
- 现有主导航维持 **Library / Ask / Sources / Activity**。Home 和 Settings 沿用当前辅助入口；`records`、`work`、`activity` 等内部 route ID 不重命名。本次建议不设定新的主导航、采集默认值、权限策略、同步范围或新的后台处理政策。
- GitHub parity integration 草稿 PR 170–182 不视作已进入此基线。

最先值得验证的改动是：把已经存在于辅助 Home 的产品说明与添加动作，在真正的默认 Library 中用紧凑组件表达；让文件夹、文件与屏幕记录同级可发现；修正来源和 Coding 进度标签的范围。Mac 笔记附件需要单独处理：当前按钮只是打开中央笔记页，本机草稿并没有随之传递。可先把边界说清，再用明确命名的复制动作衔接正文。

这些是候选假设；应由运行基线及独立评估的结果决定每轮采用哪一组，不把本清单直接算成已完成迭代。

## 1. 约束与最接近的现有模式

| 方面 | 保留和复用 |
| --- | --- |
| 原生结构 | Mac `apps/desktop/src/navigation.ts`，Android `PrimaryNavigation.kt`；默认 Library，四个主标签，现有返回栈与来源归属 |
| 添加动作 | Mac `index.html` 的 `[data-add]` / `[data-add-choice]` 与 `ui.ts` 处理器；Android `NativeUi.kt:434–454` 的 `MoteAddAction`、`openMoteAdd()`、`showMoteAddActions()` |
| 文件确认 | Mac `beginSourceSelection()` 及 source confirm；Android `FileTaskActivity` 的主动选择、范围、保存/取消。新增快捷入口只调用它们 |
| 视觉 | 现有 `packages/shared/design-tokens*.json`；Mac secondary controls、helper、actions；Android `MoteUi` 字体/颜色/圆角角色与 `menu()` 组件 |
| 文案 | 先用 `packages/shared/src/i18n-en.ts` 已有 key；中文字符串是当前 key 模式。新增 key 更新该文件，再执行 `node scripts/sync-i18n.mjs` 同步 Android 英文资产，检查 `node scripts/check-i18n.mjs` |
| 验证 | 合成 fixture，真实入口与生命周期，后台/headless。一个 driver 为冻结候选运行 `npm run check:affected`；各子任务只做必要的聚焦检查 |

`AGENTS.md` 要求复用既有信息架构、术语、交互与组件；当前 `docs/adr-ui-presentation-packs.md` 是展示体系依据。不要为了首屏理解恢复为过去的 Home 默认页，也不要根据后端模块拆新导航。

## 2. 实施候选总表

| ID / 优先级 | 当前问题与代码证据 | 最小改动 | 文案需求 | 有意义的验收 |
| --- | --- | --- | --- | --- |
| N1 / P0 | Mac 默认 `records` 的说明较抽象；完整产品说明与五种添加入口在辅助 Home。`index.html:54–68,98–109`，`navigation.ts` | 在当前 Library 标题区复用产品用途说明；用现有 secondary 按钮样式提供紧凑添加入口或由现有 Add 展示明确动作。保留完整 Add 目录和当前默认页 | 用已有用途说明和五种 action labels，原则上零新 key | 冷启动只看首屏能说出保存个人资料、整理后搜索/提问，并指出第一步；文件夹、文件、屏幕的入口层级相同；窄屏不挤掉内容与范围选择 |
| N2 / P0 | Android `buildLibrary():465` 的 `page(Page.LIBRARY,null)` 没有用途说明；Home 已有说明和 `MoteAddAction` 五项。`MainActivity.kt:260,465` | 在实际 Library 上复用用途说明与紧凑添加动作；用同一 `MoteAddAction` 和 `openMoteAdd()`，不另写文件/截图业务 | 用已有 key；注意同时说明本机与中央边界，不承诺所有内容已索引 | 默认启动而非测试主动切到 Home；411dp 与 320dp/大字体下可发现文件夹、文件、屏幕、随手记，新增入口进入原有流程并能返回 |
| N3 / P0 | Mac 文件/文件夹按钮在默认关闭且名为“日历与编码对话”的 disclosure 内。`index.html:119` | 把现有 `source-files`、`source-directory` DOM 元素移动到 Sources 可见动作区；可同区使用已有 `[data-add-choice=screen]`。日历和 Coding 留在匹配其标题的原分组 | 大部分复用“导入文件”“同步文件夹”“记录屏幕”“本机来源” | 不展开“日历与编码对话”即可找到文件与目录；按钮 ID 仍唯一；选择/取消不创建 source；确认沿用当前首次同步与范围 |
| N4 / P0 | Android Sources 只有屏幕、按应用配置和“日历与文件”混合入口。`MainActivity.kt:588–600` | 复用 `menu()` + `MoteAddAction`，给文件夹与文件明确的同级入口；既有 `SourcesActivity` 保留为查看范围、暂停、重新授权的管理位置。配置屏幕与按应用范围继续沿用 | 复用“本机来源”“来源管理”“逐个查看范围、暂停或重新授权”等已有 key；无需新造资料层级 | 无路径提示可进入文件或文件夹任务；没有新的第二套 source 创建状态；既有来源管理仍可达；权限只由原流程触发 |
| N5 / P1 | Mac Sources 页题为“自动来源”，实际包含一次导入；Activity 名称有后台工作和本机统计两类。Android 主 Activity 已有解释 | Mac 页标题可复用“本机来源”，保留导航“来源”和其实际副标题；主 Activity 保留“活动”，辅助 `activity` 页保留“本机统计”。Android 只核对路径文案，不添加重复说明 | 优先零新 key | 用户能区分来源范围管理、后台进度和应用使用历史；内部 route/back 行为不变 |
| N6 / P0 | Mac“图片与语音附件”只 `openCentral('notes')`，未传本机草稿。`index.html:112`，`ui.ts:535` | 先明确“在中央工作台写带附件的笔记”及本机草稿保留。若本轮包含正文衔接，使用明确的“复制文字并打开中央工作台”动作；复用草稿持久化、连接引导与 clipboard fallback。见第 6 节 | 3–5 个新 key，视是否包含复制行为 | 输入草稿→动作→中央打开/未配置引导→回到 Mac，正文与草稿 ID 未丢；无未说明的新保存或自动提交；复制失败可恢复 |
| N7 / P1 | Android `CentralLibrary`“上传与处理”查询的只是 `/api/coding/uploads`。`CentralLibrary.kt:52,64–75` | 入口和页标题均改用既有“Coding 会话同步状态”；按需增加一句明确范围的说明。保留原 endpoint、分页和正文跳转 | 标题已有 key；范围句最多 1 个新 key | 页面不会被误解为所有文件或屏幕的上传队列；Coding fixture 仍正确显示接收/发布/索引，返回资料库和按 source 看正文正常 |

## 3. 默认首屏：说明复用与紧凑呈现

### 3.1 Mac

现状：

- `apps/desktop/src/index.html:54–68` 的 Home 已包含产品定位以及 folder/file/screen/note/lark 五个明确动作。
- 默认 Library 在 `index.html:98`，目前标题是“内容”，副标题为“文件、屏幕和想法，在同一处阅读。点开内容即可核对出处和整理状态。”。
- 当前 `.content-library-tools` 有本机/接收等 scope、刷新及通用“添加”，下面是内容 feed。屏幕日期浏览是折叠细节，并非需要提升成另一条主导航。
- `ui.ts:96–121` 已为所有静态 `[data-add]` 和 `[data-add-choice]` 注册处理器。新的静态按钮只需复用数据属性；如果改为晚渲染组件，需采用现有可用的事件注册时序，避免 HTML 出现而没有 handler。

建议复用的既有说明：

> 文件、屏幕记录和想法先保存在本机；连接中央并完成整理后，可搜索和提问。

不要把 Home 的整块大型卡片直接复制到 Library。`styles.css:275–278` 的通用 `.add-choice` 为较大的选项；`370–372,402,417,820` 还有 Home/dialog 的后置布局覆盖。应沿用 Library 工具区的紧凑 secondary controls，必要时换行，保持标题、范围和已有内容的优先次序。使用同一 action label/dispatch 可以保留上下文快捷入口，而不会形成另一套功能管理位置。

第一轮可以只用简明说明加一行紧凑动作；密度交给独立评估检查。若首屏动作过多，保留完整 Add 目录、明确其内容，再决定适合的可见动作呈现，而不是固定另一套导航政策。

### 3.2 Android

现状：

- `MainActivity.kt:465` 实际默认 Library 缺少 page subtitle，已有“本机保留 / 中央归档”和“本机保留的记录，离线也能查看；同步后的完整资料在中央资料库中。”。
- `buildToday():260` 有产品用途、五种添加动作，但它不是首次默认到达的页。
- `NativeUi.kt:434` 的 `MoteAddAction` 是已存在的动作词典，包含 FOLDER、FILE、SCREEN、NOTE、FEISHU。`MainActivity.addContent():367` 和 `Activity.openMoteAdd():441` 已处理所有目的地。

复用候选：

> 同步文件夹、导入文件、记录屏幕或写一条随手记。内容会先保存在本机。

加上当前已有中央整理后可搜索/提问的产品说明即可完成用途表达。应避免同屏堆积三段意义相近的 helper；选择一句产品说明，再保留准确的本机/中央 scope 解释。

`MainActivity.menu():1785` 的行组件已有原生字体、图标、触摸高度、chevron 和内容描述，可提取小型通用 action renderer，或直接复用 `menu()` 创建输入快捷行。实现时对照 `buildToday()` 的真实组件，不写新卡片设计体系。布局不应让五个 64dp 大行全部占住有数据 Library 的内容区；可使用已有原生按钮角色的紧凑换行安排，但需实际小屏检查。

测试 tag 要保持唯一：Home 当前使用 `add:FOLDER` 等，`SourcesEntryInstrumentedTest` 在整棵 view tree 中使用 `.single { tag == ... }`。Library / Sources 的复用入口采用 `library-add:*` / `source-add:*` 或基于可见页的稳定选择，不重复 Home tag。`UiIterationInstrumentedTest` 中还有固定旧 action 数目的断言，实施时按测试要保证的旅程核对，不能仅为了通过检查机械改数字。

## 4. 文件、文件夹与屏幕入口：复用原选择和确认流程

### 4.1 Mac Sources

最小 DOM 改动：把 `source-files` 和 `source-directory` 从 `source-connect-panel` 移到 Sources 顶部的可见 action row。移动而非复制；`ui.ts:726–729` 的 `sourceAction()` 按这些 ID 同步控制 busy 状态，重复 ID 或另起 handler 会破坏确认时的互斥。

来源页要为“持续同步文件夹”和“一次导入文件”各自提供准确说明，复用：

- “同步文件夹” / “让选定文件夹的变化持续归档”。
- “导入文件” / “保存一份文件，也可选择以后自动同步”。
- “记录屏幕” / “选择允许记录的应用与范围”。

`ui.ts:649` 的 `beginSourceSelection('directory' | 'files')` 已完整处理页面切换、系统选择取消、首次确认和是否持续同步。当前文件默认 continuous false、目录 true。新增展示不改变这些状态和确认顺序；按钮点击本身不创建来源或开始截图。

### 4.2 Android Sources

最接近的现有实现是 `MainActivity.buildSources()` 通过 `menu()` 进入既有目的地，以及 `NativeUi.MoteAddAction` 通过 `openMoteAdd()` 分发到 `FileTaskActivity`、PRIVACY、NOTES 或中央飞书页面。

在当前 Sources 信息架构内添加明确的文件夹和文件入口，调用 `openMoteAdd(MoteAddAction.FOLDER/FILE)`。屏幕范围沿用 `SCREEN` 或当前配置目标；“按应用配置”继续表示配置细节，不用另一个“添加屏幕”名称指代同样的配置状态。

将“日历与文件”这个兼有添加与管理的模糊菜单，说明为既有来源管理职责：可复用 `来源管理` 与 `逐个查看范围、暂停或重新授权`。它仍进入 `SourcesActivity`，日历授权、现有 source 列表、保留范围和后台策略留在原页面。新增快捷入口不替换管理位置。

`SourcesEntryInstrumentedTest` 已有真实 `FileTaskActivity` 的入口、picker 取消、recreation、source count 和草稿恢复验证。扩展到新的来源/Library origin 即可；不需要再写一套假的 source creation 测试。

## 5. “来源 / 活动”命名核对

### 5.1 Mac

- `index.html:116` Sources 页 h1 为“自动来源”，副标题列出“文件夹、文件、日历和编码对话”。其中一次导入不是自动来源；“本机来源”已有翻译，且适合当前这些设备侧能力。四个主导航中的“来源”保持。
- `index.html:157` 主 `data-page="work"` 已是“活动”，副标题“查看本机发送与中央资料整理、问答和记忆工作的实际进展。”，下分“本机发送”和“中央工作”。这已经准确，可以保留。
- `index.html:167` 的 `data-page="activity"` 是“本机统计”。这是辅助低频本地统计，不是主 Activity，`navigation.ts` 和测试已有区分。不要把两个内部 ID 一起改名。

### 5.2 Android

`CentralWorkActivity.kt:44–50` 已通过 `/api/work-activity` 展示后台进度，并解释：

> 这里是 Mote 的后台工作：理解资料、导入、整理记忆与生成洞察。手机和电脑的应用使用情况在「资料库 → 应用活动」。

因此无需再给 Activity 添一段同义说明。可以核对“资料库 → 应用活动”是否和当前端真实入口吻合；`CentralLibrary.rawArchive()` 的应用活动入口以及本机 Library 的类型筛选处有对应内容，文案应指向用户实际可见路径。若本轮没有动该跳转，不要顺便扩写成新的跨端导航政策。

MainActivity 的主 Activity 是嵌入 `CentralContent` 的中央页面；本地 header 隐藏。若需要修作用域说明，位置应是 `CentralWorkActivity`，给 `buildUi` 添加本地副标题可能根本不会显示。

## 6. Mac 笔记附件：先准确说明，再实现明确的正文衔接

### 6.1 当前边界已经核实

| 环节 | 当前实现 |
| --- | --- |
| 可见按钮 | `index.html:112`，`note-attachments`，文字“图片与语音附件” |
| 点击 | `ui.ts:535`，只有 `desktopApi.openCentral('notes')` |
| 本机草稿 | `note-draft.ts`：id、text、mood、revision、prepared；没有附件元数据或中央 draft handoff |
| IPC | `contracts.ts:151–154` / `preload.ts:78–81` / `main.ts:579–582`；打开中央只接受 page/evidence ID，不带正文 |
| 中央目的地 | `central-browser.ts:13` notes 映射为 `#notes`；没有把当前本机草稿恢复进中央编辑器的协议 |

因此当前按钮有“为这条笔记附图或录音”的暗示，实际打开的是另一处笔记编辑器。不能把改标签说成已经解决同一条笔记跨端附件合并。

### 6.2 推荐的最小实现

**第一层（纯 UI 清楚表达）：** 将附件按钮改为“在中央工作台写带附件的笔记”，可使用现有 external icon；补一句“当前文字草稿保留在这台 Mac。带附件的笔记在中央工作台单独编辑。”。未连接时复用现有 connection 引导，而不是让 openCentral 抛一个用户难懂的错误。

**第二层（若这一轮要完成正文衔接）：** 非空草稿使用明确命名的“复制文字并打开中央工作台”；空草稿直接打开中央新笔记页。点击含复制字样的动作后，再复制当前正文、打开中央，并显示“文字已复制。请在中央工作台粘贴后添加附件。”。不自动提交本机随手记，也不清空本机草稿；这样用户不会无意创建两条已保存内容。

最小实现位置仍在 `ui.ts`，无需改 IPC/API：

1. 将 handler 放在能访问 `draft`、`noteSaving`、`noteComposing` 的草稿区域；仍沿用 `perform()` 的可见状态/错误处理。
2. 复用 `ui.ts:555–574` 的 revision 和 `updateNoteDraft` 持久化逻辑，先确认最新可见文字保存在本机。保存中的草稿、IME 未结束、prepared draft 的原 ID 和锁定状态应完整保留；必要时暂时禁用附件动作，与现有 noteSaving/busy 锁一致。
3. 未连接时沿用 `central` 按钮的 `currentStatus.config.serverUrl` 检查和 `showPage('connection')`，返回仍经现有导航栈，保留正文和来源页。
4. 在明确的复制动作中复用 `ui.ts` 已有 `navigator.clipboard.writeText` 及选择 textarea 的 fallback（日志页已有此模式）。正文不进入 URL、控制台、诊断或新存储。
5. clipboard 失败时保留编辑器、选中文字并给可操作反馈。若中央打开失败，仍保留本机草稿，并用已有错误 UI 说明；不声称已成功到达中央。

在 prepared draft 中编辑器 readOnly，属于“上次保存未完成，用原 ID 重试”状态。附件衔接不能隐式调用 `saveNote`、覆盖 prepared ID 或替用户完成重试。判断复制条件以当前显示正文为准，保留 prepared 元数据。

若需要自动把同一条 Mac 笔记和中央附件合并，工作量已超出上述 UI 变更：需要账户绑定的 handoff、中央草稿冲突规则、幂等提交与离线/失败恢复。当前没有这样的协议。本轮可准确改善衔接，但不要静默引入一个未经定义的新上传/复制保存政策。

### 6.3 需要的回归场景

- 已连接 + 非空合成草稿：点击命名明确的复制动作，复制内容是当前输入，中央目标为 notes；Mac draft id、text 和 revision 可恢复；queue 没有额外新增 note。
- 未连接 + 有草稿：显示连接引导；返回编辑器仍有正文，之后可继续原任务。
- clipboard 或打开中央失败：反馈有操作含义，文字仍可手动复制；按钮没有永久 busy。
- 草稿正在保存、IME composing、prepared retry 三种高风险状态：不重复保存、不损坏原 ID、不丢最近文字。
- 关闭再恢复 Mac 草稿：此前衔接动作不能导致草稿被当成已提交而清空。

这些验证关注用户输入和恢复，不写只断言新文案是否存在的镜像单元测试。

## 7. Android Coding 进度范围

改动只需进入 `apps/android/app/src/main/java/dev/mote/collector/CentralLibrary.kt`：

- `archive():52` 的按钮文字由“上传与处理”改为已有 key“Coding 会话同步状态”。
- `codingStatus():65` 页标题同样修改。
- 根据独立评估决定是否补充“这里只显示 Coding Agent 会话的接收、正文发布与索引状态。”。下方保留当前关于原件、正文、索引/记忆各阶段的事实说明。
- 保持 `/api/coding/uploads?limit=20`、source name、received events/materials/indexedMaterials、分页和“查看聚合正文”的原行为。

这能把页面的承诺与数据范围对齐，无需假造覆盖全部来源的 upload endpoint。一般后台进度已经有主 Activity；仅当实际导航任务表明用户需要且现有 `ui.navigate` 路由可直接复用时再考虑上下文跳转，不为这次更名额外建新管理页。

## 8. 翻译清单

### 8.1 直接复用（无新增 key）

以下均已在 `packages/shared/src/i18n-en.ts`，Android 也应由同一 catalog 同步：

| 现有中文 key | 大致行号 / 用途 |
| --- | --- |
| 文件、屏幕记录和想法先保存在本机；连接中央并完成整理后，可搜索和提问。 | 125，默认页产品定位 |
| 本机来源 | 5567，设备 Sources 页标题或分组 |
| 打开中央工作台 | 5579，已有外部工作台动词 |
| 添加内容 | 6693，添加动作总称 |
| 同步文件夹 | 6694，文件夹输入 |
| 逐个查看范围、暂停或重新授权 | 6710，既有来源管理入口说明 |
| 同步文件夹、导入文件、记录屏幕或写一条随手记。内容会先保存在本机。 | 6777，Library 输入概述 |
| 管理你选择的文件夹、文件、日历和编码对话。每个来源都可单独暂停。 | 6829，Mac Sources 原有说明 |
| Coding 会话同步状态 | 8230，Android Coding 状态按钮/标题 |
| 在中央工作台查看 | 8338，工作台范围动词 |
| 查看本机发送与中央资料整理、问答和记忆工作的实际进展。 | 8340，Mac Activity 已有说明 |

具体 file/screen/note/Feishu 标题与副标题直接由现有 Mac markup / `MoteAddAction` 复用；不增加第二份业务动作词典。

### 8.2 建议新增（按实际采用的候选加入）

| 中文 key | 英文值 | 适用 |
| --- | --- | --- |
| 在中央工作台写带附件的笔记 | Write a note with attachments in the central workspace | N6 空草稿/纯标签改善 |
| 复制文字并打开中央工作台 | Copy text and open the central workspace | N6 明确的正文衔接动作 |
| 当前文字草稿保留在这台 Mac。带附件的笔记在中央工作台单独编辑。 | Your text draft stays on this Mac. Notes with attachments are edited separately in the central workspace. | N6 说明实际边界 |
| 文字已复制。请在中央工作台粘贴后添加附件。 | Text copied. Paste it in the central workspace, then add attachments. | N6 成功反馈；仅复制成功后显示 |
| 复制失败，请复制当前文字后打开中央工作台。 | Copy failed. Copy the current text, then open the central workspace. | N6 失败恢复；优先复用现有 clipboard failure key 若表达相同 |
| 这里只显示 Coding Agent 会话的接收、正文发布与索引状态。 | This view shows receipt, publication and indexing for Coding Agent conversations. | N7 可选范围说明 |

单纯 N1–N5 和 N7 更名不需要新增翻译 key。只有被产品实际采用的字符串进入 catalog；英文按钮较长，需要在 Mac 窄窗口和 Android 小屏一起检查换行/触摸范围。

## 9. 相关现有测试与最小验证矩阵

### 9.1 Mac

| 现有位置 | 相关保障 / 建议 |
| --- | --- |
| `apps/desktop/test/navigation.test.ts` | 默认内容、Sources 主页、notes 原归属、设置 dirty guard、辅助 activity 与主 work、连接后返回。当前导航不变时使用已有保障，不为改标签增加同义断言 |
| `apps/desktop/test/content-library-ui.test.ts` | 本机/中央详情、合成 fixture、错误恢复；Library 范围保留时可聚焦运行 |
| `apps/desktop/test/work-activity-ui.test.ts` | 本机发送和中央工作、正确打开 Activity；只有触及其行为才扩展 |
| `apps/desktop/test/note-draft.test.ts`、`complex-notes.test.ts` | draft ID、revision、prepared 和重试；N6 需聚焦运行，并对新增 handoff 行为补真实状态场景 |
| `apps/desktop/test/central-browser.test.ts` | notes/openCentral 目标；若目标协议未改，不必重写映射 |
| `apps/desktop/scripts/test-ui.mjs` | 当前公开 wire-2 UI 检查入口；由 `multiuser-native-runner.mjs` 执行合成账户与原生生命周期。优先在这套实际入口补首屏/衔接检查 |
| `apps/desktop/scripts/ui-smoke.cjs` | 有 fresh profile、Home/Add、Sources 取消、返回和 820×620 片段可参考；文件使用旧直接 IPC fixture，不能以它单独证明当前 wire-2 UI 通过 |

视觉与操作选少量高风险组合：空库默认页 zh/light、合成有内容 en/dark、820×620 窄窗口；必要时在当前窗口尺寸检查 key action 和焦点。对纯文案调整不运行整个矩阵；对新增 notes clipboard/connection 状态重点检查第 6.3 节。

### 9.2 Android

| 现有位置 | 相关保障 / 建议 |
| --- | --- |
| `app/src/androidTest/java/dev/mote/collector/SourcesEntryInstrumentedTest.kt` | 实际 FileTaskActivity 进入、picker 取消、recreation、保存前不新建 source、草稿恢复；扩展新 Library/Sources origin 即可 |
| `NavigationInstrumentedTest.kt` | 主标签与来源返回、notes 和连接流程；应检查新增快捷动作能回原处 |
| `UiIterationInstrumentedTest.kt` | 明确 `uiIterationFixture=true`、空合成状态、app-owned rendering 保留 FLAG_SECURE；其部分场景主动进入 Home，首屏目的测试应加入真正默认 Library 启动 |
| `UiInventoryRolloutInstrumentedTest.kt` / `UiRolloutInstrumentedTest.kt` | 现有 UI inventory/rollout 截图机制可复用；不把旧评分当本次独立评价 |
| `UiCentralRolloutInstrumentedTest.kt` / `UiCentralDetailRolloutInstrumentedTest.kt` | Coding scope、原始资料与中央工作区域的合成接口 fixture 可优先复用 |
| `app/src/test/java/dev/mote/collector/PrimaryNavigationTest.kt` / `NativeUiPackTest.kt` | JVM 路由/呈现约束；可证明映射，不能代替真实小屏点击、返回或首屏理解 |

最小 runtime 验证场景：

1. 默认 Library 空合成数据，411dp 正常字号：用途理解、四类本机输入可发现；通用添加目录仍包含 Feishu。
2. 默认 Library 合成有数据，320dp / fontScale 1.3，英文：动作可操作、scope 和首条内容没有布局遮挡，原生 48dp 控件规范继续沿用。
3. Sources → 文件夹 / 文件 → 明确选择 → 取消 → 返回原页：原 source count、同步策略和已有 draft 保持，picker 不在进入时自动打开。
4. 屏幕快捷入口进入应用范围/权限配置，不开始未经确认的 capture。
5. Coding 状态用合成 upload response：按钮/标题范围准确，分页、查看聚合正文和 Back 仍正常。

当前部分 Android instrumentation 带严格 `.dev` 和 `Build.FINGERPRINT.contains("emu64a")` 或 `"/emu64a:"` 防护。这些测试不能直接在普通 x86 软件模拟器上当作可执行 gate。不要删掉保护来把结果变成“通过”；应复用符合前置条件的隔离 arm64 AVD，或单独设计同样仅使用生成数据的隔离 x86 fixture 并清楚记录覆盖差异。

## 10. 容器构建和模拟器可行性（只读核对）

### 10.1 当前实际环境

| 项目 | 读取结果 | 含义 |
| --- | --- | --- |
| Host arch | `x86_64` | 与 arm64 emulator fixture 前置条件不同 |
| `/dev/kvm` | 不存在；不可读、不可写 | 当前没有可用的 Linux KVM device |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `JAVA_HOME` | 均未设置 | 尚无配置好的 Android 工具链路径 |
| `java` | `/usr/bin/java`，OpenJDK 17.0.20 | 有 JRE，版本本身符合项目所用 AGP 的 JDK 下限 |
| `javac` | PATH 中没有；`/usr/lib/jvm` 只见 Java 17 runtime | 缺完整 JDK，当前不能把“java 可执行”视为构建就绪 |
| JDK 21 | 已检查的常见 JVM/缓存位置未发现 | 项目不要求它；缺失不会单独成为问题 |
| `adb` / `emulator` / `sdkmanager` / `gradle` | PATH 中没有 | 需要 SDK 和 Gradle wrapper 下载才能工作 |
| SDK / 工具缓存 | 检查常见 `/opt/android*`、`/usr/local/lib/android`、root 的 Android/Gradle 目录及 `/tmp`、`/opt/codex`、`/workspace`、`/root/.cache` 下可读候选，未找到实际 sdkmanager/adb/emulator/android.jar/JDK 下载包 | 不能按已有预热 SDK 安排立即 build 或 emulator 运行 |

没有下载、安装或启动；`apt-cache policy` 也没有返回可用本地索引。一个 exec 短暂 transport disconnected，后续只读调用恢复，结论不是由该临时错误推断。

### 10.2 仓库真正需要的版本

| 依据 | 当前配置 |
| --- | --- |
| `apps/android/build.gradle.kts` | Android Gradle Plugin 8.11.1；Kotlin 2.1.20 |
| `apps/android/gradle/wrapper/gradle-wrapper.properties` | Gradle 8.14 all distribution |
| `apps/android/app/build.gradle.kts` | compileSdk 36、targetSdk 36、minSdk 29；Java source/target 17，Kotlin jvmTarget 17 |
| `.github/workflows/release-android.yml:43–46` | Temurin JDK 17；安装 `platforms;android-36` 与 `build-tools;36.0.0` |
| `scripts/release/check-environment.mjs` | 仅确认 java 命令版本成功和 SDK 路径等；该 preflight 不证明完整 javac、SDK platform 或 JDK 21 |

**构建判断：** 安装完整 JDK 17、Android command-line tools、platform 36/build-tools 36 并允许 Gradle/Maven 依赖下载后，可以尝试 debug/development build 与 JVM 测试；这些不依赖 KVM，也不需要 release 签名。JDK 21 不是此项目的必要前置。当前只读环境不足以立即构建。

**模拟器判断：** 无 KVM 时，当前 Android 官方命令行文档仍说明 TCG/software CPU emulation 可通过 `ANDROID_I_WANT_MY_TCG=yes` 与关闭加速显式启用，但该路径被标为不受支持且很慢；未设置变量会拒绝启动。软件 GPU（`-gpu software` 等）仅处理图形，不能替代缺失的 CPU 虚拟化。即使下载 emulator/system image，也需要实际启动验证才能判断容器内的可运行性和速度，不应现在承诺可完成 15 轮原生 UI 交互。

建议执行次序：先补齐构建工具，完成受影响的 Kotlin 编译和 JVM 检查；原生 UI 由适当的隔离 Mac/Android AVD 执行。若 root 决定尝试容器软件模拟器，先用单个合成首屏作为时间受限的可行性试验，再决定是否用于后续轮次，并保留以上 instrumentation 架构限制。

### 10.3 官方资料（仅用于工具链可行性说明）

- [Android Gradle Plugin 8.11 release notes](https://developer.android.com/build/releases/agp-8-11-0-release-notes)：JDK 17 最低/默认，最高支持 API 36，Gradle 最低 8.13。仓库实际选用 Gradle 8.14 和 SDK 36。
- [Android Emulator command-line options](https://developer.android.com/studio/run/emulator-commandline)：Linux KVM、`-accel off` 的软件模拟限制、`ANDROID_I_WANT_MY_TCG=yes`。
- [Configure hardware acceleration for the Android Emulator](https://developer.android.com/studio/run/emulator-acceleration)：图形加速与 VM 加速分别配置；没有 hypervisor 时需要慢速代码块转换。

## 11. 给实施者与 evaluator 的交接

实施者先选一个有基线证据的候选组，记录行为假设，再做最小真实改动。独立 evaluator 只对可运行的候选实际操作和评分；静态计划不计轮次。

首屏理解任务不要预先告诉 evaluator“文件夹与屏幕要同级”，而是只给真实初始画面，问产品是什么、可做哪些事、第一步是什么。功能发现任务也只描述目标，例如“让一个工作文件夹里之后修改的内容继续归档”或“把这段想法和一张图片保存下来”，记录实际误判、回退和最终结果。之后由熟悉功能清单的 evaluator 对照是否完整、归属是否一致、旅程是否结束。

N6 尤其需要按真实结果判断：文字仍在 Mac 草稿、复制成功、中央编辑器打开，是清楚的跨工作台衔接；在中央真正完成带附件笔记并可找回，才是该跨端任务成功。二者应分别记录，不把打开链接当作已经保存附件。
