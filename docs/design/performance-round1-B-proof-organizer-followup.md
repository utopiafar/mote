# Round 1 B: evidence and organizer follow-up boundaries

Status: investigation and bounded future plans, not implementation approval.
Frozen source: `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`. B is the sole
module owner. Scheduling approval does not approve either plan below, and all
round-2 work still requires the controller's release and applicable independent
plan approval.

## Evidence proof batch: current journey

The production Ask composition connects M03 intake/publication, M07 organizer
publication and M06 publication to `ScopedAskRetrieval.accepted/published`
(`scope/ask.ts:90–98`). Current startup/query does not perform paid historical
backfill (`scope/ask-retrieval.ts:37–39,71–73`).

The repeated work is more precise than “materialRecords expands everything per
block.” `AskEvidence.materialRecords` (`scope/ask-evidence.ts:132`) delegates
canonical block projection to `ScopedMemoryData.projectMaterialEvidence`
(`scope/memory-data.ts:53–72`). Subsequent per-block `evidence()` calls use
`originalReceipt()` (`ask-evidence.ts:126`), whose Material-anchor branch
recursively expands the entire Material input tree and hashes the sorted
capture/incarnation/fingerprint/full-JSON rows plus anchor. Sibling block anchors
share Material id/revision, so the same closure can be loaded and hashed again.
The material read path (`:221–222`) also reads/parses the draft per span to
compute offsets. Scope validation and repeated full pin validation repeat this
work. Their proof semantics cannot be replaced by Memory's semantic hash.

Indexing admission (`ask-retrieval.ts:58–60`) captures account epoch, exact source
incarnations, transitive Material incarnations and original receipts. Candidate
eligibility (`:63–69`) is deliberately local to each candidate. If X retires,
eligible sibling Y must continue. Admission (`:74–82`) crosses model configuration,
model lease and per-child submission awaits. Current grant/evidence is checked
again at those barriers; a confirmed retired candidate may be skipped, while a
global credential/model/task failure must remain visible (`:86–90`).

Index execution uses `indexCurrent()` (`:93`) at authorization, execution,
physical request and final commit. Embedding transport (`:96–102`) checks before
and after its asynchronous effect. Semantic query checks candidate SQL, embedding
hash and current evidence after vector-worker awaits, and rereads lexical results
(`:117–123`). These are separate lifecycle boundaries, not removable duplication.

Ask's run proof (`scope/ask.ts:121`) includes task/history, all evidence/material
pins and Memory pins. Tool-return fences (`:134–152`), `withProof` before/after
async work (`:242–245`), actual `authorizeModelRequest` (`:248,250`), artifact save
and final conversation/run publication (`:255–256`) retain fresh checks. They
cannot accept a previously successful admission proof as current authority.

## Evidence proof batch: proposed next bounded plan

The candidate optimization is a private synchronous proof-batch context within
an explicitly established database transaction/read snapshot and the same
authorization fence. A synchronous JavaScript function without an await does
not establish that snapshot. Do not add an instance-wide AskEvidence cache.

Within one batch, sibling block receipts may share the exact transitive closure
rows/digest and draft parse, keyed by owner, effective disclosure/source scope,
Material id and revision. The full receipt format/hash inputs, order, null/missing
behavior and every current per-evidence check must remain identical. A proof
batch does not memoize authorization or extend authority. It ends before await,
model/transport send, tool disclosure, final artifact save/publication or a
source/head/material/original write. Writes from canonical anchor projection
also matter; nested transaction/savepoint handling must not turn pre-write rows
into post-write proof. Exact batching entry points, snapshot ownership and local
write invalidation require a separate plan review before implementation.

Original incarnation is required in addition to content hash, source id and
epoch. Identical UUID/content deleted and recreated is a different lifecycle.
Source/original incarnations originate in `scope/ask-schema.ts:86–93`;
Material history/incarnation triggers are at `:32–35,69`. Current Material head,
visible sequence and source scope are checked by `ask-evidence.ts:48`, and
Material publish has input/head/dependency/CAS fences in
`scope/private-data.ts:225–278`. None is superseded.

`PrivateSql` reauthorizes every operation (`private-data-sql.ts:21–38`) and
caches only compiled statements, never rows/owner bindings/authority. Its
`changeToken()` (`:58–64`) observes local writes (even rolled-back work) and
external commits, but is not by itself proof of one authorized transaction.
This optimization must compose with that gateway; a shared helper change stays
with the controller/A and needs a change request.

| Classification | Disposition |
| --- | --- |
| KEEP | Complete original/transitive evidence, source scope, current head/revision/visible sequence, source/Material/original incarnations, exact receipt shape, per-candidate eligibility, every async/external/disclosure/publication fence. |
| CHANGE | Only equal closure rows/digest and draft parsing within one explicit synchronous authorized proof batch. |
| REMOVE | Only equivalent repeated expansion/parsing in that batch; no receipt input, candidate, check, model call or source is removed. |
| EXCEPTION | Partial-ready artifacts, attachments, history grants, image evidence and nested/cross-source Material keep their distinct eligibility/disclosure rules. |
| UNKNOWN | Actual SQL/hash/authorization cost split; anchor-write invalidation; precise batch entry/snapshot ownership; external writer seams. Resolve in the separate technical plan, not by broadening a scheduling approval. |

