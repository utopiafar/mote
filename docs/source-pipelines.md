# Source pipelines: archive first, publish before model processing

This is an MVP backend epoch 4 baseline, not a backwards-compatible dual-write layer. An old vault refuses startup with an actionable error. Stop the server and explicitly run `npm run reset:mvp-vault -- --data-dir <directory> --confirm-clear` before starting the new backend. This removes historical data and old connection records while preserving configuration and keys; it does not automatically modify a running vault. Client releases are independent; consumers must support the required ingress/data formats, without matching component versions. Collector writes require `X-Mote-Ingress-Version: 2`, and a versioned receipt means only that the input can be recovered. Ordinary record-backed sources retain their physical storage path but use the same receipt, recipe, execution, and material publication boundaries. See [后端流程重构工作稿](backend-plugin-rearchitecture.md) for the full contract and confirmed product decisions.

## Contract

The host provides private raw-file storage, reliable receipts, durable group work, material publication, indexing, evidence authorization and the existing Memory executor. A Cordis plugin owns the complete source workflow and representation; it does not implement its own SQL database or model client. An installed connector can register one using `ctx.sourcePipelines.context.plugin(plugin)` and dispose the returned Cordis scope in its close hook. See `apps/server/src/coding-source-plugin.ts` for a complete installed example.

A `SourcePipeline` declares:

- `id`, `version`, `sourceKinds`, optional `priority`: explicit protocol identity, never inferred topics. Equal-priority overlapping defaults are rejected. Existing source bindings remain pinned; an owner may select another installed pipeline for the same source kind.
- `storage: records | archive`: record-backed ingestion, or file-only raw events. Moving an existing source between physical storage modes requires a new source identity.
- `recipe`: a versioned declarative DAG bound to trusted reader, grouping, organizing, publication and exposure components. The Coding recipe receives a scoped, paged `RawReader` and reads only newly appended archive references when the prior published head can be reused. Archive pipelines require a declared recipe; trusted recipe components own deterministic grouping and organization.
- `index: material | none`: whether the published current document participates in full-text search.
- `modelInput: material`: the only input boundary for this workflow's semantic processing.
- Automatic Memory permission is recorded for new source inputs. `memory` is not a pipeline/configuration field. Required outputs, selected Memory recipes, source grants, settling and readiness determine when the existing executor can start. Receipt reuse and derived changes do not renew paid extraction authorization. Explicit owner tasks remain available.

Other workflows can reuse the same host services, register their own representation, and compose registered `ContextProcessor` steps using pinned `materialInputs`. Record-backed files still use their existing extraction/transcription processors. This API does not replace those decoders or require every binary input to become Markdown before OCR/ASR.

## Coding path

```text
v2 client events and durable receipt
  → private immutable batch files + file-only version/head manifest
  → one durable work row per source/session group
  → complete chronological clean conversation Markdown
  → immutable material revision, bounded text sections
      → optional current-document full-text index
      → existing authorized Memory task / receipt
          → background conversation understanding over bounded sections
          → summary + work records + optional events + Memory candidates
          → independent Memory review and publication
      → model catalog, paged reads, verified section citations
```

Raw events produce no `captures`, `source_versions`, `source_heads`, observation, segment or raw FTS rows. SQL stores source/group execution, authorization and a file-only manifest index; raw event bodies stay in batch files. File manifests retain retry identity and per-event positions without putting them in SQL. ACK means files and the work checkpoint are durable, not that organization or model processing has finished. Retry after an interrupted commit is idempotent; conflicting revisions are rejected. Raw batches are kept for rebuilding, with the existing content-encryption policy.

Grouping uses source, provider, project and session IDs. Raw archives are private deterministic-processing inputs, never model context. Schema 6 admits only verified human utterances and protocol-confirmed final agent replies. Commentary, reasoning, diagnostics, tools, host envelopes, subagent conversations and unknown speaker/finality are excluded before indexing and all semantic processing. Complete multipart events are assembled before admission. Explicit leading host envelopes are removed; messages over 12,000 UTF-16 units are withheld with fidelity limitations. Missing parts and reference-only inputs remain partial and cannot grant automatic Memory work. Native Claude UUIDs provide stable event identity; sidechain copies cannot replace canonical events.

