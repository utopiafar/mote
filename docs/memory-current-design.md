# Memory 当前设计

日期：2026-11-08。状态：当前实现说明。范围：本文记录当前代码里的 Memory 主链路、数据与状态、五项保证和已冻结的可替换接口。旧 ADR 和历史设计稿只作为决策记录；本文不描述后续目标设计。

代码位置约定：路径相对于仓库根；`文件` 加函数/常量名指向具体实现，行号可能随重构移动，以符号为准。

## 1. 主链路

Memory 不是一次模型调用，而是宿主编排、可恢复的多阶段链路：

**提取 → 独立审查 → 反馈规划 → 整合 → 发布**

宿主负责来源与模型授权、范围固定、证据校验、持久化、重试、取消和删除；模型只做语义选择。主执行器是共享的 `ExecutionEngine`，Memory 没有第二套队列或数据库（`apps/server/src/memory-pipeline.ts` `MemoryPipeline` 构造函数注册 `memory.input`、`memory.batch`；`apps/server/src/execution-engine.ts` `ExecutionEngine`）。

### 1.1 入口与任务

- 自动入口：来源资料与 Material 完成接收后，`MaterialMemoryWork` 用固定配方和接收授权创建 Memory job（`apps/server/src/material-memory-work.ts` `MaterialMemoryWork` 的 `create` 调用）。语义资料入口走 `MemoryPipeline.createFromArtifacts`（`apps/server/src/memory-pipeline.ts`）。
- 手工入口：`POST /api/memory-jobs` 创建显式范围/配方任务，`POST /api/memories/extract` 创建一次带独立审查的手工提取（`apps/server/src/features/memory/runtime.ts`；`apps/server/src/features/memory/publication.ts` `registerMemoryExtractRoute`）。
- `MemoryPipeline.create` 在创建时固定证据、配方、工作契约、评估时刻、时区、语言、批次字符上限和模型配置；跨重启不重新解释旧任务（`apps/server/src/memory-pipeline.ts` `MemoryPipeline.create`）。手工输入计划在 `MemoryPipeline.createManual` 中固定，计划本身由 `memory_input_plans` 保存。
- 任务和批次分别保存为 `memory_jobs` / `memory_batches`；输入计划保存为 `memory_input_plans`；执行步骤复用共享 `execution_steps`，失败回执复用 `execution_failures`（`apps/server/src/memory-storage-schema.ts`；`apps/server/src/memory-input-plans.ts` `MemoryInputPlans`；`apps/server/src/execution-engine.ts`）。
- 自动准入可暂停、排空和立即停止。`MemoryAutomation` 保存 `desired / generation / cutoff / barrier / stopRequested`，`MemoryLifecycle` 保存每个自动扩展的游标、活动窗口和检查点（`apps/server/src/memory-automation.ts` `MemoryAutomation`；`apps/server/src/memory-lifecycle.ts` `MemoryLifecycle`）。

### 1.2 提取

- 每个批次按冻结的 `EvidenceRange` 生成目标成员，模型通过 `MemoryPhasePorts.query` 执行提取；带范围评估契约时使用 `memoryWorkInstruction` 和 `memory-candidates@1` 输出（`apps/server/src/memory-pipeline.ts` `MemoryPipeline.execute`；`apps/server/src/memory-work-contract.ts` `memoryWorkInstruction`）。
- 提取输出先经过宿主校验，再允许保存：`MemoryStore.extract(..., {validateOnly:true})` 检查结构、准入字段、精确引文、当前证据、Coding 适用范围和关系目标版本；`readMemoryWorkCoverage` 检查每个目标范围的覆盖声明；图片候选还必须带有本轮实际交付的视图证明（`apps/server/src/memory-pipeline.ts` `validateOutput`；`apps/server/src/memory.ts` `MemoryStore.extract` 与 `validateClaims`；`apps/server/src/memory-work-contract.ts` `readMemoryWorkCoverage`；`apps/server/src/memory-image-proof.ts`）。
- 有效提取草稿是私有缓存，不是已发布 Memory。`MemoryExtractionDrafts` 按生成契约、语义输入和配置固定草稿；阶段结果另有 `MemoryPhaseOutputs` 检查点，只有当前批次和授权仍有效时才能复用（`apps/server/src/memory-extraction-drafts.ts`；`apps/server/src/memory-phase-outputs.ts`）。
- 没有候选也是一个合法提取结果；但带工作包的批次仍必须声明完整覆盖，不能把未读范围说成 `no_candidates`（`apps/server/src/memory-work-contract.ts` `readMemoryWorkCoverage`；`apps/server/src/memory-pipeline.ts` `execute` 对 `incomplete` 的拒绝）。

