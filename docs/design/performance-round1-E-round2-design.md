# E second-round bounded design — no implementation approval

Read-only evidence at frozen base
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`, independently investigated by
`/root/round2_readonly`. These options need a future owner plan with exact
candidate base/head and independent approval. Round 1 does not implement them.

## D05/D06: exact accounting and lightweight pages

`queue.activeUsage` serializes complete QueueRecords and counts shared blobs
once. `stats` caches record sizes but still traverses records, and `exclusive`
invalidates aggregate stats even after reads. `nextBatch` filters/sorts all eligible
records before limiting to 25. Capacity preserves a deliberate distinction:
`atCapacity` uses `>=`, while commit admission uses `>`.

First consider only rebuildable in-memory metadata byte totals, depth and blob
reference counts, maintained after existing durable commit boundaries. Enumerate
initialize/replay, stage outputs, block/approve, retry/reset, state extension,
ACK and both imports before implementation. A separate later batch can evaluate
an ordered eligible index. No persisted index or new recovery format is needed.

`localContentPage` currently clones all queue content and all source pending
content, projects summaries, sorts, then slices 30. Source pending includes
realtime, history and quarantined versions; paused sources still own pending
data. A lightweight projection could omit full metadata/body/base64/spool data,
merge in the existing order, preserve exact total and keep full detail reads.
Invalidation must cover policy reset, source rename, account replacement, ACK,
quarantine, import and state replacement. Keep the existing synchronous snapshot.

Three orders must remain distinct: upload ties retain Map insertion order
(including restore load order); screenshot browser ties use ID descending;
Content ties use key ascending. Do not invent one common comparator. Preserve
160-character summaries, note first-line titles, category/error state and local
versus central UI deduplication.

## D07: proof of durable blob reuse

`enqueue` writes an input blob durably before its input journal. The default stage
retains those bytes, but `commitCaptureStages` can rewrite the same blob because
no committed record references it yet. Reuse should carry a private transaction
proof of the already validated, durably written input hash/length/byte identity.
Recovery may create the same proof only from its validated input read. Changed
or newly generated stage images still require their original writes.

Keep input/stage journal authority, atomic file/dir fsync, rollback, cleanup and
last-reference deletion. A pathname's existence alone is insufficient proof.
Unknown cases needing explicit coverage: several same-hash outputs, custom stages,
conflict/capacity failure, and death after input blob/input journal/stage journal
or partial event persistence. Do not change queue-storage migration ownership.

## D01/D03: exact Server lookup contract, owned by A

`accountOriginalDescriptor` scans authorized sources then originals; absent
source provenance it matches device/platform and enabled sources. Reads include
fresh account/deployment checks, grant/retention/availability and ticket content.
Material lookup scans materials ordered by updated time and ID descending, then
members, selecting the first extraction-ready material with a real `capture:ID`
member and reading a fixed text revision.

Existing Server capture-browser extraction projection has additional publication,
complete-artifact, original-member and matching artifact-revision requirements.
It is not automatically equivalent to the current Desktop rule. A must freeze
exact selection, DTO, error mapping, generation/grant boundaries and multiple
candidate behavior before E switches consumers. No fallback scan, shared API or
Server source change is authorized for E in round 1.

## D02: preserve derived image behavior explicitly

Desktop's worker caps input at 16,777,216 pixels, applies `rotate()`, fits a
thumbnail inside 480×480 without enlargement, and encodes JPEG70 (detail JPEG90).
The existing Server thumbnail caps at 24M pixels, uses JPEG72 and has no explicit
rotate. Account Desktop currently downloads the full original; the other branch
can re-encode a Server thumbnail. These paths are not equivalent substitutes.

A future exact derived-image contract needs matching orientation/size/quality
and authorization/generation checks after expensive awaits. Begin without a new
long-lived client cache to avoid unapproved deletion/revocation/retention policy.
Keep UI concurrency four, page size 30 and recordsRevision stale-result guards.

## Classification, resources and validation proposal

KEEP: complete original journeys, exact counters/totals/ordering, all categories,
quality, privacy/authority, current formats, quotas, retry/recovery and ACK/fsync.
CHANGE: only derived in-memory accounting/projections, transaction-local durable
reuse proof, and future exact Server lookup/thumbnail consumption. REMOVE: proven
redundant encoding/scans/copies/writes. EXCEPTION: full initialization/import
validation and full detail bodies remain necessary. UNKNOWN: all contract and
invalidation questions above; benchmarks must establish net benefit first.

E owns minimum Desktop queue/content/source files; A owns Server lookup and
derived-image contracts. Shared DTO/helper/config changes require controller
coordination. No helper residency, encoder replacement, ACK/fsync merging,
sampling/quality/default/limit/navigation changes or legacy compatibility.

Generate 1k/10k/50k mixed records; compare every mutation against a full exact
oracle for bytes, depth, references, page preview/order/total. Cover capacity
equal/plus-one, shared blobs, state extension and stale ACK, review/blocked/retry,
quarantine/import/restart. Inject process death at each D07 durable boundary and
count actual blob writes. Scoped HTTP fixtures need dual-account same IDs,
multiple materials/originals, revision changes, source pause/deletion, snapshot
expiry, deployment replacement and revocation during await. Generate EXIF-rotated,
transparent, long-aspect and pixel-boundary images and compare output specs and
rendered pixels. Use independent data/profiles, port 0, existing hidden Electron
policy and campaign heavy gate for builds/benchmarks/Electron. Report native
permissions, physical-device and live-model checks separately.
