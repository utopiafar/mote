# Joint validation decisions and provenance

This is a preparation decision log, not a new product ADR. Governing decisions
remain the [original multi-user ADR](../adr-multiuser-scope.md), original domain
ADRs, [module contract](multiuser-modules.md) and PR135
[public mechanisms](multiuser-public-contracts.md). Executable scope and evidence
are in the [joint acceptance matrix](../validation/multiuser-joint-validation.md).

| Decision | Basis | Impact / verification |
| --- | --- | --- |
| KEEP shared SQLite, services, one executor | Original ADR and PR135; explicit handoff | No per-user runtime/database, new coordinator or general authorization framework. Existing real production fixtures are reused. |
| KEEP original user outcomes through new scoped entry points | AGENTS supersession protocol; module contract and domain parity ledgers | Route changes are allowed, capability removal is not silently accepted. Missing Imports/Files/Memory/connector/settings/client behavior stays a blocker. |
| CHANGE integration location only | User forbids remote main/integration changes and touching the original dirty workspace | Compose exact freezes in own `codex/mote-multiuser-joint-validation`; remote branches remain6272. No deployment or CI enablement. |
| KEEP separate evidence provenance | PR135 requires exact version/entry/exit and real lifecycle ordering | M16 execution at107 is historical shared evidence; new independent probes/final candidate results get their own receipts. Documentation-only deliveries do not trigger redundant full gates. |
| KEEP native recovery and Docker recovery as distinct requirements | Original backup/recovery capability, M16 explicit limits and source guard | Native compiled/package pass does not close epoch5 Docker refusal or actual Hindsight volume recovery. Source guard and daemon availability are independently checked; no silent exclusion. |
| EXCEPTION legacy algorithm fixtures only | Original ADR's explicit test-only boundary | Useful characterization; cannot substitute for scope, final production composition, renderer/native/worker or restored package proof. |
| REMOVE completion inference from checkpoint or test totals | Explicit handoff and AGENTS | M14 has delivered its explicit final module freeze; M13/M15 remain active checkpoints. Final gate waits for all freezes and retained capabilities. All named final rows initially pending. |
| UNKNOWN actual platform/provider/deployment behavior | Explicit no real I/O/system-permission constraints and existing validation limits | No system permission change/live provider write. Unrun physical/device/permission/Docker tests stay explicit; authorization is not inferred from fixture results. |
| CHANGE Files adaptation inside M06 only | Original recording, correction and confirmed-speaker ADRs; actual old HTTP consumers | M03 originals, M06 artifacts/publications and M05 remain authoritative. A small owner-bound annotation journal retains raw evidence and confirmation provenance; no second FileStore, scheduler or model execution path. Exact-A/B, tar, M16 merge/delete/backup/restore are narrow candidate probes. |
| KEEP archive evidence distinct from current execution evidence | Actual older personal archive merge failed after a legitimate speaker/Material update; M07 retained-history requirement | Reuse the canonical Material projection in a restore-only method. Validate retained identity/body/hash, keep live readers/admission current-only, reject old pinned execution, and verify fresh current owner execution remains possible. |
| CHANGE earlier UNKNOWN QR producer state to delivered canonical contract; consumers still OPEN | Parent-provided PR144 final485/test672 full affected0; Joint08fa exact source composition and bounded16/16 | Preserve original invitation consent/origin/device-only PKCE/self/ACK. No extra browser confirmation, owner alias or inferred full private API authority. New Desktop consumer32f is still running its final gate; M13/M15 consumer acceptance is separate. |

No new domain policy, semantic heuristic, quota, automatic migration, data reset,
shared secret exposure or user-facing approval step is proposed here. Technical
choices reuse the current tools and tests. If closing a retained capability needs
an architectural change, provide the parent a concrete minimal proposal and its
effect before treating it as accepted scope.

## Later explicit model/data regression constraint

User amendment `Sentinel_90402956f4b881918763a8a61d350969` authorizes real-model
regression through this computer’s signed-in Codex “GPE 6.1 sol”; the parent
interprets the intended name as GPT-6.1 sol. Verify actual availability and its
exact interface before running; do not substitute a model/provider, add secrets,
or restart the coding session to satisfy a regression-model choice. Deterministic
generated transport tests retain their role in account/fence/retry assertions.
This supersedes the initial prohibition on all real-model checks only for that
explicit local-model regression scope; real calendar/mail writes remain excluded.