Physical text blocks and per-model evidence ranges are bounded to 12,000 UTF-16 units. Markdown fragments concatenate without adding characters inside words or surrogate pairs. The prior full-conversation model overview pass has been removed. Every model-facing surface requires schema 6, including historical-derived lineage. The default Coding recipe uses manual reprocessing: installing this version does not rebuild or backfill existing archives. New receipts use the current rules; old schema bodies are denied to models rather than read as fallback. Fidelity limitations disclose omitted process text, unconfirmed replies and oversized messages. Agent reports remain unverified; meaningfulness and memory value remain model decisions over admitted dialogue.

Desktop sends the canonical channel and attribution fields. Retries preserve the immutable input payload; there is no old-field negotiation or persisted legacy wire variant.

### Shared conversation understanding

The Coding processor is a child of an existing authorized Memory task, not a model call on every receive. The automatic path requires applicable recipe/source authority and an authorization recorded at raw receipt time; an owner may also explicitly start a Memory task over the selected evidence. Deterministic publication, upgrading the organizer, importing historical raw input or later changing settings never creates a new automatic model grant for previously denied input. Tool-only arrivals do not count as new conversational input or renew a completed grant. If required outputs are not ready or authorization is absent, clean publication and source retrieval still work without background understanding.

While a parent waits for a queued child, durable input authorization remains valid independently of the parent’s temporary running lease. Cancellation, paused admission, revoked source grants and changed material inputs still prevent child publication.

Within that task, the processor uses the existing background execution lane, model selection, usage ledger, parent material authorization and semantic-product contract. It reads a pinned, bounded range of the clean conversation and produces one interpretation for downstream consumers: an attributed summary, work records, optional personal events and proposed Memory candidates. Work records preserve requirements, constraints, decisions, reported results, validation statements, open items and artifact references. The selected extraction policy guides Memory candidates; its fingerprint participates in the processing task identity, so a different extraction policy cannot reuse the old policy's candidate output. The model decides which products are useful; empty events and Memory candidates are valid. Coding understanding emits no calendar action cues.

The readable, searchable semantic body contains the summary, work records and events, including actor, status, basis, source time, uncertainty and original evidence IDs. Memory candidate bodies are not copied into that search/read projection. They remain structured task metadata for the separate Memory admission/review stage, whose published results use the existing Memory surface. A navigable work record or event therefore remains available even when no candidate qualifies for durable Memory.

Every claim retains its actor, status, basis, source time, uncertainty and exact original support. Host validation checks original evidence IDs, unique quotes and absolute UTF-16 offsets inside the supplied range. Derived summaries and work records never become original evidence. Memory admission/review remains an independent decision over those same source anchors; producing a useful work record does not make it durable personal Memory.

`sourceTime` identifies when a supporting statement was recorded; `occurredAt` is present only when the event's occurrence is explicitly established. A reported outcome by the assistant is not independent verification. Conversation gaps do not measure work duration. A bounded processor result does not establish full-session coverage or the absence of events outside the range. Long conversations remain paged source evidence rather than silently keeping only a head or tail.

Publication and indexing do not depend on a model succeeding. Authorized background understanding may remain pending or fail while the clean conversation stays readable. Query agents use the existing read-only catalog/search/read surfaces and decide when to expand from a compact product to supporting source sections. They receive no raw-tool read capability and cannot write back to Claude Code, Codex or Kimi memory/configuration. Raw archival access and query exposure remain separate permissions. See [Coding conversation and Memory](coding-agent-memory.md) for an example and the historical chain.

Unknown original times are labelled observed times. Equal-time events retain received order; the v2 client event shape does not include a recoverable native sequence for every provider, so it cannot reconstruct an ordering absent from the input. Unknown fields, local paths and native system/reasoning data are not invented in the Markdown. Raw received source items retain their approved metadata.

Only the latest document revision is indexed, using a contentless FTS index; search does not keep another full text copy. One/two-character queries use a bounded result query over published indexed material blocks. Historical clean revisions remain readable by pinned ref but do not appear as duplicate search results. Every model-facing Coding material and derived lineage must satisfy schema 6. The current recipe does not automatically rebuild historical archives; explicit reprocessing follows owner authorization. No old body is read as a fallback.

