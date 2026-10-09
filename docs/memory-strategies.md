# Memory 策略组合

Memory 的提取与语义审核可以由本地受信插件分别注册，通过具名配方组合。它们复用 `MemoryPipeline`、现有执行引擎、正式资料锚点、模型预算和私有草稿缓存，不另建任务引擎或模型客户端。2026-10-07 起，已授权来源的新输入持续处理，普通自动提取关闭语义被取代；归属与迁移契约见 [ADR](adr-material-attribution.md)。

## 安装与执行

部署模块沿用 `ConnectorManifest`，纯 Memory 模块可声明 `sourceKinds: []`。在 `init` 中通过 `ctx.memoryStrategies` 注册提取器、审核器和配方，在 `close` 中调用返回的注销函数。安装只登记能力，不启用自动处理、不重算历史，也不删除已有产物。

```ts
const stopExtract = ctx.memoryStrategies.registerExtraction({
  id: 'example.extraction', version: '1',
  input: 'memory-evidence@1', output: 'memory-candidates@1',
  permissions: ['evidence.read'],
  prompt: 'Read the supplied originals and propose supported candidates under this product policy …',
});
const stopReview = ctx.memoryStrategies.registerReview({
  id: 'example.review', version: '1',
  input: 'memory-candidates@1', output: 'memory-candidates@1',
  permissions: ['evidence.read'],
  policy: 'Independently inspect the originals and apply this admission policy …',
});
const stopRecipe = ctx.memoryStrategies.registerRecipe({
  id: 'example.memory', version: '1',
  extract: { id: 'example.extraction', version: '1' },
  review: { id: 'example.review', version: '1' },
});
```

以上字符串是受信部署定义，不从捕获正文加载。模块只能声明当前支持的只读输入输出契约；不能通过配方扩展工具权限或替换公共校验。此版是本地插件接入，不提供插件市场或任意不可信代码隔离。

所有者可从 `GET /api/memory-recipes` 查看已安装配方及依赖可用状态，通过现有 `POST /api/memory-jobs` 显式选择一个或多个组合：

```json
{
  "evidenceIds": ["a-current-formal-evidence-uuid"],
  "recipes": [
    { "id": "mote.personal-memory", "version": "2" },
    { "id": "mote.coding-memory", "version": "2" }
  ]
}
```

两个内置组合共用上下文提取器，审核器分别判断个人和 Coding 产物；它们都能处理日记或 Coding 会话等来源。一方的审核拒绝不会否决另一方。手工任务未传 `recipes` 时仍沿用原有默认流程；正式来源资料的自动接收队列使用下面的独立组合选择。

`mote.personal-memory@2` 使用同一提取器和独立的 `mote.personal-review@2`。新版个人审核区分普通任务线索与有依据的个人意义或后续用途：单次感受、重要经历、有意义的愿望、明确约束及限定用途的资源关联仍可收录；不能仅以“未来可能追踪”为由，将待办、普通开发进度和一次性安排升为选中 Memory。这是可替换的产品政策，不是公共层的关键词规则，也不限制 Coding 或其他策略。当前 MVP 只安装内置 v2 配方与审核；自定义已选版本仍固定定义，安装不授权历史重算。

`mote.coding-memory@2` 只替换独立的 `mote.coding-review@2`，继续共享原提取器。审核保留有依据的工程决定、失败机制与适用经验中的具体接口、前提、实施顺序和验证边界，可从原文补回草稿遗漏的必要细节；相关进展可以作为这条经验的上下文，但不能仅凭报错、修补、PR 或成功自述构成长效经验。尚未实施的有理由设计也可收录，须区分他人建议、用户采纳、已完成与未知。具体测试及结果才支持相应范围内的 `tested`，不能把未测试部分一并升级。内置 Coding v1 与个人 v1 已移除；当前配方仍固定自身定义，不因安装自动重算历史。

## 自动接收的组合选择

所有者在「系统管理 → 模型与服务 → 模块与模型 → 自动 Memory 组合」选择非空默认组合，或为某个来源保存非空覆盖组合，也可让来源跟随默认。来源覆盖是所有者的明确选择，不根据来源名称或正文推断语义类别。已授权来源的新资料持续处理，普通用户无需另行开启 Memory；来源暂停接收、模型及隐私授权仍是独立边界。

