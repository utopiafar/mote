# Personal applied-policy archive checkpoint

The module consumes exact Joint production freeze
`a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695`. Its RED commit is
`74c0fee6fc267403fced377c8ca613cab7832e3b`; production implementation is
`decf31533a5ec03061ad7857e3173c8338f36328`; final test freeze is
`2206d33b3277c1fc44782dd9100f5f257cedf6ae` initially, with zero production diff from
`decf3153`. Final audit reproduced a local-integrity gap in RED
`7242c9cef6371673844b813e151619b4a1e4fec3`; final production/test freeze
`77a2818ec45b0bac2732cd613787daf7ee6fea81` adds the minimal parent guard.
It supersedes `decf3153` for composition. Final gate-compatible runtime
`2699d1f7eeeb12390c2b87229c11c32dc731d9ee` then mechanically renames the helper
method from `prepare` to `preflight`; its two-line delta changes no behavior. The [contract and supersession decisions](../design/multiuser-policy-personal-archive.md)
record current configuration/control precedence, opaque historical plan IDs and
the absence of execution authority in personal data recovery.

Production changes are limited to a new `scope/processing-policy-archive.ts`
helper and processing lifecycle export/parse/prepare/restore hooks. There is no
SQL schema, current policy mirror, plan ID formula, stored plan body, task engine
or provider transport change. Later Joint WIP was not consumed. The old
[recovery evidence](multiuser-recovery-lifecycle-seams.md) keeps its original SHA
and image boundaries.

## Real RED and final GREEN

All accounts, content, database faults and external responses are generated.
Tests use the production `buildApp`, real owner HTTP credentials/routes,
configuration/lifecycle adapters, SQLite publication transaction and executor.
Only external media HTTP is fake. No real model or central private data is used.

| Evidence | Actual result |
| --- | --- |
| Exact a2 production plus new two-case RED test; `/tmp/mote-policy-archive-a2-red.log/.exit` | 0 pass, 2 fail, 0 skip, exit 1, 13.878 seconds. Actual export omits the plans; actual complete personal merge after Capture deletion leaves both plan history and binding absent. |
| First minimal production implementation; `/tmp/mote-policy-archive-minimal-green.log/.exit` | 2/2 pass, exit 0, 18.766 seconds. |
| Clean `decf3153` test freeze; `/tmp/mote-policy-archive-frozen-matrix.log/.exit` | 25/25 pass, 0 fail/skip, exit 0, 52.980 seconds. |
| Clean `2206d33b` final owner freeze; `/tmp/mote-policy-archive-owner-final.log/.exit` | 26/26 pass, 0 fail/skip, exit 0, 63.268 seconds. Includes real B-only parent and stable control generations across repeated merge/restart. |
| Nine directly affected prior processing/personal/recovery cases; `/tmp/mote-policy-archive-frozen-neighbors.log/.exit` | 9/9 pass, 0 fail/skip, exit 0, 28.663 seconds. Named table stopped recovery, same-account merge/erasure, live-call disable/enable, historic Memory evidence, missing data merge, cross-domain rollback, pagination, restart/automation suppression and direct domain restore. |
| Final `77a2818e` owner matrix; `/tmp/mote-policy-archive-final27.log/.exit` | 27/27 pass, 0 fail/skip, exit 0, 46.904 seconds. |
| Final `77a2818e` same nine consumers; `/tmp/mote-policy-archive-final77-neighbors.log/.exit` | 9/9 pass, 0 fail/skip, exit 0, 22.792 seconds. |
| Isolated a2 source plus final minimal five-file patch; `/tmp/mote-policy-archive-exact-a2-final77.log/.exit` | 5/5 critical cases pass, 0 fail/skip, exit 0, 25.180 seconds. No prior recovery cohort is copied. |
| Final Server build and strict new-test/minimal-projection noEmit | Exit 0: `/tmp/mote-policy-archive-final-build.log/.exit`, `/tmp/mote-policy-archive-final-test-types.log/.exit`, `/tmp/mote-policy-archive-final77-minimal-types.log/.exit`. |
| Server noEmit and fresh Server build | Exit 0: `/tmp/mote-policy-archive-server-types.log/.exit`, `/tmp/mote-policy-archive-build.log/.exit`. |
| Strict new-test noEmit and i18n | Exit 0: `/tmp/mote-policy-archive-test-types-owner-final.log/.exit`, `/tmp/mote-policy-archive-i18n.log/.exit`. I18n checks 8,439 bilingual messages/call sites. |

