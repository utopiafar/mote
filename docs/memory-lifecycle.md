# Memory lifecycle

> 2026-10-15: Integration requires current readable inputs and actual delivered
> bodies/originals. A no-delivery failure preserves its window and requires
> explicit retry. Internal planner failures no longer masquerade as owner waits.
> See the [delivery and failure-state decision](adr-memory-evidence-delivery-and-failure-state.md).

> 2026-10-14 更新：按所有者的MVP简化决定，取消宿主字符/token近似配额、结果缩页和Memory自动二分恢复；真正资源失败留下明确未完成范围，明确临时故障复用共享引擎有界重试。下面较早策略描述中的资源分拆由[当前决定](adr-ask-evidence-quality-and-simple-context.md)取代。

> 2026-09-27 更新：整合采用独立注册的整合/审核配方，固定输入与模型配置，自动选择只处理后续增量；历史工作需显式触发。详见 [策略组合](memory-strategies.md)。新产物的 admission 与审核边界见 [记忆准入设计](memory-admission.md)。

> 2026-10-12 更新：所有者可以在「设置 → 插件 → 记忆方案」暂停全部自动 Memory，排空已登记任务，或另行立即停止。安装、配置、启用与绑定分开；正文和检索可以由已核验的供应方接管。操作与当前支持范围见 [插件中心](plugin-center.md)。