### 1.3 独立审查

- 审查通常是另一次只读模型调用，输入是未受信的提取草稿和冻结的原件读取范围；草稿不能改变审查指令或写入 Memory（`apps/server/src/memory-review.ts` `reviewMemory`；`apps/server/src/memory-review-policy.ts` `defaultMemoryReviewStrategy`）。
- 审查阶段重新执行宿主校验和图片证明检查，不能只信提取结果；审查回执包含草稿 run、审查 run、结果哈希、删除快照、策略指纹和评估时刻，策略标识为 `bounded-exact-review@1`（`apps/server/src/memory-review.ts` `reviewMemory`；`apps/server/src/memory-schema.ts` `memoryReviewReceiptSchema`）。
- 审查复用只限有界的提取工具，并且要求输入快照和删除快照一致；`MemoryReviewCache` 是进程内有界缓存，不持久化、不跨归档共享（`apps/server/src/memory-review-cache.ts` `MemoryReviewCache`；`apps/server/src/memory-review.ts` `reviewMemory` 的 `bounded` 键）。
- 普通无工作包的空提取可以复用提取结果形成 `empty` 回执；带范围评估工作包或原生引擎草稿的空结果仍走独立审查（`apps/server/src/memory-review.ts` 的空草稿分支与工作包注释）。
- 当前组合在手工提取和配方任务中都安装了审查执行器；没有审查回执的结果不会被自动发布，只会保持 `proposed`，等待所有者显式发布或重新审查（`apps/server/src/memory-pipeline.ts` `createManual` 对 `phases.review` 的要求；`apps/server/src/memory.ts` `MemoryStore.extract` / `publish`；`apps/server/src/features/memory/publication.ts` `registerMemoryOwnerRoutes`）。

### 1.4 反馈规划

- 审查后的覆盖声明把目标分为 `checked`、`no_candidates`、`needs_context`、`needs_owner_input`、`incomplete`（`apps/server/src/memory-work-contract.ts` `memoryRangeEvaluationCoverageSchema`）。
- `needs_context` 由反馈规划器处理。`registerMemoryFeedbackPlanner` 通过既有 `DelegationRuntime` 提交 `memory.feedback-group` / `memory.feedback-stop` 提案，只能重组当前任务已授权的目标范围并选择上下文范围，不能新增授权或读取范围（`apps/server/src/memory-feedback-planner.ts` `registerMemoryFeedbackPlanner`；`apps/server/src/memory-feedback.ts` `MemoryFeedbackRequest` / `validMemoryFeedbackPlan`）。
- 规划结果由 `MemoryPipeline.applyFeedback` 转成子批次；每个子批次保留目标、上下文范围、配方和授权，最多两轮（`apps/server/src/memory-pipeline.ts` `applyFeedback` / `planReviewedContext`）。子批次仍走同一审查和发布链路。
- `needs_owner_input` 由共享 owner-question 宿主持久保存；Memory 只是其中一个受信 provider（`apps/server/src/owner-questions.ts` `OwnerQuestions`；`apps/server/src/memory-owner-questions.ts` `installMemoryOwnerQuestions`）。回答可结束该缺口，或创建保留原授权的继续任务；不会让模型猜身份，也不占用等待期间的执行器/模型槽（`apps/server/src/memory-pipeline.ts` `closeOwnerQuestion` / `continuedOwnerQuestion`；`apps/server/src/memory-owner-continuation.ts` `MemoryOwnerContinuationPort`）。
- `incomplete` 保留具体未完成范围并阻止批次假装完成；资源失败和临时传输失败走共享执行器的有界恢复，不截断正文冒充完成（`apps/server/src/memory-pipeline.ts` `execute` 对错误码 memory_evaluation_incomplete 的处理；`apps/server/src/execution-failures.ts`）。

### 1.5 整合

