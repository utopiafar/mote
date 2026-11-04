# Operations read model

The shared executor records memberships in `execution_operation_steps`. A step may belong to multiple operations without repeating execution. `operation_progress` stores incremental counters maintained in the same SQLite transaction as step transitions. List/detail reads never enumerate evidence or original files. The owner-only `/api/operations` API provides type/state filters and bounded keyset pages; `/api/operations/:id` provides bounded step/dependency metadata without processor inputs, outputs or credentials.

File configuration revisions and independent OCR/semantic revisions identify current memberships. Switching configurations preserves historical links while removing obsolete steps from current progress. Explicitly unscheduled optional summaries are counted separately from required blocked work. The initial migration reconstructs host configuration metadata from legacy steps and preserves their identifiers; child association follows its first preceding file parent, and a later cache replay records the current association explicitly. It does not invent historic associations that were never stored.

Material organizers also use a generation slot per saved group. A changed input
fences the old step, while discovery creates a replacement for the current input.
Only the current generation contributes to task progress and attention; superseded
steps remain visible in operation history. Startup reconciles older organizer
memberships against the saved current group and its existing step without creating
or retrying execution, publishing materials, or changing the historical receipts.
Current failures and stale steps remain visible until a replacement actually exists.

`operation_changes` is a bounded committed-change journal. Clients consume its cursor, deduplicate IDs and reset their reads when a cursor has expired. Rollback emits no visible changes. Web resources are scoped to one authenticated API instance, deduplicate observers and fence late responses. A single Operations subscription refreshes matching visible details and filtered lists, pauses requests on hidden documents and stops when no observer remains. Temporary disconnects retain the last result and retry.

The Processing page displays operation summaries and paged step details, including prior configurations. Source pages still own their domain controls; the existing context workflow controls remain available. Import phases, query runs and insight runs now use the shared executor, with parent membership propagation and persistent result references. Domain lifecycle windows link their child work to the same Operation. Collector credentials do not gain owner-only task reads: native clients show central processing as unknown and offer the authorized central task page. See [execution and snapshot integration](operation-import-insight-closure.md) and [native status contract](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/client-scheduling-and-status.md).

Validation: 400 dated generated operations exercise keyset paging and change cursors, transaction rollback, shared step counts, current/history migration, optional work and collector denial. Authenticated application tests cover unauthenticated/collector rejection and malformed bounds. Cache tests cover late and aborted responses, session isolation, retry and shared subscriptions. A real Electron renderer with an isolated generated server exercises 400 operation rows, automatic list/detail updates, filter reset, pagination, detail focus restoration and 200%/mobile layout (`scripts/test-web-operations.cjs`). These are fixture tests; no live model or personal data is used.

Domain summaries follow the same current-progress boundary. Organizer
`pendingSteps` counts current waiting/running steps; `blockedSteps`, `failedSteps`
and `stepCounts` expose the remaining states independently. Memory summaries
separate processing failures from input invalidation with `invalidatedBatches`
and a publication `outcome`; an all-invalidated terminal task is skipped in its
execution envelope without changing persisted scheduling state. Action analysis
alerts require a surviving job and matching current evidence.

Startup recovery also respects activation. A manual Memory job created without
an explicit start remains dormant; `run()` persists activation before scheduling.
Activated unfinished work can recover under its saved scope, while paused,
cancelled or revoked work cannot. Ordinary query dependency checks use current
permission metadata in batches and yield during asynchronous preparation so the
existing execution lease can renew; the final external-request and publication
fences still revalidate all dependencies. Counters and status must not report
success merely because a model returned or a task was admitted.