`GET /api/memory-recipe-settings` 返回默认选择，加 `?sourceId=...` 返回来源的有效选择及是否继承。每个条目包括固定的组件版本/指纹和当前是否可用。通过 `PUT /api/memory-recipe-settings` 保存：

```json
{
  "sourceId": "an-existing-source-id",
  "recipes": [
    { "id": "mote.personal-memory", "version": "2" },
    { "id": "mote.coding-memory", "version": "2" }
  ]
}
```

省略 `sourceId` 修改默认；新的 `recipes: []` 被拒绝；指定来源并传 `recipes: null` 恢复继承。持久化空选择也被拒绝；继承由缺少来源覆盖记录表示。配置接口只接受所有者凭据，采集端不能修改。首次建立这份配置时只选择 `mote.personal-memory@2`；Coding 和其他已安装配方不自动开启。已有非空配置固定确切定义，不跟随安装版本漂移。缺失的已选组件会显示为不可用，不偷偷替换为另一策略。

原件接收事务为当时选中的每个配方分别保存授权或拒绝，并固定同一接收时刻作为评估语境。公共队列按资料和配方范围保存状态，首次发布只延续自己的未用授权；重复接收、后来选择、改版本、重启和确定性重建都不补发历史授权。当前 API 拒绝 extraction.enabled:false 及来源 memory 字段；未授权输入和拒绝收据不能因重启、改配方而获得授权。收费历史处理继续通过所有者显式创建的 Memory job 发起。

从非空选择中移除某个组合，会在保存配置的同一事务中撤销对应接收授权，再取消相关在途工作；执行及提交边界也校验授权，迟到结果不能提交。再次选择只对后续新接收的原件生效。其他组合可以继续，已有 Memory 不因移除而删除。旧的单范围自动队列升级时保留资料及依赖状态，取消无法固定策略的旧工作，不据此重算历史。

## 固定版本与共享产物

### 配方自己的输入依赖

Memory 配方可声明 `requires: ['extracted-text']`，或 `requires: ['source-body']`。这些名称是处理契约，不是正文语义类别。省略时使用来源的默认依赖；已有内置配方因此继续适用于多种来源。改变依赖也要更换配方版本，不能改写已固定的定义。

组织器在 `MaterialDraft.artifacts` 中用 `blockIds` 声明产物对应的证据块，例如 `{key: 'extracted-text', state: 'ready', blockIds: ['chunk-1']}`。发布时拒绝重复产物名、重复或不存在的块。当前 source-item 组织器分别映射来源记录、原文、原件和提取正文；文件协议的原始 `text` 为空，所以 `source-record` 可以是元数据线索，不能冒充转写正文。是否沉淀为长期 Memory 仍由所选提取与审核策略判断。

每个自动配方独立等待自己的输入。任务固定依赖名称、产物版本和对应证据锚点的指纹，在入队、读取、执行及提交时重新检查。无关转写完成、失败或更正不会撤销仅依赖仍有效来源记录的任务；所需转写被更正则拒绝旧结果。模型只能读取当前批次已授权的证据，不能沿整个任务的输入清单扩大读取范围。配方依赖不能越过来源启用、隐私、模型本地性和暴露路由。

同名或不同名依赖若最终选择完全相同的有效证据、提取器和评估语境，仍可共用一次提取。输入门禁不额外增加模型调用；恢复转写不会自动授予历史 Memory 重算权限。缺少 `blockIds` 的组织器和特殊 `material` 依赖仍固定整份资料版本，不承诺局部更新独立性。

手工 `POST /api/memory-jobs` 按范围选择时遵循显式配方的输入依赖，并返回未就绪或不可用资料的选择状态。多配方选择保留各配方独立 input plan 及显式命名产物；就绪配方可以处理，等待配方保持自己的依赖和恢复状态。自动依赖不能覆盖手工选中的 OCR、转写等产物。

任务批次固定配方、提取器和审核器的 ID、版本及定义指纹。完成检查点包含组合身份、评估时刻、显示时区和语言；替换审核器或更改评估语境不能误命中另一结果的完成记录。Memory 产物保留完整组合来源，审核回执另存实际审核策略指纹。不同组合的产物分别保留；审核后的显式替代关系按目标版本原子应用并保留历史。可替换的跨策略去重、关联与冲突整合仍是后续工作。