- 手工整合只接受明确的输入卡片版本：`POST /api/memory-integrations` 要求 `{id, version, fingerprint}`；并发修正返回 `409 memory_selection_changed`，旧的 `memoryIds` 请求不被接受（`apps/server/src/features/memory/runtime.ts`；`apps/server/src/memory-integration.ts` `requestMemoryIntegration`）。
- 自动整合是 `MemoryLifecycle` 的 `consolidation` 扩展，按选择后的 `memory_events` 增量取卡，不隐式重跑历史；选择本身保存在共享 `settings` 中（`apps/server/src/memory-integration.ts` `registerMemoryIntegration`；`apps/server/src/memory-integration-settings.ts` `MemoryIntegrationSettings`；`apps/server/src/memory-lifecycle.ts` `MemoryLifecycle.register`）。
- 整合模型只读选中的卡片和原件，结果以 `tier: consolidated` 保存，输出必须声明 `relatedMemoryIds`；每个父卡必须贡献直接原件证据，不能复制父卡结论充当新整合（`apps/server/src/memory-integration.ts` `registerMemoryIntegration`；`apps/server/src/memory.ts` `MemoryStore.extract` 的 `tier === 'consolidated'` 校验）。
- 整合结果同样经过独立审查和宿主校验；支持 `contradicts` / `supersedes`，关系目标必须匹配当前版本、指纹和当前原始证据，`supersedes` 在发布事务中原子写入 `supersededBy` / `supersededAt` 并保留被替代卡片（`apps/server/src/memory-integration.ts`；`apps/server/src/memory.ts` `MemoryStore.publish`；`apps/server/src/memory-schema.ts` `memoryRelationSchema`）。

### 1.6 发布

- 发布是把 Memory 从提案状态推进到自动可读状态的唯一入口。没有外部绑定时，`MemoryStore.publish` 校验当前证据、删除快照和关系目标后把 `status` 从 `proposed` 改为 `published`，并递增版本（`apps/server/src/memory.ts` `MemoryStore.publish`）。
- 有外部绑定时，`MemoryPublication.stageExtract` 先准备不可变正文并写入供应方；每次写入带固定 opId 和正文摘要，写入后按精确键读回校验。只有 `memory_publications` 进入 `verified` 且绑定未变化，`MemoryPublication.assert` 才允许宿主提交；提交后 `committed` 标记日志，迟到写入被退役规则隔离（`apps/server/src/plugins/memory-publication.ts` `MemoryPublication.stageExtract` / `assert` / `committed`；`apps/server/src/plugins/memory-private-storage.ts` `installMemoryPublicationRetirement`）。
- 批次提交在 `MemoryPipeline.commitBatch` 内完成：先调用 `publication.stageExtract`，再调用 `MemoryStore.extract` 传入已准备的正文，最后 `publication.committed`；任一步失败都不会出现半发布卡片（`apps/server/src/memory-pipeline.ts` `commitBatch` 与 `memory.batch` 的 `execute`/`commit`）。
- 所有者命令走 `POST /api/memories/:id/publish`、`POST /api/memories/:id/correct`、`DELETE /api/memories/:id`；外部绑定时发布/纠正/删除先写 `memory_owner_mutations`，重放时重新核对当前正文、原件和绑定，不直接返回旧回执（`apps/server/src/features/memory/publication.ts` `registerMemoryOwnerRoutes`；`apps/server/src/plugins/memory-publication.ts` `publish` / `correct` / `delete` / `ownerResult`）。
- 未知远端写入和擦除不记为成功：`memory_provider_writes` 的 `submitted` 状态由 `MemoryPublication.reconcile` 按供应方实际正文对账；`memory_provider_erases` 与 `memory_provider_evidence_revocations` 保存可重试的删除/撤权意图（`apps/server/src/plugins/memory-publication.ts` `reconcile`；`apps/server/src/memory-provider-contract.ts` `MemoryProviderReceipt`）。

## 2. 用到的表和状态

### 2.1 表

