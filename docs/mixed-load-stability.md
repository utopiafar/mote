# Fixed-data mixed-load stability

The earlier [mixed-load report](validation/0.0.61/mixed-load.json) verified fault recovery and concurrent progress while importing 100,000 directory records and 400 generated daily observations. Its roughly 152-second duration and rising final RSS/heap did not establish a stable memory window.

The follow-up uses `scripts/benchmark-mixed-load.ts` with `MOTE_MIXED_FILES=100000`, `MOTE_MIXED_CAPTURES=400`, `MOTE_MIXED_MS=120000`, and `MOTE_MIXED_STEADY_MS=720000`. After ingestion, pagination and recovery checks finish, the source dataset is fixed for another 12 minutes. The deliberate late-deletion fixture leaves 399 original notes alongside the 100,000 directory references. No personal content or real screenshots are used.

Two concurrent loops run throughout the tail:

- Browse scoped central archive and Operation pages, then run a real `QueryRuns` step with 15 ms of generated model work and scoped `ContextQuery` retrieval; wait 150 ms after the iteration.
- Rotate through the existing successful background step IDs, explicitly retry each, perform 40 ms of generated work and update its existing result under the engine's fenced commit; wait 150 ms after completion.

This tests actual archive reads, durable query admission, shared execution and commits. It uses in-process desktop-to-central transport and generated model work. It does not measure network RTT, browser rendering or live-model throughput. Original records and background result identities stay fixed; durable query receipts continue to grow as queries complete, which is reported explicitly.

Every second the process records actual RSS, heap used, heap capacity, external memory, ArrayBuffers, waiting queue depth and oldest queued age. RSS covers this process, including its desktop worker thread, fixture orchestration and native allocations; Node heap/external/GC observations describe the main thread. Natural GC events are observed through Node's performance API; no forced GC, heap-cap flag or process restart is used. One-minute memory extrema show whether heap drops occur naturally. A heap drop alone is not treated as an RSS recovery.

The first two tail minutes are warmup. Criteria fixed before the full run require ten subsequent sampled minutes, final five-minute low-water slopes of at most 4 MiB/min RSS and 2 MiB/min heap, sampled queue depth at most eight and oldest age at most five seconds, and complete final draining. These are criteria for this bounded offered load, not a product SLA or a proof that no long-term leak exists. One-second queue samples do not measure every subsecond peak.

The script's added tail path first passed a 500-directory, 12-day, two-second generated fixture. Script typecheck passed. Full-run measurements are recorded below after completion; the short fixture alone does not establish a plateau.

## Measured result

The full run completed in 893.78 seconds, including the complete 720-second fixed-data tail. All original fault/recovery, acknowledgement, pagination, scope and late-delete assertions passed. The tail completed 3,194 queries and 3,194 background executions; durable query receipts increased from 407 to 3,601 while the 100,399 source records and existing background result count remained unchanged.

The 716 tail samples showed zero waiting work; the overall run sampled a peak of one queued step, 119 ms oldest age, and zero remaining work. Tail p95 was 82.41 ms for queries, 2.41 ms for browsing, and 45.55 ms for background execution. Main-thread observation recorded 344 natural GC events, including six major collections.

Actual tail RSS started at 1,081.4 MiB, peaked at 1,221.3 MiB and ended at 337.0 MiB. Heap used started at 345.6 MiB, peaked at 387.3 MiB and ended at 188.3 MiB. Those endpoints show recovery from ingestion, but they do not by themselves establish a final plateau.

| Tail minute | RSS min–max MiB | Heap min–max MiB | Natural GC / major |
| --- | ---: | ---: | ---: |
| 1 | 838.5–1221.2 | 158.4–387.3 | 5 / 1 |
| 2 | 683.5–880.6 | 166.3–217.7 | 3 / 0 |
| 3 | 553.7–688.0 | 159.9–191.4 | 71 / 1 |
| 4 | 540.4–571.0 | 160.2–171.7 | 39 / 1 |
| 5 | 554.2–556.4 | 164.0–174.2 | 25 / 0 |
| 6 | 423.1–559.2 | 160.1–176.1 | 65 / 1 |
| 7 | 416.0–433.7 | 161.1–172.6 | 46 / 1 |
| 8 | 340.9–433.7 | 162.0–173.7 | 24 / 0 |
| 9 | 279.8–341.2 | 168.8–179.5 | 23 / 0 |
| 10 | 282.2–354.5 | 163.5–182.1 | 19 / 1 |
| 11 | 319.2–354.4 | 166.7–182.4 | 12 / 0 |
| 12 | 324.4–337.0 | 173.4–188.3 | 12 / 0 |

