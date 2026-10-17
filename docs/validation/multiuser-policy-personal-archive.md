# Personal applied-policy archive validation

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
| Checker-compatible `2699d1f7` owner matrix; `/tmp/mote-policy-archive-preflight27.log/.exit` | 27/27 pass, 0 fail/skip, exit 0, 55.800 seconds. |
| Checker-compatible `2699d1f7` isolated a2 plus minimal patch; `/tmp/mote-policy-archive-preflight-minimal5.log/.exit` | 5/5 pass, 0 fail/skip, exit 0, 31.804 seconds. |
| Same runtime supervisor fixtures and release tools | Exit 0: `/tmp/mote-policy-archive-preflight-runner.log/.exit`; 52/52, 0 fail/skip, exit 0: `/tmp/mote-policy-archive-preflight-release.log/.exit`. Recorded separately so a prior Server failure cannot hide unexecuted `&&` stages. |
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
A new full Central affected gate started from clean doc-only tip `1170f676`
with production freeze `2699d1f7`; its distinct evidence prefix is
`/tmp/mote-policy-archive-required-final`. No first-run success is substituted
for that rerun. Its actual terminal exit is **1**, with the complete results below. UI, final clients and compiled-container recovery of
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

## Complete required gate on the final candidate

`/tmp/mote-policy-archive-required-final.log/.exit` records the real command above,
actual exit **1**, started on clean
`1170f67654c1a2fe4026c1e750de30453dc11827` with production source exactly
`2699d1f7eeeb12390c2b87229c11c32dc731d9ee`. Only validation documentation was
edited while it ran. The same gate completes all four builds/types and i18n.

| Required component | Actual result |
| --- | --- |
| Shared | 192/192 pass, 0 fail/skip. |
| Agent | 317 pass, 0 fail, 1 skip. |
| Server | 2,790 pass, 3 fail, 2 skip; 2,795 total, 1,505.827 seconds. All 27 personal-plan archive cases and production scope architecture pass inside this complete run. |
| Web | 515/515 pass, 0 fail/skip, 85.943 seconds. |

The required gate is **not accepted as green**. Its three original failures are
retained without changing shared backends, fixture assertions or timeouts:

| Current failure | Actual untouched-a2 reproduction and classification |
| --- | --- |
| `failed real child retries only its own model branch while successful checkpoints remain single-use` | `/tmp/mote-policy-archive-a2-ask-baseline.log/.exit`: 0/1, exit 1, 24.165 seconds. The original fixture's 20-second Ask wait expires with status running and a final validating event. Source is an unmodified tracked a2 snapshot at `/tmp/mote-policy-archive-a2-required-baseline`. This confirms a preexisting failing scenario, without claiming a cause or a later successful completion. |
| `a held actual media result is fenced after configuration while B remains operational` | `/tmp/mote-policy-archive-a2-configuration-baseline.log/.exit`: 0/1, exit 1, 5.437 seconds, pin count 1 versus 0. The exact-pin observer above shows the old pin retires and a distinct new pin belongs to fresh work; the QR disposer repair is already present. |
| `Web feature metadata describes real routes and Library keeps owned canonical material/source paging` | `/tmp/mote-policy-archive-a2-web-metadata-baseline.log/.exit`: 0/1, exit 1, 6.705 seconds, `do not advertise absent legacy runtime`. The frozen runtime has scoped Imports, while this old assertion assumes absence; the peer already reported the same stale fixture. No peer WIP is copied. |

The failed workspace command prevents its later `&&` supervisor/release stages
from running. They were also run independently on this same frozen candidate:
supervisor fixture exit 0; release tools 52/52, no fail/skip, exit 0. Those results
are separate evidence and do not turn the failed required command into a pass.
No additional source changes follow this gate; final publication edits only
documentation and PR metadata.

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
`/tmp/mote-policy-archive-a2-final77.patch` preserves the reviewed final77 module
with SHA-256 `66464b9adc0a01e14aa9e00c1b8932d5ca3d5f93113fb1b9da3079da14e48f08`.
The checker-compatible `/tmp/mote-policy-archive-a2-preflight.patch` contains only
those four module files and the fixture typing correction, with SHA-256
`be8fd61a7ae7d9ce1095b231c064fded41e5462f0a3ce508e65416828b44209a`.
An isolated a2 source projection plus precisely these files is separately
checked; its command/log and final result are recorded in the public freeze file.
Repository dependencies and Shared/Agent runtime are unchanged from a2.

The integration branch was remotely verified still at
`6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`. This checkpoint supplies a minimal
module patch and feature commits for Joint composition. The authorized Draft PR targets integration with its frozen dependency stack
explicitly disclosed. Its integration comparison includes pending dependencies
and earlier recovery tests; the independent module comparison against `20f04d0c`
contains five files, including two production files. No merge, deployment or CI
configuration change is performed. The task delivery records the actual PR URL.

## Bounded closing phase: fixture repairs and compiled joint recovery

The parent required continuing PR150 through the inherited failures and the new
module's compiled recovery. Production remains exact
`2699d1f7eeeb12390c2b87229c11c32dc731d9ee`; no public backend, schema, plan body,
ID formula or timeout changes follow it. Closing test/runner freeze is
`371bd18649a40b0ac3a9764a5223b08970266d38`.

The exact E2E test-only pin repair
`94241d7e7d71e4dd1ed50e0279104e78864bafb0` was read from its owner's task-6
checkout, then selected without modifying that workspace. It awaits actual pin
release within the existing `until` budget after immediate task retirement.
The Imports assertion now advertises the real scoped `/api/imports` route.
The first bounded list passes 10/10, no skip, exit 0, 55.561 seconds in
`/tmp/mote-policy-archive-close-narrow1.log/.exit`; Ask still uses its original
assertions/budget there. Subsequent overlapping runs retain their failures.