| 用途 | 表 | 代码位置 |
| --- | --- | --- |
| 正文、索引与证据 | `memories`、`memory_catalog`、`memory_scopes`、`memories_fts`、`memory_dependencies`、`memory_artifact_dependencies` | `apps/server/src/memory.ts` `MemoryStore.ensureIndex` / `ensureCatalog` / `extract`；`apps/server/src/memory-storage-schema.ts` |
| 任务、批次与检查点 | `memory_jobs`、`memory_batches`、`memory_batch_dependencies`、`memory_checkpoints`、`memory_job_counts`、`memory_job_dependencies`、`memory_input_plans`、`memory_input_authorizations` | `apps/server/src/memory-storage-schema.ts`；`apps/server/src/memory-pipeline.ts` `initializeCounts` / `create` / `insertBatch`；`apps/server/src/memory-input-authorization.ts` |
| 提取、审查与反馈 | `memory_extraction_drafts`、`memory_phase_outputs`、`memory_feedback_plans` | `apps/server/src/memory-extraction-drafts.ts`；`apps/server/src/memory-phase-outputs.ts`；`apps/server/src/memory-feedback-planner.ts` |
| 生命周期与设置 | `memory_lifecycle_state`、`memory_lifecycle_effective`、`memory_recipe_settings`、`memory_automation`、`memory_control_commands`、`memory_automation_fences` | `apps/server/src/memory-lifecycle.ts`；`apps/server/src/memory-recipe-settings.ts`；`apps/server/src/memory-automation.ts` |
| 绑定与供应方配置 | `memory_plan_binding`、`memory_preparation`、`memory_binding_commands`、`memory_provider_configurations`、`memory_provider_receipts` | `apps/server/src/memory-bindings.ts` `MemoryBindings`；`apps/server/src/memory-adapters.ts` `MemoryAdapters` |
| 整合与事件 | `memory_integration_deliveries`、`memory_events` | `apps/server/src/memory-integration.ts` `registerMemoryIntegration`；`apps/server/src/memory-lifecycle.ts` `MemoryLifecycle` |
| 发布与外部操作 | `memory_publications`、`memory_publication_outputs`、`memory_publication_dependencies`、`memory_publication_retirements`、`memory_provider_writes`、`memory_owner_mutations`、`memory_provider_erases`、`memory_provider_evidence_revocations` | `apps/server/src/plugins/memory-publication.ts` `MemoryPublication`；`apps/server/src/plugins/memory-private-storage.ts` |
| 原生引擎暂存与清理 | `memory_engine_stage_drafts`、`memory_engine_stage_cleanups` | `apps/server/src/memory-native-stages.ts` `MemoryNativeStages` |
| 删除账本 | `memory_deletions`、`memory_deletion_dependencies` | `apps/server/src/plugins/memory-deletions.ts` `MemoryDeletions` |
| owner 澄清问题 | `owner_questions`、`owner_question_dependencies`、`owner_question_replies` | `apps/server/src/owner-questions.ts` `OwnerQuestions` |
| 共享执行器 | `execution_steps`、`execution_failures` | `apps/server/src/execution-engine.ts` `ExecutionEngine` |

### 2.2 状态

| 对象 | 状态 | 含义与代码位置 |
| --- | --- | --- |
| Memory 卡片 | `proposed`、`published`、`stale` | `proposed` 是未通过完整发布；`published` 才进入普通读路径；`stale` 表示原件变化、归档恢复或上游 Memory 被删除。`staleReason` 为 evidence_changed、restored_archive、memory_deleted（`apps/server/src/memory-schema.ts` `memorySchema`；`apps/server/src/memory.ts` `ensureCatalog` / `publish` / `delete`） |
| Memory job | `queued`、`running`、`completed`、`failed`、`waiting_for_model`、`waiting_for_input`、`cancelled`、`paused`、`pausing` | 任务状态由 `refreshJob` 从批次、输入计划和执行步骤汇总；取消原因区分 `authority`（授权撤权）与 `owner`（所有者操作）（`apps/server/src/memory-pipeline.ts` `MemoryJob` / `refreshJob` / `cancel`） |
| Memory batch | `pending`、`running`、`completed`、`failed`、`invalidated` | `invalidated` 表示输入或授权失效；批次计数由 `memory_job_counts` 触发器维护（`apps/server/src/memory-pipeline.ts` `MemoryBatch` / `initializeCounts`） |
| 覆盖成员 | `pending`、`checked`、`no_candidates`、`failed`、`stale`、`needs_context`、`needs_owner_input`、`incomplete` | 模型声明的覆盖状态与宿主成员状态分开：模型只能声明 `checked`、`no_candidates`、`needs_context`、`needs_owner_input`、`incomplete`；`pending`/`failed`/`stale` 由宿主维护（`apps/server/src/memory-work-contract.ts` `MemoryWorkMember` / `memoryRangeEvaluationCoverageSchema`） |
| 生命周期扩展 | `disabled`、`running`、`failed`、`retry_wait`、`pending`、`waiting_for_model`、`waiting_for_increment`、`waiting_for_interval`、`ready`、`cancelled` | 自动窗口和重试状态在 `MemoryLifecycle.view` 中投影；窗口只能按固定版本运行（`apps/server/src/memory-lifecycle.ts` `MemoryLifecycle.view` / `execute`） |
| 自动准入 | `enabled`、`paused`、`draining`、`stopping`、`blocked` | 持久状态为 `desired`、`generation`、`cutoff`、`barrier`、`stopRequested`；暂停不删除已有 Memory（`apps/server/src/memory-automation.ts` `MemoryAutomation`） |
| 绑定准备 | `waiting`、`running`、`verified`、`applied`、`cancelled`、`blocked`、`failed` | `verified` 还需 `snapshot`、尾部排空和同一绑定；`activate` 原子切换 binding 后标记 `applied`（`apps/server/src/memory-bindings.ts` `MemoryBindings.prepare` / `action`） |
| 发布日志 | `staged`、`verified`、`committed`、`retired` | `memory_publications.state`；供应方写入为 `submitted` / `acknowledged`，擦除同为 `submitted` / `acknowledged`（`apps/server/src/plugins/memory-publication.ts`；`apps/server/src/plugins/memory-private-storage.ts`） |
| owner 问题 | `open`、`deferred`、`answered`、`closed`、`obsolete` | 等待回答不占用执行器；依赖原件删除、资料退役或安装替换会把问题标为 `obsolete`（`packages/shared/src/owner-questions.ts` `ownerQuestionStateSchema`；`apps/server/src/owner-questions.ts`） |

