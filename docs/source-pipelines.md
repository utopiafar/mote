# Source pipelines: archive first, publish before model processing

This is an MVP storage cut-over, not a backwards-compatible dual-write layer. A server with legacy Coding captures refuses startup with an actionable error. Back up the stopped vault, preserve its configuration/key, and select a fresh data directory before starting this version. This change does not automatically modify a running personal vault. Existing client upload and receipt contracts stay unchanged. Ordinary record-backed sources retain their existing storage path.

## Contract

The host provides private raw-file storage, reliable receipts, durable group work, material publication, indexing, evidence authorization and the existing Memory executor. A Cordis plugin owns the complete source workflow and representation; it does not implement its own SQL database or model client. An installed connector can register one using `ctx.sourcePipelines.context.plugin(plugin)` and dispose the returned Cordis scope in its close hook. See `apps/server/src/coding-source-plugin.ts` for a complete installed example.

A `SourcePipeline` declares:

- `id`, `version`, `sourceKinds`, optional `priority`: explicit protocol identity, never inferred topics. Equal-priority overlapping defaults are rejected. Existing source bindings remain pinned; an owner may select another installed pipeline for the same source kind.
- `storage: records | archive`: record-backed ingestion, or file-only raw events. Moving an existing source between physical storage modes requires a new source identity.
- `group(item)`: deterministic logical grouping using declared source IDs/fields.
- `organize({source, items, group})`: deterministic construction of a complete `MaterialDraft`. It receives values, not the database, filesystem paths or a model client.
- `index: material | none`: whether the published current document participates in full-text search.
- `modelInput: material`: the only input boundary for this workflow's semantic processing.
- `memory`: opt into the existing Memory executor after publication and settling. The executor continues to own model configuration, quotas, concurrency, review, cancellation and retries. No model runs in the raw receiving/organizing steps.

Other workflows can reuse the same host services, register their own representation, and compose registered `ContextProcessor` steps using pinned `materialInputs`. Record-backed files still use their existing extraction/transcription processors. This API does not replace those decoders or require every binary input to become Markdown before OCR/ASR.

## Coding path

```text
unchanged client events and receipts
  → private immutable batch files + file-only version/head manifest
  → one durable work row per source/session group
  → complete chronological conversation Markdown
  → immutable material revision, bounded text sections
      → optional current-document full-text index
      → optional settled Memory job over material sections
      → model catalog, paged reads, verified section citations
```

Raw events produce no `captures`, `source_versions`, `source_heads`, observation, segment or raw FTS rows. SQL stores source/group execution state and aggregate archive size only. File manifests retain retry identity and per-event positions without putting them in SQL. ACK means files and the work checkpoint are durable, not that organization or model processing has finished. Retry after an interrupted commit is idempotent; conflicting revisions are rejected. Raw batches are kept for rebuilding, with the existing content-encryption policy.

Grouping uses source, provider, project and session IDs. Rendering preserves roles, event IDs, timestamps, parts and tool-call IDs. Missing event parts or reference-only inputs are marked partial and are not automatically submitted for Memory extraction. No four-million-character tail truncation remains. Physical text blocks are bounded to 12,000 UTF-16 units; they are contiguous document sections, not raw event records. Markdown fragments concatenate without inserting characters inside words or surrogate pairs. Pages and per-model budgets remain bounded.

Unknown original times are labelled observed times. Equal-time events retain received order; the unchanged client protocol does not include a recoverable native sequence for every provider, so it cannot reconstruct an ordering absent from the input. Unknown fields, local paths and native system/reasoning data are not invented in the Markdown. Raw received source items retain their approved metadata.

Only the latest document revision is indexed, using a contentless FTS index; search does not keep another full text copy. One/two-character queries use a bounded result query over published indexed material blocks. Historical revisions remain readable by pinned ref but do not appear as duplicate search results.

Material section evidence IDs resolve to `material ID + revision + block`, never a raw event row. Existing answer/Memory quote verification reads these sections. Revision replacement invalidates dependent memories and in-flight evidence grants. A whole-session view is conservatively excluded when it crosses the selected hard time/device scope; absence in a narrower view is not proof of absent events.

## Owner configuration and extension

Owner-only endpoints:

- `GET /api/source-pipelines`: installed policies and group states.
- `GET /api/source-pipelines/:sourceId`: effective source options.
- `PUT /api/source-pipelines/:sourceId`: `{ "pipelineId": "installed.id", "index": true, "memory": false, "settleSeconds": 300 }`. Fields other than the settling default may be omitted. Replacement configuration is explicit; changing settings requeues group organization.
- `DELETE /api/source-pipelines/:sourceId`: erase that archive source's materials/history, dependent evidence and raw files, and pause the source to prevent queued uploads restoring it. Only archive-backed sources are accepted.
- `GET /api/materials?query=...`: search published indexed material text, with the existing scope/pagination filters.

Uninstalling a bound pipeline blocks reception and pending organization. It never falls through to the raw record store. Reinstall resumes pending work; upgrading a version requeues existing logical groups. A higher-priority plugin can supply a different default for new sources; `pipelineId` selects it explicitly for an existing compatible source. Source capability registration remains required.

Raw privacy erasure pauses the source and removes published data before file removal. A file deletion failure is reported and can be retried; the source stays paused. Published materials are independent of raw-event database rows. There is no automatic raw archive expiry in this MVP policy (`keep`).

## Backup and validation

`npm run backup` includes `source-archive/` and checksum entries with the database and assets. Stop the server first; preserve encryption keys separately. Portable JSON export rejects archive-backed vaults instead of silently omitting them. Physical and logical storage accounting include the raw archive.

Tests use generated records only: 10,000 events and >4 million characters, zero raw SQL/FTS entries, multiple source kinds, retry/conflict, reopen, plugin removal, short Chinese search, revision movement, scope restrictions, erasure, model extraction inputs, and HTTP → actual agent bridge → verified citations. Physical-device and online-model checks must be reported separately.
