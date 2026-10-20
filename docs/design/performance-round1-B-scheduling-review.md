# Round 1 B: independent scheduling plan review receipt

Decision: **APPROVE**. This is a pre-implementation engineering plan approval,
not product implementation, execution evidence, delivery or round-2 release.

| Identity | Reviewed value |
| --- | --- |
| Reviewer | Independent collaboration agent `/root/scheduling_plan_review` |
| Model / effort | `gpt-6.1-sol` / High |
| Product base | `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4` |
| Exact submitted documentation head | `00decc5f2b3a965079215082b85d8d532c0db03c` |
| Plan | [Bounded execution selection facts plan](performance-round1-B-scheduling-plan.md) |
| Plan SHA-256 | `f8a84eecd02fbf6735c08d93657c1c5876e687b9db3dc4d57c93d8701ee3486d` |
| Source difference at review | Base to head contains only the two B plan documents; clean worktree confirmed by reviewer |
| Scope | One candidate iterator's valid durable running-row observations; optional private decoded JSON reuse with fresh callback object semantics |
| Minimum future source owner | B: `apps/server/src/execution-engine.ts`; B-specific new tests permitted |

The reviewer independently read AGENTS and development plan-review rules,
execution/recovery/policy/parity documentation, engine and TaskExecution,
production plugin/Perception/delegation/lane callbacks, and existing claim,
availability, lane, cross-pool unit and resource-continuation tests. The reviewer
confirmed that the complete original/intended journeys and
`KEEP / CHANGE / REMOVE / EXCEPTION / UNKNOWN` classification match the code.
No blocking plan change was requested. The reviewer neither implemented nor
edited files, installed dependencies, ran tests/benchmarks or created another
user chat.

## Approved boundaries and retained validation items

1. Reuse requires same connection lifetime/pool coverage, lossless
   `total_changes()`, `data_version` and lease/time validity, including rolled-back
   local writes, external commits, exact expiry and backwards time. A changing
   load token permits only that fresh query's result, with no retained snapshot.
2. Native active-iterator behavior in WAL and rollback journal was unverified
   at review time. A future implementation must compare with the original live
   query at identical barriers, using the original fresh path when equivalence
   cannot be established. Tokens do not establish another freshness policy.
3. Dynamic `available` and candidate/running/active lane, limit and partition
   callbacks retain their real-time evaluation and original order. Plugin reap,
   wake and restoration admission side effects are not cached. Private canonical
   JSON never escapes, and local `active.step` reference semantics stay intact.
4. Unsettled local physical promises still count; exact same-unit children share
   capacity across pools/connections and retain their eligibility after shrink.
   A full capacity must not stop candidate scanning.
5. Facts never cross resource turn, validation/claim, pool/lane, await or tick.
   Resource turns and `BEGIN IMMEDIATE` claim predicates retain fresh SQL and
   all live gates; they cannot receive the selection snapshot.
6. Account/model/input authority, attempt/fairness accounting, the 100 ms timer,
   cancellation/restart/lease behavior, unknown external outcomes and publication
   fences remain unchanged. No two-second backoff or new product policy is
   approved.

The reviewer found the consumer/state/real TaskExecution and authenticated HTTP
validation matrix adequate, including deterministic barriers, observed states,
resource isolation and the single final check driver. Native observation tests,
JSON clone net benefit, production callback cost, P95/energy and latest-main
integration remained validation items, not claimed passed checks.

This receipt binds only the exact plan/base/head/scope/assumptions above. Later
documentation may attach measurement evidence without changing the approved
plan. A change to its decision boundaries requires delta review by the same
reviewer. [Evidence and organizer follow-up](performance-round1-B-proof-organizer-followup.md)
is explicitly excluded. Round 2 still requires controller release; no source
implementation is authorized by this receipt alone.
