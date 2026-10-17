# Shared owned Files/Imports adaptation: staged delivery

This closes shared production seams for the original Web/Android consumers; it
does not introduce another FileStore, ImportManager, executor or user database.
The [original recording ADR](../adr-recording-outcomes-runtime.md),
[speaker/correction ADR](../adr-speaker-range-and-display.md) and
[file source ADR](../adr-file-source-context.md) keep their semantic requirements.
The [joint matrix](../validation/multiuser-joint-validation.md) remains pending.

## Current limited consumer PREP:8177e8af

Source `8177e8af4eb55410afe2e27dff5da25b85920910` is explicitly consumable for
client implementation and narrow combination now. This replaces the historical
0095 request bodies; the exact delete decision contract below is mandatory.
Current source noEmit, independent reviews, affected/compiled/client and current
native/container gates are pending. Releasing this stable limited contract does
not declare a module or whole integration complete, and old checks are not moved.

Included are owned Files/originals, controls/reviews, exact delete/allow decisions,
parent-bound archived attachment preparation, joined caption/OCR and Memory image
reading, plus frozen QR production deltas. The actual Library capture entry uses
M13's declared be6 original marker; attachment retirement/forgery filters run before
its count and paging. New processing-plan/profile/rule/service-test/preview/
reprocess/import-image-choice behavior is still OPEN; its pure value schema is not
an API or execution implementation. Consumers must not infer support from it.

## Read checkpoint: implemented, narrow validation only

The existing M06 registrar installs `scope/processing-files.ts`. It reads current
M03 originals, source heads, M06 artifacts/publications and actual M05 task
receipts through owner-bound SQL. Source/owner/query filters precede pagination.
It creates no private rows, model work or execution authority. The existing M02
cursor key is passed only through trusted composition to PrivateCursor.

| Entry | Contract |
| --- | --- |
| `GET /api/files` | Optional sourceId, query (original title), mimePrefix and limit1–100; signed opaque nextCursor binds deployment/user/full query/limit. Current enabled source heads only. No other account's rows or cursor. |
| `GET /api/files/:captureId` | Owned original capture, sourceId, originalRef, exact size/hash/availability, item metadata, actual M06 saved/processed/indexed/derivations in `processing`, and actual admitted M05 `job` or null. No synthetic legacy queue/summary counts. |
| `GET /api/files/:captureId/chunks?offset=N` | Current extraction's complete structured segments, 100 per page with nextOffset. Existing Capture-style text and fileEvidence preserve artifact/chunk identity, timing, anonymous speaker/uncertainty/overlap and document/image location. M06 artifact IDs are64hex; shared schema retains UUIDs for existing algorithm fixtures and accepts those actual scoped IDs. |
| `POST /api/files/:captureId/playback {}` | Delegates to M03's account/credential/epoch-bound play ticket. Returned URL is the authenticated Ingress3 original reader, preserving byte Range. Fetch with the original Api/native credential and required protocol headers; renderer audio/image uses the authenticated bytes/Blob. The URL alone does not remove M03 auth. |
| `GET /api/files/:captureId/export` | Current transcript JSON/Markdown/CSV, current available derivations and exact original/artifact manifest in the existing USTAR+gzip format. Pure existing formatting/tar code is extracted once for legacy and scoped consumers, with an authority check at stream boundaries. Existing64MiB export bound remains. No raw original, credential or other account's content is included. |

This read checkpoint does **not** close reference-only catalog files, proposed review,
acoustic override/sample assets,
cancel/retry/forget or complete original legacy recording export outcomes. Those
remain explicit shared Files work; neither the current transcript export nor a
generic Material list substitutes for them.

## Owner corrections and speaker confirmation: narrow shared freeze

The existing M06 service accepts the original exact `artifactId`, `chunkId`,
`originalText` and `correctedText` correction contract. It reuses the production
evidence-ID function, retains the uncorrected immutable extraction, creates a new
owner-bound artifact, and republishes through M06's existing Material algorithm.
A stale artifact/text/chunk or another owner's artifact rejects. Identical text
is unchanged. No model or new task is admitted by an owner edit.

