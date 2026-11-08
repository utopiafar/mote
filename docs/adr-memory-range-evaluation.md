# ADR: complete range evaluation and model-selected Memory

> **状态：历史。** 本文记录当时的决定与验证范围，不再描述当前实现；当前设计见 [Memory 当前设计](memory-current-design.md)。

Date: 2026-10-13. Status: accepted by the owner; implementation and validation are recorded separately. Deployment requires the owner's final confirmation.

Updated 2026-10-14: the [simplification decision](adr-ask-evidence-quality-and-simple-context.md)
supersedes automatic resource subdivision and host character/tool quotas. The
range-evaluation, exact evidence and independent-review responsibilities remain.

## Decision and user journey

Keep the complete authorized originals in the archive. Independently assess every
authorized target range, then let the selected model policy choose useful Memory
and observation candidates. Memory is a derived retrieval aid; it is not an
exhaustive copy of the archive or a list of every useful fact. Original retrieval
remains available when a fact was not selected into Memory.

The previous work contract combines range evaluation with candidate enumeration.
It treats either `capacity.saturated=true` or a candidate count at the host ceiling
as incomplete work, then recursively subdivides the whole uncommitted batch.
Member grouping and text subdivision share a depth counter. This can fail after
complete range inspection merely because the response contains eight candidates;
smaller batches also receive smaller candidate ceilings. Increasing that ceiling
does not resolve the responsibility mismatch.

New reviewed work uses the explicit `workContract=range-evaluation@1` contract. Completion
means that the complete listed target ranges were assessed under the fixed policy,
and the selected result and its coverage were independently reviewed. It does not
promise exhaustive semantic recall or prove that the model made the best selection.
The host validates identities, evidence, coverage and resource bounds; it does not
choose personal significance or candidate grouping with keywords or heuristics.

## Selection, omission and unfinished evaluation

The new candidate output is `{memories:[...],coverage:[...]}`. It has no semantic
`capacity` envelope or candidate-count quota. Preserve exact target identities,
source attribution, member context time, target/context ownership and quote
validation. Candidate indexes remain validated nonnegative array indexes, without
the previous 64-index ceiling. Every candidate must have supporting target coverage;
context-only members cannot independently produce candidates or checkpoints.

`checked` means that the full supplied target range was assessed and supports at
least one selected candidate. `no_candidates` means that the full range was
assessed and no additional candidate was selected under the fixed policy. Both
require independent review, including an empty candidate array. They do not claim
that the whole original is complete when only a partial range was supplied.

Deliberately selecting a coherent episode or a small set of useful clues instead
of every potentially useful detail is permitted. Extraction and review must make
that semantic choice from the complete supplied ranges. Review may add, remove,
combine, narrow or downgrade candidates under the selected policy. It must not
manufacture candidates to fill coverage, erase material uncertainty, or silently
accept unsupported statements. A candidate omitted by this selection remains in
the original archive; it is not an unassessed range.

The new `incomplete` coverage state is different: the target range was not fully
assessed. It requires a concrete reason. Unread input, truncated input/output,
uncompleted inspection and invalid coverage must never become `checked` or
`no_candidates` to make progress appear complete. Preserve the unfinished target
and its reason without semantic recursive splitting or a completion checkpoint.
The existing batch commit boundary and successful sibling results remain intact.
An explicit incomplete evaluation is observable unfinished work, not a new
automatic paid retry or an instruction to infer a result from partial evidence.

Keep `needs_context` for specific useful additional evidence within the existing
grant, and `needs_owner_input` for a consequential owner fact that cannot be
represented honestly with current scope and uncertainty. Existing reviewed
question, answer, defer and context-feedback lifecycles remain. Missing owner
identity alone still permits useful source-scoped observations under the personal
policy; the host does not infer an identity or broaden authorization.

## Resource bounds and recovery

Remove candidate count as a completeness signal. Do not replace eight or 32 with
another semantic quota. Keep the existing 1,000,000-character Agent answer bound,
per-field schema bounds, provider output-token and time limits, private draft
512-KiB entry bound and existing global storage/cache quotas. Validate the existing
answer-size bound for adapter results as well as the ordinary Agent path; never
silently slice an oversized candidate array or answer into a successful result.
Shared semantic/conversation products retain their separate existing 64,000-byte
response budget. Removing a Memory count quota does not enlarge that transport
budget or the independent event/action-cue limits.

