# Android queue follow-ups: AD04, AD01 and AD02

Design only. F-queue-followups-v1. Owner F. Inspected base/HEAD:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
AD05's concurrent uncommitted selection helper does not touch these boundaries.
No second-round implementation is included. Findings below are source inspection,
not measured device performance. See also the [AD09 plan](performance-round1-F-ad09-plan.md).

## AD04: batch only rebuildable browse writes for a verified ACK set

UploadWorker -> Ingress3Client.settleCaptures -> captures(events) validates the
whole receipt -> synchronous per-event current check and callback ->
DurableQueue.acknowledge. For explicit 409/410/413, settleCaptures recursively
splits the request. A successful first half is acknowledged before the second
half's network operation; a later exception cannot erase that progress.

Each authoritative ACK still reads the current event, rejects a late ACK when
stateSeries has gained samples, checks idempotency, and either removes the event
or persists its retention deadline with temp/write/fsync/rename. Shared blobs and
thumbnails disappear only after the final reference. Stage release, mutation
invalidation, operation ledger and sync status keep their existing per-record
order. QueueBrowseIndex is a rebuildable 16-shard projection. Each mutation
invalidates its shard before the authoritative write; normal changed() then
serializes, writes, fsyncs and renames that shard again. A set of ACKs sharing a
shard repeats this projection work.

Proposed seam: extend settleCaptures with an optional synchronous wrapper for
publishing one successfully verified captures(events) collection. The default
wrapper immediately invokes its action, preserving existing consumers. The
worker's wrapper is queue.withDeferredIndexWrites(action). Inside the action keep
the original per-event current check and callback unchanged. Scope it only around
this already verified set, never around captures(), recursion or a network wait.
Singleton 409/410 rejection publication remains unchanged. Each finally ends its
batch scope; projection persistence is attempted only when shared batch depth
reaches zero. The kth callback throwing still leaves earlier authoritative ACKs
durable. The wrapper may not retain/reorder callbacks or
replace exception results. No complete-transport ACK accumulation is permitted.

The existing withDeferredIndexWrites obtains the queue lock only for begin/end;
each individual mutation retains its lock and durability boundary. Concurrent
queue consumers see the in-memory projection; missing on-disk shards rebuild
after interruption. Keep pendingDiskBytes quota accounting. Index persistence
failure retains its existing best-effort behavior; authoritative invalidation
failure remains an error. Do not broaden the process cache lifetime or remove
event fsync.

- KEEP: exact response/owner validation, event ACK and callback order, retention,
  stateSeries stale-ACK rejection, source pause, recursion, retries, shared blob
  references, operation/accounting and network outside the queue lock.
- CHANGE: defer projection persistence during one validated successful set only.
- REMOVE: repeated same-shard projection serialization/fsync within that set.
- EXCEPTION: no product exception. Rejection/conflict/archiveMissing paths keep
  current behavior; no wrapper spans separate network responses. Overlapping
  wrappers may share projection persistence through the existing batch depth.
- UNKNOWN: final wrapper signature and exact failure fixture seam at future HEAD.
  These must preserve the stated action/exception semantics before implementation.

Minimum future sources: UploadWorker.kt and Ingress3Client.kt; DurableQueue.kt
and QueueBrowseIndex.kt should not need changes. New module tests own the added
coverage. Consumers: Ingress3OutcomesTest, MultiuserIngressTest,
QueuePerformanceTest, queue/journey tests and real Worker ACK lifecycle. Generate
same-shard/cross-shard sets, retention 0/nonzero, shared blob final reference,
duplicate/stale-samples ACK, owner change between callbacks, failure at kth ACK,
first recursive half success + later network failure, concurrent browsing and
enqueue, index save/invalidation faults, interrupted batch/restart rebuild.
Count projection seals separately from event seals; event write count/order must
remain equal while each touched nonempty shard flushes once per bounded set in
an uncontended fixture. Preserve exact inventory and pending IDs after restart.
No emulator is needed to establish this JVM seam, but real Worker entry-point
coverage remains separately required for final integration as applicable.