The original speaker-name contract keeps anonymous labels, timing and text;
only the owner confirms an existing label's name. Confirmations include the
existing owner/UUID/time provenance and survive later text corrections. Their
small per-owner annotation journal references both the current and original raw
M06 artifact. Existing Material revisions retire dependent views. Old artifacts
remain retained evidence rather than new execution input.

The existing tar export includes current and uncorrected JSON/Markdown/CSV in
separate entries, raw artifact identity in the manifest, and a separate confirmed
speaker attribution entry. M16 portable export, semantic merge, physical account
deletion, and offline instance backup/restore include this canonical journal.
Older imported names cannot overwrite an existing newer confirmation. Corrupt
raw-artifact links reject atomically. Recovery does not renew login or execution
grants. Newly produced instance backups require the complete annotation table;
pre-candidate backups have not been accepted as compatible by this checkpoint.

An actual older-archive merge after a speaker/Material update exposed an existing
Memory restore conflict: it validated historical archive evidence through the
current execution reader. Recovery now uses a narrowly named retained projection
of the same canonical algorithm. Live `materialEvidence`/`evidence`, admission
and revision checks stay current-only. A generated real-host/model regression
retains old history, rejects old-revision execution and permits a fresh current
owner request. No retired evidence is promoted to current authority.

Thin freeze: `a10effd109e64651e5cafe801b686238271964bf`. Exact current server
types pass; seven actual source cases and all fifteen affected portable cases
pass without skips. M13 bounded review of exact643812 plus a10 finds no new
confirmed P0/P1/P2. Its reviewer did not execute these tests. Read endpoints now
also require M06's trusted `file`/`processor:*` original format, so a retained
source-item JSON envelope is not an external file or playback authority. The
speaker/recovery cases use generated WAV through actual M03/M04/M05/M06 with
only external ASR transport substituted. Details and log identities are in the
[joint ledger](../validation/multiuser-joint-validation.md).

These are narrowly exercised paths, not final Files, Imports or joint acceptance.
Fresh own compiled/client artifacts and the final affected gate remain pending
the complete final composition. Proposed model-assisted
reviews/calendar matching, acoustic per-file overrides, sample assets and all
remaining lifecycle controls are still OPEN.

## Remaining shared Imports contract

Android's actual entry uploads `{id,name,sizeBytes,mimeType}`, sends raw4MiB parts,
commits to an archived file ID, then creates a preview ImportJob using stable
requestId and explicit instruction. Both clients need real list/detail,
capabilities, preview/ambiguity, confirm, retry/resume, cancel and archived bytes.
M03 has account-bound original/parts/commit/receipts; M06 has deterministic/media
processors and artifacts; M05 owns execution; M07 owns downstream Memory.

The original ImportStore cannot be mounted: it reaches the retired unscoped
Store, SourceStore, FileStore and runtime. Keep its pure schemas, decoder,
manifest/disposition validation and review-gate semantics. Unconfirmed parser
rows must remain staged and outside query-visible evidence. M03 intake completion
and automatic M06 publication cannot be used as preview/confirmation success.
Ordinary import must not regain shell/host-path authority. Administrator-only
host import stays separate. Model interpretation uses existing M04 leases/M05
tasks and generated external transports in validation; no semantic keyword rules.

The joint thread owns this shared backend adaptation. M13/M14/M15 own their
original thin UI/native consumers and final acceptance. They were notified to
avoid a second backend projection. Until a tested shared freeze is published,
these Imports/write paths remain OPEN rather than faked or silently removed.


## Shared Imports consumer PREP contract

Supersedes only the earlier unavailable/write-path paragraph above. The current
clean consumable source checkpoint is `43dbf8ab6e55f747bd4c941d0419a86955826123`;
production runtime is `1f377f826809b897a9a4723a8039ac7c47bc51cb` with subsequent
generated tests/validation only. This is a thin integration checkpoint, not a
whole Imports/Files or client final delivery. It includes M14 final cd46 and the
delivered M12/M16 ancestors, and excludes later peer WIP and independent theme.

