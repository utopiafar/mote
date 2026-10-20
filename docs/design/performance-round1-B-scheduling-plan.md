# Round 1 B: bounded execution selection facts plan

Status: design only; independent review pending. Engineering approval of this
plan does not start implementation. Round 2 requires the controller's release.

## Identity, ownership and decision

- Frozen campaign/source base: `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
- Owner worktree: `/Users/utopiafar/.codex/worktrees/547b/mote`.
- Branch: `codex/perf-r1-b-execution-proofs`.
- Review binds the exact submitted Git head and SHA-256 of this plan, recorded
  in the separate review receipt. No product source changes belong to round 1.
- Minimum future product owner/file: B, `apps/server/src/execution-engine.ts`.
  New B-specific tests may be added. `scope/task-execution.ts` is a consumer,
  with no timer or task-host changes planned. No shared helper, schema, root
  package/lock, protocol or Operations changes are requested.

The proposed change removes repeated loading of the same durable running rows
within one candidate selection scan. It reuses no admission, authorization or
resource-turn decision. Transactional claim and all external-effect/publication
fences retain their live checks. A cache of whole-tick capacity conclusions is
outside this plan.

## Original complete journey and responsibilities

1. Production `scope/app.ts:131` starts `TaskExecution.start()`. Authenticated
   domain submission validates immutable input, captures durable account/model
   authority and creates canonical execution steps and operation membership.
   `TaskExecution.start()` (`scope/task-execution.ts:342`) invokes the same
   engine immediately and every 100 ms. Host `wake()`, completion wakes and
   explicit drains also use this engine, with coalescing/reentrancy protection.
2. `ExecutionEngine.tick()` (`execution-engine.ts:296–329`) recovers elapsed
   leases/recovery windows, reaps expired dynamic resource ownership/requests,
   propagates dependency failures and visits registered pools and their lanes.
   Its candidate SQL retains dependency/resource eligibility and orders by
   account, stage and operation fairness, then creation time and SQLite rowid.
3. The candidate loop (`:311–312`) materializes each candidate for lane and
   capacity checks. `capacityAvailable()` (`:147–157`) checks local active
   identity and live optional `available`, derives the current host capacity,
   loads all unexpired durable running rows in the relevant pools, derives each
   running row's host capacity and combines distinct units with unsettled local
   promises. A candidate may share an already occupied unit across pools.
   A full background reservation does not imply a full interactive reservation.
4. Resource turns remain live and account/operation fair (`:258–277`). The
   selected candidate is validated before `claim()` (`:331–358`). Claim starts
   `BEGIN IMMEDIATE` and rechecks durable state, live capacity, static/dynamic
   locks, resource turn, input/authority and domain admission. Only successful
   claims charge an attempt (where applicable), advance fairness, install a
   fence/lease and project progress. A rejected gate reserves no local slot and
   is skipped only for this tick. Admission waiting persists its reason/time
   and yields an event-loop turn, without consuming a processing failure.
5. The engine reserves the successful claim locally before launching handler IO
   on the next microtask. TaskExecution restores current account/model authority
   before providing services. Physical gates, per-call budget starts, external
   issuance ledgers and continuous resource reservations remain independent.
6. Running work renews every 10 seconds with a 30-second ownership lease. Its
   checkpoint and final commit use fresh grant/input checks in fenced write
   transactions. Domain output, success and operation projection are atomic.
   Abort, account revoke/delete or a lost fence rejects late publication.
7. Completion/resource release wakes queued work. Cancellation remains terminal;
   shutdown stops admission before settling the engine. Restart recovers current
   replayable work/checkpoints, but an issued unknown external result is not
   proof of non-execution and still blocks blind replay. Users retain existing
   progress, retry and cancellation behavior and operation hierarchy.

`store.ts` and `sqlite-database.ts` are storage/receipt infrastructure, not a
second scheduler. `StoreDatabase.prepare()` preserves lossless write receipts;
there is no proposed change to it, metadata reservation, WAL/FULL, backup, ACK,
quotas or wire/storage versions. Account authorization stays in TaskAuthorization
and TaskExecution; a scheduling observation never becomes user authority.

## Intended selection-only mechanism

### Lifetime and invalidation

Create a private, local selection-facts object for exactly one candidate SQL
iterator, after recovery/cleanup. Discard it when that iterator finishes or
selects a candidate, before invoking validation/claim. Never retain it across
pool/lane iterations, a claim (successful or rejected), a resource turn, an
`await`, tick, timer, close/reopen or a running task. No long read transaction,
persistent generation column, cached host authorization or new scheduling
policy is introduced.

The object lazily loads durable running rows for the union of the current pool
and registered partition-capable pools. For each predicate, filter to the exact
pool set used by the original algorithm: current pool only if unpartitioned;
all currently partition-capable pools if partitioned. Do not invoke callbacks or
decode irrelevant pools merely because their raw rows were bulk loaded. Do not
change original SQL candidate order or stop scanning on an occupied capacity.

Reuse raw running rows only when their database observation is still valid:

- Same open database/connection lifetime and same registered-pool coverage.
- Unchanged connection-local `total_changes()` (read losslessly) and SQLite
  `PRAGMA data_version` from other connections, read after the candidate's live
  `available` and capacity callbacks and immediately before using running facts.
  These follow the existing host invalidation precedent in
  `scope/private-data-sql.ts:58–64`; no edit to that shared gateway is proposed.
- Candidate predicate time has not moved backwards and has not reached the
  earliest retained lease expiry. Preserve `lease_until > now`, including exact
  equality. Clock movement can invalidate a snapshot without any write.
- Load with a before/after token. If they differ, use the fresh query rows for
  this predicate only and retain no reusable snapshot. Do not introduce an
  unbounded retry loop, a queue delay, or extra host-callback invocations.

If validity cannot be established, perform the original fresh running query for
that predicate. Other connections may claim, renew, cancel, release or update
configuration during a synchronous JavaScript scan; absence of `await` alone is
not a snapshot proof. SQLite iterator behavior in WAL and rollback-journal
connections must be characterized by the round-2 tests below. A cache must
observe the same read snapshot as the original live predicate; a token cannot
grant a stronger or weaker snapshot. No cross-connection freshness assumption
may be inferred from a successful single-connection benchmark.

### What is recomputed

Keep `available(step)` live, in its existing order and at every existing call
site. Keep current candidate `capacity(step)`, lane, limit and partition
callbacks live. Recompute each relevant running row's capacity and each current
local active step's capacity in original order for every predicate. Do not cache
positive/negative eligibility, distinct-unit sets, limits, partition mappings or
resource-turn results. This preserves dynamic in-memory host state as well as
database changes. In particular, plugin `available` reaps physical flights and
its partition callback records qualified restoration admissions; those callbacks
are not assumed pure (`scope/plugins.ts:157–182`).

Running JSON may be decoded once per unchanged fact set into private canonical
input data. Whenever supplying a durable running step to a host callback,
provide the same fresh mutable JSON object semantics as the original `view(row)`:
clone the canonical JSON input and reconstruct the step/immutable ownership
envelope. Never expose the canonical input itself. Preserve lazy decoding,
errors and callback order. Do not change local `active.step` reference semantics.
The existing candidate `view()` calls remain unchanged in this bounded change;
candidate decoding consolidation is deferred because callbacks can mutate input.
Measure clone cost before claiming a net CPU improvement. If it fails to improve
cost, retain raw-row reuse and leave JSON decoding unchanged; removing decoded
reuse narrows this optimization without altering the decision boundaries.

`capacityAvailable()` used by transactional `claim()` and `resourceTurn()` stays
uncached. It must query current durable leases, count unsettled local work,
check live `available`, derive current capacity and use the same unit semantics.
The selection-only variant is private and cannot be passed into claim or grants.
This separation is an engineering boundary, not another scheduling authority.

## Supersession and preservation review

| Classification | Disposition |
| --- | --- |
| KEEP | Full input/domain journey, task registration order, candidate scope/order, account/stage/operation fairness, independent lanes and background cap 32, cross-pool distinct-unit accounting and exact-unit child admission. |
| KEEP | Every live gate/limit/partition callback; unsettled local promises even after durable cancellation/expiry; resource turns/releases; transactional rechecks; attempt/budget accounting; 100 ms timer, completion wakes and retry times. |
| KEEP | Account/model/task authority, incarnation/fences, external unknown ledger, synchronous output/success commit, cancellation/restart/shutdown, quotas/durability and current wire/storage. |
| CHANGE | One iterator may reuse unchanged durable running row observations, and privately decoded JSON with fresh callback copies, instead of reloading/reparsing them per waiting row. |
| REMOVE | Only redundant running-row reads and safe repeated decoding within that observation; no lifecycle check, candidate, output or historical data is removed. |
| EXCEPTION | Dynamic callbacks retain current evaluation; malformed/unprovable observations fall back to the original fresh path. Existing same-unit admission can remain eligible at/above a reduced limit. |
| UNKNOWN | Native iterator/token behavior under external commits, net clone cost, dominant callback cost in real Perception/plugin/delegation pools, actual host P95/energy, latest-main integration. These are validation items, not approved behavioral exceptions. |

This does not supersede the scheduling authority or recovery ADRs. Inspected
assumptions: AGENTS; development plan/check/resource rules;
[execution engine](../execution-engine.md);
[task budgets/recovery ADR](../adr-task-recovery-and-execution-budgets.md);
[policy registrations](../task-execution-policies.md);
[scoped parity](../validation/execution-parity-2026-10-18.md);
engine/TaskExecution/TaskAuthorization; production pool registrations in
instance-controls, processing-perception, plugins and delegation-runtime;
background startup/close in scope/app; existing engine/resource/HTTP regressions.
UI, prompts, configuration shape, background jobs and agent capability surfaces
have no altered contract; no UI or prompt edit is proposed. PR #194 is outside
the frozen base and requires controller integration/delta review before delivery.

## Validation design for a future implementation

Round 1 only measures generated extracted selection code; it does not execute
the following product tests or establish lifecycle equivalence. Preserve all
existing assertions, input scales, timeouts and success conditions.

| Journey/state | Required observation and entry point |
| --- | --- |
| Saturated scan, empty and partial pool | Exact selected ID/no admission and candidate order; generated 100/1,000/5,000 waiting × 4/32 running; count running queries, rows, decoded bytes, synchronous scan/tick wall time, RSS and event-loop delay separately. Fresh claim reads are counted separately, not hidden in a reduced total. |
| Mixed ownership/stages/operations/lanes | Compare complete admission sequence and fairness tables to original; hard no-borrowing and background 32 cap; later eligible candidate and same-unit child after a large ineligible prefix. Existing `execution-lanes`, `multiuser-execution-core`, `multiuser-execution-parity` cases are design anchors. |
| Cross-pool and cross-connection units | Parent and exact child in separate pools/connections count once; unrelated child counts separately; limits shrink below occupancy without preemption; existing units stay eligible, new units wait. Include three-way full pool + shared unit + physical resource contention. |
| Dynamic available and callback semantics | Gate changes between scan and claim, reentrant wake, unavailable head followed by eligible work; no claim/attempt/fairness/local active leak. Mutating callback input must not contaminate another predicate's fresh view. Existing `execution-host-claim` and `execution-host-availability` assertions remain. |
| Database observation transitions | A second connection commits running admission, cancellation, renewal, configuration changes and releases between candidate predicates. Cover WAL and rollback journal; compare original live-query results at the same barrier. Include local writes, rolled-back writes, a token change during bulk load, exact lease boundary and backwards clock. Prove invalidation actually occurred, not merely a PASS. |
| Local physical lifetime | Durable step cancelled/expired while physical promise still settling; it continues to count until existing cleanup permits release. Release wake dispatches eligible work without an extra timer. Plugin restoration/ordinary flights and different-account controls retain behavior. |
| Resource waiting and release | Dynamic/static locks across two connections; full-pool static peer cannot block running continuation; cancellation/revoke/expiry while waiting or holding; release/reacquire fairness and no leaked fence-bound reservations. Use `execution-continuation.test.ts`, including process-exit coverage. |
| Claim race and setup failure | Another connection consumes capacity after selection; `BEGIN IMMEDIATE` recheck refuses over-admission with unchanged attempts/fairness. No snapshot crosses claim. Preserve claim policy/BEGIN failure, abort-before-launch and unclaimed-row progress cases in `execution-host-claim`. |
| Recovery and unknown outcomes | Real scoped TaskExecution startup/close/reopen and authenticated task/Operations HTTP entry; generated issued external call held across cancel/revoke/crash, no automatic repeat, late result fenced, owner confirmation unchanged. Use `multiuser-execution-lifecycle`, model-failure and recovery regressions. |
| Timers and downstream consumption | Actual engine tick under large admission-wait backlog still lets callbacks/timers/lease renewal run; preserve `execution-event-loop`. Focused Ask/Memory/Perception/plugin production fixture runs verify independent work and existing operation membership. No live model, personal screenshot or physical device is required for these fixtures. |

Use deterministic barriers and recorded state witnesses for races, not sleeps
that merely hope to enter them. Domain consumers outside B remain owned by their
campaign owners/controller; required consumer validation grants no edit rights.
If a shared fixture/helper is necessary, submit a controller change request.

## Resources, evidence and rollout limits

Every install/build/test/benchmark uses the external campaign resource gate.
Heavy is exclusive; light is limited to two small directed checks. B tmp,
artifacts and profiles remain under the B control directory; generated SQLite
uses memory or an explicitly owned temp path, ports 0, and no existing service,
credential/profile, simulator, device or personal content. Do not install the
full dependency tree solely for this round's microbenchmark.

The accompanying baseline report records its actual method, generated scale,
Node/SQLite/host identity, exact command, result and gate cleanup. No historical
failed-child timing is used. Reused source/test knowledge is not executed or
REUSED passed-test evidence. The future acceptance target is lower measured
saturated-scan work without a regression in eligible dispatch or any matrix
contract; no new product latency threshold is introduced here.

This round may open a documentation-only draft PR. Module directed validation
and unified integration acceptance remain distinct. Do not run full
`check:affected`, `check:local`, whole-repository tests or cross-client end-to-end
journeys in round 1. The controller is the final integrated check driver after
implementation converges. No product fix is delivered by this plan or its
approval.
