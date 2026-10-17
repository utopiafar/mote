# Evidence revisions and retained conversation history

Date: 2026-10-17. Status: owner-directed implementation; independent review pending.
Applies to main. This does not authorize deployment or a paid historical replay.

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

Explicit capture deletion, retention expiry, a source-item tombstone, Material
forget/retirement, and existing access restrictions retain their destructive or
blocking behavior. Source tombstones and Material retirement retract all retained
generations, including earlier answers that were only marked stale on a previous
ordinary revision. User questions retain the existing policy. An ordinary update
never issues historical processing grants or restores a revoked original.

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
conservative. Erased prose is never reconstructed. The original result and its full
privacy lineage are preserved independently of those receipts.

Every historical model context pins the conversation ID and revision. Preparation,
external model admission, resumed prepared queries and final publication revalidate
that snapshot and current root permissions. Historical Material-root checks use the
current Material's exposure policy without treating an obsolete block as a current
quote grant. Tombstones, retirement, missing roots and attachment restrictions still
refuse disclosure. Newly read evidence retains the ordinary stricter checks.

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
| CHANGE | Ordinary evidence invalidation marks old dialogue stale while preserving its answer and references. Historical discussion remains available to follow-ups with status and live permission checks. |
| REMOVE | Equating ordinary supersession with `evidenceDeleted`; withdrawing every obsolete assistant proposal from dialogue/summary context. |
| EXCEPTION | Explicit deletion/revocation still erases or blocks; incomplete lineage stays conservative; already-erased text cannot be recovered. |
| UNKNOWN | Real-model quality in distinguishing historical discussion from current facts requires separate evaluation. Generated fixtures prove host state and permission transitions, not semantic quality. |

This supersedes the ordinary-update clearing language in the Material disclosure
lineage ADR and the obsolete-prose withdrawal detail in source-context conversation
handling. Material attribution, original-read policy, source declaration ownership,
client navigation and explicit privacy cleanup remain in force. It does not change
Memory/cache invalidation; that is a separate module.

## Validation

Generated production HTTP journeys cover revision → retained answer/citations →
cache removal → restart → referential follow-up → summary → source tombstone or
capture deletion, with all subsequent derived answers cleared. Legacy receipt
backfill and rejection of a frozen revoked history before model entry are included.
Existing attribution, transcript correction, independent-dialogue, deletion,
compaction-race and query-authority regressions remain required. The webpage
regression checks stale text/citation display followed by destructive deletion;
Agent envelope tests ensure host receipts are never serialized to the model.

Fixture checks and live model/device results are reported separately in the PR.