| Original user entry | Scoped contract and authority |
| --- | --- |
| Upload originals | POST `/api/import-uploads` with stable optional UUID `id`, relative `name`, `sizeBytes`, optional `mimeType`; PUT `/:id/parts/:part` raw exact4MiB parts; POST `/:id/commit` returns `ArchivedFile`. Replay the same upload ID/bytes after ACK loss. One-day staging/64MiB file bounds remain. |
| Prepare private import | POST `/api/imports` with stable `requestId`, archived file IDs or inline name/mimeType/dataBase64 files, instruction, automatic/preview and optional configured SourcePack. Returns202 ImportJob. Same ID/body resumes; changed body409; host directory403. |
| Read original workflow | GET `/api/imports`, `/:id`, `/api/import-capabilities`, `/api/import-source-packs`, `/api/archived-files/:id` and `/content`. These are account client/web routes, not collector/device/plugin upload aliases. |
| Preview and owner decision | POST `/:id/prepare` with optional instruction; `/confirm`, `/cancel`, `/retry` with empty objects. Models map only admitted original readers into private validated rows; no query evidence is published before confirmation, except the existing deterministic automatic review rule. |
| Confirmed publication | Exact manifest/current epoch/owner generation binds original M03 receipts, immutable attribution and archived file links, followed by existing M06/M05 processing and M08 intake. No new runtime/executor or implicit owner. |
| Delete | DELETE `/:id` retains sibling job/capture references and B objects. Returns files/bytes/garbagePending. Metadata commits before physical GC; activity, real pins, a surrounding host transaction or GC failure defer physical cleanup to the existing `/api/ingress/gc` path. |
| Status and recovery | Import publication, searchable Material and Memory are separate. Memory counts follow actual selected recipe/intake/task/job receipts; a proposed job ID is not a link until the job exists. Personal/instance recovery carries private history without old grants; incomplete previews require fresh preparation and the original review/confirmation rule. |

Canonical schemas are `packages/shared/src/imports.ts` and archive-contract.ts;
route registration is scope/processing-routes.ts and scope/ingress-routes.ts.
The model-preview control appends only validated private preview fragments under
a stable local ID; it cannot create Capture/Material/Memory, open host paths or
issue authorization. ZIP expansion and trusted configured Python packs reuse the
existing fixed workers/limits; uploaded executables are not accepted.

Server noEmit on43db is actual EXIT0. Source checkpoints have separate generated
entry, worker, model-barrier, personal/instance restore, physical GC/pin, recipe
batch/cancel and erasure receipts in the joint validation ledger. They are not a
compiled/client/affected gate. Consumers must preserve their original navigation
and label unfinished processing honestly. Explicit image profiles currently
block image media rather than being ignored; full image-profile/attachment parity
remains OPEN. Missing-model admission's actual stale/grant_revoked receipt is
failed, not invented model-wait. Later generated actual paused/resume, capacity
backoff/restart and exact unavailable-snapshot recovery have separate receipts in
the joint validation ledger on unchanged projection source; final composed gates
remain pending. Files model reviews/calendar matching, acoustic samples/overrides, lifecycle
controls and complete recording exports remain OPEN.

### New narrow processing freeze (supersedes the earlier PREP source only)

`c45fdb4a2518fef0d5072b02aafbe8f46cb5a90b` is now the explicitly consumable
thin source checkpoint. It contains43db/fbc and the same Imports wire contract;
there is no new client payload or independent backend projection. Current Server
source noEmit is EXIT0. Actual bare503 unknown/new-operation/queued-operation and
late account-delete ACK cases pass, with scoped B positives; existing ASR stages,
explicit unknown retry, cancellation, summary, M16 erasure and Imports entry
adjacencies have their separate narrow receipts. M13's three bounded source
reviews find no new confirmed P0/P1/P2 and did not execute the tests.