同一提取器、原件内容及元数据、范围、模型配置、语言、评估时刻和输入解释完全相同时，可共享已经通过公共校验的提取草稿。审核版本不属于生成缓存键，所以只换审核器可复用生成结果；提取器变化则重新生成。模型使用中性的 `memory-strategy` 程序执行显式策略，不自动叠加旧来源程序的价值判断。输出格式、精确引用、权限和只读范围仍由公共层强制执行。

自动任务创建时读取所有者的「提取批次字符上限」，把实际值和具体范围固定在任务中；手工请求仍可显式指定批次上限。后续修改只作用于新任务，不能改写在途或恢复任务的范围，也不触发历史重算。

手工任务的评估时刻默认固定为创建时刻；同次自动接收的各组合共享接收时刻。重放可显式传 `contextTime`（带时区的 ISO 时间）；它只决定模型的评估语境，不改变原件接收时间、收费授权或证据可见性。只有评估时刻也相同，跨任务才可能命中同一生成缓存或完成检查点；需要复现同次评估时应沿用该时刻。缓存仍受原有条数、体积及库配额约束，复用不产生新的模型用量记录，也不是审核通过的凭据。

## 失败、恢复与删除

配方缺失、组件被注销或已有任务的定义指纹不再匹配，会在调用模型之前返回 `memory_strategy_unavailable`。执行中和提交前也检查固定定义。恢复原定义后，显式重试可以复用有效草稿；不会换用另一策略完成旧任务。同一证据的工作沿用共享资源锁，避免同时重复生成。

单个审核失败不阻止无依赖批次完成；失败重试保留其他已完成批次。取消任务结束该消费者的工作，拒绝它后续返回的模型结果，不把已经验证的共享提取阶段一起撤销。其他消费者必须有自己的授权、完全匹配的输入、当前证据及独立审核；它们可以在重启后继续复用该草稿。草稿仍为有界的私有缓存，不能通过公共任务接口读取，不代表 Memory 准入通过；单任务的非共享草稿仍在取消时清除。

原件删除、保留期清理、更正和依赖失效会清除相关共享草稿。删除先在事务中沿仍存在的依赖关系撤销产物和检查点，再进行原件及正式资料的级联删除，避免丢失清理所需的关联。提取结果不能绕过语义审核直接生效；审核及公共证据校验通过后自动生效，不需用户确认。

## 当前证据边界

生成资料经真实应用入口和已安装部署模块验证了同源个人/Coding 组合、提取与审核各自换版本、跨普通来源和 Coding 归档复用、重启、单审核失败、注销与恢复、精确引用拒绝和更正失效。自动队列另验证默认/来源覆盖、同源共享提取、每个配方独立授权、失败后只重试审核、停用不影响另一组合、提交时拒绝撤权结果及旧队列升级。界面有生成数据交互回归。真实 Harness 配合本地脚本提供方验证了中性程序和只读范围。

这些验证首先证明执行契约；真实私有资料已完成的定向审核对照见验证记录，不能代替全体资料质量验收。新增回归固定真正产生草稿的自动任务，在审核中停用它，再跨重启运行另一已授权策略，实际调用计数仍只有一次提取；删除、保留期清理和更正均清除该草稿。

命名输入回归使用生成 WAV、脚本 ASR/模型及实际 UTF-8 文件处理器，验证转写失败时来源记录索引仍可完成、重启后恢复转写、两个转写消费者共享提取、单审核失败只重试审核，以及更正只使相关产物过时。另一普通文本来源用相同锚点同时生成个人 Memory 与观察线索，提取一次、审核两次。还验证了手工范围入口、21 个转写块跨两个批次时的模型实际读取范围、提交时隐私撤权和 Coding 追加块映射。真实音频/图文解析质量及组合复用、更多实际保留集、跨域整合/去重和大数据量 UI 仍待完成；生成夹具不替代这些验收。

`scripts/test-memory-recipes-ui.cjs` 在隔离库启动实际服务与 Electron 渲染器，只创建生成来源，不调用模型；验证默认组合、来源覆盖、刷新恢复、继承、空选择和桌面/窄屏布局。先运行 `npm run build -w @mote/server` 与 `npm run build -w @mote/web`，再用 `MOTE_RECIPE_UI_OUTPUT=/private/output node_modules/.bin/electron scripts/test-memory-recipes-ui.cjs` 运行。输出目录保存截图和结果；这不是 Android 真机或真实资料负载验证。