Prefer generated fixtures. If necessary, local Central content may be read only
and copied outside the repository for isolated tests. Its original contents and
all derived materials (including prompts, responses, summaries, embeddings,
screenshots, archives, logs and fixtures) are forbidden in Git operations, PR
content, shared logs/attachments and cross-thread messages. Check staged diffs
and every new file before publishing; do not rely only on ignore rules. If an
accidental Git inclusion is found, stop push and report to the parent, preserving
history until directed. Joint has not read local Central private content and its
current fixtures are entirely generated. J14 now has M15 owner-reported generated Native Ask evidence on exact local
`gpt-6.1-sol`; final composed execution and the privacy audit remain pending.


## Shared Imports restoration inside existing domains

KEEP: original upload/part/commit and inline request bodies, stable same-input
source identity, private preview and explicit review gate, real format workers,
trusted pinned Python pack sandbox, original dedup/retention, and one M05 executor.
CHANGE: route the old outcome through M03 archived originals plus M06's private
journal, with M04 model leases and current-account task grants. M03's host-only
expanded-original retention is absent from user/plugin facades; no current task
context is minted from stored JSON. Capture receipt, attribution/link/checkpoint
and no-model child admission share one SQLite commit for a fresh publication.
REMOVE: the single-owner ImportJobs/Store composition from production scoped
routes. Its review rule is extracted unchanged into a pure helper; legacy fixtures
continue to exercise their own old algorithms.
EXCEPTION: deterministic plain decoding, known media intake and fixed source packs
need no language-model lease. Semantic mapping uses only authorized job originals
through the read-only reader; bounded host preview fragments reuse the existing
host-control transport and task checkpoint without publishing domain products.
UNKNOWN: image profile/attachment equivalence, full partial-recovery/unknown-result
and Memory recipe progress, deletion reclamation and remaining Files controls are
still acceptance blockers. No success is inferred from a partial route adapter.


Import progress admission seam: KEEP M05/M08 as execution/job authorities.
CHANGE only the read projection when an intake has reserved a job ID but job
admission failed before the job row existed: report its actual owner intake task
state, and link only existing owner jobs. REMOVE the implicit assumption that a
proposed ID proves a created job. EXCEPTION no failure is interpreted as semantic
success or model waiting unless the actual task code says so. UNKNOWN model-wait
backoff/paused/partial-instance-restore variants still need execution. Basis:
generated missing-model actual Import404 RED -> exact case plus selected-recipe
batch/cancel/B-positive GREEN; no additional engine, grant, model or store.

## Issued processing calls and late settlement

KEEP the accepted recording-outcomes ADR: a bare 503, timeout or disconnect does
not prove a configured worker never executed. Explicit owner replay acknowledges
the ambiguity; it does not settle earlier external facts. CHANGE M06 transport
admission to the existing M05 issuance ledger, using its synchronous issuance
hook for the M06 activity row and its exact trusted completion capability for a
validated late response. No new scheduler, grant or user settlement endpoint is
introduced. Completed stages may admit a subsequent issuance; an old completion
can update only its original issuance and cannot settle a newer stage. REMOVE
the old M06 test assumption that every ProviderFailure permits automatic replay.
EXCEPTION existing structured local never-started facts still permit bounded
retry, and current successful ASR checkpoints still avoid retranscription.
UNKNOWN network disconnect/timeout variants and every remaining Files control
are not inferred from the generated bare-503 case. Final candidate types and
composed acceptance remain separate requirements.

The same guard also applies across operation IDs for one admitted original.
A generated second operation actually reached the ASR transport while the first
was unacknowledged unknown (RED). M06 now consults existing owner-bound M05 call
and retry-confirmation facts both before fresh pipeline admission and atomically
inside the existing issuance hook. The original operation's ACK retry returns
its existing task. Previously queued parents cannot evade the I/O guard; an
explicit retry acknowledgement still applies to its existing issuance and never
changes an old fact to succeeded. No new per-file runtime or outcome store.

## Original per-file cancellation