Final owner command:

```sh
node --import tsx --test --test-concurrency=2 --test-timeout=120000 \
  apps/server/test/multiuser-policy-personal-archive.test.ts
```

The final matrix has eleven parent journeys and sixteen malformed-data subcases. It
covers selected service closure and the separate full configuration definition,
missing original recovery, same/repeated/new import IDs, current configuration
and binding preservation, immutable-ID conflicts, old plan-less archives,
future versions, duplicate rows, dangling plans, missing/foreign originals,
invalid IDs, forbidden owner fields, malformed JSON, wrong rule/source/MIME,
missing services, embedded credentials and false archive claims. It also tests
missing current M04 connections without provider I/O, owner-isolated physical
account cleanup, existing local cancellation, atomic rollback of earlier
canonical/original restoration, unchanged unknown calls/confirmations, and
reconstruction beside surviving old tasks without changing the original
incarnation or their grant rows. An explicitly retried old task may receive the
existing API's queue ACK; the real executor then marks its old input stale with
no provider call. A queue ACK is not accepted as proof of execution authority.

The extra final journey injects a dangling binding in its own generated SQLite
database. The first implementation actually repaired its missing plan and
returned completed: `/tmp/mote-policy-archive-local-parent-red.log/.exit`, 0/1
pass, exit 1, 5.670 seconds. `77a2818e` rejects both full closure and plan-only
imports that would fill a missing plan underneath a surviving local binding;
current bindings must already have the correct owned parent. Narrow corrected
case: `/tmp/mote-policy-archive-local-parent-green.log/.exit`, 1/1 pass, exit 0,
4.460 seconds. Full final matrix and consumers then pass on that same fix.
This is a confirmed validator gap in the new module, not a defect attributed to
original a2. The initial isolated test noEmit failed to resolve `mem0ai/oss`
because only root dependencies had been linked into the source projection.
Linking the existing trusted Server workspace dependencies fixes that projection;
no dependency is installed or changed. Initial exit 2 remains in
`/tmp/mote-policy-archive-minimal-test-types.log/.exit`; final linked noEmit exits 0.

## Broader attempt and preserved failures

An earlier bounded four-file run included the evolving new test, all
`multiuser-processing`, all `multiuser-portable-import` and the three prior
policy recovery cases. `/tmp/mote-policy-archive-acceptance.log/.exit` contains
105 cases: 102 pass, 3 fail, 0 skip, actual exit 1, 394.211 seconds. It remains a
failed run. Two new-test failures were fixture/observer assumptions: comparing
live result/progress projections rather than immutable task authority, and
requiring the task-retry route to reject before its executor validation. The
final matrix fixes those assumptions and verifies stale execution/no I/O.
An attempted global background-task completion wait was also inappropriate to
this owner-data merge and is retained in the intervening failed matrix logs.

The third failure is the preexisting `a held actual media result is fenced after
configuration while B remains operational` pin-count assertion. The identical
case on an isolated **unmodified a2 tracked-source snapshot** also fails:
`/tmp/mote-policy-archive-a2-configuration-baseline.log/.exit`, 0/1 pass, exit 1,
5.437 seconds, expected pin count 0 versus actual 1. The source test is around
line 134 at a2 (135 in the recovery composition). This establishes a preexisting
failing scenario, not a newly confirmed production defect or permission to
change shared processing. The accepted QR exact-pin disposer is already present in a2 through selected
composition `08fa2ba1` (producer `1d6d933c`). A generated read-only observer in
`/tmp/mote-policy-archive-pin-composition-observer.log/.exit` retains the failing
assertion and records the acquired old pin disappearing after physical
settlement. The remaining pin has a different UUID and belongs to fresh
reconciliation with new task/grant IDs. The account-wide zero-pin assertion
conflates that new work with the retired attempt. No duplicate production repair
or assertion change is made here. The other
80 existing neighboring cases passed in that broad attempt. Their outcomes are
not spliced into a successful full affected gate.

