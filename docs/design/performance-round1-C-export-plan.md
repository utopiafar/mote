# Round 1 C: bounded original export plan

Status: design and generated evidence only; no product implementation authorized in this round.
Owner: C (Originals, ingress, storage and lifecycle). Frozen source base/head:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`. The independent receipt records the
exact documentation commit and this plan's SHA-256. This plan must not follow
`main` drift or authorize the separately scoped WAL proposal. Before any second-round
implementation, the controller must rebind the review to the actual integration
base/head and reconfirm synchronous consumers and async authority/cancellation/
error/backpressure boundaries; this frozen-source review is not rollout approval.

## Decision requested

Approve a future, bounded asynchronous read/hash path for **raw originals in
`GET /api/files/export` only**, retaining fresh full-part verification for every
64 KiB output window. Do not approve a larger output window, verified-part reuse,
a cross-request cache, a new export job/store/grant, or reduced corruption checks.
The optimization target is event-loop responsiveness. It does **not** remove the
logical read/hash amplification or establish a throughput improvement.

A generated mutation witness demonstrates that stream-local part reuse changes
current corruption discovery. No existing owner/ref/hash/part/generation tuple,
file stat identity or database change token establishes immutable on-disk bytes.
Do not infer byte integrity from `mtime`, inode, size or an unchanged SQL token.
A proposal to avoid repeated full-part validation needs a different, separately
reviewed integrity/lifecycle contract and human approval for any product change.

## Complete existing journey and constraints

1. The existing storage-page `FilesExport` control takes explicit MIME and
   current/history selection, authenticates through `Api.raw`, consumes a gzip
   response and saves a Blob only after the response finishes. It aborts on
   cancel, unmount and account replacement. No UI/navigation change is proposed.
2. `registerFileExport` resolves a current account context and creates owner-bound
   `PrivateSql` and `IngressHost.forUser`. It selects **all** matching originals
   and declared linked attachments, with source enabled, privacy/deletion,
   current-head and attachment filters before output. Metadata preserves identities,
   hashes, exact sizes, generation and safe TAR names. The original export limit
   includes metadata and selected bytes; metadata mode opens no byte reader.
3. Selection is bracketed by `PrivateSql.changeToken()`. `current()` always
   reasserts credential/account authority; any local write or other-connection
   commit triggers a complete selection/incarnation proof and a stable token.
   This avoids quadratic full-set rereads without caching authorization.
4. In data mode each original first uses `readOriginal(ref,{length:0})` and rejects
   an unavailable snapshot even if a separate pin exists. The lazy generator
   calls `current()` then `readOriginal` for every at-most-64-KiB window.
5. `IngressHost` re-resolves ref, owned source, device/source capability and exact
   attachment binding on every read. `Originals.read` validates range, snapshot
   expiry and any live original-specific pin. Every intersected part fetches the
   owned object/part checksum, validates owned ancestor directories, opens with
   `O_NOFOLLOW|O_NONBLOCK`, checks regular-file/uid/single-link identity, reads the
   whole `.plain` or `.aes` part, decrypts if needed, and verifies exact plaintext
   size and SHA-256. It slices the requested window only after verification.
6. Attachment exports have a **different existing path**: current selection and
   capture/declared-link validation, then `archivedBytes()` verifies the complete
   object and whole SHA once, followed by 64-KiB slices with `current()` fences.
   This path is outside the proposed optimization and remains unchanged.
7. `exportTar` starts lazily after response hooks, checks authority at entries,
   input chunks and compressed output, enforces exact entry size and safe names,
   and destroys source/gzip on failure or closure. A retired or corrupt download
   cannot finish successfully. Export adds no original pin, managed archive,
   processing work or durable recovery state; retry is a fresh user download.

Authoritative current references: [split export contract](multiuser-keep-controls.md#owner-split-files-export),
[scoped storage](multiuser-content-storage.md),
[Files and delete generations](multiuser-files.md),
[development protocol](../development.md#technical-plan-review).
The generic [asset storage guide](../asset-storage.md) describes legacy AssetStore
stream pins; it does not establish a pin in this scoped split-export route.

Source anchors at the frozen source:

| Responsibility | File / lines |
| --- | --- |
| Selection, token proof, 64-KiB original loop and attachment path | `scope/file-export.ts:16–60` |
| Source/device/ref/attachment authority | `scope/ingress.ts:93–105,179–182` |
| Snapshot/range/part integrity and filesystem admission | `scope/originals.ts:40–45,121–143` |
| Exact attachment relationship and incarnation | `scope/ingress-attachments.ts:5–35`; `scope/ingress-file-forget.ts:15–23` |
| Token includes local writes and other-connection commits | `scope/private-data-sql.ts:58–64` |
| Lazy TAR/gzip, per-block fences, error and cleanup | `file-export-tar.ts:17–39` |
| Actual UI cancellation and Blob completion | `apps/web/src/FilesExport.tsx:6–18` |

Paths without an `apps/` prefix in this table are below `apps/server/src/`.

## Supersession and ownership

| Class | Exact disposition |
| --- | --- |
| KEEP | Current wire/storage/portable formats, MIME/current/history selection and ordering, complete counts, byte/export limits, authentication and source/device/attachment checks, durable generations, existing snapshot/pin admission, per-window fresh checksum and full-part read, lazy streaming/backpressure and error delivery, attachment branch, metadata zero reads, no export pin, existing retry/GC/forget behavior, encryption policy and FULL/fsync/ACK. |
| CHANGE | Future raw split-export windows may await filesystem read and SHA work instead of blocking the event loop. One host-only reader and an additive async-iterable TAR capability are required; no other consumer adopts the new reader. |
| REMOVE | No product capability or check. Reject the audit suggestion to equate a 4-MiB read window or cached part with this route's current 64-KiB revalidation. |
| EXCEPTION | Generated diagnostics disable automatic processing through the existing fixture, use ephemeral client credentials and an ephemeral loopback port. These are measurement controls, not product defaults or full journey restoration evidence. A preexisting live pin can admit an expired snapshot read, but export's initial availability precheck remains unchanged. |
| UNKNOWN | Async scheduling benefit, thread-pool contention, peak memory/cleanup under many streams, and exact controlled expiry/interruption equivalence. The future candidate must pass the validation below; no performance or delivery claim exists yet. |

C is the sole future implementation owner for `scope/originals.ts`,
`scope/ingress.ts`, `scope/file-export.ts`, `scope/app.ts` and new C-specific
tests. IngressHost owns pending reads for its app; app composition registers its
shutdown drain before the shared database is allowed to close.
The controller owns the shared `file-export-tar.ts` change. A change request in
C's orchestration directory describes it; approval here does not grant C editing
rights there. No package/lock/protocol/shared helper, existing fixture or A/B
source change is requested. In particular `processing-imports.ts` and
`processing-files.ts` belong to A and are only consumers to validate. A recording
backup export currently uses the same 64-KiB pattern; adopting the new reader
there is a separate A-owned delta, not implicit scope.

## Intended future algorithm and evidence obligations

1. Add a host-only asynchronous reader for this export. Keep `readOriginal`, the
   frozen plugin `SourceCapability`, download/playback, processing, Ask and
   portable archive readers unchanged. Never pass a caller-selected owner, path,
   SQL connection, task grant or reusable byte capability to background work.
2. Keep 64-KiB output windows. After queue admission, run `current()` and the
   existing ingress/range/snapshot/pin admission again before the actual read.
   Each window derives its own trusted file path and fresh descriptor containing
   deployment/user/context, ref/source/capture, file generation/attachment binding,
   hash/object bytes/part count, part index/checksum, offset and length. The
   selection proof remains owned by the route, not returned to a caller.
3. Use asynchronous filesystem open/stat/read/close with the **same** flags and
   checks; hash every full plaintext part with asynchronous native SHA-256. The
   current AES-GCM open can remain synchronous and bounded to one 4-MiB part in
   this first candidate; do not add key transfer, another encryption format or a
   worker database. Respect current plaintext preference and mixed representations.
   Changing future-encryption policy alone must not retire a valid existing read.
   Keep current key-identity/error behavior; do not invent an enabled-policy fence.
4. Bound byte-bearing asynchronous work to two active windows process-wide,
   at most one outstanding read per stream, using a FIFO in-memory admission
   queue with no new rejection, user quota, timeout or retry policy. Queued items
   contain no file bytes. This is a resource bound, not a durable export job.
   Cancelled queued work is removed; a dispatched read closes its FD and settles
   before its resource slot is released. FD closure in an unconditional `finally`
   must not require still-current account authority: a revoked reader can clean
   its own FD without gaining another read. Native hashing already dispatched may
   finish, but its result must be discarded after cancellation or retirement.
5. Reassert current context/source/device/attachment/generation and re-fetch the
   object/part descriptor after **each await** and before returning/yielding bytes.
   If an admitted identity or explicit snapshot/pin state changed while pending,
   fail closed with the existing appropriate error; never rebuild that read with
   a new generation. SQL change alone still uses the existing complete proof and
   does not automatically retire an otherwise unchanged valid stream.
6. Preserve time accounting: snapshot/pin expiry eligibility for one window is
   sampled at actual read admission, as in current `Originals.read`; passage of
   time is checked again at the next window, never renewed by the export. Explicit
   release/removal or generation change during an await retires the pending
   window. Tests must distinguish deadline passage from an explicit mutation.
   If that cannot reproduce the current admission contract without exposing a
   retired capability, stop and seek a delta review rather than add grace time,
   renew a pin or silently omit bytes.
7. No verified full-part buffer survives to serve the next window. Return only
   the requested bytes; after each completion, drop the full part before admitting
   the next window. In-flight allocations, SHA input copies, decryption copies,
   TAR/gzip backpressure and concurrent-stream bounds must be measured, not inferred
   from the nominal two-slot limit. Do not prefetch the next part/window.
8. The controller's TAR adaptation accepts `Iterable<Buffer> | AsyncIterable<Buffer>`
   and keeps existing synchronous consumers. Input-chunk checks must occur **after**
   awaiting `next()` and before yield; compressed-output checks, lazy start, exact
   sizes, traversal protection, error propagation and source/gzip destruction stay.
   The returned stream close/error or consumer cancellation must first signal
   the pending read/queue, then await pending `next()` settlement and iterator
   `return()` cleanup. Calling `return()` alone cannot interrupt an async
   generator already awaiting `next()`. The shared adapter owns that early abort
   signal and passes it to the C-owned reader; its abort action cannot wait for
   the generator finalizer. Do not settle HTTP success while a source error or
   cancellation is pending.
9. IngressHost tracks only its own export admissions/in-flight work. Its idempotent
   shutdown first stops new admission and signals queued/dispatched work, then
   drains all owned native work and FD/iterator cleanup without a new timeout or
   early slot release. C-owned `scope/app.ts` registers and awaits this drain in
   preClose/onClose/error cleanup before closing the shared database. A revoked
   context cannot prevent this fixed-resource cleanup; one host must not cancel
   another host's exports in a shared process. Existing domain close ordering and
   synchronous consumers remain, with this required read-drain dependency added.

The async API choice follows the [Node filesystem promises API](https://nodejs.org/api/fs.html#promises-api)
and [SubtleCrypto digest API](https://nodejs.org/api/webcrypto.html#subtledigestalgorithm-data).
Its responsiveness and thread-pool contention still require measurements on the
actual supported runtime; API names alone establish no measured benefit.

The mutation witness in [the evidence report](performance-round1-C-evidence.md)
is a required durable regression for a future implementation. A byte near the end
of a part changed after its first window must fail at the next window even when
that window does not include the changed byte. Stat-only proof and matching SQL
must not allow it. Final output SHA is verified by the test consumer; this plan
does not add a new whole-object hash to the original product's per-part path.

## Validation and resources for a future candidate

Use C's generated data, private tmp/profile directories and campaign resource
gate. Benchmarks/builds/browser work are heavy; small targeted tests may be light.
No real screenshots, daily credentials, real profile, device, simulator or live
model. A real CLI, if needed, must use explicit `--home` under C/profiles and a
random port. No complete `check:affected`/`check:local` in this round.

| Journey / transition | Required oracle and real entry |
| --- | --- |
| Empty, <64 KiB, exactly64 KiB, 4 MiB, multi-part/tail, encrypted and mixed | Real HTTP upload begin/parts/commit → split export → gunzip/TAR; exact members, sizes, final SHA, zero metadata byte reads; preserve original limits and >one Files page coverage. |
| Corruption present initially, later part, same part after first window, during awaited read | Generated physical object mutation with recorded boundary; no completed archive, same missing/length/hash/AES errors; re-read/hash bytes counted separately from output and from physical disk I/O. |
| A/B same IDs/hash; device/source restrictions; declared vs linked attachment and parent replacement | Existing HTTP authorization and selection fixtures; no B bytes, source selectors cannot be forged, attachment branch unchanged. |
| Account disable/logout, source off/privacy, current head swap, forget/allow/recreate same IDs, attachment rebind | Barriers at real source admission, await completion and compressed output; no subsequent private output after retirement; new request succeeds only for current allowed identity. Include other-connection commits and rollback-token invalidation. |
| Snapshot expiry before request, between windows, while queued/read; live pin then expiry/release; GC/delete | Controlled clock/state boundaries with no sleeps as evidence substitute; preserve initial410, original-specific pin behavior and admission time; no new export pin/TTL or revival, exact cleanup/pending behavior. |
| Cancel/unmount/disconnect while queued, open/read/hash or gzip backpressure; host shutdown | Real HTTP stream closure and await barriers; queued work removed, FD count and resource slots return to baseline, dispatched native work settles, no late yield/unhandled rejection/hang, B remains usable. |
| Unchanged synchronous TAR consumers | Existing `file-export-stream`, transcript/recording backup and legacy file-export fixtures; same contents and authority/error behavior after additive AsyncIterable support. Do not treat mocked async iteration as real HTTP proof. |
| Responsiveness and resource benefit | Same generated files and complete assertions; separately report total export wall time, concurrent health/authorized read latency, event-loop delay, CPU, logical read/hash bytes and RSS/FD high water. Require demonstrated benefit before proposing implementation delivery; no fixed product SLO or relaxed timeout is introduced. |

Existing focused starting points are `multiuser-keep-controls.test.ts`,
`multiuser-keep-independent-http.test.ts`, `multiuser-keep-cache-independent-http.test.ts`,
`file-export-stream.test.ts`, scoped original/snapshot/forget/content-storage tests,
and the real Web controller tests when its transport behavior is affected.
No existing assertions, scales, lifecycle ordering, timeouts or success criteria
may be weakened. The future implementation owner records exact commands and
states reached. The controller alone drives final affected consumers/integration
checks after convergence. Physical device, UI and live-model evidence remain
separate and unperformed in this design round.