`scripts/test-automatic-memory-live.ts` 接收 `MOTE_AUTO_MANIFEST` 中最多三条完整 authored 原文和全新的 `MOTE_AUTO_OUTPUT` 目录，固定本地 `gpt-6-sol / max`，通过 source 接收与公共队列运行个人/Coding 自动组合。每份原文最多一次提取和两次审核，整轮最多 20 分钟，不自动重试失败。记录确切代码哈希、来源角色、授权、实际调用、用量和前台读取，再验证重启/重复接收/切换设置不追加历史工作。输出必须在 Git 之外；`passed` 只证明该运行检查的公共契约，不自动代表语义质量或保留集通过。

## 独立审核迭代的对照方法

`scripts/review-memory-recipe-live.ts` 接收已完成的私有 progressive replay 或 automatic-memory 目录和全新输出目录，在私有副本上通过实际应用的 MemoryPipeline 创建新版本审核任务。按每个实际原任务保留证据分组、提取器、模型配置、评估时刻、语言、时区及正式资料依赖；不能用报告开始时间替代任务语境。若缓存不匹配，在收费提取前失败，不偷偷重跑。核对实际审核调用、trace、原草稿身份、旧产物不变与原文哈希，报告单独统计新增任务用量。基线目录和报告保持不变。

```sh
MOTE_REVIEW_BASELINE=/private/completed-replay \
MOTE_REVIEW_OUTPUT=/private/new-review-comparison \
node --import tsx scripts/review-memory-recipe-live.ts
```

默认比较 `mote.personal-memory@2`，可用 `MOTE_REVIEW_RECIPE` 提供明确的已安装配方引用。仅适用于同提取器、最多 8 个已完成批次的定向比较。脚本固定本地 Codex App Server 的 `gpt-6-sol / max`，不恢复未完成基线，不覆盖历史报告。

例如只更换 Coding 审核器时显式设置 `MOTE_REVIEW_RECIPE='{"id":"mote.coding-memory","version":"2"}'`。最多每个原批次一次新审核，各 300 秒，整轮额外预留 60 秒；不自动重跑失败。基线必须仍保有有效共享草稿和完全匹配的资料及模型身份。

`scripts/test-personal-review-live.ts` 使用 `scripts/fixtures/personal-review-cases.ts` 的生成原文和故意可疑的提案验证审核边界；使用 `MOTE_REVIEW_FIXTURE_OUTPUT` 指定全新私有输出目录。案例预期只用于执行后的独立复核，不送入审核策略，不以关键词自动宣告语义通过。该脚本未验证提取或全流程，也不是未见过的真实保留集。两个脚本的 `status=passed` 仅表示执行及公共契约检查通过，`semanticQualityAccepted` 保持 false；原文、结果、独立 rubric 与人工判断仍需逐项核对。

该生成审核脚本默认保持个人 v2 案例，可显式设置 `MOTE_REVIEW_FIXTURE_STRATEGY=coding-v2`，使用 `scripts/fixtures/coding-review-cases.ts` 的四例独立准入与细节回归。仍只允许一次最多 300 秒的审核，不调用提取器；环境选择是测试配置，不是生产内容分类。

## 可替换的整合与审核

本地受信模块可用 `registerIntegration` 注册 `memory-cards@1 → memory-candidates@1` 的整合策略，并用 `registerIntegrationRecipe({id, version, integrate, review})` 组合整合器和独立审核器。两者分别引用固定版本；整合审核器声明 `permissions: ['memory.read', 'evidence.read']`。内置组合为 `mote.memory-integration@1`。任务采用中性的 `memory-integration` Agent 程序，允许只读检索卡片与原件；语义价值与冲突判断来自所选策略。

公共层继续执行权限和资料准入、精确引用、父卡片直接证据、关系目标版本、删除传播、提交事务、取消和用量核算。安装内容的指纹、输入卡片的完整版本以及模型配置固定在已有生命周期检查点中；删除/修改原件、更新父卡片、替换定义或改变模型配置都会阻止旧结果提交。产物保存 `integration` 配方、整合器与审核器指纹及独立审核凭据，审核后的关系在提交事务中自动生效，版本冲突拒绝提交；用户仍可主动纠正或删除。