M06 now records its calls in M05 before I/O. A bare503/network/timeout without
known never-started facts cannot automatically repeat, nor can a fresh operation
ID evade an unacknowledged call for that original. The same original operation
still returns its idempotent task. Use the existing owner task retry with
confirmUnknown when required; acknowledgement leaves old unknown facts intact.
A valid late reply may settle only the exact old fact, never revive private
publication authority. The pre-transport rejected queued task spends zero call
attempts. New file controls, image profiles, model reviews, acoustics and complete
recording outcomes listed above remain OPEN. This checkpoint has no whole-module,
compiled-production/client, final affected or joint acceptance claim.

## Original file reviews — current implementation candidate, not consumer freeze

The retained terms/calendar prompts and value validators are extracted to the
pure `file-review-contract.ts`; quarantined legacy fixtures and scoped M06 use
the same contract. Scoped `processing-reviews.ts` registers one `processing.review`
kind in M05, using the admitted personal file-model lease and real read-only Agent.
It creates no executor, per-user runtime or calendar-write capability.

| Entry | Current candidate contract |
| --- | --- |
| POST `/:id/reviews` | `{operationId,kind:'terms'|'calendar',offset?,after?,before?}` proposes against the exact current transcript/Material revision. Stable operation/body returns the same task/review; changed body conflicts. Returns `{queued:true,taskId,reviewId}`. The client retains its existing proposal/owner-confirm flow while awaiting the task. |
| GET `/:id/reviews` | Owner-only `{items}` retains proposal/decision history. Preparing work exposes its actual task status. Retired source context/calendar inputs hide the proposal payload and report stale. |
| POST `/:id/reviews/:reviewId` | `{action:'accept'|'reject',selected?:suggestionUUID[],replacements?:{suggestionUUID:text}}`. Terms acceptance validates exact UTF-16 source ranges/current artifact before publishing a corrected transcript and preserving original text/speaker provenance. Calendar acceptance confirms a proposed owned event association only; it never edits a calendar event. |
| Detail/export | An available confirmed association is `calendarLink` on file detail and `confirmed-calendar.json` in the existing tar export. Original/source and exact calendar proof are checked during streaming. Calendar withdrawal hides the association; deleting its input removes dependent retained proposal bodies. |

Calendar owner/source/current-head/privacy filters run before the existing
200-candidate bound. A metadata-only reference supplies only its already retained
title/time/provenance and explicitly marks the body unavailable. It does not fetch
or invent an original. Archived calendar originals use their exact M03 body.
Both calendar and file source-context versions and exact calendar hashes are
revalidated across model awaits and owner confirmation.

Personal/native backup schema includes the three private review/link/dependency
tables. Personal data export excludes execution input, task IDs, model leases and
preparing work. Restore validates exact text ranges, owned artifacts/calendar
parents and accepted confirmation references, keeps existing local rows, and
cannot resume old model work. This candidate has narrow actual journey evidence
in the joint validation ledger; source types, independent review, complete affected
and final composed client/compiled/container gates remain pending. It is not yet
an explicitly consumable replacement for the previous public thin checkpoint.

## Original file forgetting — current typed candidate

Current source4be0cb4c supersedes0095's delete/allow-again bodies. Files detail
adds `originalGeneration` (zero for an original never forgotten). A new explicit
DELETE `/:captureId` sends `{operationId,originalGeneration}`; preserve that exact
body and operation ID across lost ACK/restart. Missing/stale generation or a
changed body under an existing operation ID returns409. Never fetch a newer
generation automatically to rebase a delayed delete intent.

The response is `{deleted,cleanup:'complete'|'pending',decision:{sourceId,
externalId,decisionId,generation}}`. M03 keeps a fixed owner-only deletion receipt;
a repeated operation returns it even after the file has been explicitly reimported,
and cannot delete that newer incarnation. Only the owner can remove all revisions
at the exact source/external ID. M06 retires existing work; M03 commits the
content-free tombstone, canonical removal and receipt before existing pin-aware
physical GC. An I/O fault or held physical reader reports pending and does not
roll SQL back to point at missing bytes. Other owned files and B remain independent.

