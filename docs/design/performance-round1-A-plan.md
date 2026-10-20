# Round 1 A: scoped archive query and operation detail

Plan v1. Owner A; frozen base and pre-implementation HEAD:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4` on
`codex/perf-r1-a-read-models`. Independent review must approve this exact plan
before source/test implementation. This is module validation; the controller
owns final combined `check:affected` and integration acceptance.

## Classification and original journey

The schema index is an additive physical access-path change. Detail batching
changes SQL execution shape at a private-data read boundary, with authorization
and output contracts held fixed. Obtain independent Sol High review because
the owner-scoped dependency output and validation entry points need explicit
equivalence review. No product-policy or architecture change is requested.

Capture intake uses the existing M02/M03 source/capture paths; revisions remain
durable while `pd_source_heads` selects the current `(user,source,external)`
revision. A logged-in archive user requests `/api/capture-browser`; the scoped
route obtains `PrivateData.captureBrowser(processing)` and the browser performs
owner-bound extraction, attachment visibility, current-head and deleted checks,
then filters before exact count and sorted keyset paging. Per-item record reads
retain OCR/material projection and original size behavior. Gallery, sessions,
updates, private capture lists and index rebuilding reuse head membership.
Signed cursors bind full query, account and deployment; later pages still return
the full exact total. Retirement, disabled sources, invalid cursors and 404s
retain existing behavior. The old EvidenceStore composition is not this path.

Task admission validates same-owner dependencies through TaskExecution and
ExecutionEngine. The production `/api/operations/:id` route resolves the
authenticated task service, whose `operations()` constructs `Operations` with
the host-established user ID. Detail first checks the owner-bound nonempty
operation, selects `limit+1` steps in ascending account `user_position`, maps
only the first `limit`, and separately queries each mapped step's dependencies
in `dependency_id` order with `LIMIT 100`. Summary, active/optional flags,
notScheduled, kind normalization, sanitized errors, timestamps and nextCursor
are consumed by the Web operation/task views. No private task input is returned.
Legacy callers without an owner use rowid; this shared reader must preserve
their current results without introducing new legacy compatibility code.

## Intended implementation and supersession inventory

- KEEP: all intake, publication, authorization, owner checks, output schemas,
  exact counts on every page, filters, sort order, cursors, limits, visibility,
  task lifecycle, refresh timing, errors, rollback and restart behavior.
- CHANGE: add idempotent nonunique `pd_source_heads_capture` index on
  `(user_id,capture_id)` in current schema initialization. No schema version,
  migration, retention, uniqueness or FK policy change.
- CHANGE: in Operations.detail collect only already-selected output step IDs;
  read dependencies in batches of at most 100 step IDs. Each UNION ALL arm is
  `SELECT ? step_id,dependency_id FROM (SELECT dependency_id FROM
  execution_dependencies WHERE step_id=? ORDER BY dependency_id LIMIT 100)`.
  The compound query orders by step_id,dependency_id; group rows into arrays
  attached to the original ordered steps. Batches avoid SQLite compound-select
  limits even for existing direct callers with larger page limits. No query
  for an empty step page; no dependency read for the lookahead step.
- REMOVE: the repeated per-step dependency prepare/all calls only.
- EXCEPTION: none. Module-only checks and generated data/resource isolation are
  explicitly authorized by the campaign; full integration remains pending.
- UNKNOWN: planner/timing improvement size, and direct-call large-page overhead;
  resolve with generated measurement before reporting results. No architectural
  decision is superseded; inspect existing scoped routes, task admission,
  consumers, tests and current schema for assumptions before implementation.

The dependency table has a global step PK/FK and `(step_id,dependency_id)` PK;
dependencies have no owner column. Keep the same owner-filtered step selection
as the authority boundary and bind only its IDs. Do not add a target-owner
filter or materialize unrelated dependency rows. Reads remain synchronous on
the same connection, with no new cache, transaction, await or authority reuse.

## Ownership and resources

Only modify `apps/server/src/scope/private-data-schema.ts`,
`apps/server/src/operations.ts`, new A-specific files under `apps/server/test/`,
and `docs/design/performance-round1-A-*`. Existing shared fixtures/helpers and
consumer sources remain read-only. No dependency or shared-file change is
needed. Other A-owned processing read models remain untouched in round 1.

Install/build/test/benchmark commands use the campaign gate with owner A;
builds, scale tests and timing use heavy exclusively. Small targeted checks may
use light. Independent node_modules/dist only. Generated temporary data lives
under campaign A/tmp and measurements under A/artifacts. Use port 0 and no
personal profiles, screens, models, devices, existing services or UI windows.

## Validation design

Create dedicated regression files without changing existing harness behavior.

1. Build only required libs/server with heavy. Run existing focused Operations,
   operation generations, scoped task/operation, private-data lifecycle and
   capture-browser tests as relevant; do not run full workspace suites.
2. Generated scale fixture with 1k and 10k current heads, old revisions and two
   accounts sharing logical identities. Seed through PrivateData source intake
   in bounded 500-item batches. Exercise real authenticated browser HTTP reads
   against production composition, with processing installed. Compare complete
   before/after-index responses at identical filter/sort/limit/cursor inputs:
   all fields, exact total, stable tie order, first/middle/tail pages, source,
   device, app, time, collection, OCR and empty filters. Independently assert
   current IDs/no historical or deleted heads, owner-specific text, cursor
   account/query rejection. Exercise replacement, rollback, deletion, reopening
   current schema idempotently, and existing HTTP restart/retirement fixtures.
3. Capture real executed membership/count/page SQL and EXPLAIN QUERY PLAN on
   the generated production database with/without only the new index. Assert
   the indexed plan searches both user_id and capture_id using the covering
   index; report prior owner-prefix scan versus indexed point lookup and warm
   repeated timings. SQL call count alone is not index evidence. Do not assert
   machine-specific absolute latency or reduce required scale.
4. Generate scoped tasks/operations through production admission with zero,
   one, 99 and 100 dependencies, multiple steps/pages and another account;
   assert normal admission still rejects >100 dependencies. Separately use the
   existing ExecutionEngine/direct-reader fixture for 101+ dependencies to
   verify the reader's unchanged per-step cap; do not describe that fixture as
   production admission or weaken the submit schema's existing 100 cap.
   Compare full detail to a baseline reader that retains the original per-step
   SQL, using the same persisted state. Include active/retired generations,
   optional/notScheduled, errors/kind normalization and rollback/restart with
   existing tests. Traverse pages including empty tail and compare all fields;
   preserve foreign/missing operation 404 and unrelated-owner invariance.
   Instrument only dependency SQL to assert one batch per <=100 returned steps,
   each arm keeps its own limit/order, and EXPLAIN uses the dependency PK.
   Add >100-step direct-reader page regression for batch-boundary completeness.
5. Run server typecheck and `check:affected -- --dry-run --base <frozen base>`
   under the gate. Report exact new commands/results and cleanup; no reused
   checks unless inputs and original receipts are proved. Full affected/local,
   UI, native devices and live models are explicitly unrun at module stage.

## Risks and deferred bounded design

Index increases current-head writes/storage modestly; validate schema/FK
cleanup and head transitions. Compound SQL has more bind parameters but at
most 200 per batch and 100 arms. Sorting is bounded to 100 dependencies per
selected step; no global window scan. Preserve synchronous consistency and
avoid fetching every dependency before applying each step's cap.

Round 2 design only: investigate FTS identity-to-rowid mapping (all identity,
delete/rebuild/rollback consumers); lightweight import/Perception/speaker reads
(same state/refresh/failure evidence); precise original/material reverse lookup
(owner, visibility, incarnation and multiplicity). Each requires a separate
bounded plan and independent review; none is authorized for implementation by
this first-round approval.