## AD01: spool identity, missing parts and integrity limitation

The actual Android owner is FileArchiveQueue, not a SourceArchive class. Source
UI -> SourceWork -> SourceScanWorker/SourceUploadWorker -> FileSources.prepare ->
FileUpload.syncSlice registers/begins the immutable pending revision. Each slice
then iterates from part zero when begin returns no complete receipt; the existing
complete-receipt shortcut acknowledges directly. queue.part reads the full local part before testing
the server's received checksum/length. Only missing parts are admitted/uploaded;
the next missing part can be read before an exhausted slice refuses it. Default
per-source slices are 4 MiB, 64 requests and 15 seconds, under the existing
dispatch/rotation rules. The current LocalContentCipher for format 4 is identity
bytes; call this repeated read/ByteCipher.open/hash, not production AES work.

Candidate follow-up: atomically publish a descriptor of immutable spool identity,
per-part exact lengths/checksums and manifest identity with the pending revision.
Validate begin's full part-description set (including duplicates, bounds and
lengths), derive missing indices in ascending order, admit by known actual
length before opening a missing part, then read and verify its bytes before send.
Keep per-request self verification, current source/owner checks, budgets,
expiry/pause/ACK/recovery ordering and zero-byte/reference/deleted behavior.

However, cached checksums alone are insufficient for the requested preservation:
the current loop also detects local corruption of a part already ACKed by the
server. A same-size, restored-mtime corruption defeats a file-stat cache. Private
ownership, a read-only application convention, a checksum descriptor, or an open
file descriptor does not prove that bytes have not changed. This limitation is
especially concrete because production spool bytes are not authenticated by a
cipher. Merely skipping the prefix removes a current corruption-detection state.

Therefore the complete prefix-skip proposal is **not implementation ready**.
The future task must first establish a real integrity guarantee with equivalent
failure behavior, or retain verification of local acknowledged parts and report
the smaller benefit honestly. If no such guarantee exists, retain the reads;
neither a TTL nor weakening corrupt-prefix checks is approved. A conservative
descriptor/missing-index design can eliminate the unused next-part read and
duplicate checksum computation only where actual bytes have already been
verified in the same controlled operation; it does not establish zero rereads
across WorkManager invocations or mutate the current storage contract here.

- KEEP: wire/manifest/revision identities, corruption checks currently performed
  by the part loop and the existing complete-receipt shortcut,
  source rotation/budgets, exact owner verification, recovery and ACK durability.
- CHANGE (candidate): immutable descriptor publication and missing-part indexing.
- REMOVE (conditional): only redundant work whose integrity proof remains valid.
- EXCEPTION: none; no permission to skip corrupt-prefix detection.
- UNKNOWN: a sound immutable-spool proof, atomic descriptor recovery and final
  current-format storage representation. Resolve before design approval to code.

Minimum future owners: FileArchiveQueue.kt, FileSources.kt and a private spool
descriptor helper/test if justified. No wire/server or public helper changes.
Generated matrix: 0/1/4 MiB/4 MiB+1/17 MiB+19; no/contiguous/noncontiguous/all
received parts; invalid/duplicate server descriptors; local missing/corrupt ACK
prefix and missing parts (including same-size/same-mtime); corrupt descriptor;
restart and begin/part/commit expiry, lost commit ACK, snapshot exact recovery,
pause/withdrawn owner, source policy change and large/small-source rotation.
Existing 17 MiB JVM queue tests exercise preparation/part/ACK, not the complete
multi-slice FileUpload worker path. Future real-entry-point checks need explicit
isolated headless instrumentation resources; none ran in round one.

## AD02: move SAF copy outside the archive monitor

FileArchiveQueue.prepare already selects a full row/policy/generation snapshot
under its companion monitor, releases it for onSelected and a possibly networked
anchor lookup, then re-locks and compares policy/generation/full row. It then
holds that global monitor across two provider unchanged checks, opening/reading
the complete SAF stream, part writes/fsyncs, digest and manifest publication.
Each part recalculates all archive disk usage with walkTopDown. Thus another
source's progress, part read, ACK or configuration can wait for unrelated SAF
I/O. The digest-to-hex step formats only 32 digest bytes and is not this cost.

