# ADR: ask the owner when Memory needs information the archive cannot supply

Date: 2026-10-10. Status: accepted; implemented in this change.

## Problem and decision

A complete conversation may contain meaningful personal expression without
establishing which participant is the owner. Reading the same anonymous dialogue
again cannot establish that relationship. A participant's name or role does not
establish owner identity, and one diarization label may contain both sides of a
conversation.

Extraction and independent review distinguish completed evaluation,
`needs_context`, and `needs_owner_input`. Models decide whether uncertainty can
be retained, specific additional authorized evidence can help, or a meaningful
result requires an owner fact. Deterministic code validates evidence quotes,
range accounting, authorization, versions and continuation identity. It does not
dispatch on filenames, speaker words or unknown attribution.

A reviewed owner question persists on the original Memory operation. That
operation waits without holding an execution slot or launching a feedback
planner. Independently supported results commit with their own dependencies and
receipts; the unresolved range receives no completed checkpoint. Existing
bounded context processing remains available for useful additional evidence.

Before a context adjustment is admitted, the host requires explicit context
references to authorized ranges that were not already jointly inspected with
each affected target. Extraction, review and planning receive the exact prior
target/context vectors and reviewed outcomes. A completed range from a separate
batch may supply useful new background; regrouping an unchanged target with its
already inspected companions does not. Empty or repeated context cannot launch
another adjustment task.

## Owner journey

Activity's existing overview and Material's existing source-context tab expose
the question. Activity associates questions with its current operation children,
so regrouping public work cards does not lose the entry. Ask shows open and
deferred questions in its existing history, alongside ordinary conversations.
`#/ask?question=<id>` opens an assistant-first clarification dialogue using the
established conversation heading, message and composer components. No additional
top-level navigation is introduced.

The dialogue shows the reason, source quote and source links. The owner can:

- Choose a model-authored answer, optionally edit it, and submit **Answer and
  continue**. Submission authorizes processing only the affected material.
- Enter free text. The provider's model may request a more specific answer in
  the same dialogue; the UI never guesses a role from the text.
- Say **I don't know**. The current evaluation closes with uncertainty retained
  and no automatic recheck on unchanged evidence.
- Defer. The question remains answerable and other work continues.
- Return to a closed question from its Activity or Material context and choose
  **I have new information**. This reveals the composer without creating a new
  question or changing the persisted state until submission.

An exact choice is submitted by its authored identifier. Editing it submits the
literal text instead. Submission is one explicit action; no additional mandatory
confirmation step is inserted. A recorded answer does not imply a saved Memory:
the affected material receives new extraction and independent review before any
selected result is saved. Ordinary Ask replies remain archive queries and cannot
become owner declarations.

The scope is one material. A speaker number never establishes an identity in
another file. Owner answers augment attribution context without rewriting
originals or renewing unrelated historical processing authorization.

## Feature and trust boundaries

The generic `mote.owner-questions` backend feature owns the owner-only list,
detail and reply routes. Its service owns encrypted private question content,
stable question identity, revision checks, request receipts, dependency
invalidation and provider registration. Collector credentials cannot answer.
Query agents receive no write tool for this control plane.

The Memory feature registers its provider through the existing backend host.
That provider validates current source/material authority, interprets free text
with the model, records the scoped owner statement and admits a continuation
through the existing Memory pipeline. It retains the original recipe and model
scope and uses the existing executor and review. The declaration changes the
material attribution snapshot, so all previously authorized affected ranges of
that material are reevaluated. Other materials are not reread.
Provider installation identity fences stale registrations; it is not public
question data. The generic service has no Memory-specific interpretation policy.

The Web feature contributes panels to exact Ask, Activity and Material contexts
through the existing Web host. Each panel requires its declared server
capabilities. Removing the feature disposes its contributions; unavailable
capabilities show the established retry/unavailable presentation. Source evidence
and messages remain literal untrusted text, including any embedded instructions.

Question/reply UUIDs and optimistic revisions fence duplicate admission and late
results. A retry of the same request reuses its receipt across restart; changed
content cannot reuse that identity. Deleted, corrected, cancelled or otherwise
invalid evidence cannot continue from the old question. Obsolete questions lose
their private prose and refuse replies. The UI discards source quotes and local
answer copies when permission is lost and cancels work when identity changes.

Explicit cancellation also stops the operation's admitted owner-reply descendants
and fences late model results. Withdrawal of an original automatic grant does not
withdraw a later explicit owner reply's processing authorization. Answered
question records remain accessible from Activity and Material contexts, while
Ask's pending queue contains only open and deferred questions.

## Supersession check

| Classification | Disposition |
| --- | --- |
| KEEP | Model interpretation, authorized retrieval, originals, attribution version fences, recipes, independent review, usage accounting and existing execution ownership. |
| CHANGE | Reviewed coverage distinguishes owner facts from missing evidence; assistant-first questions use Ask; owner replies admit a scoped continuation; independent supported results commit while dependent ranges wait. |
| REMOVE | Automatic owner-identity feedback planning on `needs_owner_input`; repeated extraction for that unchanged gap; blanket withholding of supported sibling results; treating an ordinary Ask answer as a declaration. |
| EXCEPTION | Useful additional authorized context still uses bounded feedback; provider/configuration repair remains separate; dependency, budget and authorization checks still gate admission. Closed questions accept explicitly supplied new information. |
| UNKNOWN | Live-model judgment about when to ask, whether an answer resolves the gap, and utterance-level attribution quality. Generated fixtures prove lifecycle behavior, not semantic model quality. |

The coverage contract, review instructions, pipeline waiting/commit behavior,
Material attribution context, backend/Web registrations, Activity source entries,
Ask navigation and regression fixtures implement this decision. English text and
the Android English catalog are synchronized.

See [validation](memory-user-clarification-validation.md),
[attribution](adr-material-attribution.md),
[conversations](conversations.md) and [Activity](delegation-and-activity.md).