The affected scope is Central only. The parent subsequently requested the actual
required gate and an independently reviewable Draft PR. The first gate started on
clean documentation tip `a606d97b`, with production/test source exactly final77:

```sh
npm run check:affected -- --base 20f04d0c09ad721f42040763e62d1bf876c4e87c
```

Its log, source SHA and original clean status are retained in
`/tmp/mote-policy-archive-required.log`, `.sha` and `.dirty`. After reproducing the
checker failure below, the owner intentionally stopped only that runner
and its verified descendants to avoid completing the superseded candidate.
The shell exits 143; cancellation-generated failures are not test defects or a
complete suite result. The exact stop reason/PIDs are recorded in
`/tmp/mote-policy-archive-required.interrupted.json`. Before interruption, four
component builds/types, Shared 192/192 and Agent 317 pass/1 skip had completed.
The final gate will rerun the full Central scope on the renamed runtime; no
first-run success is substituted for that rerun. UI, final clients and compiled-container recovery of
this new personal module remain unverified. The fresh Server build verifies
compilation; the old a2 Docker image remains evidence only for the preceding
recovery phase.

Joint then reproduced a scope-checker failure: its conservative `.prepare`
rule interprets the new helper call as raw SQL. This lane independently ran
`node scripts/check-scope-contracts.mjs` on final77: actual exit 1,
`private SQL bypass: apps/server/src/scope/processing.ts`, retained in
`/tmp/mote-policy-archive-scope77-red.log/.exit`. The bounded correction is a
mechanical helper method rename to `.preflight`, with no checker exemption,
SQL, archive semantics or ID/JSON changes. Commit `2699d1f7` applies exactly that
rename and independently passes the checker, exit 0, retained in
`/tmp/mote-policy-archive-preflight-scope.log/.exit`. The original RED is retained.

## Minimal handoff

Joint completed an independent read-only review of exact final77, recorded in
`/tmp/mote-joint-review-policy-archive-77a2818e.md`, and directly confirmed no new
P0/P1/P2 findings. It checked optional v1 compatibility, owned parent closure,
current-control precedence, fresh generations/unfinished-task fencing, the
final dangling-local-plan guard and publication ordering. It did not execute
our tests. The earlier outbound review requests returned unconfirmed; the later
direct review supersedes that pending state. Joint is selecting the module
commits into its own composition; its tests and later WIP are separate evidence.

The feature commits can be selected after a2 without the old recovery-lane test
cohort: `74c0fee6`, `decf3153`, `2206d33b`, `7242c9ce`, then `77a2818e`, followed by checker-compatible `2699d1f7`. Strict standalone test noEmit
also uses the earlier two-line `scoped-files.ts` Fastify payload typing correction
from the recovery lane; it has no runtime effect. The explicit minimal patch
`/tmp/mote-policy-archive-a2-final77.patch` includes only those four module files
and that fixture typing correction, with SHA-256
`66464b9adc0a01e14aa9e00c1b8932d5ca3d5f93113fb1b9da3079da14e48f08`.
An isolated a2 source projection plus precisely these files is separately
checked; its command/log and final result are recorded in the public freeze file.
Repository dependencies and Shared/Agent runtime are unchanged from a2.

The integration branch was remotely verified still at
`6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`. This checkpoint supplies a minimal
module patch and feature commits for Joint composition. The authorized Draft PR
will target integration and disclose its frozen dependency stack; no merge,
deployment or CI configuration change is performed.
