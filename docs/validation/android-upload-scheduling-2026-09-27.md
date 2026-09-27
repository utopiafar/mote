# Android upload scheduling

A note saved after an upload's final empty-queue check could lose its wake-up while that worker was still `RUNNING`: WorkManager `KEEP` ignored the new request. Scheduling now retains at most one waiting successor. Repeated producers preserve an existing successor or retry backoff. Explicit sync keeps its existing replacement behavior.

Immediate, timer and periodic upload workers also shared an outbox without excluding concurrent reads. A generated run observed the same note sent twice. Capture uploads now acquire a process-local gate before the connection guard and recheck cancellation and current connection settings. Contention waits at most 250 ms, then retains WorkManager's existing retry/backoff. Source uploads, heartbeats and UI actions do not acquire this gate. Ambiguous network failures can still require retrying an ID; central idempotency remains necessary.

The existing background scheduling executor performs WorkManager query/enqueue waits; UI calls continue to dispatch asynchronously. A slow WorkManager database can still delay that background scheduler. `APPEND_OR_REPLACE` in WorkManager 2.10.2 does not rescue a successor when its predecessor fails or is cancelled after enqueueing. Tests verify that propagation and recovery through a subsequent scheduling event.

## Validation

Only a newly created API 35 / Android 15 / en-US emulator (`mote_fixture_api35`) and generated records were used. No existing emulator or physical device was used; no personal screenshots, real model, OCR or ASR calls were made.

- Offline Android build passed; JVM 214 tests across 49 suites passed without failures or skips.
- Final instrumentation: 30/30 passed (OfflineSync 20, LocalSources 3, Connection 6, NativeAsk 1), without skips. Coverage includes concurrent scheduling, one successor, retry backoff, cancellation, configuration changes, pending-data node protection and independent worker contention.
- Connection tests now locate translated labels using the active catalog. The final device run used English; a separate Chinese-device run was not performed.
- Root review verified all four source hashes, original failure-log hashes, final instrumentation output and JVM XML totals. Translation and diff checks passed.

The first 24-test run had four failures. Its realtime timeout lacked sufficient counters for unique causal attribution. Separate deterministic WorkManager failures established the lost-wake window and concurrent outbox access; both before-fix logs remain available. A later 28-test run also exposed the duplicate-send counter before the upload gate was added. None of these failures was overwritten.

External evidence: `/Users/utopiafar/Documents/Codex/mote-goal-2026-09-27/android-emulator-validation-001/ROOT_SAFE_android-sync-fix-validation.json` (SHA-256 `ded1b606957f885bd1257987ba4df28504587fef910fcf5ca250ae5abce777b0`). The earlier three-round complex-note run used 18 generated notes and is separate from these 30 tests; it was not repeated after this repair. Physical-device, OEM power-management and post-repair process-kill recovery remain unverified.