所有者 API：

- `GET /api/memory-integration-recipes`：已安装组合及可用状态。
- `GET/PUT /api/memory-integration-settings`：选择自动整合配方，写入体为 `{recipe: {id, version}}`，`{recipe: null}` 停用。
- `POST /api/memory-integrations`：明确选择 `inputs: [{id, version, fingerprint}]` 和一个 `recipe`，返回既有生命周期任务及操作 ID。服务端在同一事务中核对卡片版本与指纹并冻结输入；发生并发修正时返回 `409 memory_selection_changed`，需要刷新后重新选择。只发送旧式 `memoryIds` 的请求不会被接受。受当前 `consolidation.maxItems` 限制，最多 50 张卡片。
- `POST /api/memory-integrations/:id/cancel`、`.../:id/retry`：取消或显式重试当前任务；状态沿用 `/api/memory-settings`。

自动配方切换只授权选择之后的 Memory 日志增量，不隐式重跑历史。再次保存同一配方不改变授权起点。初始化默认组合、安装和重启也不会补跑已有卡片。停用或换选会撤销旧的待执行自动窗口，保留已有产物；明确手工发起的历史任务有自己的固定授权，不因自动选择变化而被撤销。自动开关与手工任务分开，采集端令牌无权访问这些管理接口。

整合复用已有 `MemoryLifecycle`、`ExecutionEngine`、模型账本和 Memory 存储，没有第二套队列或数据库。当前一个自动整合配方、一个活动窗口；窗口仍按个人/Coding 域处理。一个域失败不阻止另一个域完成，检查点与产物在同一事务内提交，恢复跳过已完成域。最多自动尝试三次，之后必须显式重试。开放检索会读取检查点之外的当前卡片，因此失败域重试暂时重新生成并审核，不复用提取阶段的有界草稿缓存。空结果直接完成，不追加无意义审核。

该版本支持可替换的整合提案和既有 `contradicts`/`supersedes` 关系；**跨域等价/关联、可替换的去重检索视图、同时启用多个自动整合策略及整合管理 UI 仍未完成**。不能以这些接口或一次空结果宣称完整整合目标已完成。

生成应用回归实际安装插件，并独立更换整合器、审核器，覆盖个人/Coding 共用原件、历史授权、跨重启定义固定、取消与删除、模型配置变化、错误引用/关系版本、两种失败顺序的局部恢复、最大输入长度和采集端鉴权。`scripts/test-memory-integration-live.ts` 在一个已完成自动回放的私有副本上，选择其全部（最多 8 张）个人 Memory，使用本地 Codex App Server `gpt-6-sol / max`，最多两次外层调用和 400 秒、一次实际尝试；复用原件、保存调用/用量/原文、验证旧产物不变及重启不重跑。`MOTE_INTEGRATION_BASELINE` 与新的 `MOTE_INTEGRATION_OUTPUT` 必须在 Git 之外。执行通过和语义价值分别判断，零产出不证明正向整合能力。

调研依据（2026-09-27）：[Graphiti 当前 main 的去重提示代码](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/dedupe_edges.py) 区分重复与冲突，并保留日期、数值和限定条件差异；[Mem0 Dream 官方产品说明](https://mem0.ai/blog/dream-background-memory-consolidation-for-ai-agents) 区分合并、替代和综合，使用条件写入并将启用范围限定于之后的新活动。后者是托管产品说明，不是已审计的开源实现。此前借鉴了这些边界且未引入新依赖；2026-09-27 的自动生效契约进一步采用版本绑定的审核后原子替代并保留历史。

## Rolling packages and reviewer-stage recovery (2026-10-10)

Ordinary automatic inputs form bounded structural packages under their exact receipt/generation contracts. Packing does not imply semantic relatedness. Member time, attribution and target ranges remain independent; zero candidates still require review. Reviewer format/coverage failure preserves a valid extraction draft and repairs review only, subject to current evidence, recipe, configuration and deletion policy. An uncommitted saturated/incomplete batch is subdivided in full; checked declarations are not committed results. Coding reuse requires exact complete unsaturated v2 products. Existing cache bounds, retention and full-evidence locks remain. See [ADR](adr-system-refactor.md).
