# Cross-client upload scheduling

The production desktop collector alternates bounded capture turns with source-upload slices. A source yields after admitting about 4 MiB of request bodies, 64 requests or 15 seconds. An already admitted request finishes, so the byte limit may overshoot by one protocol-bounded request and the time limit by that request's own timeout. Original parts remain 4 MiB. The next source then runs, and capture/note uploads get a turn between sources. The same manual sync action continues the rounds until the selected sources drain; yielding is not an error or a new confirmation request.

Within one source, real-time and historical queues account for admitted request-body bytes. History becomes eligible after a 16 MiB real-time burst. Yielding before a history request is admitted does not reset that eligibility. The policy is based on explicit queue labels and byte accounting, never interpretation of source text.

Capture turns are bounded by 25 entries, approximately 4 MiB of encoded payload or 15 seconds before the next request. New observations since the current sync began get preference over older captures, followed by an oldest-first turn after a 16 MiB burst. Existing transport timeout, privacy, binding, idempotency and ACK checks still apply. Original capture time/IDs/payloads are not changed by prioritization.

A partial original keeps its outbox entry and immutable local parts. On the next slice, the central upload receipt identifies already accepted parts; only missing parts are sent. The local original is removed only after the final matching version ACK. Cancellation or a failed transport request is not converted into a successful yield. The process-local byte counters may restart, but server part receipts and the local outbox remain durable.

Batch capture 413 responses split the batch recursively; a single oversized record remains an error with its ID preserved. Only 404/405 route absence uses the legacy single-capture endpoint. 401/403/429 never switch upload endpoints, and malformed/mismatched ACKs remain errors.

## Validation and remaining boundaries

Generated tests cover a 20 MiB original yielding to 400 dated notes, process reconstruction and exact final bytes, cancellation, byte-based real-time/history service, 401/403/429, 413 splitting, and one manual collector flush of 400 historical notes plus a new note inserted between source turns. The larger durable-write fixtures use a 30-second test timeout; their original five-second harness limit was exceeded under parallel filesystem load without an assertion failure.

`scripts/test-upload-fairness.cjs` uses the actual compiled desktop source manager, workers and central HTTP/SQLite. With one 20 MiB original and 400 small generated files, all four small-file manifest batches complete between original parts 0 and 1; seven source turns finish the large original with an identical SHA-256. The Electron offline-binding fixture also checks the real main/preload IPC, manual-sync policy, unchanged payloads and both queues draining.

Android now rotates per-source 4 MiB/64-request/15-second slices within bounded dispatches, with a separate bounded capture queue. Web uploads one 4 MiB part per file in round-robin order and preserves upload IDs after lost ACKs. Desktop scan and upload tasks are independent; serial source-state mutations do not hold their lock across a network wait. See [client contract and focused evidence](client-scheduling-and-status.md). Scheduling is local to each client and central resource pool; it is not a global bandwidth allocator across devices.
