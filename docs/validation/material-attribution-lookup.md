# Raw attribution lookup under bulk image processing

Raw image processing resolves the current attribution declarations of every
Material containing the original or one of its linked ancestors. Repeated
fingerprints during bulk processing must look up those members by their exact
capture reference rather than scan the archive's unrelated capture members.

The resolver now places the recursive original set before a SQLite `CROSS JOIN`
to `material_members`. The existing `(kind, ref, material_id)` index can therefore
use both `kind` and `ref`. No schema migration or attribution policy changes.

- KEEP: current revision and visibility fences, recursive ancestor deduplication,
  stable Material ordering, conflict disclosure and the digest of all declarations.
- CHANGE: join ordering and the resulting member lookup plan.
- REMOVE: the optimizer's kind-only scan from this resolver's execution path.
- EXCEPTION: a Material anchor still resolves its own current declaration directly;
  originals without visible parents still inherit the source declaration.
- UNKNOWN: live processing throughput and worker readiness after deployment.
  A faster query alone does not prove OCR, transcription or Memory completeness.

The generated regression exercises a cyclic linked-original graph, unrelated
members, inherited correction, conflicting current declarations and retired
parents through `MaterialStore.contextForEvidence`. It captures the resolver's
actual SQL and checks that SQLite uses the member reference in the lookup plan.
The prior query passes the attribution assertions but fails this plan check.
Existing attribution fixtures cover shared-parent disclosure limits, hidden
declaration digest changes, corrections and late-result fencing.

Private live CPU profiles and read-only database measurements remain outside
Git. They identify this resolver as a bulk-processing hot path and compare
identical parent results before and after the join change. They are operational
diagnostics, separate from generated regression tests and media-model quality.
