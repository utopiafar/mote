# AD05: select only the capture payload that will be sent

Plan identity: F-AD05-v1. Owner: F. Base and preimplementation HEAD:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4` on `codex/perf-r1-f-android`.
This is the bounded first-round implementation plan; AD04/09/01/02 remain design only.

## Current and intended journey

Capture services and QuickNotes durably enqueue records. SyncSchedule dispatches
UploadWorker under the capture upload gate and ConnectionGuard read boundary.
The worker checks its stamp, manual/paused state and sending conditions, then
selects live records while the existing 16 MiB live turn permits, otherwise
history. DurableQueue.peekBatch sorts by modified time and ID within that
priority, excludes uploaded/blocked/foreign-origin records, applies the metadata
window, reads selected events/blobs, encodes images and applies count/4 MiB
transport bounds. It returns one oversized first record for existing rejection
handling. Today non-packed upload selects up to the remaining operation size and
then sends only take(1). The next iteration repeats unused payload preparation.

The intended flow chooses maxCount=1 before payload materialization for non-packed
upload and the unchanged remaining count for packed upload. The worker still sends
the selected record(s) through Ingress3Client.settleCaptures. That client verifies
the exact owner and response before the existing per-record acknowledgement,
retention, conflict/missing, status and accounting callbacks. Failures, stop,
pause and continuation behavior stay in their current code paths.

## Classification and scope

- KEEP: queue order and filtering, metadata windows, 4 MiB limit, oversized first
  record, remaining operation size, live/history accounting and turn persistence,
  WorkManager/manual retry, ConnectionGuard, transport/ACK validation, fsync,
  retention, source pause and partial failure handling.
- CHANGE: non-packed selection count is one before event/blob/base64 construction.
- REMOVE: construction of payloads discarded by the non-packed take(1).
- EXCEPTION: no product or isolation exception. Tests use generated records and
  private JVM temporary directories; no screenshots, credentials or devices.
- UNKNOWN: physical-device latency and allocation impact. No timing claim is made.
  Queue metadata index preparation still inspects metadata and is outside AD05.

Minimum owned source: UploadWorker.kt and a small internal CaptureUploadBatch.kt
extension that delegates to the unchanged peekBatch with this transport count,
the existing byte bound, supplied metadata window and supplied preferSince.
The extension is the actual worker call site and permits a generated JVM test
without constructing Android WorkManager. DurableQueue, Ingress3Client, shared
helpers, build files and other modules are unchanged. A new
CaptureUploadBatchTest.kt is the only new test owner. It adds coverage rather than
altering any existing entry point, assertion, required scale, timeout or criterion.

## Validation and resource boundary

New generated JVM scenarios exercise the same selection extension as the worker:
count blob ByteCipher.open calls to prove one non-packed blob is loaded and later blobs
are untouched; compare packed selection and exact payload; same-modified-time ID
order; metadata windows with mixed image/metadata records; oversized first record;
preferSince live then historical selection; selection/retry does not ACK and a
single actual ACK survives restart with remaining records and bytes intact.
Use explicit fixture file times rather than waiting for wall time.

Run the new suite plus existing DurableQueueTest, Ingress3OutcomesTest and
MultiuserIngressTest (queue/transport consumers) through testDebugUnitTest with
exact --tests filters. Existing outcome tests cover invalid ACK, owner change,
partial failure, source pause and singleton oversized rejection. This proves the
JVM selection and transport contract, not real WorkManager startup/conditions.
No instrumentation/AVD/physical-device or live-model checks this round.

All Gradle dependency resolution, compilation and tests use the campaign heavy
gate, F/gradle-user-home and this independent worktree's Gradle project output,
--no-daemon, bounded workers and in-process Kotlin compilation. No node install is
needed for the JVM patch. Final check:affected belongs to the controller; this PR
stays draft with unified integration validation pending.

Risks: a helper must be the actual worker selection call, not a test-only copy;
tests distinguish blob opens from metadata/index opens; generated timestamps
must exercise ties/live/history deterministically. Deferred construction means
later-record payload faults surface on that record's actual turn. No queue
validation or corruption checks are removed. Documentation and diff review will
confirm no unrelated paths changed.
