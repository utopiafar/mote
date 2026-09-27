# Heldout replay: one-batch wave-1 continuation

The adapter now permits only the next original batch of the same wave-1 job, indices 1–5. Every invocation remains limited to one complete batch, at most two outer admissions, 300 seconds per outer, and the unchanged 720-second supervisor. It does not implement integration, later-wave ingestion, or question A/B. This implementation used no real model and did not read any heldout source/question/output semantics.

`stage-resume-freeze` is a zero-model mode. It requires the previous executor manifest, the existing external ledger, the last successful closed checkpoint, the next batch index, and the applicable safe offline report. It writes only a new manifest. Its `continuation` section fixes:

- Parent checkpoint path/tree hash and batch index.
- Previous manifest path/SHA-256.
- Offline validation path/SHA-256; the report must pass, have zero real calls/no heldout semantic exposure, and match the new runner file hashes.

Production source/dist, runtime, inputs, model/strategy settings, original seed/job/batch plan, and stable experiment identity remain unchanged. Only executor source/supervisor pins and the new fixed continuation request change. `stage-live` consumes that manifest; no supervisor change or unpinned parent/index argument is required.

Before opening a live node, the adapter reads the closed parent and ledger without modification. It rejects a live writer, uncertain/failed accounting, an earlier checkpoint, skipped or repeated index, changed pending-batch pin, missing completed checkpoint, changed production pins, or an executor whose predecessor is not the latest recorded executor. The ledger is rechecked under its exclusive lock before appending the executor transition and new stage. It never clears old accounting or regenerates a completed batch.

The synchronous public `ExecutionEngine.project` method is wrapped only in the isolated adapter: the ordinary projection runs first, then `MemoryPipeline.pause()` is called when the chosen batch becomes running. This preserves the same batch's review/commit while also handling cached empty candidates that require **zero** new queries. Waiting for the first query alone would not pause such a batch. No production source, SQL scheduling state, or provider-failure substitution is used to create the boundary.

Validation: 7 tests / 10 check groups passed with 7 stub calls and 0 real calls. Two consecutive resumptions used 2, 2, 1 calls across three batches, preserving the original manifest, parent snapshots, old ledger byte prefix, inherited usage IDs, and generation draft. Empty-candidate stages used 1, 1, 0 calls and left the fourth batch pending. Rejection cases preserved the ledger and parent snapshot. The existing first-stage suite passed 12/12 with 9 stub / 0 real calls; scripts TypeScript checking and `git diff --check` passed. A mechanical CLI `stage-resume-freeze` smoke also passed without opening a model.

Safe report under the external 2026-09-27 Goal directory: `heldout-continuation-offline-004/ROOT_SAFE_continuation.json`, SHA-256 `5101877c0d9ec7e724cdd8e365feb7fe8477ed879d3af29572328d7d95afed9e`. First-stage regression: `heldout-stage-regression-011/ROOT_SAFE_tests.json`, SHA-256 `3a3f79382d906a8e16df06c876f6dfd95f5e4c0b28b2d87a3c0e5859194684f8`. CLI smoke status SHA-256 `f2873d0b006365b379816d59dea59db25d6b624c80708dc85c5bfc3dad0523cb`.

The first mechanical attempt (`heldout-continuation-offline-001`) stopped before execution because the fixture's 512-character cap split each serialized Material into two pieces. The independent fixture cap was corrected to 1024; heldout inputs and the real 12000-character plan were unchanged. All prior outputs remain separate. Final executor freezing must occur in the dedicated execution checkout after this runner-only change is reviewed and transferred there; the implementation did not modify that checkout or inspect its running live result.
