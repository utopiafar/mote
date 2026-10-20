# Round 1 A module validation

Frozen base: `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
Branch: `codex/perf-r1-a-read-models`. This is a draft module submission;
combined integration acceptance and complete `check:affected` remain with the
controller. It is not a claim that the change is present on main or released.

## Approval and scope

Independent reviewer `/root/plan_review`, `gpt-6.1-sol`, High, approved before
implementation at base = pre-implementation HEAD above:

- [Plan](performance-round1-A-plan.md), SHA256
  `18b356d3a3d3001ea8fffdf8bfbdfa218230a376a41191d31b8c8dbd41c315d2`.
- [SQL delta](performance-round1-A-delta.md), SHA256
  `1f26d3a448dd9b7199bf6d7c20a40c0f3355f72c4dccd1be11fdc4670eaf5281`.
- [Round 2 investigation](performance-round1-A-round2-candidates.md), SHA256
  `f741e302fc0999651e43a8f4590718d6b46aaf56cdbd51044b360a0b0796cd33`,
  approved for design-only investigation; it grants no implementation rights.

The production change is only a nonunique current-schema reverse head index
and page-scoped dependency batching. The final SQL uses JSON-bound authorized
step IDs and a correlated ordered/limited read per step. No source paths outside
the two approved files changed. No migration, API, owner, total, sort, refresh,
task lifecycle, UI or other product-policy change was introduced.

## New execution

All commands used the campaign `run-resource.py --owner A` gate. Installation,
builds and the sequential scale/timing run used exclusive heavy resources.
Node `v26.11.1`, npm `11.20.0`, macOS arm64; independent worktree node_modules
and build outputs. No evidence was reused from another worktree or old run.

```sh
npm ci
npm run build:libs
node --import tsx --test --test-concurrency=1 \
  apps/server/test/performance-round1-a-heads.test.ts \
  apps/server/test/performance-round1-a-operations.test.ts \
  apps/server/test/operations.test.ts \
  apps/server/test/operation-runs.test.ts \
  apps/server/test/multiuser-execution-core.test.ts \
  apps/server/test/multiuser-execution-parity.test.ts \
  apps/server/test/multiuser-capture-browser.test.ts \
  apps/server/test/private-data.test.ts \
  apps/server/test/private-data-lifecycle.test.ts
```

Results: installation and library builds passed. Targeted tests: **59/59 PASS**,
zero skipped/cancelled, 145.88 seconds. Resource receipt
`b4cd4fa2-e318-4648-8e04-2d2c947b81dc` confirmed complete process-group cleanup.

The head fixtures ingest 1k/10k current revisions plus equally many historical
revisions **per account**, with identical logical identities for two accounts.
They traverse signed HTTP pages and compare eight complete query responses
with/without only the index: first/middle/tail, combined predicates, time range,
activity, missing app and completed OCR. They retain exact totals on all pages,
tie order, current/deleted/raw visibility, owner/query cursor binding, head
replacement, rollback, deletion, idempotent schema setup and FK integrity.
Source-item OCR is not_applicable; the existing real M03/M06 fixture separately
verifies actual screen OCR/publication, albums/sessions, device restriction,
thumbnail retirement and restart. Fastify inject exercises production routes;
the existing private-data fixture also checks real loopback HTTP and restart.

Operations compares every output field to the frozen original reader, across
multiple page sizes, account isolation, missing/foreign 404, 0/1/99/100
dependencies, normal admission rejection above 100, lookahead exclusion and
empty tail. A separate direct-engine fixture checks 125-dependency truncation,
206-step pages and batch boundaries, kind/reason normalization, optional/history
and rollback. Existing production HTTP tests cover generations, late children,
parent membership, cancellation, changes and restart. These are generated
fixtures with no personal data or live model.

## Measurements

The same database, data and query inputs were used before/after the index.
Full response deep equality was checked. These are local fixture observations,
not production latency percentiles or hard speed assertions.

| Generated scale per account | Unfiltered first HTTP page, no index | Same page, indexed |
| --- | ---: | ---: |
| 1k current + 1k old revisions | 93.72 ms | 7.56 ms |
| 10k current + 10k old revisions | 11,844.91 ms | 33.44 ms |

The captured production count SQL plan changes from
`SEARCH h USING INDEX sqlite_autoindex_pd_source_heads_1 (user_id=?)` to
`SEARCH h USING COVERING INDEX pd_source_heads_capture (user_id=? AND capture_id=?)`.
The old plan tests capture membership across an owner's head prefix; the new
plan locates the exact capture. Statement counts alone were not used as index
evidence. Full plans and all eight query timings are in the private campaign
artifact `A/artifacts/measurements.json`.

For a 100-step detail with 0/1/99/100 dependencies, five rounds of 20 reads on
the same frozen state gave median **1.660 ms original → 0.852 ms batched**.
Dependency SQL calls drop from 100 to one; each selected ID retains its own
ordered first 100 dependencies and EXPLAIN checks its covering dependency PK.
The initially approved UNION shape measured about 4.2 ms against 1.8 ms and was
replaced through the independently approved delta before this final run.

### Test budget exception

The 10k case took 121.14 seconds (new case timeout 180 seconds). It intentionally
executes the original quadratic owner-prefix membership plan at full scale for
all eight equivalence queries. This exceeds the 30-second case / 60-second file
soft budgets; the required input scale, before/after assertions, HTTP entry and
cleanup are retained. The indexed production requests themselves are tens of
milliseconds. No existing timeout/assertion was relaxed or test entry changed.
The controller should retain this known long functional scale case when
selecting the final combined run; default suite concurrency may affect timing.

## Earlier attempts and remaining checks

The first run stopped the head cases on invalid generated deletion text;
the corrected fixture uses the existing metadata-only deletion contract.
That run's Operations equivalence passed but its UNION timing regressed; it is
not evidence for the final JSON implementation. Three later attempts returned
UNRUN/75 while another campaign owner held heavy resources, with no test work
and no locks taken or reclaimed.

`npm run build -w @mote/server` passed, including its TypeScript compilation
(receipt `79f07399-ccd6-4ffa-b47b-a7b070311f9b`, cleanup confirmed).
`npm run check:affected -- --base af11ab7c3e9fb5f38deaea4e4bae11462a7306b4 --dry-run`
passed as a scope inspection only (receipt
`b5109030-e54e-4f45-b157-eb72119c0282`, cleanup confirmed). It does not execute
or establish success for the selected complete plan.
No complete `check:affected`, `check:local`,
whole-workspace test, browser/Electron UI, Android, physical-device, personal
capture or live-model validation was performed here. All final integration and
release decisions remain pending controller acceptance.
