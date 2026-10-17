# Personal applied-policy archive checkpoint

The module consumes exact Joint production freeze
`a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695`. Its RED commit is
`74c0fee6fc267403fced377c8ca613cab7832e3b`; production implementation is
`decf31533a5ec03061ad7857e3173c8338f36328`; final test freeze is
`2206d33b3277c1fc44782dd9100f5f257cedf6ae`, with zero production diff from
`decf3153`. The [contract and supersession decisions](../design/multiuser-policy-personal-archive.md)
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
| Server noEmit and fresh Server build | Exit 0: `/tmp/mote-policy-archive-server-types.log/.exit`, `/tmp/mote-policy-archive-build.log/.exit`. |
| Strict new-test noEmit and i18n | Exit 0: `/tmp/mote-policy-archive-test-types-owner-final.log/.exit`, `/tmp/mote-policy-archive-i18n.log/.exit`. I18n checks 8,439 bilingual messages/call sites. |

Final owner command:

```sh
node --import tsx --test --test-concurrency=2 --test-timeout=120000 \
  apps/server/test/multiuser-policy-personal-archive.test.ts
```

The matrix has ten parent journeys and sixteen malformed-data subcases. It
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
change shared processing. Whether its global pin assertion is stale under
fresh unfinished-work reconciliation or reveals a physical cleanup problem is
left to Joint; no production repair or assertion change is made here. The other
80 existing neighboring cases passed in that broad attempt. Their outcomes are
not spliced into a successful full affected gate.

The required scope planner reports Central only in
`/tmp/mote-policy-archive-affected-plan.log/.exit`. It is a **dry run**, not a
passed `check:central`. The parent requested this bounded owner module without
repeating the full stack. Full affected checks, UI, final clients and compiled
runtime recovery of this new personal module are not claimed. The fresh Server
build verifies compilation; the old a2 Docker image remains evidence only for
the preceding recovery phase.

## Minimal handoff

Joint directly confirmed three-table semantics and the old ID formula's missing
processor receipt. The outbound request to review exact `decf3153` returned
`An earlier turn submission is not yet confirmed`; it is not recorded as
delivered, accepted or composed. Later `2206d33b` changes tests only. Final
composition and independent owner review remain pending.

The feature commits can be selected after a2 without the old recovery-lane test
cohort: `74c0fee6` then `decf3153` then `2206d33b`. Strict standalone test noEmit
also uses the earlier two-line `scoped-files.ts` Fastify payload typing correction
from the recovery lane; it has no runtime effect. The explicit minimal patch
`/tmp/mote-policy-archive-a2-minimal.patch` includes only those four module files
and that fixture typing correction, with SHA-256
`42d4054c91aa2e159ee7adba7020b4d7777bc086e38343be6145585ccf6b87ba`.
An isolated a2 source projection plus precisely these files is separately
checked; its command/log and final result are recorded in the public freeze file.
Repository dependencies and Shared/Agent runtime are unchanged from a2.

The integration branch was remotely verified still at
`6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`. This checkpoint supplies a minimal
module patch and feature commits for Joint composition; no PR, merge, deployment
or CI configuration change is part of this handoff.
