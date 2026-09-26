# Memory 策略组合

Memory 的提取与语义审核可以由本地受信插件分别注册，通过具名配方组合。它们复用 `MemoryPipeline`、现有执行引擎、正式资料锚点、模型预算和私有草稿缓存，不另建任务引擎或模型客户端。

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
    { "id": "mote.coding-memory", "version": "1" }
  ]
}
```

两个内置组合共用上下文提取器，审核器分别判断个人和 Coding 产物；它们都能处理日记或 Coding 会话等来源。一方的审核拒绝不会否决另一方。手工任务未传 `recipes` 时仍沿用原有默认流程；正式来源资料的自动接收队列使用下面的独立启用配置。

`mote.personal-memory@2` 使用同一提取器和独立的 `mote.personal-review@2`。新版个人审核区分普通任务线索与有依据的个人意义或后续用途：单次感受、重要经历、有意义的愿望、明确约束及限定用途的资源关联仍可收录；不能仅以“未来可能追踪”为由，将待办、普通开发进度和一次性安排升为选中 Memory。这是可替换的产品政策，不是公共层的关键词规则，也不限制 Coding 或其他策略。版本 1 保留原定义；安装新版本不改变已有选择或重算历史。

## 自动接收的组合选择

所有者在「系统管理 → 模型与服务 → 模块与模型 → 自动 Memory 组合」选择默认组合，或为某个来源保存覆盖组合。可同时选多个配方、选择空组合关闭新资料的自动 Memory 工作，或让来源跟随默认组合。来源覆盖是所有者的明确选择，不根据来源名称或正文推断语义类别。

`GET /api/memory-recipe-settings` 返回默认选择，加 `?sourceId=...` 返回来源的有效选择及是否继承。每个条目包括固定的组件版本/指纹和当前是否可用。通过 `PUT /api/memory-recipe-settings` 保存：

```json
{
  "sourceId": "an-existing-source-id",
  "recipes": [
    { "id": "mote.personal-memory", "version": "2" },
    { "id": "mote.coding-memory", "version": "1" }
  ]
}
```

省略 `sourceId` 修改默认；`recipes: []` 关闭该范围的新自动工作；指定来源并传 `recipes: null` 恢复继承。配置接口只接受所有者凭据，采集端不能修改。首次建立这份配置时只选择 `mote.personal-memory@2`；Coding 和其他已安装配方不自动开启。已有配置固定确切定义，不跟随安装版本漂移。缺失的已选组件会显示为不可用，不偷偷替换为另一策略。

原件接收事务为当时选中的每个配方分别保存授权或拒绝，并固定同一接收时刻作为评估语境。公共队列按资料和配方范围保存状态，首次发布只延续自己的未用授权；重复接收、后来启用、改版本、重启和确定性重建都不补发历史授权。全局自动提取和来源处理开关仍需允许。收费历史处理继续通过所有者显式创建的 Memory job 发起。

停用某个组合会在保存配置的同一事务中撤销对应接收授权，再取消相关在途工作；执行及提交边界也校验授权，迟到结果不能提交。重新开启只对后续新接收的原件生效。其他组合可以继续，已有 Memory 不因停用而删除。旧的单范围自动队列升级时保留资料及依赖状态，取消无法固定策略的旧工作，不据此重算历史。

## 固定版本与共享产物

### 配方自己的输入依赖

Memory 配方可声明 `requires: ['extracted-text']`，或 `requires: ['source-body']`。这些名称是处理契约，不是正文语义类别。省略时使用来源的默认依赖；已有内置配方因此继续适用于多种来源。改变依赖也要更换配方版本，不能改写已固定的定义。

组织器在 `MaterialDraft.artifacts` 中用 `blockIds` 声明产物对应的证据块，例如 `{key: 'extracted-text', state: 'ready', blockIds: ['chunk-1']}`。发布时拒绝重复产物名、重复或不存在的块。当前 source-item 组织器分别映射来源记录、原文、原件和提取正文；文件协议的原始 `text` 为空，所以 `source-record` 可以是元数据线索，不能冒充转写正文。是否沉淀为长期 Memory 仍由所选提取与审核策略判断。

每个自动配方独立等待自己的输入。任务固定依赖名称、产物版本和对应证据锚点的指纹，在入队、读取、执行及提交时重新检查。无关转写完成、失败或更正不会撤销仅依赖仍有效来源记录的任务；所需转写被更正则拒绝旧结果。模型只能读取当前批次已授权的证据，不能沿整个任务的输入清单扩大读取范围。配方依赖不能越过来源启用、隐私、模型本地性和暴露路由。

同名或不同名依赖若最终选择完全相同的有效证据、提取器和评估语境，仍可共用一次提取。输入门禁不额外增加模型调用；恢复转写不会自动授予历史 Memory 重算权限。缺少 `blockIds` 的组织器和特殊 `material` 依赖仍固定整份资料版本，不承诺局部更新独立性。

手工 `POST /api/memory-jobs` 按范围选择时也遵循显式配方的输入依赖，并返回未就绪或不可用资料的选择状态。一次手工合并的多配方任务要求每份入选资料满足全部所选配方，执行时也保留整个任务的依赖检查；不会忽略某个所选策略后开始处理。需要各自等待与恢复时使用独立任务；自动来源队列已经按配方拆分。手工聚合任务的进一步独立调度仍未完成。

任务批次固定配方、提取器和审核器的 ID、版本及定义指纹。完成检查点包含组合身份、评估时刻、显示时区和语言；替换审核器或更改评估语境不能误命中另一结果的完成记录。Memory 产物保留完整组合来源，审核回执另存实际审核策略指纹。不同组合的产物分别保留，不静默覆盖已确认事实。可替换的跨策略去重、关联与冲突整合仍是后续工作。

同一提取器、原件内容及元数据、范围、模型配置、语言、评估时刻和输入解释完全相同时，可共享已经通过公共校验的提取草稿。审核版本不属于生成缓存键，所以只换审核器可复用生成结果；提取器变化则重新生成。模型使用中性的 `memory-strategy` 程序执行显式策略，不自动叠加旧来源程序的价值判断。输出格式、精确引用、权限和只读范围仍由公共层强制执行。

自动任务创建时读取所有者的「提取批次字符上限」，把实际值和具体范围固定在任务中；手工请求仍可显式指定批次上限。后续修改只作用于新任务，不能改写在途或恢复任务的范围，也不触发历史重算。

手工任务的评估时刻默认固定为创建时刻；同次自动接收的各组合共享接收时刻。重放可显式传 `contextTime`（带时区的 ISO 时间）；它只决定模型的评估语境，不改变原件接收时间、收费授权或证据可见性。只有评估时刻也相同，跨任务才可能命中同一生成缓存或完成检查点；需要复现同次评估时应沿用该时刻。缓存仍受原有条数、体积及库配额约束，复用不产生新的模型用量记录，也不是审核通过的凭据。

## 失败、恢复与删除

配方缺失、组件被注销或已有任务的定义指纹不再匹配，会在调用模型之前返回 `memory_strategy_unavailable`。执行中和提交前也检查固定定义。恢复原定义后，显式重试可以复用有效草稿；不会换用另一策略完成旧任务。同一证据的工作沿用共享资源锁，避免同时重复生成。

单个审核失败不阻止无依赖批次完成；失败重试保留其他已完成批次。取消任务结束该消费者的工作，拒绝它后续返回的模型结果，不把已经验证的共享提取阶段一起撤销。其他消费者必须有自己的授权、完全匹配的输入、当前证据及独立审核；它们可以在重启后继续复用该草稿。草稿仍为有界的私有缓存，不能通过公共任务接口读取，不代表 Memory 准入通过；单任务的非共享草稿仍在取消时清除。

原件删除、保留期清理、更正和依赖失效会清除相关共享草稿。删除先在事务中沿仍存在的依赖关系撤销产物和检查点，再进行原件及正式资料的级联删除，避免丢失清理所需的关联。提取结果不能绕过语义审核直接发布；所有 Memory 仍先保存为提案。

## 当前证据边界

生成资料经真实应用入口和已安装部署模块验证了同源个人/Coding 组合、提取与审核各自换版本、跨普通来源和 Coding 归档复用、重启、单审核失败、注销与恢复、精确引用拒绝和更正失效。自动队列另验证默认/来源覆盖、同源共享提取、每个配方独立授权、失败后只重试审核、停用不影响另一组合、提交时拒绝撤权结果及旧队列升级。界面有生成数据交互回归。真实 Harness 配合本地脚本提供方验证了中性程序和只读范围。

这些验证首先证明执行契约；真实私有资料已完成的定向审核对照见验证记录，不能代替全体资料质量验收。新增回归固定真正产生草稿的自动任务，在审核中停用它，再跨重启运行另一已授权策略，实际调用计数仍只有一次提取；删除、保留期清理和更正均清除该草稿。

命名输入回归使用生成 WAV、脚本 ASR/模型及实际 UTF-8 文件处理器，验证转写失败时来源记录索引仍可完成、重启后恢复转写、两个转写消费者共享提取、单审核失败只重试审核，以及更正只使相关产物过时。另一普通文本来源用相同锚点同时生成个人 Memory 与观察线索，提取一次、审核两次。还验证了手工范围入口、21 个转写块跨两个批次时的模型实际读取范围、提交时隐私撤权和 Coding 追加块映射。真实音频/图文解析质量及组合复用、更多实际保留集、可替换整合策略和大数据量 UI 仍待完成；生成夹具不替代这些验收。

`scripts/test-memory-recipes-ui.cjs` 在隔离库启动实际服务与 Electron 渲染器，只创建生成来源，不调用模型；验证默认组合、来源覆盖、刷新恢复、继承、空选择和桌面/窄屏布局。先运行 `npm run build -w @mote/server` 与 `npm run build -w @mote/web`，再用 `MOTE_RECIPE_UI_OUTPUT=/private/output node_modules/.bin/electron scripts/test-memory-recipes-ui.cjs` 运行。输出目录保存截图和结果；这不是 Android 真机或真实资料负载验证。

`scripts/test-automatic-memory-live.ts` 接收 `MOTE_AUTO_MANIFEST` 中最多三条完整 authored 原文和全新的 `MOTE_AUTO_OUTPUT` 目录，固定本地 `gpt-6-sol / max`，通过 source 接收与公共队列运行个人/Coding 自动组合。每份原文最多一次提取和两次审核，整轮最多 20 分钟，不自动重试失败。记录确切代码哈希、来源角色、授权、实际调用、用量和前台读取，再验证重启/重复接收/切换设置不追加历史工作。输出必须在 Git 之外；`passed` 只证明该运行检查的公共契约，不自动代表语义质量或保留集通过。

## 独立审核迭代的对照方法

`scripts/review-memory-recipe-live.ts` 接收已完成的私有 progressive replay 目录和全新输出目录，在私有副本上通过实际应用的 MemoryPipeline 创建新版本审核任务。保留原来的证据分组、提取器、模型配置和评估时刻；若缓存不匹配，在收费提取前失败，不偷偷重跑。核对实际审核调用、trace、旧产物不变与原文哈希，报告单独统计新增任务用量。基线目录和报告保持不变。

```sh
MOTE_REVIEW_BASELINE=/private/completed-replay \
MOTE_REVIEW_OUTPUT=/private/new-review-comparison \
node --import tsx scripts/review-memory-recipe-live.ts
```

默认比较 `mote.personal-memory@2`，可用 `MOTE_REVIEW_RECIPE` 提供明确的已安装配方引用。仅适用于同提取器、最多 8 个已完成批次的定向比较。脚本固定本地 Codex App Server 的 `gpt-6-sol / max`，不恢复未完成基线，不覆盖历史报告。

`scripts/test-personal-review-live.ts` 使用 `scripts/fixtures/personal-review-cases.ts` 的生成原文和故意可疑的提案验证审核边界；使用 `MOTE_REVIEW_FIXTURE_OUTPUT` 指定全新私有输出目录。案例预期只用于执行后的独立复核，不送入审核策略，不以关键词自动宣告语义通过。该脚本未验证提取或全流程，也不是未见过的真实保留集。两个脚本的 `status=passed` 仅表示执行及公共契约检查通过，`semanticQualityAccepted` 保持 false；原文、结果、独立 rubric 与人工判断仍需逐项核对。
