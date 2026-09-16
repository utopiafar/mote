# Memory lifecycle

The central node stores readable text, provenance, status and version metadata in SQLite. Memory statements and conversation summaries are text, not vectors. Each memory has a Markdown download; FTS5 is a disposable index over the text. This implementation does not create a second independent directory of editable Markdown files.

## Admission and defaults

All four automatic workflows require **elapsed interval AND new changes**. A one-minute timer only checks admission; upload and import completion do not call a model. A first deployment starts its interval clock at registration and retains the existing journal as pending work. Manual extraction/review runs immediately. A process restart retains clocks, windows and cursors. A configured model is required.

| Workflow | Interval | Minimum increments | Maximum journal entries per window |
| --- | --- | --- | --- |
| Evidence extraction | 6 hours | 25 | 100 |
| Long-term consolidation | 24 hours | 20 | 30 |
| Insight review | 24 hours | 100 | 1,000 |
| Conversation working memory | 1 hour | 8 turns | 20 |

Settings → 问答与回顾 → 记忆与洞察 persists these settings immediately through `/api/memory-settings`. Each workflow can be disabled separately. The old environment insight interval only seeds the initial persisted interval; subsequent policy edits live in the database. Explicit zero previously meant manual-only; installations upgrading to this lifecycle receive the new documented defaults. Every gate remains AND: a small remaining backlog waits for further increments or an explicit manual run.

A bounded snapshot consumes a contiguous prefix of an arrival journal, not an occurrence-time window. Late uploads therefore remain eligible even when their authored dates are months old. Duplicate uploads do not create new increments. Updates and deletions are increments; invalidated originals are skipped. File processing completion writes another increment, so files that were not ready at the earlier check are revisited. New arrivals during a run remain after its watermark.

A successful run advances its watermark and clock. Failures preserve the exact window and its settings, retain the durable extraction job, and retry with exponential backoff (up to six hours). Overlapping ticks share one promise. Extraction checkpoints include original content fingerprints, ranges and skill versions. A completed empty extraction is a checkpoint too. Automatic work is serialized; manual queries retain the existing query concurrency limit. Disabling a workflow pauses future admission/retries; it does not cancel a model call already running.

## Layers and trust

- Working memory: model-written, bounded conversation summary plus recent turns. Summary prefix fingerprints prevent saving against a changed conversation. Explicit changes of decision and open questions are preserved by the skill. Dialogue and previous assistant prose are untrusted context, not evidence. Working-memory sessions cannot call context retrieval tools. The settings control the minimum recent turns exempt from compaction, summary length and context budget; until compaction catches up, available uncompressed turns are retained up to the context budget and the 20-turn ceiling; unrepresented turns are counted explicitly.
- Episode memory: proposals from bounded original segments, with exact quotes and UTF-16 ranges.
- Consolidated memory: a separate skill compares episode cards, searches related text and revisits original evidence. Its output may be episodic, semantic or procedural, with optional explicitly supported validity dates. Conflicts, evolving preferences and attribution are expressed in text and uncertainty. Existing confirmed memories are retained, never silently overwritten. Consolidated proposals remain pending owner confirmation.
- Progressive disclosure: searchable overview cards → full statement, uncertainty and provenance → original evidence. `memories` supports FTS queries, tier/kind filters and cursors. The host applies hard device/time scopes. The `changes` tool pages the host-selected incremental snapshot; it is empty in ordinary queries. Search includes Chinese trigrams and scoped lexical matches without the old global top-500 cutoff. Whitespace-separated literal terms use AND; one- or two-character terms use literal substring matching as well as the word index, so queries such as `林岚 清晨` find unsegmented Chinese text. Original captures and file chunks share this lexical behavior. A memory miss explicitly points the model back to original-record search, since the memory index covers selected summaries only.

Source revisions invalidate dependent proposals and working summaries. Privacy deletion removes dependent text memories, their indexes, insights and working summaries. All consolidated memories carry direct original-evidence dependencies; derived memories never become independent sources. Conversation deletion cascades to its summary. No keyword router decides memory type, topic, importance or insight.

## Extension boundary

`MemoryLifecycle.register()` accepts an extension ID, version, input stream and asynchronous `run(window, checkpoint)` callback. `registerMemoryExtensions()` supplies the four built-ins. Hosts can inject `buildApp(..., {memoryExtensions})` replacements without editing scheduler code; `replace()` refuses to replace a handler with an active window. Resumed windows require the same extension version. The host owns durable admission, read authorization, validation and writes.

Coding uploads use this same extraction gate. Their explicit provenance selects the coding profile and isolates session/project batches; consolidation preserves coding applicability, validation and scope references in a separate domain checkpoint. The old 60-second coding inbox is no longer an automatic entry point.

The model procedures are native DeepSeek Harness Skills registered by the existing Cordis plugin (`memory-extraction@1.1.0`, `memory-consolidation@1.0.0`, `working-memory@1.0.0`). Their read-only tools remain native Harness tools. `responseMode` is an explicit host contract, independent of skill selection. Persistent global scheduling belongs to the long-lived Mote server; per-query Harness sessions are ephemeral and do not own background timers.

## Verification

`memory-lifecycle.test.ts` replays 480 fictional originals over 180 days, four devices, three speakers and four projects, with 24 revisions, 12 duplicate uploads and eight privacy deletions. The 472 current originals are fully processed by fixture-model batches. It also verifies AND gating, restart/retry, concurrent arrivals, old Chinese/English search, pagination, summary invalidation and exact provenance. This is deterministic fixture coverage, not a live semantic judgment of all records.

`node --import tsx scripts/memory-live-eval.mjs` uses an isolated local Codex App Server with **gpt-5.6-luna / max**, through a loopback test adapter. DeepSeek Harness still chooses and executes its own declared read-only tools; Codex supplies inference. It reuses existing login authentication only, isolates configuration and plugins, and rejects native tool requests. The run caps provider attempts at 20 and uses only generated content. The live subset exercises extraction, consolidation, cross-month FTS retrieval, working summaries and incremental insights. Reports go to `/private/tmp/mote-memory-live-report.json` unless explicitly overridden. This adapter is a test utility, not a new production provider.

No physical capture or personal screenshot is needed by these tests. Live semantic results and physical-device verification must be reported separately from fixture tests.

Completed fixture and live results, costs, repaired failures and unperformed checks: [0.0.31 validation](memory-validation-0.0.31.md).
