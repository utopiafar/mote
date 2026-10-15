# M03 originals, intake and synchronization

M03 is based on M05 PR #130, exact head
`7f72e9040872dbbb351f3c9a22afa6f069aa59c8`. That head contains the accepted
M00/M01/M02/M04/M05 implementations. PRs #126–#130 remain prerequisites; this
module neither merges those PRs nor changes the integration branch.

## Production boundary

`buildScopedApp` calls `registerIngress` after the account, private-data,
configuration and execution hosts are installed. It registers the `ingress`
private service and lifecycle. The actual account verifier establishes every
identity. There is no request-selectable owner, legacy owner route, default
account, second database, executor or processor implementation.

New intake uses wire 2 plus `X-Mote-Ingress-Version: 3`. Receipts contain version,
stable deployment/account/source/batch identities and accepted capture/original
references. They attest reception only; they do not claim OCR, ASR, Material,
Memory or indexing succeeded. M06 owns those algorithms and downstream task
admission. Unsupported domains and old transports stay closed.

| Restored production API | Behavior |
| --- | --- |
| `POST/GET /api/ingress/devices` | Own device registration/list. Limited device credentials cannot enumerate all devices. |
| `POST /api/ingress/sources` | Own source registration; a device credential can bind only its fixed device. |
| `POST /api/ingress/sources/:id/captures` | Immutable capture batch, optional original screenshots, atomic M02 receipt and original links. |
| `POST /api/ingress/sources/:id/items` | Immutable source items, including raw Coding archive input. |
| `GET /api/ingress/sources/:id/receipts/:batch` | Durable receipt; erased/expired inputs cannot produce a success receipt. |
| `POST /api/ingress/sources/:id/uploads` | FileRevision manifest/idempotency admission and resumable part listing. |
| `PUT /api/ingress/uploads/:id/parts/:part` | Exact immutable part bytes/checksum. |
| `POST /api/ingress/uploads/:id/commit`, `GET /api/ingress/uploads/:id` | Verified full-object commit and durable receipt/recovery state. |
| `GET /api/ingress/sources/:id/originals` | Scoped reference metadata, bounded ordered pages. |
| `POST /api/ingress/originals/:id/tickets` | Five-minute download/play ticket bound to the issuing credential, account, epoch and exact original. |
| `GET /api/ingress/originals/:id/content` | Authenticated ticket consumption with bounded chunk streaming and byte ranges. |
| `POST /api/ingress/gc` | Own reference/pin-aware GC and expired staging cleanup. |
| `POST /api/ingress/host-import` | Administrator's own source only; regular and limited-device credentials fail before filesystem access. No shell. |

Screenshots have a 16 MiB transport body bound; file parts retain the existing
4 MiB chunk and 512 MiB full-file contracts. Part JSON has a 6 MiB body bound.
Source-item batches retain the shared schema and ordinary transport bound. These
are transport/decoder bounds, not daily processing quotas. Upload staging and
pins retain the existing one-day recovery/hold period. A receipt retry never
renews an expired upload grant.

## Storage, identity and failure ordering

The adapter uses the original AssetStore mechanism: immutable checksummed chunks,
private owned directories, durable replacement, the existing bounded asset child
worker, reference/pin accounting and GC. It does not open the quarantined
single-owner Store. Every new private key and FK includes `user_id`; filesystem
names derive only from host deployment/account identity and content digest or
host-generated UUIDs. Equal bytes can deduplicate inside one account; A and B
never share an object directory, original reference, upload session or receipt.
All tables/directories/APIs are inventoried. `ig_meta` is the instance ticket key;
`ig_*` data rows are private, with `ig_state` a deletion fence.

`receiveCaptures`, `receiveSourceItems` and `publishMaterial` delegate to M02 in
synchronous nested transactions. Host authority, optional instance generation and
source scope are checked before statements and again before commit. Async file
preparation runs outside SQLite and must revalidate before it can attach any
original or receipt. The existing M05 durable attempt context remains the
background authority; no request context or client-provided user ID is restored
from a job body.

Canonical captures retain only an original image descriptor, never base64 bytes.
A host-only `ingressSourceId` binds plain captures to their source without forging
upstream provenance. M02 records this source in Material dependencies, including
transitive publication, source-description rebuild and lifecycle validation.
M02 capture/source deletion cascades original references; the raw-capture source
projection also deletes its capture when that source is erased. Snapshot release
removes its original reference; `holdOriginal` pins an exact object while a trusted
processor uses it. Archive originals cannot be released through the snapshot API.