## 3. 五项保证

### 3.1 证据可追溯

- 每条候选必须带 `evidenceIds`，并为每个 ID 提供精确引文或本轮交付的图片视图；默认引文必须在授权范围内唯一解析，显式 offset 时也必须在范围内逐字匹配，不能用模糊匹配或模型摘要代替（`apps/server/src/memory-schema.ts` `memorySchema` / `memoryEvidenceSchema`；`apps/server/src/memory.ts` `validateClaims`）。
- 证据引用保存来源、设备、时间、原文版本和 `contentHash`；原件变化会使依赖 Memory 失效，而不是继续引用旧副本（`apps/server/src/memory.ts` `reference` / `memoryEvidenceFingerprint`；`ensureCatalog` 中的原件更新触发器）。
- 卡片到原件的依赖写入 `memory_dependencies`，语义产物依赖写入 `memory_artifact_dependencies`；删除和保留期清理沿这些关系传播（`apps/server/src/memory.ts` `extract`；`apps/server/src/memory-pipeline.ts` `commitBatch`；`apps/server/src/evidence-archive.ts` `memory_artifact_dependencies`）。
- 读路径可通过 `GET /api/memories/:id/evidence` 回到原件读取器，卡片详情页只展示引用身份与精确证据（`apps/server/src/evidence-routes.ts`）。

### 3.2 删除传播

- 原始资料更新时，`ensureCatalog` 的原件更新触发器把依赖卡片标为 `stale` / `evidence_changed`；原件删除时，对应的删除触发器删除依赖卡片，并继续触发发布退役和问题退役（`apps/server/src/memory.ts` `ensureCatalog`；`apps/server/src/plugins/memory-private-storage.ts` `installMemoryPublicationRetirement`；`apps/server/src/owner-questions.ts` 的删除触发器）。
- 所有者显式删除一张 Memory 时，`MemoryDeletions.revoke` 先把依赖它的下游卡片标为 `stale` / memory_deleted，再删除目标卡片；删除账本保存原件身份、来源谱系和必要原文，防止通过重新生成绕过删除意图（`apps/server/src/memory.ts` `MemoryStore.delete`；`apps/server/src/plugins/memory-deletions.ts` `MemoryDeletions`）。
- 外部发布不把删除当作本地删除：`memory_publication_dependencies` 记录操作依赖，`memory_provider_erases` 保存可重试的擦除意图，`memory_provider_evidence_revocations` 保存原件撤权；`MemoryPublication.reconcile` 按供应方实际记录确认擦除，未知不记为成功（`apps/server/src/plugins/memory-private-storage.ts` `registerMemoryPublicationDependencies`；`apps/server/src/plugins/memory-publication.ts` `delete` / `reconcile`）。
- 任务、批次和阶段输出在授权失效、原件删除或取消时清理私有正文；已发布历史按删除账本处理，不把控制投影当成不可撤销的副本（`apps/server/src/plugins/memory-private-storage.ts` `installMemoryPrivateRetirement`；`apps/server/src/memory-phase-outputs.ts` 的退役触发器）。