Actual provider context/output capacity failures remain explicit failures of the
complete frozen target. Memory does not halve, recursively subdivide or silently
trim that target after a capacity failure or timeout. New range-evaluation initial
packing uses the existing configured segmentation size without an additional
20-member cap; saved batches retain their original ranges. Coverage, initial seed
IDs and private dependencies preserve every authorized target rather than clipping
them to the previous 100/200-member limits.

Only explicitly classified transient provider failures use the shared execution
engine's bounded recovery, normally four attempts within six hours. Valid
extraction drafts and successful siblings/checkpoints survive recovery. Generic
provider failures, actual capacity failures, host deadlines and invalid output do
not authorize unlimited paid replay; an unknown external write outcome must be
reconciled before replay. Supplied context and interpretations remain untrusted
navigation, and every retry rechecks current evidence, model, policy and authority.

## Versioned policies, defaults and saved work

Pin the new contract when a new reviewed job is created without an explicit recipe
binding. This includes the API path with `recipes` omitted, raw evidence jobs with
or without a work package, and a new manual job's unbound fallback. A source's
provenance does not choose a semantic quota. Use a host procedure consistent with
the selected contract; an old source-specific procedure's eight/three-candidate
instruction cannot reintroduce a quota into new work.

Explicit recipe bindings take precedence: an old fixed binding with no work
contract still selects the legacy contract even inside a newly created manual job.
Existing persisted jobs without the new field remain legacy through restart and
explicit retry; do not infer a new contract from the current executable or upgrade
their rows. Internal paths without an independent-review executor retain their
legacy contract and do not claim the new reviewed-completion guarantee. None of
these routing rules adds evidence, grants or a historical scheduler.

Add new immutable built-in definitions rather than changing an installed
`id@version` in place:

| Recipe | Extraction | Review | Work contract |
| --- | --- | --- | --- |
| `mote.personal-memory@5` | `mote.personal-extraction@3` | `mote.personal-review@5` | `range-evaluation@1` |
| `mote.coding-memory@3` | `mote.selected-context-extraction@1` | `mote.coding-review@3` | `range-evaluation@1` |
| `mote.daily-event-memory@2` | `mote.daily-event-extraction@2` | `mote.daily-event-review@2` | `range-evaluation@1` |

Personal v5 retains the complete context-reading personal policy introduced by
[personal v4](adr-memory-context-reading.md): narrator/declaration applicability,
retrospective time, continuations, modality and autonomous `context_evidence`
inspection by both extraction and independent review. It adds selected-output
semantics through new immutable extraction v3 and review v5 definitions. The v4
recipe, extraction v2 and review v4 remain installed with their original fingerprints
and legacy capacity contract. Coding and dated-event policies likewise retain their
admission responsibilities while their output instructions distinguish selection
from incomplete evaluation.
Personal significance, source/time boundaries and separate capture observations
remain model decisions under the fixed policy; removing the exhaustive-candidate
promise does not authorize false actions, invented coding lessons or merged dates.

Freeze the explicit work contract in the recipe binding or new unbound job, and in
the durable batch identity. A missing `workContract` on an explicit binding or an
existing persisted job denotes the previous all-candidate contract, not the new
selection contract. Recipe/component fingerprints include the work
contract, so an already authorized but unclaimed receipt retains its old policy
when its job is created later. Preserve old definitions, bindings, default receipts,
jobs, artifact metadata, range keys and checkpoints without migration or replay.

Use the existing named default-upgrade mechanism only for exact built-in default
compositions. The existing fixed upgrades remain v2 → v3 → context-reading v4;
the new range-evaluation upgrade advances exact personal-v4 ordinary defaults to
personal v5 and exact personal-v4 + daily-event-v1 capture defaults to personal v5
+ daily-event v2. A new vault starts with personal v5 and adds daily-event v2 only
when establishing the separate capture default. Each migration has a durable
one-time marker; an owner later choosing an old recipe does not trigger it again. Preserve already authorized
old scopes while they drain under their old definitions. Custom compositions and
source overrides remain owner choices. Installation, upgrades, duplicate receipt
delivery, restart and projection rebuilds do not create historical authorization.

Generation, draft, review, conversation-product and retained-publication identities
must include the work contract and fixed policy. Validate their contract before
reuse, including a retained reviewed output that otherwise bypasses generation.
Old candidate arrays, `capacity` flags or artifacts cannot be relabeled as new
range-evaluation results, and new results cannot bypass legacy validation. Reuse
continues to require current originals, attribution, configuration, deletion policy,
authorization and exact ranges. No new prose-retention or disclosure policy is
introduced.

## Supersession check

