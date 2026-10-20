# Desktop performance round 1 — E

Plan v2; implementation base and pre-implementation HEAD:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
Branch: `codex/perf-r1-e-desktop`. Owner E is the only implementation owner.
Independent review must approve this text before implementation.

## Current and intended journeys

The user selects a file/directory in Desktop. `LocalSourceManager.addFiles` and
`sync` validate policy/adapter version, then the registry invokes
`scanSourceFiles`. Its `DirectoryCatalog` sorts each directory once, advances a
durable lexicographic `activeDirectory.after`, and records metadata in an
incremental draft. The scanner uses savepoints to undo an unconsumed shard when
the 16 MiB/2,000-item bound stops processing. SourceSync stages catalog changes
and durable originals before transport; retries/restart retain pending revisions.
Watcher paths take priority without removing the reconciliation scan. Snapshot
recovery uses a second manager scan entry point with the same context contract.

D04 currently filters the entire cached listing on every `next(1)`, even when
stat work is constant. Retain the sorted listing, add a transient position, and
on loading a listing locate the first name strictly greater than durable `after`
using binary search with the existing JavaScript string comparison. Advance only
in the existing committed name loop. `begin`, restore and savepoint rollback
invalidate the listing/position together. No position is persisted. Directory
discovery order, exclusions, up-to-four stat concurrency, stat failure epoch,
skipped counts, candidates, reconciliation and last-item completion behavior stay
the same. Restart lists again and resumes after the durable name, including when
that name disappeared or a new earlier name was added.

D08 currently calls both the full `SourceSync.checkpoint()` deep clone and the
borrowed-catalog `fileCheckpoint()`, although the built-in local-files adapter
uses only the latter. Add optional internal `SourceAdapter.checkpointMode: 'file'` opt-in,
declared only by the built-in local-files adapter. In both normal scan and
snapshot recovery, omit the full clone only for adapters declaring that mode.
All other adapters (including injected custom local-files implementations)
still receive the full cloned checkpoint. Keep the existing fileCheckpoint borrow/draft ownership and staging.
The built-in local-files adapter explicitly declares its existing file-only
checkpoint input; injected adapters retain the original full context by default. No changes to SourceSync state, checkpoint schema, worker transfer,
coding-agent checkpoint contents or calendar behavior are planned.

Desktop's Collector uploads saved queue records under existing sync policy and
node/account binding. A slice allows 25 records/4 MiB/15 seconds, prioritizes live
records until 16 MiB then gives history a turn, and interleaves source slices.
`DurableQueue.nextBatch` orders eligible records stably, loads and verifies each
image, and returns cloned records; transport creates the unchanged JSON/base64
payload and meters actual streamed bytes. Valid per-item receipts cause durable
ACK before removing unreferenced blobs. Missing/transient receipts back off;
409/410 records are held; batch partial results retain unacknowledged items.

D15 currently calls `next()` and then `nextBatch()` for packed upload, rereading
and rehashing the first image. Select the packed batch once. Preserve the current
failure boundary: a failure reading the first item propagates without marking a
record failed; a failure reading a later item still marks the verified first
item failed and emits the existing start/failure event. To do this, add an
optional synchronous first-item observer to the internal `nextBatch` API, called
after its first validated cloned entry is appended. Collector captures that entry
and starts the attempt there; the remaining batch stays private until complete.
The observer only records local attempt bookkeeping and never mutates the queue.
Existing callers omit it. Nonpacked still calls `next` once. Network failures,
per-item receipt handling, attempted-history settlement, durable ACK ordering,
slice accounting and scheduling remain in the existing branches.

The diagnostics recorder is always present in normal main startup, and ignores
`recordUpload` while disabled. Guard construction of the diagnostic argument with
the recorder's actual `status().enabled`. When enabled retain the exact existing
`Buffer.byteLength(JSON.stringify({...event,imageBase64}))` expression. Neither
that counter nor metered transport bytes becomes an estimated value. The existing
queue/slice admission formula is unchanged, including its bounded overshoot.

## Classification and supersession check