### 3.3 分层披露

- 列表接口默认返回目录级字段和 `disclosure` 链接；完整正文通过 `GET /api/memories/:id`，精确证据通过 `GET /api/memories/:id/evidence`，Markdown 导出通过 `GET /api/memories/:id/text`（`apps/server/src/evidence-routes.ts`；`apps/server/src/memory.ts` `MemoryStore.page` / `text`）。
- HTTP 列表默认排除 `stale`、已被替代和已过期的卡片，但允许用 `status` 与历史参数显式读取 `proposed` / `published` / `stale`；问答、MCP 和上下文读路径只消费 `published` 且未过期、未被替代的卡片（`apps/server/src/memory.ts` `MemoryStore.page`；`apps/server/src/context-query.ts` 的 `status:'published'`；`apps/server/src/connectors/mcp.ts` `mote_memories`）。
- 模型只能读取本轮授权的原件范围；上下文补读也必须命中冻结的读取授权并留下回执，不能靠目录或声明扩大权限（`apps/server/src/memory-read-context.ts` `memoryReadRanges` / `assertMemoryTargetSupport`；`apps/server/src/memory-pipeline.ts` `assertContextReadScope`）。
- 外部供应方只获得精确命名空间和精确键的读写权限；查询 Agent 得到只读 facade，发布/纠正/删除属于所有者命令，不因供应方可读而自动获得（`apps/server/src/memory-provider-contract.ts` `MemoryProvider` 注释；`apps/server/src/features/memory/publication.ts` `routeGuard`）。

### 3.4 独立审核

- 提取与审核默认是两个独立模型调用；普通无工作包的空提取可以复用空回执，但任何候选、工作包或原生草稿都进入独立审查。审核看到的是未受信草稿和原件，不是提取器的隐藏状态，也不能调用写工具（`apps/server/src/memory-review.ts` `reviewMemory`；`apps/server/src/memory-strategy-contract.ts` 的只读权限契约）。
- 审核策略、提取策略和配方分别固定版本和指纹；更换审核器不需要重跑提取，但必须重新审核草稿，旧审查回执不能命中新策略（`apps/server/src/memory-strategy-contract.ts` `memoryRecipeBindingSchema` / `memoryStrategyPin`；`apps/server/src/memory-pipeline.ts` `MemoryPipeline.execute` 的 review 阶段）。
- 自动发布要求当前审核回执匹配结果哈希和删除快照；没有回执的卡片停在 `proposed`，所有者显式发布仍要经过当前证据和删除快照校验（`apps/server/src/memory.ts` `MemoryStore.extract` / `publish`；`apps/server/src/memory-schema.ts` `memoryReviewReceiptSchema`；`apps/server/src/features/memory/publication.ts` `registerMemoryOwnerRoutes`）。
- 独立审核也适用于整合结果和原生引擎草稿：原生输出只是未审查提案，必须经过同一审查和宿主校验（`apps/server/src/memory-integration.ts` `registerMemoryIntegration`；`apps/server/src/memory-review.ts` 对 `native-engine` 的处理）。

### 3.5 owner 澄清问题

- 当有意义的结论需要原件无法提供的 owner 事实时，覆盖声明使用 `needs_owner_input` 并附具体问题、选项和精确原文证据；问题由共享 `owner_questions` 持久化，不占用执行器或模型槽（`apps/server/src/memory-work-contract.ts` `memoryOwnerQuestionSchema`；`apps/server/src/owner-questions.ts` `OwnerQuestions`）。
- Memory 的 provider 在回复后重新核对问题版本、原件范围和当前绑定；回答可以结束该范围，也可以创建继续任务，但不能自动认证身份或把候选直接发布（`apps/server/src/memory-owner-questions.ts` `installMemoryOwnerQuestions`；`apps/server/src/memory-pipeline.ts` `closeOwnerQuestion` / `continuedOwnerQuestion`）。
- 原件删除、资料退役、安装替换或问题过期会让问题变为 `obsolete`，不继续向所有者追问旧内容（`apps/server/src/owner-questions.ts` `obsolete` 与依赖触发器）。
- 当前问题 API 和读模型复用共享 owner-question 服务；Memory 不建立第二套问题表或第二套回答状态（`apps/server/src/plugins/owner-question-services.ts`；`apps/server/src/owner-questions.ts`）。

