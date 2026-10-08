# ADR: proposal completion and executable-child waiting

Date: 2026-10-07. Status: accepted for the Memory planning deadlock correction.

The shared delegation instruction required submit followed by yield. Memory and
Memory feedback instead submit proposals whose products are created only after
the complete plan returns and passes host validation. A live planner submitted
a complete 64-member catalog and yielded on its 25 proposals. The coordinator
fragment succeeded, but planningComplete was absent, the children had no
execution steps, and no event could wake the planner.

The host explicitly describes the channel lifecycle as proposal or execution.
System instructions and context envelopes share one contract. Proposal planners
return normally after complete submission; independent inspections can still
use yield. The host rejects waits on unlinked nonterminal proposals before
writing a durable wait. Persisted proposals are not processing completion.

Old impossible waits recover only after the coordinator fragment stops and
frozen configuration and authority are revalidated. The product applies its
normal complete-plan validator to persisted units. Complete plans retain every
handle and hand off without another model call. Incomplete plans resume a fresh
fragment with explicit saved local IDs. Complete-plan validation and atomic
receipt claims remain authoritative. Invalid authority becomes stale; cancelled work never resumes. Overlapping plans cannot
claim an original twice, and unclaimed originals remain eligible. Recovery never
sets completion from model prose or directly edits receipt ownership.

## Supersession audit

| Classification | Disposition |
| --- | --- |
| KEEP | Model-chosen grouping, complete-catalog validation, product-owned extraction/review, grants, fences, cancellation, deduplication, settings and privacy policy. |
| CHANGE | Phase-aware shared instructions, executable-wait admission and recovery from saved proposal handles. |
| REMOVE | Unconditional submit-then-yield and the assumption every waiting branch has an executor. |
| EXCEPTION | Independent inspections can wake a proposal planner. Query delegation continues to yield. |
| UNKNOWN | Future remote proposals require an explicit executable handoff; an unlinked handle cannot admit a wait. |

Affected surfaces: instructions/context, SDK/Codex tool contracts, scheduler and
recovery, initial/feedback Memory planning, Activity/Operations projections,
argument-error delivery, tests and current behavior documentation. No navigation,
defaults, model configuration, processing scope or retention changes. Operations
reflects a new coordinator revision only when a fresh fragment is needed;
Activity owns whole-work status.

Existing bounds are stated in supported tool annotations and validated by the
host. The SDK schema subset rejects numeric/array limit keywords; tests compile
all definitions with the real converter. Host-authored argument failures cross
the bridge as invalid_delegation_arguments; provider failures remain private.

See [validation](memory-proposal-lifecycle-validation.md).

## Status reconciliation correction, 2026-10-09

An expired prefix filled the status reconciler's first 64 rows indefinitely,
leaving independently resumed products with old blocked source-plan projections.
Status reconciliation now excludes terminal parent works and rotates a bounded
keyset through remaining candidates, including authority-rejected history.
`resumeExternalUnit` still revalidates each parent and product before reconnecting
the existing status worker. No planner or product retry is invoked.

KEEP: product execution, current authority, completed receipts, model grouping,
attempt policy and the existing 64-row work bound. CHANGE: fair iteration of
status-only candidates. REMOVE: the assumption that rejected prefix rows will
eventually leave the candidate set. EXCEPTION: stale/cancelled/succeeded parents
stay terminal; a 409 remains a rejection. UNKNOWN: semantic output quality is
separate from a correctly updated status. This corrects the existing recovery
responsibility; it introduces no new permission, processing scope or retry policy.

Paused/failed products can also leave their claimed source requests parked at
the terminal scheduling time. If the existing explicit product action later
changes that same job to a runnable state, bounded rotating queue reconciliation
restores its due time. Source permission and input-version checks still gate
execution. Terminal jobs are not retried; completed claims are not renewed.
This preserves the queue's existing responsibility to recover authorized work
after restart, including both planned and legacy entry points.