Minimum candidate B files are `ask-evidence.ts` and `ask-retrieval.ts`; only if
necessary also B's `ask.ts` and `memory-data.ts`. A/shared `private-data*`, schema
and public fixture/helper edits are not authorized by this document.

Use generated blocks × nested Materials × distinct originals × JSON bytes ×
sources for a new baseline. Explicitly identify extracted SQL/hash functions
versus real AskEvidence/admission classes. Record closure queries, returned rows,
hash bytes, authorization calls and elapsed time. The earlier failed-child
attempts and old audit numbers provide no successful measurement for this work.

Required future regressions include equal receipts for shared/duplicate and
cross-source nested input, one to many blocks, partial-ready behavior, and
same-id/same-content delete/recreate. At each real configuration/lease/child-fork,
vector, tool and model-send await, retire X while Y continues; separately revoke
global credentials and require the global failure. Final artifact/publication
must fail after retirement even if an earlier batch succeeded. Preserve all
existing pin journals, complete inputs, assertions, timeouts and tested entry
points. Existing generated tests below are design evidence, not run results:

- `multiuser-ask-index-siblings.test.ts:23,46,53`: sibling retirement, transitive
  proof and actual child-fork/global-credential barrier.
- `multiuser-ask-index-incarnation.test.ts:30,55` and
  `multiuser-ask-read-races.test.ts:8,30,38,40`: identical/replacement ABA,
  declarations, artifact deletion, caller policy and abort.
- `multiuser-ask-02.test.ts:19,73,77` and
  `multiuser-ask-retrieval.test.ts:55,87,101,114,123,130`: real producer paths,
  held model work, cancellation/revoke and scope before top K.

The governing [Ask evidence ADR](../adr-ask-evidence-quality-and-simple-context.md)
already allows metadata reuse within one authorization check and requires exact
current checks before external requests and publication. No ADR policy is
superseded; implementation must demonstrate that its reuse boundary is that
narrow. Physical-device/live-model validation remains separate from fixtures.

## Organizer projection: preserve the two publication times

The current scoped producer is `MemoryCaptureMaterials`
(`scope/memory.ts:126`). At `memory-capture-materials.ts:32`, execution first
performs `run.grant.commit(() => publish(run))`, then checks image/attached-image
pending. Pending work returns a 100 ms waiting failure with
`executionStarted:false`. After readiness, the handler's final commit publishes
again under the current fence. Those are two observable lifecycle stages.

The first publication exposes an existing Material with pending/partial artifacts
while OCR/understanding is still running. The existing real generated intake
test `multiuser-memory-02.test.ts:97–101` holds those tasks and observes a daily
Material first pending, still pending after OCR, then ready after understanding.
Removing the first publication would change visibility and timing. Conversely,
`MemoryIntake.accept` (`memory-intake.ts:31–55`) still requires complete required
artifacts and durable intake authorization before Memory admission. Early
Material visibility is not permission to run Memory early.

`publish()` permits source members, projects records/file products, invokes the
shared pure organizer builder, normalizes source/capture membership, publishes
the Material and notifies consumers. `permit -> project -> file`, builder
`reader.file`, and the final pending test can repeat file/attachment projection.
`mm_organizer_origins` identity (`:40–47`, schema FK cascade at
`memory-schema.ts:57–58`) preserves task identity across restart/metadata edits
and replaces it on delete/recreate. Builder use by a legacy host is not proof
of the scoped production journey.

The next organizer plan should evaluate only file/product projection reuse
inside one synchronous publication/build attempt, using source/current-head,
input/artifact/incarnation and authorization dependencies. Cache nothing across
the first publish, pending decision, waiting retry or final publish without
independent evidence of an identical post-write snapshot. Do not bypass original
reading, integrity checks, member completeness, dependency registration, quota
admission, notifications or consumer indexing. No code change is approved here.

| Classification | Disposition |
| --- | --- |
| KEEP | First pending publication time, final ready publication, identical builder recipes/defaults/member ordering, nested attachments, authorization, source identity, origin incarnation, CAS and notifications. |
| CHANGE | Potentially reuse a file/product projection inside one proven unchanged synchronous build attempt. |
| REMOVE | Only demonstrated duplicate projection work in that attempt; neither publish call nor a consumer event is removed. |
| EXCEPTION | Pending nested products and partial coverage retain current publication/waiting/readiness behavior; restart/delete/recreate keeps current identity rules. |
| UNKNOWN | Projection changes caused by publication writes/triggers; event ordering/idempotence; exact generated cost; shared-builder ownership. |

B owns `memory-capture-materials.ts` and `memory-data.ts`. Shared organizer
contract/builders are outside the campaign list; changes there require a
controller change request. First measure generated normal/daily/coding/image
and nested-attachment inputs through the actual scoped producer, count
projections/publications/notifications and verify pending-to-ready timing, source
head replacement, cancellation/revoke, retry/restart and one-time Memory intake.
Then submit a separate exact-base/head plan to an independent reviewer.

All future benchmarks/tests use the campaign resource gate and B-only temporary
data. No whole-repository or cross-client acceptance belongs to this round;
module-directed evidence will be passed to the controller's single integration
driver. Both plans remain pending and may not be implemented on scheduling
approval alone.