Bounded future design: extend the existing selection seam with a unique prepare
token containing account/directory/source, policy/generation and full row.
Write into token-owned staging storage outside the archive monitor. Keep both
provider unchanged checks outside the monitor and retain their relative order
around the stream read. Before each part's write, reserve its actual sealed
storage length under a short monitor transaction; unknown provider size reserves
incrementally, never from the reported length alone. After the final provider
check, re-lock, compare the same full row/generation/policy and token ownership,
then publish the immutable spool and authoritative pending manifest in the
original logical order. Only one token may win a source; losing/error cleanup
may delete only its own staging path and may annotate a failure only if its
original candidate is still current. Never overwrite a newer observed row or
delete another attempt's pending bytes.

The proposed precise usage ledger is a separate correctness obligation, not an
assumed scalar. The next plan must inventory every write/delete/rename of
state/journal/todo/temporary/staging/spool files and preserve their exact current
admission scope. Initialize/reconcile from disk, count orphan staging until it
is actually removed, and retain exact reservations while writes are outstanding.
Within the original per-part comparison, preserve the strict inequality
`used + length + 64 < 1 GiB`, the 512 MiB/source limit and failure semantics;
do not turn it into a new broader quota or silently change metadata admission.
Bytes already written replace their reservation atomically in the ledger and
must never be double-counted or subtracted before deletion succeeds.

Publication crash recovery needs a named token/manifest identity: no row may
point at absent parts, the old pending version must remain valid until its
replacement is durably selected, and startup must reconcile abandoned tokens.
Preserve todo-before-row, activeKey-before-pending-row, per-part fsync,
temp/fsync/rename row commit, one-time importCaptured repair, stability wait,
new_only baseline, reference/deleted no-content reads, exact revision/recovery
matching and the 60 s prepare retry. No new migration/compatibility path.

- KEEP: provider checks, full bytes, privacy/policy, size/quota thresholds,
  stability and lifecycle, durable publication/ACK/recovery and all failures.
- CHANGE (candidate): lock-free SAF staging, token CAS and exact resource accounting.
- REMOVE (candidate): stream/network/provider waits under the archive lock and
  per-part whole-directory size scans. Do not remove reconciliation on recovery.
- EXCEPTION: none; reference/deleted/existing pending still avoid opening SAF.
- UNKNOWN: complete byte-mutation inventory, ledger recovery, exact spool publish
  protocol, provider cancellation and concurrent prepare fencing. This task is
  **not implementation ready** until these are resolved and independently approved.

Minimum future source scope: FileArchiveQueue.kt and FileSources.kt; add
LocalSources.kt/SourceWorkers.kt only for a demonstrated missing cancellation or
generation fence, with a delta review. Do not refactor the text/calendar queue.
Generate a blocked stream while other-source progress/ACK complete; same-source
double prepare; observe/rename/exclusion/retention/allowRead/removal while copying;
cancel/provider failure/incorrect or absent reported sizes; exact capacity ±1 and
two-source reservations; crashes after part fsync, spool publish, row commit and
before importCaptured; restart, pending reuse and stale failure cleanup. Every
case must prove exact remaining bytes/pending rows and no cross-token deletion.

## Shared follow-up constraints

Relevant constraints are in [archive admission/cleanup](../adr-archive-admission-cleanup.md),
[Android local state](../android-local-state.md), and the
[development review/resource rules](../development.md#technical-plan-review).
Use generated inputs, exact future base/head and original-owner plans reviewed
by independent Sol Medium/High before implementation. Any shared/storage contract
or test entry-point expansion needs a delta. All future Gradle work uses the
heavy resource gate and independent output; instrumentation requires an allocated
serial. Round one implements none of AD04/01/02 and makes no device/model claim.