KEEP the original file cancel journey: revoke unfinished file processing, retain
completed raw/canonical results and originals, report a running/unknown external
wait honestly, and allow explicit owner evidence correction. CHANGE the missing
scoped endpoint to M05 cancellation plus one owner/original cancellation generation
inside M06. This fences late stage/plugin publication and stops automatic intake
from reopening that original; unrelated A files and equal-ID B remain independent.
The small canonical intent table is included in M06 portable merge/deletion and
the existing stopped-backup catalog. Portable merge does not replace an existing
local control, and it never restores an M05 task/model authorization. REMOVE the
scope_unavailable response for this established endpoint, not the old outcome.
EXCEPTION exact late transport completion may settle its fact; cancellation and
replay acknowledgement never certify unknown remote execution as stopped.
UNKNOWN file retry/reprocess, selected diarization/acoustic overrides, reviews,
image-profile and complete recording parity still require their own implementation
and acceptance. This candidate does not introduce a second executor or generic
control framework. Native archives predating this new required table are not
claimed compatible; older personal payloads default missing controls to empty.

## Original explicit file reprocessing candidate

KEEP explicit owner reprocessing and its unknown-outcome acknowledgement; a
physically active call still blocks even after another owner task endpoint has
recorded acknowledgement. Originals, successful artifacts and old outcome facts
remain retained. CHANGE the replacement admission to a fresh per-original
nonzero generation and a new M05 task. Zero-generation canonical input stays
byte-compatible with the historical identity formula. REMOVE replay through an
obsolete cancelled input/grant. EXCEPTION a host-only M05 acknowledgement records
consent for exact owned unresolved calls without changing their outcomes or
requeuing old work. UNKNOWN diarization-only retry/overrides, complete image
policies/reviews/acoustic assets and full compiled/client gates remain pending.

The narrow retry candidate accepts POST `/api/files/:id/retry` with a stable
client-generated `operationId` (1–128 characters), `stage: transcribe|summary`
(default transcribe) and optional `confirmUnknown` (default false). It returns
`{queued:true,taskId}`; the same exact operation/body returns the original task,
including after completion, and body conflicts return409. The consumer persists
this request identity through lost ACK rather than requiring another user step.
Running work returns409; an unacknowledged unknown also returns409 until explicit
confirmation. All confirmations/control-generation/admission/receipt writes share
one transaction. The original owner/source/file checks precede lookup. Summary
reprocessing keeps raw extraction and uses fresh summary stages; transcribe uses
fresh extraction fingerprints. Portable archives retain the per-file control
intent but exclude retry/admission history and execution grants. The native backup
catalog covers the new owner-keyed `mp_file_retries` journal. This is still WIP,
not a replacement consumer freeze or complete Files acceptance.

## Exact raw extraction and diarization-only candidate

KEEP accepted raw ASR separately from aligned dialogue and explicit per-file
speaker options. CHANGE the missing raw locator to M06 canonical stage-output
references, written under the existing M05 grant after validated stage output.
`mp_file_steps` stores only owner/original/generation/role/artifact references;
`mp_file_diarization` stores the original exact-count/range/processor option.
Neither table schedules work or carries model endpoints/credentials. Diarize
retry selects the current accepted raw extraction, checks an optional supplied
artifact ID exactly, then reuses that immutable artifact in the existing audio
recipe. The new file generation fences all obsolete jobs. The override persists
for this original only; explicit null removes it and restores inherited settings.
REMOVE repeated ASR as a side effect of retrying diarization. EXCEPTION a failed
diarizer leaves validated raw extraction readable but does not claim a complete
indexed pipeline. UNKNOWN acoustic sample/assets, model reviews, image profiles,
calendar associations and full native/production acceptance remain open.

The candidate expands retry stage to `transcribe|diarize|summary`. Optional
`diarization:{artifactId,options}` is valid only for diarize; options use the
existing FileDiarizationOptions contract or null. Old UUID artifact assumptions
are replaced by the M06 64-hex identifier; no new user confirmation is added.
GET Files detail exposes `rawArtifactId` even when later diarization failed.
Portable export/merge includes canonical stage references and per-file options,
validates owner/original/artifact/type/generation links before any writes and
never restores execution rights. Existing destination intent wins on merge.
Native backup lists both tables. Historical M06 artifacts without a recorded
stage reference are not guessed into raw ASR based on an engine-name string.

## Acoustic previews and recording-export candidate