Archive source-item bodies, including Coding transcripts, stay in original chunks;
M02 indexes only the source item's metadata/head with an empty raw text body.
The restricted original reader supplies exact raw evidence to the registered
source/processing pipeline. This module does not reinterpret Coding dialogue or
reimplement the existing source recipe/processing algorithms.

A repeated batch/manifest returns its original receipt only if its captured input
still exists. Changed content under the same immutable identity conflicts.
Upload sessions bind stable user/source, manifest and account epoch across lost
ACK and server restart; credential rotation cannot reassign them. Old receipts
cannot acknowledge another account's pending upload. Workers use an explicit
not-ready object sentinel so failed preparation cannot poison later same-byte
intake. Failed transactional writes may leave unreferenced immutable chunks;
owner-scoped GC removes them without touching B.

## Credential and plugin contracts

M01 device handoffs carry a fixed device restriction through credential ancestry.
Their normal private archive routes, credential minting, ticket exchange and host
import are denied; `/api/connections/self`, logout and scoped ingress remain
available. A full account client/session retains its established APIs. MCP
credentials remain rejected by normal authentication and await M11's explicit
finite-source adapter. Administrators gain no access to B's private originals.

The M09 integration seam is host-only:

```ts
const source = ingress.bindSource(context, Object.freeze(sourceIds), assertCurrent);
// source: SourceCapability
source.receiveCaptures(sourceId, batchId, captures);
source.receiveSourceItems(sourceId, batchId, items);
source.readOriginal(ref, {offset, length});
source.pageOriginals(sourceId, after, limit);
source.publishMaterial(draft, expectedRevision);
```

The facade is frozen, carries no context/user selector, SQL or host path, and
checks all direct/transitive source dependencies. `assertCurrent` checks the M09
instance generation plus M05 grant before/after calls and at synchronous commit.
M09's worker RPC exposes the data methods above using argument arrays; callback
based `withWorkspace` stays with the trusted host/M06. Its workspace facade only
reads/writes safe single-component names and removes temporary files on success,
failure or revocation. It cannot import host paths.

M03 and M09 keep their own registrar calls; the parent combines the two tiny
`scope/app.ts` changes and installs the binder after both registrars. No central
source-kind business dispatch or parallel plugin system is added. M09's adapter
must remain unavailable until this binding is present.

## M16 lifecycle handoff

`ingress` version-1 export includes current original bytes/checksums, exact
source/capture associations and device metadata. Coverage explicitly excludes
pending upload staging, active authorizations, pins, tickets, workspaces and
receipt history. M02 must accompany it for canonical source/capture/Material
records. This is not a complete personal portable archive or a historical
single-user restore promise; M16 owns composition and whole-instance recovery.

Restore validates all checksums, unique identities and canonical parent/source
bindings before writes. Image descriptor hash/mime and raw-capture scope must
match; stitched same-user other-source originals are rejected. It renews no
upload, credential, task or paid model authorization. Same operation replay is
idempotent, a changed payload conflicts, and a nonempty target is rejected.

Deletion first persists `ig_state.deleted`, closing reads/publication, and removes
references/intake state. Only confirmed physical removal returns `complete`.
Filesystem failure or a live/interrupted async I/O journal returns
`result_unknown`. A durable `ig_activity` record is never cleared merely because
time elapsed. M16 may inspect `pendingErasure` using an actual ingress-domain
delete LifecycleContext, independently prove the old process/worker stopped,
call `settleErasure(..., 'stopped')`, then retry deletion. Ordinary UserContext and
known live activities cannot use this reconciliation. B remains readable with
unchanged original bytes. Offline full-instance backup must include the admitted
SQLite file, `originals/`, and the separate configuration/snapshot artifacts owned
by the other domains.

KEEP: immutable input identity, checksummed chunk worker, durable ACK recovery,
source metadata, synchronous M02 transactions, M05 grants and one shared engine.
CHANGE: user-qualified storage, explicit source capability and device boundary.
REMOVE: owner intake, client-selected ownership and ordinary host-path import.
EXCEPTION: trusted plugin/host code is not a malicious-code sandbox.
UNKNOWN: physical devices, external providers/models, downstream algorithms and
whole-instance M16 orchestration require their owning modules' acceptance.
