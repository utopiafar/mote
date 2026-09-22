# Operation, import, document, and insight closure

This batch uses generated fixtures and focused regressions. It does not claim a live Gmail connection, physical-device validation, live-model quality validation, or a release build.

## Execution and attribution

Query and insight work is admitted through the shared execution engine, including synchronous API calls. Domain run records project that engine's state and retain bounded progress/result references. The creation-time deadline covers queue time. Cancellation and engine shutdown revoke commit authority, so a late provider response cannot publish a result.

Interactive functions cannot be reconstructed after a process restart. Each owner has a renewable database lease and a distinct handler identity. A second connection leaves a live owner alone; an expired owner becomes `interrupted` instead of silently replaying a model call. Historical successful/cancelled/failed receipts retain their timestamps.

Import prepare and commit are durable engine phases. Preview confirmation remains an explicit blocked step when model mapping requires review. Imports link to capture/file/Memory operations through membership edges; the parent receives later child steps and generation changes from the same authoritative step rows. Query, insight, import, and file analysis pass their operation IDs into model accounting.

## Format decoding and reviewed manifests

Manifest validation, original-file hashing, strict line parsing, and normalized output writing run in the bounded format worker. Original and reviewed-manifest hashes are checked around validation. Cancellation kills the worker before its private temporary file is removed. The server then streams validated records into individually fenced import commits.

`@mote/shared/document-decoder` is the common PDF/DOCX/XLSX contract for Desktop file copying/indexing, central file processing, and import helpers/direct document imports. Decoders preserve PDF page locations, DOCX paragraph text, and XLSX worksheet/row/cell coordinates. XLSX expressions and cached values are returned without evaluating formulas. Known plain formats can be imported as original text without a model choosing authorship or dates.

Original bytes are retained. Author and original event time stay unknown unless supplied as actual metadata. Empty PDF text layers are unsupported; missing text layers and extraction limits produce explicit coverage warnings. Limits bound input bytes, pages, Office decompression metadata, rows, columns, and extracted text. Unsupported formats remain archived and may be mapped in the existing reviewed model workflow. ZIP expansion retains its own bounded archive step.

## Local invalidation and historical versions

`evidence_dependency_edges` projects existing capture, context artifact, file artifact, file chunk, Memory, and Memory-batch lineage. It does not create another state authority. When a file container is rebuilt, a chunk keeps its ID only if text, location, timing, speaker, and other stored metadata are unchanged. Changed chunks receive new identities; their old text remains in the old artifact receipt and their old IDs cannot resolve as current evidence.

Only descendants of retired chunks become stale. Generating a summary no longer marks every Memory of the file stale or deletes all historical insight reports. Original deletion retains the existing privacy invalidation behavior. Memory evidence fingerprints ignore only the processing-container ID; content, source version, chunk identity, and positioning remain part of the fingerprint.

Insights retain a fixed scope, creation time, source-watermark receipt, derived-content fingerprint, coverage gaps, and version lineage. The final snapshot check and report insertion happen in the same fenced transaction. Evidence arriving inside the selected scope requires a new report version; unrelated devices and dates do not reject the run. File-backed Memory dependencies are normalized to their original capture for scope checks. Measured duration is the union of observed device intervals, with overlapping device time and unobserved intervals reported separately; it is not an estimate of work time.

## Focused evidence

- `operation-runs.test.ts`: queue deadlines, cancellation, historical receipt migration, parent membership propagation/rollback, shutdown, and two live database owners.
- `insight-snapshots.test.ts`: overlapping-device time, late evidence versions, preserved prior reports, scoped concurrent-change rejection, and atomic commit fencing.
- `import-manifest-worker.test.ts`: bad later records, changed originals, changed reviewed manifests, and cancellation without worker-slot loss.
- `document-ingestion.test.ts`: the same generated PDF, DOCX, and XLSX through Desktop extraction, automatic import, and central file processing; missing text layers preserve originals without inventing content.
- `evidence-dependencies.test.ts`: changing one of two segments preserves the other identity and Memory, invalidates the changed descendant, keeps historical artifact text/reports, and includes published file-backed Memory in insight snapshots.
- `document-decoder.test.mjs`: missing PDF pages, explicit partial coverage, strict UTF-8, extraction limits, and Unicode-safe chunks.

The latest combined file/document/dependency regression passed 17 tests. The earlier combined import/operation/snapshot regression passed 23 tests. Server and Desktop type checks passed after the decoder and dependency changes. These are batch-local checks; the main release checklist owns the final full regression and packaging results.

## Lifecycle and server assembly closure

Automatic insight generation now uses `InsightRuns`, including the immutable scope/coverage snapshot and atomic versioned report commit. A lifecycle window has a real `workflow:lifecycle:<window>` operation and a fenced engine step. Extraction jobs, semantic workflows and insight runs link their execution membership to the window. Consolidation and working-memory writes check the current grant in the same transaction as their write. An insight child also checks its parent's grant inside the child's final commit, so another host cancelling the parent cannot publish a late report before the local abort notification arrives.

Normal shutdown preserves replayable window checkpoints. Explicit cancellation remains terminal. A second host cannot replay a live window or replace its checkpoint. Semantic model usage and trace metadata use the actual workflow operation and job IDs supplied by the executing host.

Source, processing, Memory, model-profile, and execution-setting routes now have separate registration modules at their existing service boundaries. `app.ts` remains the composition root. External capture, bundle, batch and note admission rejects host-owned `metadata.memoryCorrection` before any write; internal reviewed corrections and authorized archive restoration keep their existing path.