The built-in repository stores readable Memory text and version metadata in SQLite. A verified external repository may become the selected body authority; the host retains authorization, provenance, status, version identity and publication control. Formal reads use the selected exact provider revision and fail explicitly if that body is unavailable. They never silently substitute a local SQL body. Memory statements and conversation summaries remain text, not vectors. Each Memory has a Markdown download; the built-in FTS5 index is disposable. Working-memory summaries keep their independent store. See [plugin contracts](library-plugin-contracts.md#memory-正文权威与发布).

## Admission and defaults

New source inputs with automatic Memory authorization use a separate ready-Material queue: ordinary background workers structurally pack at most eight compatible members using the configured initial batch size, then extract/reuse and independently review. Initial segmentation is separate from retrieval allowance; reading no longer consumes a host character quota, and a failure does not halve an existing package. They do not wait for the lifecycle count threshold or maximum wait, and import completion does not create duplicate work. Global automatic admission must be open when a new input obtains its receipt. The window admission rules below describe the retained artifact/history workflows, consolidation, insights and conversation summaries. Member attribution, time and receipt scopes remain separate within a transport package. See [system refactor ADR](adr-system-refactor.md) and the [simplification decision](adr-ask-evidence-quality-and-simple-context.md).

Creation alone does not activate a manual Memory job. Explicit `run()` persists
`activationRequired=false` before scheduling; startup recovery selects only
activated detached jobs and still rejects pause, cancellation, revoked originals
or changed versions. An unstarted `activationRequired=true` job stays dormant.
MVP historical jobs can be explicitly rerun; recovery does not infer owner
authorization from past attempts.

New versioned built-in recipes and newly created unbound jobs with independent
review use `range-evaluation@1`: complete target-range
assessment and independent review precede model-selected Memory. Empty selection
is valid after full assessment and review; candidate count is not a completion or
truncation signal. Explicit `incomplete` coverage preserves an unfinished target
with its reason. Structural grouping is separate from recovery. Actual
context/output capacity failures preserve the original unfinished range; explicitly
typed transient transport failures retry the same valid input through the shared
executor. Automatic subdivision is removed for old and new jobs. Old
receipts and tasks retain their pinned candidate contract; saturation now leaves
an explicit failure. Installation or default upgrade never retries historical
jobs. Newly created reviewed raw/API jobs use the contract even when `recipes` or
the work package is omitted, as does a new manual job's unbound fallback. Explicit
old recipe bindings take precedence; existing no-field jobs and internal paths
without an independent reviewer remain legacy. See
[range evaluation ADR](adr-memory-range-evaluation.md).

Automatic insights require **the minimum interval AND the count threshold**. Their `intervalHours` is the minimum delay after successful completion (or registration); `maxWaitHours` does not bypass either requirement. The other three Memory workflows require **pending changes AND (the count threshold OR the maximum wait)**. For those three workflows, the implementation uses `maxWaitHours` when set, otherwise `min(intervalHours, 1)` hours, measured from the last successful window (or initial registration). For those three workflows, `intervalHours` is a retained configuration field, not an additional mandatory delay once the count threshold is reached. A one-minute timer only checks admission; upload and import completion do not call a model. A first deployment starts its interval clock at registration. Integration initializes its selection at the current Memory journal watermark, so pre-existing cards require an explicit historical request. Other workflow journal rules are unchanged. Manual extraction/review and explicitly requested integration can run immediately. A process restart retains clocks, windows and cursors. A configured model is required.

| Workflow | Stored intervalHours | Count threshold | Maximum journal entries per window |
| --- | --- | --- | --- |
| Evidence extraction | 6 hours | 25 | 100 |
| Long-term consolidation | 24 hours | 20 | 30 |
| Insight review | 24 hours | 100 | 1,000 |
| Conversation working memory | 1 hour | 8 turns | 20 |

Settings → model settings → 记忆与洞察 persists these scheduling settings immediately through `/api/memory-settings`. The retained `extraction.enabled` field accepts only `true`; changing it to `false` is not the pause protocol. The owner pauses all automatic Memory through the separate binding admission control described below. Consolidation, insights and working memory retain their individual scheduling settings; global Memory pause covers automatic extraction and integration, while independent insights and working summaries retain their own controls. A new Central epoch 7 vault starts with the declared lifecycle defaults; older vaults are rejected before schema installation. Subsequent policy edits live in the database. With the defaults above, automatic insights require at least 24 hours and 100 increments. The three Memory workflows have an effective maximum wait of one hour. Their small backlog can run without reaching the count threshold; an empty journal does not call a model. Current authorized windows and explicit manual requests retain their identities across restart. See the [MVP baseline ADR](adr-mvp-baseline.md) for the storage boundary.

A bounded snapshot consumes a contiguous prefix of an arrival journal, not an occurrence-time window. Late uploads therefore remain eligible even when their authored dates are months old. Duplicate uploads do not create new increments. Updates and deletions are increments; invalidated originals are skipped. File processing completion writes another increment, so files that were not ready at the earlier check are revisited. New arrivals during a run remain after its watermark.

A successful automatic run advances its watermark and clock. Manual integration leaves the automatic watermark and admission clock unchanged. Failures preserve the exact window and its settings and retry with exponential backoff (up to six hours). Integration stops after three failed attempts and requires an explicit retry; completed domain checkpoints remain intact. Extraction retains its durable child job. Overlapping ticks share one promise. Extraction checkpoints include original content fingerprints, ranges and skill versions. A completed empty extraction is a checkpoint too. Each extension admits at most one active window; the shared executor and configured resource pools bound concurrency across extensions and model work. Interactive queries retain a separate admission pool. For consolidation, insights and working memory, disabling their workflow switch pauses their automatic admission/retries; it does not cancel a model call already running. Global automatic Memory pause uses the durable protocol below. The integration recipe selection is separate: switching or clearing it retires prior automatic windows and fences their results. Explicit historical integration requests keep their own authorization and support cancellation/retry through the owner API.

## Pause, drain, stop and resume

The owner API at `/api/memory-spaces/default/binding` projects desired admission, actual state, queued/running/checkpointed work, unknown external outcomes, binding revision and generation. Commands require an operation ID and expected revision. The UI reads these server facts; a switch position or accepted request is not completion.

- **Pause** closes new automatic admission at a durable cutoff. Already registered work retains its frozen authorization and old generation, including queued work and declared child stages needed to finish it. Restart and ordinary retries do not revoke that original authority or widen its inputs. The UI remains draining while such work exists.
- **Immediately stop** is a separate action. It revokes unfinished automatic publication authority, cancels host work and requests external cancellation. Explicit manual work keeps its own authorization. A remote cancellation receipt alone does not prove that the provider stopped writing; unknown results remain tracked and late outputs are fenced from publication.
- **Resume** creates a new admission generation. Previously authorized work retains its original generation. Inputs refused during the gap remain refused after restart, duplicate upload, provider re-enable or global resume; historical work requires its own explicit range and authorization.
- **Privacy deletion and source revocation** take effect immediately for both new and draining work. A prior task receipt does not grant an exception to current evidence, privacy or deletion checks.

Immediate stop follows the durable lifecycle checkpoint to its automatic extraction child, including an earlier failed child without an `automaticGrant` field. Startup reconciles the saved parent cancellation with that child. Independently authorized manual work and an explicit owner-question continuation retain their own authority. A cancellation request remains stopping while its actual transport has not exited; cancelled metadata alone does not remove the cutover tail.

Original reception, readable Materials, existing Memory and read-only queries remain available during a Memory pause. Disabling a bound provider additionally blocks new automatic processing while retaining its reader for existing bodies. A verified plan change temporarily freezes old write admission, waits for authorized tail work and external reconciliation, and verifies the current snapshot before CAS activation. Cancelling preparation releases that temporary barrier without changing the owner's pause choice. Authorized canonical copies already imported during preparation are retained without activating the target binding. Cancellation is not data deletion: exact source deletion or privacy revocation still removes its dependent copies and retained operation bodies, including reconciliation of unknown external writes. New manual Memory writes are blocked behind the cutover barrier; queries continue on their fixed read binding.

## Layers and trust

- Working memory: model-written, bounded conversation summary plus recent turns. Summary prefix fingerprints prevent saving against a changed conversation. Explicit changes of decision and open questions are preserved by the skill. Dialogue and previous assistant prose are untrusted context, not evidence. Working-memory sessions cannot call context retrieval tools. The settings control the minimum recent turns exempt from compaction, summary length and context budget; until compaction catches up, available uncompressed turns are retained up to the context budget and the 20-turn ceiling; unrepresented turns are counted explicitly.
- Episode memory: internally reviewed claims from bounded original segments, with exact quotes and UTF-16 ranges or a host-verified original image view; valid commits become active automatically.
- Consolidated memory: an installed integration/review recipe uses a neutral skill to compare episode cards, search related text and revisit original evidence. Its output may be episodic, semantic or procedural, with optional explicitly supported validity dates. Conflicts, evolving preferences and attribution are expressed in text and uncertainty. Reviewed supersession is applied atomically against the exact target version and preserves the original historical record. Contradictions retain both claims. No owner confirmation is required.
- Progressive disclosure: searchable overview cards → full statement, uncertainty and provenance → original evidence. `memories` supports FTS queries, tier/kind filters and cursors. The host applies hard device/time scopes. The `changes` tool pages the host-selected incremental snapshot; it is empty in ordinary queries. Search includes Chinese trigrams and scoped lexical matches without the old global top-500 cutoff. Whitespace-separated literal terms use AND; one- or two-character terms use literal substring matching as well as the word index, so queries such as `林岚 清晨` find unsegmented Chinese text. Original captures and file chunks share this lexical behavior. A memory miss explicitly points the model back to original-record search, since the memory index covers selected summaries only.

Source revisions invalidate dependent memories and working summaries. Privacy deletion removes dependent text memories, their indexes, insights and working summaries. All consolidated memories carry direct original-evidence dependencies; derived memories never become independent sources. Conversation deletion cascades to its summary. No keyword router decides memory type, topic, importance or insight.

Derived context cache invalidation retains dependent Memory statements as stale
and withdraws their extraction checkpoints. Default discovery excludes these
cards. Exact immutable artifact replay preserves the existing graph after current
evidence validation; it does not repeat model work or reactivate a stale card.
Original evidence deletion retains its destructive cascade. See the
[cache retention decision](adr-cache-memory-retention.md).

## Extension boundary

`MemoryLifecycle.register()` accepts an extension ID, version, input stream and asynchronous `run(window, checkpoint)` callback. `registerMemoryExtensions()` supplies the four built-ins. Hosts can inject `buildApp(..., {memoryExtensions})` replacements without editing scheduler code; `replace()` refuses to replace a handler with an active window. Resumed windows require the same extension version. The host owns durable admission, read authorization, validation and writes.

Formal source Materials use the independently authorized recipe queue described in [Memory strategies](memory-strategies.md); the artifact lifecycle remains for its declared consumers. Source provenance provides session/project scope but does not veto personal or Coding semantic products. Material attribution context travels with originals and formal ranges: unknown never suppresses processing or retrieval, external speaker claims remain external, and evidenced owner actions/resource associations remain discoverable. Integration preserves Coding applicability, validation and scope references in a separate domain checkpoint. A failed domain does not block another domain; recovery skips completed domains.

A retained extraction verdict that needs an owner attribution question requires a published Material reference. A legacy raw-original task without that reference is blocked with `memory_owner_material_required` and `waiting_for_input` before canonical publication. Its exact reviewed output remains durable, including an earlier verified publication envelope; explicit rechecking reuses that output without new native preparation or model review. It cannot continue automatically. The UI explains the missing formal material, keeps result access and manual rechecking available, and permits cancellation. Ordinary waiting for a valid Material retains its existing processing guidance.

The model procedures use the existing Cordis/Agent skill catalog, including the neutral `memory-strategy` and `memory-integration` programs. Installed policies are separate from these host programs. Their context tools remain read-only; current skill versions are listed by the catalog. `responseMode` is an explicit host contract, independent of skill selection. Persistent global scheduling belongs to the long-lived Mote server; per-query Harness sessions are ephemeral and do not own background timers.

## Verification

`memory-lifecycle.test.ts` replays 480 fictional originals over 180 days, four devices, three speakers and four projects, with 24 revisions, 12 duplicate uploads and eight privacy deletions. The 472 current originals are fully processed by fixture-model batches. The original 0.0.31 validation covered the then-current AND gate; current scheduling tests cover count-or-wait admission, restart/retry, concurrent arrivals, old Chinese/English search, pagination, summary invalidation and exact provenance. This is deterministic fixture coverage, not a live semantic judgment of all records.

`node --import tsx scripts/memory-live-eval.mjs` uses an isolated local Codex App Server with **gpt-5.6-luna / max**, through a loopback test adapter. DeepSeek Harness still chooses and executes its own declared read-only tools; Codex supplies inference. It reuses existing login authentication only, isolates configuration and plugins, and rejects native tool requests. The run caps provider attempts at 20 and uses only generated content. The live subset exercises extraction, consolidation, cross-month FTS retrieval, working summaries and incremental insights. Reports go to `/private/tmp/mote-memory-live-report.json` unless explicitly overridden. This adapter is a test utility, not a new production provider.

No physical capture or personal screenshot is needed by these tests. Live semantic results and physical-device verification must be reported separately from fixture tests.

Current automatic activation and persistent owner deletion intent are specified in [Memory updates](memory-updates.md#automatic-activation-and-deletion-intent-2026-09-27). Retired lifecycle schemas require the explicit [MVP upgrade procedure](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/audits/compatibility-cleanup-2026-10-04.md). Query-time bounded source disclosure is specified in [Memory source disclosure](memory-source-disclosure.md).
