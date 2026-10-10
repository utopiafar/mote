# ADR: Structured page captures enter automatic Memory

Date: 2026-10-10. Status: accepted for intake wiring by the owner.

The owner requested that Android structured article/product captures enter the
existing automatic Memory path, as screenshots do, while retaining original
archive and on-demand model reads. The choice of a broader daily-event admission
policy remains a separate product discussion; this change keeps the installed
extraction/review recipes, observation versus selected-memory distinction and
independent review.

The subsequent owner request adopts an independent daily-event policy for
screenshots and fields; see [its ADR](adr-daily-event-memory.md). The original
archive, intake authority and existing personal policy described here remain.

## Decision and flow

Capture Memory intake owns the transaction-time receipt for both image originals
and v2 field captures. Image processing continues to own OCR and visual products,
but no longer owns the Memory receipt. New v2 captures register their existing
`ui-page:<device hash>` material source and freeze the owner's selected recipes in
the same receive transaction. Screenshot source identity and receipts are
unchanged. Page sources inherit the configured default recipes unless the owner
has explicitly configured a source override.

The existing `mote.ui-page-object` organizer preserves the original observations
and publishes `source-body`. Its existing Memory observation now continues the
fresh input receipt through `MaterialMemoryWork`, bounded packages,
`MemoryPipeline`, independent model review and exact evidence checks. A zero
candidate result is valid and is independently reviewed. No page OCR or new model
client, queue, timer or keyword classifier is added.

The full material retains `partial / visible_window` coverage. A ready named
`source-body` input is eligible for Memory over that captured scope, without
claiming the entire article was captured or read. Whole-material requirements
continue to reject incomplete coverage. Query catalog/read and raw evidence
permissions remain unchanged; Memory inputs stay pinned to their named product,
source, recipe, attribution and original text ranges.

Only newly accepted input receives authority. Duplicate ACKs, startup, portable
restore, deletion rebuilds and organizer version backfills do not mint or renew
receipts. Historical fields remain archived and queryable; existing explicit
historical Memory requests remain the route for reprocessing them. Source recipe
changes revoke unused/in-flight authority under the existing contract. Deleted
evidence cannot publish a late Memory result.

## Supersession audit

| Disposition | Decision and inspected surfaces |
| --- | --- |
| KEEP | Android v2 fields, privacy gates, immutable IDs, upload/ACKs, exact overlap, original archive, visible-window coverage, query tools and images only on request. |
| KEEP | Default/source recipe selections, receipt pinning, bounded Memory packages, independent review, exact quotes, cancellation, deletion, restart and no implicit historical model work. |
| CHANGE | The evidence-store intake hook records shared capture Memory authority; image processing stops owning that receipt. App startup installs the hook before external intake. |
| CHANGE | Ready v2 `source-body` may satisfy scoped Memory reads while the material remains partial. Existing full-material and other-source exposure policies remain. |
| REMOVE | The page-field ADR and perception guide's claim that newly received v2 fields have no automatic Memory grant. |
| EXCEPTION | v1 queued page observations retain their existing behavior; previously archived v2 inputs are not automatically backfilled. |
| UNKNOWN | Live model quality, physical App capture compatibility and the owner's final daily-event/long-term memory policy require separate acceptance. |

Inspected code includes capture intake/store, image inputs/processing, field and
screen organizers, source pipelines, Memory authorization/work/package/pipeline,
readiness, evidence exposure/reader, and App lifecycle. Android payloads/settings,
transport, UI navigation, shared schemas and model prompts need no changes for
this wiring. Generated HTTP, model-reader, restart, review and deletion scenarios
are recorded in [validation](validation/ui-page-automatic-memory-2026-10-10.md).

This supersedes only the automatic-Memory exclusion in
[the page-field ADR](adr-android-page-fields.md), retaining its capture and central
organization responsibilities.