KEEP anonymous sample audition, private WAV delivery and the full raw/unaltered/
corrected recording export distinction. CHANGE the unavailable assets endpoint to
read only the exact current owner-bound diarization stage, with the original
WAV header/size checks before that stage can be accepted. Detail exposes sample
metadata without base64 bytes; file-list rows do not materialize acoustic bodies.
The existing private assets route delivers validated WAV bytes with no-store.
Original raw ASR/extraction, aligned/uncorrected/corrected transcript, diarization
JSON/RTTM/CSV, sample WAVs and confirmed names remain distinct export entries.
A partial pipeline can export accepted raw evidence without claiming indexing or
complete processing in its manifest. Stream proof includes source/file, current
Material revision and metadata-only raw/diarization stage IDs; it is checked at
consumption and while yielding existing gzip chunks. REMOVE false missing assets
for an accepted current speaker sample. EXCEPTION replacement/foreign acoustic
IDs are404; an invalid sample cannot replace the last valid publication. UNKNOWN
calendar confirmations/model review and the remaining old capability matrix are
still open. No filesystem asset store, new model call or new executor is added.

## Original file review adaptation decision

KEEP the original model-proposed terms/calendar algorithms, explicit owner choice,
exact source ranges and immutable originals. The pure prompts/value schemas are
shared with the quarantined original tests; no keyword matching or guessed event
association is added. CHANGE only the host: M03/M06 evidence and personal M04 leases
are admitted through the existing single M05 executor. Private proposal/link history
is data; personal restore never reconstructs a task/model lease. Calendar links
confirm a planned event association and never establish attendance or write an event.
Metadata-only references contribute only retained metadata with an unavailable-body
marker; they never cause a speculative provider/original fetch. Exact source context,
artifact revision and calendar hash are rechecked after awaits and on confirmation.
Current narrow receipts are in the validation ledger. Original profile/rule routing,
all client consumers, native/container schema combination and final whole acceptance
remain independently tracked; these new review cases do not supersede those gaps.

KEEP the original per-source/external-ID forgotten-file policy and explicit
allow-again, including410 before any stale upload/batch replay. The shared M03
owner tombstone survives removal of all revisions; its generation retires signed
original tickets without changing account credentials. M06 cancels owned file
work before canonical removal; physical GC follows SQL commit and remains pin-aware.
No account-wide task/config reset, per-user runtime or real user deletion is used.
Current deletion intent rejects conflicting older personal content atomically; this
is explicitly validated with archive_conflict and unchanged target/B state. Additions
are specific to the original Files policy, not a general deletion framework.


## Exact forget decision and lost deletion acknowledgement

Independent M15 actual same-capture stale allow-again200/upload200 was reproduced
locally, alongside lost DELETE acknowledgement404 (durable9360ca56; both actual
RED). Fix4be0cb4c binds allow-again to a fresh opaque decision UUID and DELETE to
its captured original generation plus stable operation ID. Fixed owner-only
receipts survive canonical deletion and replay without acting on a later import.
This is transport/lifecycle metadata for the existing owner actions, not another
approval or new deletion policy. Missing expected metadata returns409 instead of
silently targeting the latest state. Consumers must preserve exact request bodies
across delays/restarts and may only choose a newer decision by a new explicit
owner action. Personal data restore mints new decision IDs and excludes operation
receipts, retaining the existing no-authority-restoration boundary. Native schema
admission includes the new metadata column/journal. Actual narrow10/10 is recorded
separately; previous types/full gates do not cover this change.

## Attachment relationship and restored image authority

KEEP the original parent-caption/image relationship, original byte retention,
explicit preparation and accepted OCR reuse. CHANGE only admission/publication
through existing M03/M06/M07 services and one executor. A declared parent ID is
insufficient: actual owned archive lineage and current parent/head/source must
match. Binding metadata is specific to this retained relationship; no generic
nonce framework, new runtime or permission step is introduced. M02's existing
asset value shape can retain metadata once M03 is present; byte access remains
M03, and existing canonical members drive transitive retirement. Legacy organizer
chunk evidence IDs are adapted to M02 capture IDs while preserving exact locators.

Actual settled-publication testing exposed old image navigation revival after
same-ID reattachment and again after data-only restore. Immutable Material lineage
and fresh per-binding Memory image evidence IDs prevent these independently of
raw OCR cache identity. Restore preserves accepted data and mints no execution or
model lease. Current770f source needs new type/delta/full combination checks; old
component/gate receipts are not moved. Profile/rule/service-test and import choice
remain OPEN, as do final clients and complete composed acceptance.

## Frozen QR producer composition