The failed-child retry fixture had also inherited duplicate parent submission
and ordered-child setup beyond its own sibling-retry assertion. Only its
`failSecond` variant now submits its two independent units once. Ordered and
pause/restart variants keep their ordered dependencies and duplicate submission.
The retry case still exercises real host tools/workers, requires `one:1/two:2`,
one completed turn and the original 20-second completion wait. It additionally
captures the successful sibling's actual task ID/state/attempts/result/checkpoints
before retry and compares them after completion. No shared Ask code is changed.
The final retry case passes in 18.903 seconds and the unchanged ordered neighbor
passes in `/tmp/mote-policy-archive-ask-closure5.log`; that same overlapping run
fails the unchanged pause/restart case. The latter then passes alone, unchanged,
in `/tmp/mote-policy-archive-pause-original-idle.log/.exit`: 1/1, exit 0, 29.083
seconds including setup/pause/restart, with its original wait budget.
Earlier `close-narrow2`, `close-narrow3` and `ask-closure4/5` failures remain
failed. The temporary checkpoint observer initially queried the wrong table;
the final observer uses `user_tasks` for result/checkpoints. No other named
case's fix or timeout is mechanically transferred to the retry case.

### Actual compiled Docker/native/Hindsight combination

The new opt-in runner is `apps/server/test/fixtures/policy-native-recovery.ts`:

```sh
MOTE_CONTAINER_VALIDATION_IMAGE=mote-recovery7-validation:policy-2699d1f7 \
node --import tsx --test --test-timeout=600000 \
  apps/server/test/fixtures/policy-native-recovery.ts
```

`/tmp/mote-policy-archive-compiled-joint5.log/.exit` records 1/1, no fail/skip,
actual exit 0, 218.249 seconds, clean source freeze `371bd186`. Runner SHA-256:
`95ee0c0f0f25c03d4d2263f6e97f3dad6cd9a72b2de8561002825d19c8736f4e`.
The new image is
`sha256:45ba7b69cb72ae419cf5b69e6ed191767baa87ac7ac3a9d73059e9a61a8b7c38`.
It overlays freshly compiled Server2699 and unchanged backup scripts on the
verified installed a2 dependency image, with `--pull=false --network=none`;
no dependency is installed/downloaded. Both new compiled module files were
hashed inside the image and match the host build byte for byte. Build/input/hash
receipts use `/tmp/mote-policy-archive-compiled-{build,image-build,image-inputs,files}`
and `/tmp/mote-policy-archive-compiled-image-files.json`.

The real compiled HTTP host exports complete applied-plan history and bindings,
reprocesses under a new current policy, merges the older personal archive while
preserving current binding/control/settings/authority, deletes the original and
reconstructs its missing historical plan under a fresh generation. B remains
readable. Production stopped backup/restore then carries that actual state,
generic issued/unknown fact and two owner-scoped native providers in **one**
whole-instance archive, through both native and production Docker restore.
Plan/binding/control rows round-trip exactly. Old HTTP credentials reject,
all prior task grants are revoked, issued/unknown fields and unacknowledged
native operation journals remain unchanged; no grant, confirmation or physical
settlement is fabricated.

Historical native canonical bodies are generated SQL fixtures in the actual
migrated host/PostgreSQL schemas. Package/instance/snapshot and model-descriptor
setup use the real compiled plugin and M04 APIs; only external release bytes
are fake. This does not claim semantic retain/publication or a successful native
capability probe. Real pinned Hindsight API, PostgreSQL, tar/whole-instance
backup, fresh native volumes and compiled ManagedHindsight/HindsightEngine run.
Four exact canonical reads across A/B and both restore paths succeed, wrong
namespaces return no body, old API tokens reject, runtime identities rotate,
automatic workers stay disabled and model-call count is zero.

Earlier runner logs `compiled-joint1..4` retain actual failures: empty DELETE
with a JSON Content-Type, treating a backup package as a live vault, wrong
synthetic instance-fingerprint encoding, and a descriptor helper using the image
UID rather than the restored profile UID. These were runner corrections, with
no production changes. In the fourth run, two freshly restored native volumes
escaped the first cleanup ledger. They were independently identified by exact
generated namespace hashes matching that failed runner's paths, verified
unmounted and removed; `/tmp/mote-policy-archive-joint4-cleanup-proof.json` records
both. The final runner discovers published native descriptors before cleanup,
and `/tmp/mote-policy-archive-joint-final-receipt.json` verifies zero remaining
owned volumes/containers plus matching compiled file hashes.

Before the next full gate, actual no-network/no-model native-constructor smoke
passes under its exact executable `/opt/homebrew/Cellar/node/26.11.1/bin/node`,
Node26.11.1/ABI147. Both root and mem0 resolve the working local
`node_modules/better-sqlite3/lib/index.js`. The image separately passes under
`/usr/local/bin/node`, Node24.22.0/ABI137, resolving `/app/node_modules` for both.
Full resolved paths and constructor read/write receipts are in
`/tmp/mote-policy-archive-node-abi-smoke.json` and
`/tmp/mote-policy-archive-image-abi-smoke.json`; both exit markers are 0.
No binary is copied between those environments.

The final required command is rerun once after these narrow closures and this
joint recovery. Its distinct evidence prefix is
`/tmp/mote-policy-archive-close-required`; the preceding complete failed gate and
all untouched-a2 RED remain unchanged. Final client union and later Joint
contracts remain separate; this phase proves the bounded complete module2699.
