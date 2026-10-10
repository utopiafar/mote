# ADR: Daily event Memory for captured screens and pages

Date: 2026-10-10. Status: accepted by the owner.

The owner requested automatic daily recall of what appeared, was browsed and was
done, for both screenshot and structured capture, with original proof, distinct
action states and correct speaker attribution. This extends the earlier
[structured intake wiring](adr-ui-page-automatic-memory.md).

## Product decision

Install `mote.daily-event-memory@1`, with an independent extraction policy and an
independent review policy. Ordinary identifiable dated events qualify without
long-term personal significance. Outputs use the existing personal-domain,
episodic, `admission.layer=observation` contract. They are published after exact
evidence validation and independent review, searchable by day, and excluded from
default selected-memory recall and long-term consolidation. Original text,
metadata, timestamps and image assets remain in the archive.

Do not mutate `mote.personal-memory@2`: it continues to select personal experiences,
facts and preferences under its own policy. Daily events may provide useful
history without promoting passive displays into owner beliefs or traits. Models
interpret action, subject and status; the host adds no semantic keyword routing.

| Evidence | Supported daily event; stronger claims need separate proof |
| --- | --- |
| Recommendation card | Product displayed; no comparison, intent or purchase established. |
| Article view | Captured article displayed/browsed; finished reading, learning and endorsement unknown. Brief content summaries explicitly belong to the author. |
| Draft or plan | Draft/planned activity; sending or completion unknown. |
| Cart or unpaid order | Added to cart or awaiting payment; not a paid purchase. |
| Paid order | Payment at the stated time; receipt, ownership for oneself and current use not implied. |
| Delivery or completion state | Only the explicit status and its scope; delivery is not proof of current use, task completion is not an unrelated payment. |
| Cancellation/refund | Preserve dated transition and prior history, rather than rewriting the earlier plan/payment. |

Collection time and occurrence time remain separate. Daily recap queries use
explicit local-day bounds, observation pagination and original proof. They label
the inspected capture/processing scope rather than claiming complete coverage of
the owner's day. Event history does not expire merely because a later stage
occurred; actual corrections/deletions keep the existing invalidation semantics.

Keep different capture observations in separate candidates. Automatic tasks
currently default to UTC, while later questions may use any supported timezone.
Even observations on the same UTC day may straddle the requested local midnight;
a combined card whose dependencies span that boundary fails the existing strict
query scope. Query agents can summarize repeated observations and status changes
together after retrieving the requested day. Fields/nodes within one capture can
form one event. No semantic grouping code or wider evidence scope is introduced.

## Defaults and owner control

Add a persisted `capture-default` selection, visible in the existing automatic
Memory editor as **截图和页面采集默认组合 / Screenshot and page capture defaults**.
On its first initialization, copy the then-current general default and add the
daily recipe, preserving the copied exact bindings. Subsequent edits and restarts
do not re-add it. The two defaults are thereafter independent; explicit source
overrides continue to take priority. Captures with an existing override that
omits daily events retain that choice. The editor can add the daily recipe to
such an override or restore capture-default inheritance.

Capture defaults are selected by the host's exact screen/page source identity and
device hash, not by source names, App names, text or inferred intent. Other
sources retain their original defaults. Combination capacity grows from eight to
nine so copying a full previous selection can retain it and add this one recipe.
Daily events require the named `daily-events` input; another source needs an
appropriate trusted input producer before selecting this recipe there is useful.

Only future durable intake freezes authority. New defaults, installation,
backfills, duplicate ACKs, restart and image/material rebuilds do not grant
historical work. Source/default changes revoke pending and in-flight work under
the existing transaction and publication fences. Prior published products remain
until explicit correction/deletion or evidence invalidation.

## Evidence responsibilities

Add the deterministic `mote.capture-event@1` organizer, with one material per raw
capture identity. It retains exact page fields, or the full current screenshot
OCR plus labelled image interpretations, with a single original dependency and
capture timestamp. Its `daily-events` product waits for the existing screenshot
processing products; page fields require no OCR. The structured capture retains
`partial / visible_window` coverage and is eligible only for its ready named
input. The original asset and source evidence remain queryable.

This is separate from the existing merged article and compressed screen-group
materials. A multi-day article must not prevent retrieval of one day's event,
and a later sample/group rebuild must not replace a prior event's proof. Events
also remain independent of the article group's bounded working text window.
The page organizer version advances to 2 and permits the additional structural
slot; trusted exclusive replacements retain their existing override semantics.

Both materials use the existing queue, authorization ledger, work packages,
pipeline, read-only model tools, independent review and exact quote checks. The
event material consumes only selected daily-recipe receipts; grouped materials
consume the other selected recipes, avoiding competing claims of one receipt.
No new engine, model client or timer is added.

For capture-backed cards, Memory discovery requires current discoverable formal
material proof and checks the supporting capture's expansion policy, without
making raw screen rows independently discoverable. Raw-screen-only cards remain
hidden; ordinary source metadata discovery stays independent of proof expansion.
The existing tool returns derived cards and bounded verified proof; arbitrary
raw-image expansion grants and source/privacy restrictions remain separate.

## Supersession audit

| Disposition | Decision and inspected surfaces |
| --- | --- |
| KEEP | Personal/Coding policies, archive fidelity, query originals, exact overlap, screen groups, privacy/source authority, pending dependencies, independent review, coverage/subdivision, deletion and restart fences. |
| CHANGE | Add a separately selected daily policy and capture defaults; extend the existing editor and bilingual catalog; teach query tools to retrieve observations for daily recap. |
| CHANGE | Per-observation event materials provide stable day-scoped proof; page organizer no longer exclusively occupies every output slot. |
| CHANGE | Daily policies keep independent capture timestamps in separate cards; recaps summarize repetition after scoped retrieval. Automatic UTC cannot determine a future question's local day. |
| REMOVE | For the daily policy only, omission of ordinary events merely because raw retrieval is possible. Other strategies retain their own admission rules. |
| EXCEPTION | Saved source overrides remain authoritative; historical intake is not automatically replayed; failed/unavailable screenshot processing does not fabricate an event. |
| UNKNOWN | Real-user recall completeness, actual App/permission/device behavior, OCR quality and production latency need separate validation. |

Inspected surfaces include intake and source identity, recipe installation and
settings, authorization and queue consumers, page/screen organizers, evidence
scope/disclosure, Memory schema/store/pipeline, lifecycle consolidation, Agent
instructions/tools, UI selection/navigation and i18n, generated journey fixtures,
live-model and renderer scripts, and the prior ADR/product guides.

Validation and its fixture/live/physical boundaries are recorded
[separately](validation/daily-event-memory-2026-10-10.md).