| Class | Scope |
| --- | --- |
| KEEP | User entry points, policy/defaults, inputs, retention/privacy, wire/storage, byte accounting, all limits/order/fairness, file access validation, checkpoint/savepoint/restart behavior, stat failure protection, binding, retries/held/ACK/fsync, capture implementation and UI. |
| CHANGE | Transient directory position; avoid an unused local-files full clone at two manager calls; one packed batch read with first-entry bookkeeping observer; skip disabled diagnostics serialization. |
| REMOVE | Repeated full-list filtering; unused local-files clone; first-image redundant packed read/hash; ignored disabled diagnostics argument work. |
| EXCEPTION | None to product behavior. Targeted module checks only are owner-authorized; final combined check:affected remains controller-owned and PR stays draft. |
| UNKNOWN | Host install/native runtime availability and measured speedup; to verify with generated inputs. Real permissions/screens, physical devices and live models are outside fixture evidence. |

Inspected responsibilities include manager normal/recovery scan calls, registry
contracts and all three built-in adapters, SourceSync checkpoint/staging, scanner
savepoint/rollback/reconciliation, queue selection/ACK/retry, Collector upload and
source interleaving, transport/account ingress and DiagnosticsRecorder. Relevant
constraints are AGENTS.md, development plan/background/check rules and
adr-client-action-first's retained collection, source and pending-version policy.
No responsibility or architecture is superseded. Existing consumers' optional
checkpoint/nextBatch signatures remain valid; no obsolete product behavior is
removed. Tests must not encode a new order or relaxed completeness assertion.

## Ownership and validation

Minimum product files: `apps/desktop/src/directory-catalog.ts`,
`apps/desktop/src/source-manager.ts`, `apps/desktop/src/source-adapters.ts`,
`apps/desktop/src/collector.ts`, and
`apps/desktop/src/queue.ts` solely for the D15 optional observer (not D05/06/07).
New E-specific tests/scripts and `docs/design/performance-round1-E-*` are owned
by E. Existing Desktop tests may receive additive assertions; shared helpers,
root manifests/lock/scripts, packages and Server interfaces are untouched.

Validation uses generated data only, independent worktree node_modules/dist,
owner E temporary/profile/artifact paths, port 0 and the campaign resource gate.
Install/build/benchmark/Electron use heavy; small focused tests/type checks may
use light. No full check:affected/check:local, no browser/AVD/physical device,
no real capture, credentials or personal material. Existing assertions/required
scale/timeouts/success criteria and real entry points remain intact.

1. Directory regression: generated sorted large directory and constant metadata
   inspector against a frozen copy of the old algorithm; compare complete
   candidates, skipped/faulted/complete flags, durable checkpoints (normalize only
   wall-clock scan start), catalog changes, exclusions/nested dirs/symlinks,
   missing stat and same-epoch deletion protection. Test savepoint/rollback,
   restore and restart with missing `after`, names around the cursor, repeated
   reconciliations and original four-slot ordering. Time large `next(1)` sweeps
   separately from functional assertions; no absolute performance gate.
2. Real file entry: existing source-files 2,005-file shard/restart and incremental
   draft tests; manager addFiles/sync/restart with generated originals and
   ACK-lost retries, watcher/deletion/pause/privacy scenarios. New spies prove
   local-files normal/recovery scans do not call full checkpoint, while coding
   adapters and injected custom local-files adapters still receive independent
   full checkpoint contents (default mode).
3. Queue/Collector: packed and nonpacked generated images, shared blobs, stable
   equal-time order, due retry/held filtering, 4 MiB batch admission/25-item
   slicing/15-second yielding and source/live interleave; successful/partial/missing
   receipts, 409/410, network errors and later image corruption. Assert one image
   read/hash per returned packed item, first-item failure bookkeeping equivalence,
   exact enabled diagnostics bytes, no disabled diagnostic base64 serialization,
   and actual streamed byte history. Existing queue/transport/source-consumer
   targeted suites supplement these tests.
4. Build Desktop and its shared/diagnostics prerequisites in this worktree. Add a
   generated Electron smoke that loads the existing fixture-background preloader
   before Electron/product imports, sets independent userData/session, does not
   open a window or call capture APIs, invokes the actual Collector upload and
   file manager scan paths, and checks queue drain/restore. This proves Electron
   runtime integration, not foreground UI/native permission or live-model behavior.

Risks are cursor off-by-one after restart/rollback, lost scanner fault state,
accidental withholding of coding checkpoints, changed packed error bookkeeping,
observer exceptions under queue serialization, and disabled-counter divergence.
The observer is synchronous bookkeeping only and explicitly tested; byte formulas
and transport construction remain unchanged. New limits, policy or background
workers are prohibited. Second-round D01/02/03/05/06/07 stay read-only design,
including thumbnail quality/orientation parity and durable blob provenance; no
resident helper, encoder replacement or ACK/fsync merging is in this round.
