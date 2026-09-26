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
    { "id": "mote.personal-memory", "version": "1" },
    { "id": "mote.coding-memory", "version": "1" }
  ]
}
```

两个内置组合共用上下文提取器，审核器分别判断个人和 Coding 产物；它们都能处理日记或 Coding 会话等来源。一方的审核拒绝不会否决另一方。未显式选择组合时，现有默认来源处理流程继续工作；自动接收队列的多组合启用配置和 UI 选择仍待实现。

## 固定版本与共享产物

任务批次固定配方、提取器和审核器的 ID、版本及定义指纹。完成检查点包含组合身份、评估时刻、显示时区和语言；替换审核器或更改评估语境不能误命中另一结果的完成记录。Memory 产物保留完整组合来源，审核回执另存实际审核策略指纹。不同组合的产物分别保留，不静默覆盖已确认事实。可替换的跨策略去重、关联与冲突整合仍是后续工作。

同一提取器、原件内容及元数据、范围、模型配置、语言、评估时刻和输入解释完全相同时，可共享已经通过公共校验的提取草稿。审核版本不属于生成缓存键，所以只换审核器可复用生成结果；提取器变化则重新生成。模型使用中性的 `memory-strategy` 程序执行显式策略，不自动叠加旧来源程序的价值判断。输出格式、精确引用、权限和只读范围仍由公共层强制执行。

评估时刻默认固定为任务创建时刻。重放可显式传 `contextTime`（带时区的 ISO 时间）；它只决定模型的评估语境，不改变原件接收时间、收费授权或证据可见性。只有评估时刻也相同，跨任务才可能命中同一生成缓存或完成检查点；需要复现同次评估时应沿用该时刻。缓存仍受原有条数、体积及库配额约束，复用不产生新的模型用量记录，也不是审核通过的凭据。

## 失败、恢复与删除

配方缺失、组件被注销或已有任务的定义指纹不再匹配，会在调用模型之前返回 `memory_strategy_unavailable`。执行中和提交前也检查固定定义。恢复原定义后，显式重试可以复用有效草稿；不会换用另一策略完成旧任务。同一证据的工作沿用共享资源锁，避免同时重复生成。

单个审核失败不阻止无依赖批次完成；失败重试保留其他已完成批次。证据更正、删除及取消继续经过公共失效和提交边界，相关私有草稿随依赖失效清除。提取结果不能绕过语义审核直接发布；所有 Memory 仍先保存为提案。

## 当前证据边界

生成资料经真实应用入口和已安装部署模块验证了同源个人/Coding 组合、提取与审核各自换版本、跨普通来源和 Coding 归档复用、重启、单审核失败、注销与恢复、精确引用拒绝和更正失效。真实 Harness 配合本地脚本提供方验证了中性程序和只读范围。以上证明执行契约，不代表真实模型已产出高质量 Memory；音频解析复用、多组合自动启用、UI、可替换整合策略及私有真实数据质量验收仍须分别完成。