Compose producer48547e8f04a4df76724cb286df32d44f2ecc013b (tested6726838a) as
08fa2ba1. The three auth files use that exact frozen source, including its
full-gate-covered central-purpose baseline. M05 synchronous retry recovery,
M06 shared physical-input pin and exact pin disposer are applied as deltas;
Joint originalGeneration/attachmentGeneration/fileGeneration, diarizeFrom,
per-file settings, owner reviews and acknowledgeExternalReplay are retained.
No peer directory, main/integration branch, deployment or CI setting is changed.
QR's owner full gate is producer evidence, not Joint composition proof.

Independent Joint QR/auth/disposer/retry-hook16/16 is actual0. The composed
Files neighbor run initially had29pass/4fail: four own pin assertions observed
coordinator retirement before actual media completion. Exact diagnostics show
activeMedia1 at that point (pins1 for an attachment, pins2 for the manual-pin
forget case). Waiting for actual media activity to finish makes all four pass,
with unchanged no-artifact, exact physical cleanup and B-positive assertions.
This is a fixture lifecycle correction; no production source is changed to
release a still-needed physical pin. Full current affected/types/compiled/client
and native/container combination remain pending.

## Original media connection compatibility during profile work

The original processingServiceSchema explicitly permits an empty model for OCR/
ASR while requiring it for language-model services. M04's generic configured()
check rejected both. A generated real M04 OCR lease is actual503 RED at e458bf1e;
initial pipeline-only observation was stale and retained separately. Minimal69f8133e
permits an empty model only for mote-media OCR/ASR resolution. Endpoint, credentials,
explicit unauthenticated-local checks, complete references, account/resource
retirement and no default fallback remain unchanged; chat/memory/file refuse that
empty model. No fake model ID or alternative provider is introduced. Own real fake
HTTP OCR plus M04 model-resource neighbors16/16 actual0; ASR lease resolution is
verified separately from provider execution. New types/source review remain pending.

The new pure processing-policy-contract value retains original named profiles,
source/exact-MIME/default precedence, explicit original-only archive and recipe/
parameter metadata while referencing complete M04 connections. It executes nothing,
stores no endpoint/key copy and is not wired to routes/intake yet. Its three
value-level tests are not evidence that the remaining public processing-plan
settings, service test, incomplete-task reconciliation, preview/reprocess or import
imageProfileId work is complete. Existing FileProcessing.completeConfiguration
compares unfinished runtime fingerprints and requeues changed work; completed
results remain until explicit preview/reprocess. The eventual adapter must retain
that distinction and existing unknown-call consent, not blanket-revive work.


## Bounded PREP release before final gates

Parent's explicit client-coordination instruction is to publish stable usable
sub-contracts rather than wait for every module's final candidate. Source8177e8af
is therefore released as limited consumer PREP with its pending noEmit, independent
review, full affected/production/client and current native/container schema checks
visible. No final or compiled-safe claim follows. DELETE/allow bodies are fixed;
consumer callbacks must bind late receipt/UI effects to the captured original
generation and complete credential. Profiles/rules/import image-choice execution
remains a specific OPEN group; pure values do not count as implementation.

M13's already-declared be6 Library original marker is composed without waking its
paused turn. An actual post-parent-delete raw-detail200 failure is retained;8177
filters the same exact relation before browser count/paging and passes the original
case and all six attachment cases. Metadata-only M02 remains data, not a byte grant.

## Source-recreation deletion authority correction

KEEP source and Capture removal/re-registration, deterministic canonical IDs,
old zero-generation task identities for untouched originals, existing forget/allow
intent and fixed ACK receipts. CHANGE retirement bookkeeping only: an owner-bound
identity counter survives source/capture removal so a previously unsent deletion,
signed original ticket or M06 task cannot regain authority when IDs are reused.
The canonical DELETE and counter update share the existing SQLite transaction;
failed source removal rolls both back. No new user confirmation or auto-rebase is
introduced. Counter metadata is not personal-data payload authority; account
erasure removes it, native backup preserves it. Evidence: own50527 actualRED,
519 repair8/8 plus nonzero1/1 and source native recovery1/1. Current type, independent
repair review and final compiled/container/client gates remain pending. Ordinary
engineering work is authorized; no user approval is pending in this slot.


Configuration relogin: KEEP immutable request/task subjects and existing account
epoch/durable grant boundaries. CHANGE cached M04 entry reuse to require its
original admission subject still current. Retired handlers drain before a fresh
login opens the same YAML; no old suspended request borrows new credentials.
Actual same-account logout/relogin save503 RED and fixed same-case GREEN, plus
18 existing lease/lifecycle cases, are recorded in the validation ledger.