## 4. 可替换接口（已冻结）

“冻结”指只接受缺陷修复：不新增方法、阶段、输入/输出契约、绑定模式或新授权概念；新增能力必须先修改本文件并另立决策。可替换实现仍必须满足相同的宿主校验、独立审查、发布栅栏和删除传播。

| 接口 | 当前可替换内容 | 冻结边界 | 代码位置 |
| --- | --- | --- | --- |
| 提取策略 | `memory-evidence@1 → memory-candidates@1`，只读 `evidence.read` | 不能获得写工具、发布权或替换公共校验 | `apps/server/src/memory-strategy-contract.ts` `memoryExtractionStrategySchema`；`apps/server/src/memory-strategies.ts` `registerExtraction` |
| 审查策略 | `memory-candidates@1 → memory-candidates@1`，只读证据或只读 Memory + 证据 | 不能跳过宿主校验、删除快照或独立审查责任 | `apps/server/src/memory-strategy-contract.ts` `memoryReviewStrategySchema`；`apps/server/src/memory-strategies.ts` `registerReview` |
| 配方 | 固定版本的提取器 + 审查器组合，可带输入依赖和工作契约 | 不能原地改写定义、自动升级旧任务或扩大依赖 | `apps/server/src/memory-strategy-contract.ts` `memoryRecipeSchema`；`apps/server/src/memory-strategies.ts` `registerRecipe` / `resolvePinned` |
| 整合策略与配方 | `memory-cards@1 → memory-candidates@1`，只读 Memory + 证据 | 不能改变证据准入、关系目标版本和发布事务 | `apps/server/src/memory-strategy-contract.ts` `memoryIntegrationStrategySchema` / `memoryIntegrationRecipeSchema`；`apps/server/src/memory-strategies.ts` `registerIntegration` / `registerIntegrationRecipe` |
| 存储与检索供应方 | `put`、`read`、`remove`、`search`、`export`、`health`、`recover`、`close` | 只负责存储与检索；准入、来源授权、发布栅栏、删除传播仍归宿主 | `apps/server/src/memory-provider-contract.ts` `MemoryProvider` |
| 完整引擎 / 原生阶段 | `prepare`、可选 `discardPrepared` / `erasePreparedEvidence`；适配器 `prepare` / `settle` | 只负责语义传输；宿主持有固定草稿、清理恢复、独立审查和发布权 | `apps/server/src/memory-native-stage-contract.ts` `MemoryEngine` / `MemoryNativeStageAdapter`；`apps/server/src/memory-native-stages.ts` `MemoryNativeStages` |
| 生命周期扩展 | `extraction`、`consolidation`、`insights`、`working` 的窗口执行 | 不能新增窗口种类或绕过游标、检查点、暂停/排空/停止 | `apps/server/src/memory-lifecycle.ts` `LifecycleExtension` / `MemoryLifecycle.register` |
| 发布端口 | `MemoryStagePublication` 与 `MemoryOwnerPublication` 分离的已审查暂存/所有者命令 | 不能让供应方替换宿主提交、所有者授权或删除账本 | `apps/server/src/plugins/memory-publication-contract.ts` `MemoryStagePublication` / `MemoryOwnerPublication` |
| 绑定与切换 | 内置与外部 `modules` / `engine` 计划，准备、核验、切换和失败保旧 | 不能新增第二种绑定模式或跳过正文迁移/核验 | `apps/server/src/memory-bindings.ts` `MemoryBindings.plans` / `prepare` / `action`；`apps/server/src/memory-automation.ts` `MemoryAutomation.freeze` / `release` |
| Worker 供应方 ABI | `createMemoryProvider(configuration)` 与 JSON-lines 调用，支持 repository / retrieval | 只使用已支持的调用方法；不新增方法或权限；任意 worker 声明 `engine` 不等于可运行引擎 | `apps/server/src/worker-memory-provider.ts` `WorkerMemoryProvider`；`apps/server/src/plugins/memory-provider-adapters.ts` |

## 5. 相关记录

13 份 memory ADR 和一期设计稿已在顶部标注“历史”，只保留当时的决策与验证范围；当前行为以本文件和代码为准。插件中心的固定上游配方、迁移和回滚细节仍以[插件中心 ADR](adr-plugin-center-memory-replacement.md)为决策记录，但该 ADR 不再代表当前实现说明。
