# Evidence revisions and retained conversation history

Date: 2026-10-17; updated 2026-10-29. Status: ordinary revisions already implemented;
ordinary-deletion extension implemented for independent review and PR checks.
This does not authorize deployment or a paid historical replay.

Submitted conversations remain visible after original modification or ordinary deletion. Explicit privacy erasure, forgetting and revocation retain their existing effects. This revision supersedes ordinary-deletion clearing without expanding original access or recovering erased text.

## Decision and scope

The owner explicitly requires change detection at normalized, model-visible evidence,
no Memory rewrite for transport-only changes, and visible historical conversations
when their evidence becomes stale. Exact equality is the initial boundary; semantic
model equivalence is future work. Ordinary supersession and privacy erasure remain
different operations.

An ordinary evidence/context correction marks affected saved answers `evidenceStale`.
It retains the original answer, citations, trace and run identity. The existing history
view shows its historical-version notice alongside that answer. Citations retain
their original locators; this does not make an old original current or retarget a
quote to new text. Already-erased answers cannot be recovered by this change.

History may resolve an earlier proposal, rejected alternative, user constraint or
what was said then. It is fallible dialogue, never verified current evidence. An
Agent must reread currently authorized evidence and declarations before relying on
current facts or using an old citation. Changed source declarations carry
`contextStale` as well as the historical status; their expired declaration pins do
not become current owner statements.

Ordinary capture/note/import deletion and source-item tombstones
retain submitted questions, answers, citation identities and saved citation excerpts.
Affected turns carry `evidenceUnavailable` and `evidenceStale`; unavailable has display
priority. Saved tool names, counts, bound identity/range and image-view metadata
remain; free-form tool queries, descriptions and unexpected payloads are removed. The historical
reference route returns unavailable and clients stay in the conversation; a saved
reference never redirects to a replacement original. Explicit privacy forget,
retention expiry and access restrictions retain their erasure or blocking behavior.
Privacy erasure has display priority over both ordinary states.

An external tombstone marks the historical original unavailable but does not change
the separate, existing owner immutable-archive contract. That owner route can still
read an archived copy. History citation navigation and model original reads cannot
use that route as a bypass. Central ordinary deletion physically removes the original;
privacy forget never restores erased originals or prose.

| Product entry / endpoint | Operation and historical outcome |
| --- | --- |
| Delete this record, `DELETE /api/captures/:id` | Ordinary; includes file-backed records even though the previous internal delegate was named `forget`. Remove original versions, retain submitted dialogue. |
| Delete note, `DELETE /api/notes/:id` | Ordinary; retain submitted dialogue. |
| Delete this import, `DELETE /api/imports/:id` | Ordinary for removed imported originals; retain submitted dialogue. |
| Central forget this file, `DELETE /api/files/:id` | Explicit privacy forget; clear all affected generations, including history retained after an earlier ordinary file deletion. |
| Forget source, `DELETE /api/source-pipelines/:id` | Existing archive erasure and source pause; clear retained dialogue scoped to that source. |
| External source tombstone | Ordinary original unavailability; retain dialogue, deny historical citation/model original reads. |
| Generic Material retirement | Existing clearing contract, except exact anchors already retired by a proven ordinary original deletion. A later organizer retirement cannot relabel that known operation as privacy erasure. |
| Retention prune / expiry | Existing erasure policy; also clears retained dialogue whose original was ordinarily deleted before expiry. |

## Ownership and permission receipts

EvidenceStore distinguishes ordinary invalidation from deletion when updating
saved answers. SourceStore carries source tombstones across all versions; MaterialStore
owns formal retirement. Queries, tool reads, citations and source declarations keep
the existing authorization paths.

A saved turn retains its full privacy dependency graph. Disposable artifact/Memory
IDs may later disappear, so the turn separately records the retained original
capture/Material roots used for permission checks. These host receipts are not model
input and grant no original read, citation or processing authority. New turns inherit
historical roots when their privacy dependencies include earlier dialogue.

Existing, non-erased turns receive root receipts while their graph is still present.
This metadata uses the existing capacity checks; incomplete/unknown lineage remains
conservative. Backfill and conversation quota bookkeeping commit in one savepoint,
including when called within an existing transaction; a failed migration can retry
without leaving partially added receipts. Erased prose is never reconstructed. The original result and its full
privacy lineage are preserved independently of those receipts.