| Classification | Disposition |
| --- | --- |
| KEEP | Complete originals, archive retrieval, model semantic selection, exact quotations, source/time/attribution scope, all-target range accounting, independent review including empty output, atomic batch commit, successful checkpoints, read-only tools, authority/version/deletion fences, existing resource limits and finite recovery. |
| CHANGE | New versioned recipes and newly created unbound reviewed jobs evaluate complete ranges and produce model-selected Memory; explicit incomplete assessment remains unfinished; configured initial packing is separate from actual provider capacity; future exact built-in defaults select the new definitions. |
| REMOVE | For new work only: `capacity.saturated`, the eight/32-candidate and 64-index ceilings, candidate-count inference of incompleteness, the requirement to enumerate every eligible candidate, and semantic recursive splitting driven by selected output count. |
| EXCEPTION | Explicit old pinned recipes and their receipts/products retain their fixed semantic contracts; genuine context/owner dependencies keep scoped recovery; actual resource failures preserve unfinished ranges; custom/source selections are not rewritten. MVP historical tasks can be explicitly rerun without inferring activation from past attempts. |
| UNKNOWN | Semantic selection quality, actual model adherence, completeness of evaluation claims, production cost/latency, OCR/transcription accuracy and physical-device behavior require separate evidence. No capacity change alone proves recovery of historical failures. |

The combined implementation resolves the two proposed uses of personal v4 by
preserving the context-reading v4 identity and assigning the composed policy v5.
The integration dispositions are:

| Classification | Composition disposition |
| --- | --- |
| KEEP | Context-reading grants, actual disclosure receipts/dependencies, narrator/time/continuation policy, exact support and independent review from personal v4. |
| CHANGE | New personal v5/extraction v3/review v5 compose those responsibilities with `range-evaluation@1`; exact built-in future defaults advance v2→v3→v4→v5. |
| REMOVE | Count-driven semantic subdivision only for new range-evaluation work; conflicting reuse of immutable v4 component identities. |
| EXCEPTION | Installed v4, old receipts/tasks and custom/source selections retain their original policies; context-read version and work contract remain separately frozen. |
| UNKNOWN | Combined live-model semantics, physical-device behavior and real-data quality are unverified by the earlier separate PR results; new generated integration checks are recorded separately. |

For new work this supersedes the candidate-capacity/semantic-subdivision parts of
[delegation and Activity](delegation-and-activity.md),
[system refactor](adr-system-refactor.md) and
[batch context](adr-memory-batch-context.md). It refines the evaluation promise in
[personal v3](adr-bounded-personal-memory.md) and
[daily events](adr-daily-event-memory.md), and separates resource recovery from the
capacity path retained by [context packing](adr-memory-context-and-canonical-evidence.md).
It preserves [admission](memory-admission.md),
[explicit manual output selection](adr-manual-memory-selected-outputs.md) and
[plugin replacement](adr-plugin-center-memory-replacement.md): an external engine
still cannot bypass the host's review, range, attribution or exact-evidence gates.

Inspected surfaces include work/output schemas, immutable strategy definitions and
default upgrades, receipt grants and manual plans, pipeline/review prompts and
agent procedures, conversation products, generation/draft/review/publication reuse,
checkpoint and import-progress projection, background recovery, UI terminology,
regression tests and current behavior documentation. Earlier dated validation
reports remain historical evidence, not assertions of the new behavior.

## Validation and deployment boundary

Generated fixtures must exercise the real entry points and lifecycle: whole-range
selection at former count ceilings and above them, wide short-paragraph batches,
empty output and independent review, explicit incomplete assessment,
missing/invalid coverage, actual resource failure without subdivision,
successful siblings, cancellation/deletion races,
immutable old receipts, close/reopen and explicit retry, and contract-bound draft,
product and retained-output reuse. No personal content or credentials enter Git.
The [journey and regression matrix](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/memory-range-evaluation-validation.md) keeps
the required state transitions and actual execution evidence separate.

The owner separately authorized fresh live evaluation of the five known failed
ranges in an isolated private copy using the existing Codex App Server and
`gpt-6.1-sol`. This does not authorize retrying or modifying the production jobs,
reprocessing successful batches, changing source/privacy/retention settings, or
collecting real screenshots. Preserve old receipts and report new calls, actual
results, usage and unresolved cases separately from generated-fixture validation.

This ADR records the accepted design first. Test results, live receipts, target
commit and deployed version are reported separately. Preparing or passing checks
does not confirm deployment; deployment awaits the owner's final confirmation.