The predefined plateau assessment is **false**. The last five one-minute RSS low-water marks have a +0.638 MiB/min slope, within the 4 MiB/min criterion; the corresponding heap slope is +2.052 MiB/min, narrowly above the 2 MiB/min criterion. The thresholds were not changed after observing this result. The last three minutes contain no observed major collection, and durable query history continues to grow; that window alone did not distinguish collectible allocations from retained memory well enough to diagnose the underlying problem.

This closes the missing fixed-data observation and demonstrates queue draining and substantial natural resource recovery under the stated workload. It does **not** establish the stricter heap-plateau acceptance, long-term bounded memory, or live-model capacity. It triggered the small retention diagnostic below instead of another complete import run.

Raw evidence: [fixed-data window report](validation/0.0.61/mixed-load-steady-window.json). All samples and the failed plateau assessment are retained. That initial validation changed no production code.

## Deadline retention diagnosis and fix

On the tested Node 24.15.0 runtime, composing an `AbortSignal.timeout` adds its timeout source to an internal persistent-signal set. The engine used that composition for every deadline, including the 2,147,483,647 ms safety deadline of interactive runs. Successful work removed the composite's listener but left its long timeout alive. A nine-step `async_hooks` fixture reproduced retained deadline timers after success, failure and cancellation. The engine now owns a cancellable `setTimeout` and clears it in `finally`; the regression checks zero retained long timers and preserves `TimeoutError` when an uncooperative processor exceeds 15 ms.

`scripts/diagnose-execution-retention.ts` compares separate processes with four generated originals, 10,000 QueryRuns and 10,004 executions of four fixed background steps. Neither process calls forced GC. Both end with two registered handlers and zero active steps, programs, pending runs, started runs and observed runs. Both retain the same 10,000 durable query receipts.

| Diagnostic | Before | After |
| --- | ---: | ---: |
| Natural major collections | 12 | 5 |
| First / last observed heap after major GC | 22.75 / 37.94 MiB | 16.34 / 15.44 MiB |
| Final RSS | 593.9 MiB | 244.9 MiB |
| Final heap used | 62.4 MiB | 29.8 MiB |
| Runtime | 70.05 s | 72.36 s |

The before-run major-GC observations rise through 23.32, 24.97, 26.37, 28.38, 31.22, 34.58 and 37.94 MiB. The after-run sequence is 16.34, 16.32, 16.39, 16.34 and 15.44 MiB. These matched generated workloads and the timer-lifetime regression support the specific retention fix; they do not establish a latency improvement.

The before process initialized after its imports at 16:09:51.551 UTC on September 22, before the engine file was patched at 16:09:52.617 UTC. The after report additionally records its loaded implementation hash and `usesAbortSignalTimeout: false`. The old report is preserved as generated. Evidence: [before diagnostic](validation/0.0.61/execution-retention-before.json), [after diagnostic](validation/0.0.61/execution-retention-after.json), and `apps/server/test/execution-deadline-cleanup.test.ts`. The deadline/Engine/Query/Indexer focused regression passed 23 tests; script typecheck passed.

A follow-up started with 500 directory records, 12 generated notes and a two-second initial phase, followed by a planned 12-minute tail with unchanged resource criteria. It was stopped as redundant after the matched accelerated comparison and exact timer-release tests had confirmed the defect's correction. Five one-minute console observations were retained, through 300.01 seconds of the tail: 1,686 queries and 1,518 background executions at the last observation, sampled queue zero, RSS 190.2 MiB and heap 30.1 MiB. This is **partial diagnostics**, not a completed 12-minute pass. No plateau result is calculated. The full in-memory per-second/GC report was not emitted after stopping; the partial report states that limitation and retains only the actual console observations and the database counts read after stopping.

Evidence: [stopped small-window diagnostic](validation/0.0.61/mixed-load-fixed-deadline-small-partial.json). Its owning process exited with SIGTERM (143), and its generated temporary archive was removed. The original large-data report and its `observedPlateau: false` remain unchanged.

The validation basis for this resource-lifetime fix is the combination of the completed large-data concurrent functional/recovery checks, exact release of deadline timers across success/failure/cancellation, and the matched 10,000-run before/after natural-GC comparison with empty execution containers. The self-imposed 12-minute slope criterion was useful for discovering the problem; it is not substituted for or silently relabeled as passing evidence. This closes the reproduced execution-resource accumulation defect. It does not claim that the repaired version completed a new 100,000-record steady window or that all future workloads are leak-free.