Additional focused validation (generated fixtures):
- Lifecycle execution, insight snapshots and Operation association: 12/12, including cross-host cancellation at final commit and successive automatic insight versions.
- Semantic products, model settings API, query runs, insight runs and malicious correction ingress: 20/20.
- Selected existing lifecycle compatibility cases: 7/7, avoiding the unrelated long-history replay fixture for this iteration.
- Source API/regressions and Memory configuration snapshots: 20/20. The separate budget API case passed 1/1 after allowing its loopback Harness listener; the initial sandbox `listen EPERM` was not a product failure.
- Server TypeScript check passed after route extraction and lifecycle integration.

These are focused fixture results. They do not claim a physical-device run, a live model call, Gmail account integration, or the final workspace-wide release gate.

## Action analysis execution follow-up

The final audit found that calendar proposal analysis still used its own `action_jobs` runner and lacked a model Operation attribution. It now defines `actions.extract` steps in the shared engine, retaining `action_jobs` only as a compatibility projection. The projection is updated by durable engine transitions, including a cancellation from a host that has not loaded the Actions handler. Each intake has a stable `workflow:actions:<key>` Operation; original evidence and semantic child memberships are linked, and model usage/trace uses the real operation and job IDs.

Candidate writes and semantic checkpoints commit inside the engine's fenced transaction, after rechecking original versions, selected time zone and compared proposal versions. Budget blocks and retry timing use engine states. Old completed receipts/attempts migrate without replay. Native confirmation, the first-mutation grant, operation markers and device receipts remain unchanged.

The resulting focused group passed 40/40: Actions execution (five new cases), existing Actions, shared semantic products, and file policy. Server typecheck passed. The file-policy fixture now distinguishes the deterministic default PDF decoder (a malformed PDF remains archived with `unsupported_format`) from an explicitly configured archive-only PDF policy. This supersedes the earlier test expectation that every PDF is archive-only.

## Query final-commit and cancellation regression

Successful query work now prepares its answer before the engine's commit. Conversation creation, its turn, the query receipt and engine success commit in one transaction. An injected receipt failure rolls back the conversation too. On-demand working-memory compaction uses the same grant check. Failure history cannot be written after another host revokes the run.

The local owner observes cross-host cancellation and deleted run receipts without depending on provider cooperation. This releases the model slot and lets shutdown finish even if the provider never resolves. Read projections write only on actual changes. A waiting step whose input was deleted becomes stale before recovery-window expiry is considered. The unconfigured query API retains its configuration error before strict request parsing.

The targeted batch passed 66/66 tests across query commit fencing, conversations, query/insight Operations, diagnostics, insight snapshots, Memory lifecycle and lifecycle execution. Server typecheck passed. These results precede the final workspace gate and do not replace it.

## Deadline retention found by the final load window

The first sustained load window passed data/recovery/queue checks but narrowly failed its predeclared heap low-water criterion. A minimal async-hooks fixture then found a concrete leak in the execution deadline lifecycle: all nine completed, failed or cancelled steps retained their long timeout timers. Interactive runs use a roughly 24-day engine timeout because their real host deadline is managed separately. In the tested Node 24.15.0 implementation, composing an `AbortSignal.timeout` can retain its source signal until that deadline fires even after the consumer removes its listener.

ExecutionEngine now uses an explicit host timer and clears it in `finally` on every settled path. Expiration still aborts with `TimeoutError`, and cancellation/commit fencing is unchanged. The same nine-step fixture now leaves zero long deadline timers; an uncooperative processor still times out. The combined engine, Query, Operation and Indexer regression passed 23/23. The load report retains its initial failed criterion, with separate accelerated before/after diagnostics and focused follow-up rather than erasing the failure or rerunning unrelated full suites.

## Embedding execution follow-up

Indexer discovery now admits actual capture and file-chunk embedding work to the shared execution engine. File chunks belong to their original `file:<captureId>` Operation; chunk IDs no longer masquerade as file Operations. Persistent inputs contain evidence identities and content/configuration fingerprints, while the execution reads current original text. A fenced commit refuses vectors produced after cancellation, deletion or a source/configuration change. Budget reservation and completion receive the Operation of the running step. Provider authentication, retry timing and bounded response validation retain structured failure codes.

The explicit indexing retry API resets the engine receipt as well as its domain projection. Normal shutdown keeps a background step recoverable, while discovery does not replay a user-cancelled step. Temporary query vectors are single attempts under the actual Query Operation, or a standalone embedding Operation when no parent exists. The question remains in memory; the receipt stores its hash. The short deadline includes admission time, and an occupied pool returns lexical results promptly. Optional vector failures retain their real step state, cause and attempt count without turning a successful required Query into a failed Operation. A standalone failed lookup remains a failed Operation.

Seven new generated execution fixtures passed, covering real attribution, no stored question/original text, cross-host cancellation, explicit retry, Retry-After and authentication, shutdown recovery, lexical fallback, optional parent success, a 25 ms deadline and external cancellation. The combined Indexer, metadata, media and retrieval batch initially passed 42/43: the remaining metadata fixture still mocked the former public query-embedding method for background work. It was updated to mock the provider transport and use the unified retry service, preserving its exact activity/content and request-count assertions; its eight-test file then passed. The unchanged 35 cases plus these eight passing cases cover the selected 43-case group. Server typecheck and patch whitespace checks passed. No live provider call, physical-device behavior or workspace-wide release gate is claimed by these fixture results.