POST `/:captureId/allow-again` sends the returned `decision` object. Its opaque
`decisionId` binds the exact delete decision, even when an identical capture UUID
is reused. The same current decision is idempotent; missing/older decision IDs
return409 and cannot unblock upload410. This action recreates no data or task.
GET `/:captureId/forgotten` returns `{captureId,decision,blocked}` for owner reload
or explicit recovery of the current decision, with no additional approval step.
A client must not silently replace an old failed allow request with this newer
response: applying the newer decision remains a new explicit owner action.

The generation separately fences old original tickets and M06 task inputs.
Personal import rejects an older forgotten original atomically; local tombstone
intent wins. Data-only personal export retains tombstone identity/generation/blocked
state, excludes operation receipts and decision UUIDs, and restore mints a fresh
UUID so a pre-restore decision cannot revive. Native metadata includes the exact
journal/decision fields; whole-instance identity retirement remains M16's contract.
Older optional tombstone payloads still parse. Existing shared databases receive
one UUID per historical tombstone on schema installation, including recovery of
an interrupted nullable-column upgrade, without rotating an existing decision.

This source has10/10 narrow actual cases (decision replay, lost DELETE ACK across
actual app restart, stale independent operation, schema upgrade, historical-zero
identity, portable restore, revisions/pins, held worker, automatic reimport and
old parentless retry). Types for203997 cover earlier0563/679a only. New4be0cb4c
noEmit, independent delta review, full affected/compiled/client/schema combination
remain pending; this is not whole Files/Imports acceptance.

Independent review then confirmed0095 missed the original automatic reimport
incarnation. Actual same-ID/bytes allow-again must receive a new task; a parentless
old retry must become stale before execution. Fix056380c2 adds the existing M03
forget generation to M06's immutable input/cache proof, independently of cancel/
retry generation. Zero stays omitted for historical identity compatibility. That0563 patch preserved the wire; later4be0cb4c separately changes the decision
contract above. The0563/679a noEmit and bounded delta reviews passed at203997;
do not move those checks to4be0cb4c or treat0095's failed reimport paths as accepted.

The historical consumer PREP source0095c897078fce04ce75c687a0e1fc6abc81b479
must use0563 for task incarnation,679a for late sample publication, and4be0cb4c
for delete/allow decision correctness. 8177 now explicitly releases the bounded replacement contract for consumer
implementation while noEmit and source reviews are pending; it is not a final gate
or permission to consume later WIP.
Remaining image work is finite: retain original named profile/source-MIME
rules and original-only archive choice, then exact parent/archive attachment
preparation and transitive retirement. Existing host leaseModel/leaseReference and
M03/M06 algorithms are the intended seams; no second secret store, private runtime,
permission flow or guessed profile-to-model mapping is introduced.

## Retained image attachment preparation —770f candidate

POST `/api/records/:id/attachments/:attachmentId/processing {mimeType?}` now
adapts the original explicit attachment action. It resolves the owned current
parent, original declaration, actual archive link and exact hash/size/MIME before
admitting the same M03 original/M06 pipeline. The response retains captureId,
parentId, attachmentId, duplicate and processing job. A supplied processingProfileId
still blocks explicitly until the separate original processing-plan work is ready;
this candidate does not invent a profile/model mapping or change defaults.

A specific M03 `ig_attachment_links` relation carries an opaque binding ID, with
canonical parent/archive FKs. Parent deletion/unlink removes the relation; merely
recreating the same parent UUID cannot reauthorize it. Source/head/declaration/
retained-byte metadata proofs gate original reads, tickets, bounded original pages
and Files SQL before LIMIT. M06 immutable input includes that binding, rechecks it
after waits, and publishes the parent as a real M02 dependency. A new explicit
preparation obtains a fresh task/Material lineage and signed ticket while accepted
raw OCR may be reused. JSON attachmentOf alone is not a capability.