Material section evidence IDs resolve to `material ID + revision + block`, never a raw event row. Existing answer/Memory quote verification reads these sections. Revision replacement invalidates dependent memories and in-flight evidence grants. A whole-session view is conservatively excluded when it crosses the selected hard time/device scope; absence in a narrower view is not proof of absent events.

## Owner configuration and extension

Owner-only endpoints:

- `GET /api/source-pipelines`: installed policies and group states.
- `GET /api/source-pipelines/:sourceId`: effective source options.
- `PUT /api/source-pipelines/:sourceId`: `{ "pipelineId": "installed.id", "index": true, "settleSeconds": 300 }`. Fields other than the settling default may be omitted. Replacement configuration is explicit; changing settings requeues group organization.

- `DELETE /api/source-pipelines/:sourceId`: erase that archive source's materials/history, dependent evidence and raw files, and pause the source to prevent queued uploads restoring it. Only archive-backed sources are accepted.
- `GET /api/materials?query=...`: search published indexed material text, with the existing scope/pagination filters.

Automatic admission pins the host's raw input identity separately from the material revision: a source-head capture for ordinary sources, or the archive group checkpoint for Coding sources. Processing completions cannot masquerade as new raw input. Current deterministic publication and explicit rebuild do not grant new model work. Readiness is separate from automatic authorization, so a withheld grant does not hide the material or prevent an explicit owner request. Missing authorization fails closed; there is one current material work queue. Startup recovery of automatic material jobs belongs to this queue, not the generic detached-job resumer. Deletion removes the queue state and durably requests cancellation.

Automatic permission is recorded in the raw receiving transaction, using host policy at receipt time. Ordinary sources bind it to the new capture; archive sources bind it to the changed group checkpoint. Denied receipts are retained too. Enabling processing before publication, restarting, repeated delivery, or deterministic recovery cannot turn a denied receipt into a grant. Publication and launch also check current policy. Claiming a grant and recording its job ID are atomic; recovery may use only that same job. Source/capture erasure removes its grants, and receipt metadata obeys the shared storage quota. Connector initialization consults persisted policy even before the lifecycle runtime is constructed.

Receipts and requests bind explicit recipe scopes. Independent simultaneous Memory recipes keep separate grants, fingerprints and review products; selected historical recompute requires explicit scoped authorization. Integration and insight workflows retain their own admission and lifecycle.

Uninstalling a bound pipeline blocks reception and pending organization. It never falls through to the raw record store. Reinstall resumes pending work; upgrading a version requeues existing logical groups. A higher-priority plugin can supply a different default for new sources; `pipelineId` selects it explicitly for an existing compatible source. Source capability registration remains required.

Raw privacy erasure pauses the source and removes published data before file removal. A file deletion failure is reported and can be retried; the source stays paused. Published materials are independent of raw-event database rows. There is no automatic raw archive expiry in this MVP policy (`keep`).

## Backup and validation

`npm run backup` includes `source-archive/` and checksum entries with the database and assets. Stop the server first; preserve encryption keys separately. Portable JSON v2 includes checksummed source archives and Material histories; it is bounded by export size and omits execution/replay state. Full offline backup preserves durable execution. Physical and logical storage accounting include the raw archive.

Tests use generated records only: 10,000 events and >4 million characters, zero raw SQL/FTS entries, multiple source kinds, retry/conflict, reopen, plugin removal, short Chinese search, revision movement, scope restrictions, erasure, model extraction inputs, and HTTP → actual agent bridge → verified citations. Physical-device and online-model checks must be reported separately.

## Bounded automatic Memory packages (2026-10-10)

Ready newly authorized inputs enter structural rolling packages without a mandatory planner. Exact recipe scope, input pins, per-member contextTime and attribution remain independent. The existing eight-member and 12,000-character multi-member bounds remain; there is no wait-to-fill window or historical grant. Every target range receives coverage/capacity accounting and independent review, including no candidates. Coding productsVersion 2 candidates replace extraction only for the exact complete unsaturated generation contract. Genuine needs_context feedback and accepted proposals retain their scoped planner path. See [ADR](adr-system-refactor.md).
