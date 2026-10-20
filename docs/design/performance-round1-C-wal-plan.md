# Round 1 C: WAL/FULL investigation boundary

Status: independent design boundary; no journal-mode implementation or rollout.
Owner C. Frozen source base/head: `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
The review receipt binds this document's hash and exact documentation head.
The [export plan](performance-round1-C-export-plan.md) is separate and does not
approve this work. No actual profile, vault or daily credential may be inspected.

## Current complete storage journey

The production entry `apps/server/src/index.ts:11–25` reads configuration without
credential initialization, preflights the vault, checks its PID, then calls the
scoped builder. `scope/app.ts:67` invokes `openScopeStorage`, which preflights again.
These two copies are existing behavior; deleting or combining them is outside
this proposal. The builder registers domain services and maintenance, then the
entry publishes its PID and starts listening. Normal shutdown stops domain work
and maintenance before closing the shared database (`scope/app.ts:129–140`).

`scope/storage.ts:12–32` admits only an empty directory or the exact current
storage identity. It copies `mote.sqlite` and present `-wal`, `-shm`, `-journal`
into a disposable directory, opens that copy and validates scope metadata and
user_version, then closes/removes the copy. Rejection must leave original vault
bytes, entries, permissions and sidecars intact. This is a **stopped-vault**
contract; per-file `ino/size/mtime` checks are not a cross-file atomic snapshot.
Opening a read-only WAL database in place can create sidecars and is unsuitable
for rejection preflight.

After admission, private directory/database/sidecar checks run before SQLite
opens the actual path. `scope/storage.ts:41–44` sets foreign keys, busy timeout,
current schema and user_version, but **sets neither journal mode nor synchronous**.
A newly generated database is expected to be DELETE. An existing database may
persist WAL. The legacy EvidenceStore/Store's explicit WAL is a different entry
and does not establish the production scoped mode. Record actual pragma values
for this Node/SQLite build before comparing performance.

`private-storage.ts:34–51` deliberately validates existing SQLite files without
raw open/close: on POSIX, closing another FD on the same inode may drop this
process's SQLite locks. Preflight copying itself opens/closes source files;
therefore do not simulate normal startup by calling the builder on a vault with
an active same-process SQLite connection. The actual entry performs preflight
before its PID check. Changing that order, adding mutual exclusion, or expanding
support to an active writer would be a new lifecycle decision, not a WAL tweak.

Originals are durably written and fsynced before publication; `originals.ts:58–62,
103–108` stages/renames parts, then records the object. `ingress.ts:113–117,267–275`
assembles the canonical receipt, calls synchronous consumers and checks capacity
within its transaction, before the user receives an ACK. No proposed mode may
weaken FULL, file/directory fsync, transaction order or unknown-result recovery.

## Backup and recovery consumers

The actual backup CLI dispatches scoped archives through `scripts/backup.ts:21–24`
to `scripts/scoped-backup.mjs`, with stopped-source and stable-inventory checks.
Its fingerprint includes present sidecars; its scratch copy verifies current
schema/deployment/owners/provider and original completeness. At line153 it uses
the SQLite backup API to create a normalized database containing committed WAL
content; sidecars are not blindly copied as standalone archive payload. It then
rechecks source inventory/configuration before publishing. A failure removes
only this operation's output.

Restore first verifies manifest, exact entries/digests, source identity, owner
and originals in scratch, then copies and rechecks in staging. It relocates
configuration and retains historical/future policy intent while retiring old
credentials, grants, leases/fences and generations. It publishes by rename only
to an empty stopped target, and cleans failed staging. It does not start a server.
The current future-authority rules are in [lifecycle parity](../adr-lifecycle-parity.md)
and [the lifecycle design](multiuser-lifecycle.md); do not add a new manual
confirmation policy based on older deployment prose.

## Dispositions and bounded next decision

| Class | Disposition |
| --- | --- |
| KEEP | Current epoch5/wire2 and mode handling in this round, FULL, original fsync, exact transactional ACK, snapshot/pin/GC/erasure, stopped preflight/backup, no rejected-vault mutation, stable source checks, backup API, empty-target staged restore and post-login future authority. |
| CHANGE | This round only reads mode values in generated disposable databases and records the design/evidence. A future admitted-database WAL/FULL candidate would require explicit delta approval and resource allocation below. |
| REMOVE | Nothing: no removal of double preflight, sidecar verification, close ordering or restore validation. |
| EXCEPTION | Generated fixtures may deliberately set WAL, disable auto-checkpoint and kill their own disposable child to create a stopped uncheckpointed source. This does not enable WAL in product code and does not prove power-loss durability. Legacy Store/Mem0 retain their own independent modes. |
| UNKNOWN | Existing-vault mode distribution, build defaults elsewhere, local filesystem/mount support, WAL/FULL benefit, checkpoint space and latency, locks under actual scoped startup, low-disk behavior and full ACK/crash/backup/restore equivalence. None may be inferred from a single default pragma probe. |

A later WAL candidate, **not approved for implementation by this round**, would
set/confirm FULL on the admitted shared SQLite connection and request WAL only
after all existing preflight/private-path checks. It must observe SQLite's
returned mode; no silent fallback to NORMAL, synchronous OFF, another mode or a
new checkpoint schedule is allowed. Failure/unsupported-filesystem behavior is
an unresolved product boundary: do not introduce a startup rejection, warning,
user step, retry rule or fallback policy just to ship an optimization. Establish
that existing local-disk deployment conditions cover the intended target; if they
do not, present that product choice to the owner and obtain a delta review.

The default WAL auto-checkpoint and shutdown behavior must first be measured.
Do not bundle explicit/truncating checkpoints, maintenance batches, staging
capacity accounting, portable serialization, backup redesign or startup-copy
removal. SQLite WAL requires local shared-memory coordination; neither remote
network filesystem support nor power-loss safety is established by these fixtures.
Reference semantics: [SQLite WAL](https://www.sqlite.org/wal.html),
[SQLite journal mode](https://www.sqlite.org/pragma.html#pragma_journal_mode),
[SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous),
[SQLite backup API](https://www.sqlite.org/backup.html).

## Required validation before a future WAL implementation can be delivered

| Boundary | Generated real-entry/state validation and oracle |
| --- | --- |
| New/current DELETE/current WAL startup | Isolated actual CLI `index.ts` entry, explicit owner profile/home, loopback port0; read mode/FULL/auto-checkpoint/page size; stop/restart and verify persisted mode, exact user data and ACKs. Direct `openScopeStorage` probes are narrower evidence. |
| Preflight rejection | Old epoch, invalid format/deployment/user_version, malformed/truncated DB, links/hardlinks and stopped uncheckpointed WAL; compare original bytes, mode, directory entries, sidecars, config/PID; no normalization/checkpoint on the original. Account for normal access-time effects separately. |
| Locks/checkpoint | Real independent processes, long reader and writer transactions, busy_timeout, blocked auto-checkpoint and release, clean shutdown; record state actually reached. Existing `sqlite-process-locks.test.ts` covers legacy Store and cannot prove scoped production behavior. |
| Crash recovery | Own generated CLI process killed after canonical ACK with committed WAL not checkpointed, and before/after original staging/publication; restart through the same CLI. Exact SHA, idempotent receipt, no missing acknowledged bytes, no revival of retired grants or replay of unknown external work. SIGKILL is process death, not a power-cut test. |
| Backup/restore | Real backup CLI and restore to a new empty owner target, committed uncheckpointed WAL and plaintext/encrypted/mixed originals. Verify hashes/history, old-auth rejection and future policy on password relogin. Missing/corrupt sidecar, changing source, active PID, nonempty target, copy/low-disk failures must not publish a target or mutate the source. Shared scripts remain controller owned. |
| Capacity/resources | Generated local APFS fixtures first; record filesystem/mount, peak WAL/SHM/journal/scratch/backup bytes, checkpoint/commit/tail latency, CPU and actual wall time; process/mount and FD cleanup confirmed. Disk-full simulation requires an independently allocated disposable quota/mount, not filling the user's disk. |

C owns future `scope/storage.ts`, `index.ts`, `scope/app.ts` changes only within
its approved scope. The controller owns `private-storage.ts`, shared backup and
restore scripts/helpers and common fixtures. Any changes there need a concrete
change request and coordinated owner; consumer validation alone grants no edit
rights. Keep current `processing-imports.ts` under A.

All installs/builds/benchmarks/native/browser/CLI work use the campaign heavy
gate; isolated small tests can use light. Use only C/tmp, C/artifacts and C/profiles;
no actual profile, existing service/port, simulator, physical device or live model.
Report focused module evidence, full integration pending the controller's single
driver, and distinguish a source/default probe from actual CLI/backup recovery.

## Deferred storage findings

These remain future scope, without product or shared-file implementation:

- `storage-capacity.ts:21–22,38–40,53–58,67–75`: exact staged-parts/object/eviction
  capacity credit. Any materialized total needs rollback/retry/duplicate/multiple
  uploads/owner and restart proof; it cannot change quotas or physical-vs-logical
  accounting.
- `processing-imports.ts:77,187`: a4096-byte sniff currently follows a complete
  `archivedBytes` read. A owns this file. A prefix-only read cannot silently
  discard the existing full-object corruption validation. C can supply a future
  reader only after an A/controller change request and whole-journey review.
- `lifecycle-operations.ts:69–82`: configuration/provider snapshot comparison and
  portable serialization must preserve read-set proof and current3 format; the
  two configuration reads do not by themselves prove removable redundancy.
- `index.ts:13` plus `storage.ts:36`: two startup preflights have lifecycle and
  stopped-vault assumptions; no copy is removed in this design.
- `archive-maintenance.ts:26–47`: owner retention, per-operation transactions,
  activity/pin conflicts, initial run and hourly schedule remain. A batch split
  requires exact cutoff/continuation/failure/shutdown proof and no delayed expiry
  or changed deletion/GC outcome.