M07 reuses the original pure source-item organizer for parent caption plus actual
attachment products/readiness. Archived parent captions are read through M03;
canonical originals remain unchanged. Asset blocks store only typed hash/MIME/
member metadata in M02, which performs no asset I/O and issues no byte grant.
M03 remains the sole reader; original image navigation uses existing M07/Memory
image anchors. Fine-grained M06 chunk UUIDs stay in locators; M02 evidenceIds retain
canonical capture semantics. Binding lineage changes the resulting Material
revision. Data-only Ingress restore mints a fresh relation; image evidence block/ID
also binds it, so accepted data can remain readable without reviving old image
navigation grants. Ordinary image/zero-generation identity is unchanged.

Current narrow5/5 verifies real routes, generated HTTP OCR, joined caption/Material,
Memory read_image, parent deletion/source disable/new head during held A response,
B positive, same-ID recreation/raw cache reuse, ticket retirement and Ingress+
Processing domain data restore. It does not establish a full personal HTTP import,
model understanding/Memory extraction/Ask, native UI, production or container gate.
Source noEmit and independent bounded review are pending. Named processing plans,
source/MIME rules, original-only archive choice and selected import image profile
remain the next finite public capability group, not complete through this entry.


The later raw Library entry check actually found a retired child still returning200
through capture-browser after parent deletion (0692552c reproduction with M13be6
marker composed). Minimal8177 applies the same exact relationship predicate before
browser count/LIMIT when M06 presentation is enabled. Ordinary standalone M02
metadata reads retain their original behavior. Same test plus six attachment cases
is6/6 actual0, including count0 and forged-declaration404; no new projection is
created. The parent head join uses its existing owner/source/external primary key.

### Source and Capture retirement keep the file incarnation (2026-10-17)

KEEP source deletion/re-registration, canonical capture IDs, the numeric
`originalGeneration` field and exact DELETE operation bodies. A source FK cascade
must not reset an unadmitted old deletion action to generation zero. M03 now keeps
`ig_file_generations` keyed by account/source/external ID without a source FK.
Canonical file Capture retirement advances it in the same SQLite transaction;
explicit forget advances it once before removing all revisions. The existing
blocked tombstone skips the redundant retirement bump during that forget. A
failed deletion rolls the counter back with the canonical data. Removing one
revision also retires old group-bound actions/tickets/tasks; a fresh read obtains
the current generation. No client may silently refresh and replay an old intent.

The counter stores identity metadata, no original content, credentials or grants.
It does not change the existing forgotten-file block/allow behavior. It is not
included in personal data exports or accepted from import payloads. Whole-instance
native backup preserves it; account-domain erasure removes it. Generation zero
remains the historical representation for a never-retired original. Tickets and
M06 already read the same helper, so recreating the source or Capture cannot
re-enable an old signed ticket or processing input. Current native/container
schema composition remains a separate pending gate.

### Processing-policy implementation checkpoint (not a consumer freeze)

The original GET/PUT `/api/file-processing` and POST `/match` are being restored
through the same M04 revision/atomic multi-domain transaction. Services contain
complete `{kind:personal|shared,id}` references instead of endpoint/key copies.
A private M06 plan ID keeps the selected profile/rule/parameters out of M05's
bounded task metadata. Named original-only plans retain bytes without admitting a
fake successful extraction; new text/media files use the shared registry and
existing M05 handlers. Named OCR/ASR references are pinned by M04 without changing
the user's global feature selection. Existing file recipe capabilities and image
recipe capabilities remain separate. Untouched legacy files keep their historical
input identity and applied results; a late old operation cannot adopt a new plan.