Every historical model context pins the conversation ID, revision and exact saved
turn/run identities. Preparation,
external model admission, resumed prepared queries and final publication revalidate
that snapshot and current root permissions. Historical Material-root checks use the
current Material's exposure policy without treating an obsolete block as a current
quote grant. A new body-free retirement receipt is minted only while the known
ordinary deletion transaction still has the original identity and exposure metadata.
It binds that root to the already submitted turn/run. Unknown missing originals and
already erased turns get no receipt. Receipt creation, invalidation and original
deletion commit or roll back together; repeated deletion does not create new proof.
The receipt is included in SQLite backup and capacity accounting and removed when
no conversation retains it. It is never a retrieval source or model-visible grant.

Retained history can use only its exact receipt roots and still rechecks the current
source identity, exposure recipe and model authorization. A mixed-root response is
not partially approved when another root is missing, forgotten, expired or revoked.
Later privacy erasure clears every dependent answer and summary. New original reads
retain their ordinary stricter checks; a receipt never authorizes a fresh citation.

For an existing explicit record selection, preparation removes only those selected
IDs proven by this conversation's exact ordinary receipts from fresh retrieval. The
saved user scope is unchanged. If none remain, `evidenceIds:[]` plus host retrieval
`none` creates a real deny-all tool session: no reader invocation, no original tools
and no search fallback. Only allowed historical dialogue is sent to the model.
Unknown/forgotten/revoked identities are not silently dropped. Explicit owner scope
clearing remains the existing route to broader retrieval.

Summaries preserve historical proposal references and stale status. They retain the
full original privacy lineage, clear on related changes, and cannot commit over a
changed dialogue/declaration. Later privacy deletion clears both a summary and any
subsequent answer influenced by the retained history. Query/delegation operational
products keep their existing invalidation/cleanup behavior; they are not new history
archives in this change.

## Supersession check

| Category | Disposition |
| --- | --- |
| KEEP | Owner authorization, source/attachment exposure, original-read and citation validation, immutable revisions, attribution fences, late-result rejection, privacy erasure, no paid replay on revision/restart. |
| CHANGE | Ordinary revision marks stale; ordinary deletion marks original unavailable, retains submitted dialogue and permits historical continuation with exact receipts and current permissions. |
| REMOVE | Equating ordinary deletion or supersession with privacy erasure; free-form original/description payloads in ordinary-deleted tool traces; historical-reference access to deleted originals. |
| EXCEPTION | Explicit privacy erasure/forget, expiry and revocation still erase or block; incomplete lineage stays conservative; already-erased text cannot be recovered. |
| UNKNOWN | Real-model quality in distinguishing historical discussion from current facts requires separate evaluation. Generated fixtures prove host state and permission transitions, not semantic quality. |

This supersedes the ordinary-update clearing language in the Material disclosure
lineage ADR and the obsolete-prose withdrawal detail in source-context conversation
handling. Material attribution, original-read policy, source declaration ownership,
client navigation and explicit privacy cleanup remain in force. It does not change
Memory/cache invalidation; that is a separate module.

## Validation

Generated production HTTP journeys cover revision → retained answer/citations →
cache removal → restart → referential follow-up → summary → source tombstone or
capture deletion, with dialogue retained until explicit privacy erasure, which then
clears every subsequent dependent answer. Legacy receipt
backfill and rejection of a frozen revoked history before model entry are included.
Existing attribution, transcript correction, independent-dialogue, deletion,
compaction-race and query-authority regressions remain required. The webpage
regression checks stale and ordinary-deleted text/citation display, unavailable
reference navigation, an enabled continuation composer and later privacy erasure;
Agent envelope tests ensure host receipts are never serialized to the model.

Independent generated journeys also cover Material revisions, two follow-up
generations after restart, retirement/forget across all generations, late summary
rejection after revision/deletion, and rejection of newly disclosed restricted
result dependencies in a historical follow-up. A DingTalk pagination-only reimport
exercises the production transcript/file path: this module preserves the old
answer and version dependencies even when upstream transport noise still produces
a new version. Stabilizing that upstream version identity is a separate change.

Fixture checks and live model/device results are reported separately in the PR.
