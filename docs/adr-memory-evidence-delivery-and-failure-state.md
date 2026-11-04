# Memory evidence delivery and honest failure state

Accepted by the owner on 2026-10-15. This decision follows the observed empty
integration reads, image interpretation being used as original evidence, false
context waits, repeated planner failures and misleading trace counts. Validation
is recorded separately in [the regression record](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/validation/memory-evidence-recovery-2026-10-15.md).

## Chosen behavior

Use integration option A: the current, precisely cited Material proof can make a
Memory readable without disclosing its raw recording ancestor. All ancestors
still pass current source, privacy, deletion, scope and attribution checks. A
Material citation covers only its own original ancestors; it cannot authorize
an unrelated raw citation, another source member or a changed proof. Frozen and
live readers apply the same rule. This changes disclosure proof, not the body's
selected provider authority or the archive's raw access policy.

Before an integration model call, verify that the selected cards and their
current original proofs are readable. Recheck before model sends and publication.
The actual Bridge response records delivered Memory bodies and original text;
an empty array, IDs, envelope characters or a model-authored JSON claim are not
delivery. A no-delivery outcome preserves the window/cursor and requires an
explicit retry. Reading evidence and deciding that no integration adds value is
valid. This does not require a new relation, one call per card or a whole-archive
scan. Existing empty-integration review policy remains: an assessed empty output
does not add an independent paid review solely to confirm emptiness.

New image Materials expose the retained original independently of OCR and visual
interpretation. When OCR suffices, the model can cite delivered OCR. When pixels
are needed, the task receives an exact current Material-to-original grant and
uses the existing image tool. Visual Memory stores the delivered view's original
hash, region and transformation. Retained visual claims require the independent
reviewer's own delivered view covering the proof. Locator JSON and generated
interpretation are navigation, not quoted original content. An unread pure-image
target cannot become a successful empty assessment. See [image processing](image-processing.md).

Unknown feedback-planner execution errors stop after one attempt; only typed
temporary provider failures use the existing bounded recovery. A planner
failure is a failure, not a request for owner context. Successful siblings and
unfinished ranges remain available. On recovery, the exact legacy shape of an
incomplete failed coordinator with no units and no actual owner question is
retired as failed. This correction does not retry, charge, change bindings or
reopen successful work. Real context stops and owner questions keep their flow.

The executor retains the latest safe failure receipt per step: fixed category
and code, phase, attempt, host identities and known run/cause identities. Provider
messages, prompts, original contents and stderr are excluded. Receipt failure
does not cause business replay; diagnostics count the failed receipt writes.
Receipts follow their owning step's deletion lifecycle. Integration delivery
receipts similarly retain the latest result per operation/input identity, use
metadata quota accounting and follow the owning step where present.

Trace counts describe actual retained trace entries. Loading, ordinary event
insertion, trace insertion and eviction share the same accounting, including
when detailed tracing is disabled or enabled again. Persisted log history and
the bounded in-memory ring remain distinct views.

## Supersession check

| Disposition | Boundary |
| --- | --- |
| KEEP | Model-led semantic decisions; exact text quotes; read-only tools; current raw/source/privacy/coding scopes; independent review of nonempty integrations; current provider bodies, scheduling and successful checkpoints. |
| CHANGE | Memory disclosure accepts exact current Material proof while checking its raw ancestry; integration completion needs actual delivery; image proof may be a host-verified view; internal planner failures project as failures. |
| REMOVE | Raw-body authorization as a prerequisite for a separately authorized cited Material body; successful no-delivery integration; interpretation JSON as image-original quotation; automatic replay of unknown planner exceptions; false owner waits and synthetic trace increments. |
| EXCEPTION | Pinned historical recipes and completed outputs retain their contracts. New image anchors do not bump all organizer/recipe versions or silently upgrade old image tasks. Assessed empty integration keeps its existing review-cost policy. |
| EXCEPTION | Hindsight's current native integration is text-only: visual parents fail explicitly before remote calls; OCR text remains supported, and no engine fallback is introduced. |
| UNKNOWN | Quality outside the explicitly validated samples, all historical image interpretations, physical devices and remote provider behavior after local cancellation. |

This supersedes the conflicting all-raw-dependencies-readable interpretation of
[evidence reads](evidence-reader.md), the unconditional empty-completion wording
in [integration strategies](memory-strategies.md), and planner failure handling
that treated an internal exception as missing owner context. It complements the
[range evaluation](adr-memory-range-evaluation.md), [context reading](adr-memory-context-reading.md)
and [image processing](image-processing.md) boundaries.

## Historical recovery

Installing the fix does not replay completed windows or grant historical image
processing. Prepare an explicit list of windows with demonstrated no-body
delivery and preserve the evidence of their impact. Exclude uncertain windows.
The owner decides whether to execute that bounded historical reevaluation after
reviewing the fix and acceptance results. Broader image-quality reevaluation is
a separate decision, not a consequence of rebuilding an organizer.