This intermediate source is **not released for consumer composition**. Original
unfinished-work fingerprint reconciliation, preview/explicit reprocess, saved
service testing, explicit root/import/attachment profile overrides, non-default
image recipe execution and data-only applied-plan history export/restore are still
OPEN. At a250 the configuration-complete callback did not yet reconcile unfinished
work; the later graph-change subset is recorded below. Full runtime-fingerprint
reconciliation is still pending. Consumers and independent tests continue using declared
2528a67d until another exact limited freeze is explicitly announced. Raw service
credentials are rejected by the policy graph and remain solely in M04.

### Named graph changes and outstanding physical work (implementation only)

A changed applied graph for an unfinished ordinary pipeline now retires that
file's old M05 tasks and admits a fresh coordinator under the current owner's
configuration intent. It does not retry/re-authorize the old task. Completed
results, manually cancelled files and explicit M09 processor grants retain their
previous boundaries. Original-only selection stops unfinished processing without
pretending to have extracted/indexed the file. Cosmetic graph edits with the same
execution plan do not create work.

The existing shared coordinator waits for old physical I/O to finish; unresolved
issued/unknown facts block it with `external_result_unknown`. Existing explicit
file retry confirmation can authorize a fresh request after physical completion,
while preserving the old unresolved issuance and B's result. This is a narrow
named-graph reconciliation subset, not full connection/runtime fingerprint
observation: same-reference model-body changes, scalar-only settings changes,
shared-resource notifications and unfinished derived-only jobs still need their
original semantics wired and verified. Preview/reprocess/health/profile overrides,
applied-plan data restore and non-default image recipes remain unreleased.


Policy-page WIP refinement: optional `models:{profiles,selections}` in the same
PUT `/api/file-processing` preserves the original one-action connection/policy
save. These are complete personal M04 connections, validated and redacted by the
existing models domain and stable-ID masked-secret rules; policy services remain
opaque `{kind,id}` references. Processing, filePolicy and optional models replace
together at one revision. Shared instance connections remain read-only metadata.
No client-consumer freeze is declared for this refinement yet.


Policy preview/reprocess WIP: original POST `/api/file-processing/preview` uses
`{revision,sourceId?,type?,profileId?}` and returns the existing token/count/items
shape. It pages the same owner/current-source/current-attachment Files projection;
MIME filtering occurs before LIMIT. It retains the original1000 scanned/100
selected/20 previews per account/10-minute expiry bounds with explicit bounded.
No second file projection/store is introduced. POST `/reprocess` accepts only
`{token}` and verifies account epoch, configuration revision and exact file task/
control/publication proofs. One synchronous existing SQLite transaction validates
all files, chooses current named plans and uses the existing file retry admission.
The original explicit reprocess action acknowledges unknown old outcomes, while
live physical work remains blocked by the existing guard. It never settles old
external facts. Failed batches roll back all admissions and retain the preview;
success consumes it. Preview tokens are not portable data and are retired with
the M06 account domain. Whole preview bounds/expiry/unknown/UI acceptance remains
to be run; this WIP has not been declared a consumer freeze.


Disabled processing preserves ordinary owned work as a genuine M05 blocked
coordinator (`processing_disabled`, zero attempts), including new automatic
originals accepted while disabled. No child/model is admitted by this state.
The host-only pipeline admission permits only the exact current original/head,
settings generation and non-cancelled file; execution still requires enabled
settings. Enabling processing uses a fresh coordinator/grant for unfinished work,
while completed results and explicit per-file cancellation remain intact. This
uses the existing executor/journal, with no synthetic task state or new queue.
Files now preserves M05's actual admission error when no attempt failure exists.


Named stage reuse uses the existing processor contract and declared settings/
parameter dependencies. Raw extraction depends on its actual ASR/OCR connection;
diarization uses the diarizer's own descriptor and speaker parameters, and
alignment includes its input artifact IDs. Current complete task input, head,
source, file/original generations and model authorization are still checked
before every cached read and publication. A downstream-only named plan change
can reuse accepted raw bytes; a changed credential or an explicit full-transcribe
file generation cannot. Existing policy-null stage identities remain unchanged.
No cache record grants authority, revives an old task, or settles an unknown call.
