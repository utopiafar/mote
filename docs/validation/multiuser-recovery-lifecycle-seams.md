# Independent recovery and data lifecycle seams

Final bounded test leaf: `dc2b0801f885a174d120478157d150d7bab439e0`.
Production runtime remains the exact Joint `2528a67d` tree. The new four cases
pass three consecutive rounds (12/12); the complete focused recovery combination
passes 103/103 after a test-observer connection correction. Actual current-runtime
Docker production recovery and managed Hindsight recovery also pass. The complete
required gate is **not accepted**: the original call was interrupted after seven
emitted failures, and its resumed Server segment exits 1 with five failures.
These outcomes and their code versions are kept separate below.

## Frozen scope

This lane uses its own clone, feature branch, generated accounts, SQLite files,
loopback ports and randomly named Docker resources. Main and integration were
both remotely verified at `6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed` with
`git ls-remote origin refs/heads/main refs/heads/codex/mote-multiuser-integration`.
The same base commit was independently resolved with the connected GitHub API.

The consumed Joint PREP is `2528a67d48e5c1ab8f44fc89e521eab1d0f6e2bd`;
its latest runtime change is source-incarnation repair
`519dc3f5ec9daa3aac61759c6c0c090942ffbad0`. New tests are committed separately as
`942995ef0e2ef1b0f012f461b28e317f376fc571`. They change no production code.
Follow-up `dc2b0801` changes only the read-only test observer's SQLite busy wait.
This is a bounded combination, not final acceptance of all clients or modules.
The [Joint contract](multiuser-joint-validation.md) and
[lifecycle contract](../design/multiuser-lifecycle.md) retain their open items.

## New durable cases

| Case | Actual path and assertions |
| --- | --- |
| Issued external call → SIGKILL → restart | Real listening production `buildApp`, HTTP credentials and task routes, SQLite, executor, external issuance journal, checkpoint and a separate held HTTP endpoint. Kill only the owned child; expire only its generated DB lease. Replacement blocks the unknown parent and dependent, rejects ordinary retry and foreign confirmation, and does not issue again. Explicit owner consent produces a different issuance, reuses the completed local checkpoint, retains the old unknown fact and allows the dependent to finish after explicit retry. |
| Cancel → late ACK | Cancel through the real HTTP route while the external HTTP reply is held. The returning old callback cannot complete its issuance or publish a result; B completes independent work. |
| Account disable → late ACK | Disable A through the administrator HTTP route while its call is held. The callback is rejected, A loses ordinary access, its result remains absent and the issued fact survives; B remains usable. |
| Personal export → file forget/reimport → personal merge → restart | Full same-deployment/same-account portable export/import. Merge cannot rewind the newer file generation, renew an old original ticket or apply an unsent old delete operation. A previously admitted delete repeats its fixed receipt without deleting the replacement. Repeated import is idempotent and B's equal-ID file remains readable. |

Only external I/O and task-specific generated work are fixtures. The runtime,
authority, journal, HTTP transport, SQLite and lifecycle ordering are real. This
is not a live model, calendar mutation, native UI or physical-device result.

## Executed evidence

The final focused combination uses installed Node `v26.11.1`, which matches the
already installed `better-sqlite3` ABI 147. All logs contain generated data only.

| Command / evidence | Actual result |
| --- | --- |
| `node --import tsx --test --test-concurrency=2 --test-timeout=60000 apps/server/test/multiuser-recovery-portable-file.test.ts apps/server/test/multiuser-recovery-http-seams.test.ts`; `/tmp/mote-recovery7-seams-final.log` | 4/4, no skips, exit 0. This earlier new-case run used Node 24 without invoking native Mem0. |
| Node 26 focused combination below; `/tmp/mote-recovery7-neighbors-node26.log` | Original `942995ef` run: 103/103, no skips, exit 0, 67.141 seconds. |
| Same focused combination after probe-only `dc2b0801`; `/tmp/mote-recovery7-neighbors-probe-fixed.log` and `.exit` | 103/103, no skips, actual exit 0, 80.321 seconds. |
| Three consecutive runs of the two new test files after `dc2b0801`; `/tmp/mote-recovery7-probe-fixed-repeated.log` and `.exit` | Each 4/4, 12/12 total, no skips, actual exit 0. |
| `node --import tsx scripts/validation/hindsight-recovery.ts`; `/tmp/mote-recovery7-hindsight-current.log` | Actual Docker and fixed Hindsight native API startup/restore, current `ManagedHindsightRuntime` reopen and canonical reads: PASS, source `942995ef`. Two canonical bodies, unknown operation retained, identity rotated, old API token rejected, unsafe tar rejected before volume creation, automatic worker disabled, zero external model calls. Canonical setup is generated SQL in the actual migrated provider schema. |
| `MOTE_CONTAINER_VALIDATION_IMAGE=mote-recovery7-validation:2528 MOTE_CONTAINER_VALIDATE_STARTUP=1 node --import tsx scripts/validation/container-recovery.ts`; `/tmp/mote-recovery7-container-current.log` | Actual Docker production default CMD startup, restore and restart: PASS, source `942995ef`. Two clean shutdown cycles; A/B identities and equal capture IDs remain isolated; two exact original bodies retained; old credentials and task grants not revived; unknown external journal unchanged; occupied valid volume preserved and corrupted package rejected before Docker admission. |

Focused Node 26 command:

```sh
node --import tsx --test --test-concurrency=3 --test-timeout=120000 \
  apps/server/test/multiuser-recovery-http-seams.test.ts \
  apps/server/test/multiuser-recovery-portable-file.test.ts \
  apps/server/test/multiuser-execution-retry-hook.test.ts \
  apps/server/test/multiuser-file-attachments.test.ts \
  apps/server/test/multiuser-portable-import.test.ts \
  apps/server/test/multiuser-file-source-incarnation.test.ts \
  apps/server/test/multiuser-file-forget-decision.test.ts \
  apps/server/test/multiuser-instance-backup.test.ts \
  apps/server/test/multiuser-backup-actions.test.ts \
  apps/server/test/multiuser-container-backup.test.ts \
  apps/server/test/hindsight-backup-admission.test.ts \
  apps/server/test/hindsight-checkpoint.test.ts \
  apps/server/test/hindsight-runtime.test.ts
```

These reuse delivered M12/M16/Container cases. They include failed nested
parent/child retry preparation rolling back unknown consent, grants and Operations
atomically; delayed attachment processing after parent/source/head retirement;
eventual physical pin release; fresh attachment/image authority after recreation;
same-ID source/Capture retirement; native stopped recovery of a **nonzero** file
incarnation; complete personal merge and rollback; native Mem0 canonical bodies;
unknown Actions facts; provider checkpoint cleanup and Hindsight backup admission.

The current Docker image reuses installed immutable dependency layers from
`sha256:2e0a192ec624a902d9396a1b0308782a0018a6c02e3af70e279e3f526563d48b`.
It overlays current compiled Server/Web/Shared/Agent/skills and backup/schema
scripts only. It is **not** a fresh dependency installation or a test of the
repository Dockerfile's dependency download. Runtime source is exactly `2528a67d`;
the image ID is
`sha256:50fd77030d446bf6af30f2cd35702d305e8ad059209dfa5362a3cd16cca0c076`.
Build evidence: `/tmp/mote-recovery7-image-build-local-base.log` and generated
runtime input hashes `/tmp/mote-recovery7-image-input-hashes.json`.
No pull or model-weight download was performed. Container and Hindsight runners
cleaned only their own resources. A subsequent filter for this Container run's
unique label returned no containers or volumes.

The current Docker restore validates the mandatory current schema, including
`ig_file_generations`. Its generated counters are empty. The **nonzero** counter
round trip is the independent native case above; this document does not combine
those into a claim that a nonzero Docker counter or one app-plus-Hindsight backup
was exercised.

## Required gate and earlier attempts

`npm run check:affected -- --base 2528a67d48e5c1ab8f44fc89e521eab1d0f6e2bd`
uses Central scope for this test-only delta. The Node 26 invocation in
`/tmp/mote-recovery7-affected-node26.log` was interrupted before a terminal result.
The execution session stopped being addressable; read-only inspection then found
no original root/descendant PIDs or log holders. The last output is inside
`multiuser-memory.test.ts`, without a summary or exit code. It is not a passed
gate or an invented known exit status. Seven already emitted failures remain
failures, independently of the execution interruption.

At the same unchanged `942995ef` test/runtime tree, resume starts from that
interrupted file, then the remaining 98 sorted Server test files. The exact
99-file list is `/tmp/mote-recovery7-server-resume-files.txt`; output and actual
exit are `/tmp/mote-recovery7-server-resumed.log` and `.exit`. Web is separately
resumed in `/tmp/mote-recovery7-web-resumed.log` and `.exit`. Web completed
515/515, zero skips, actual exit 0 in 107.406 seconds. Server at `942995ef`
completed 691 total: 685 pass, 5 fail, 1 existing opt-in skip; actual exit 1 in
433.825 seconds. Its five failures and the observer correction are recorded below.
Already completed builds/types, Shared/Agent and the independently
completed Central runner/release tools are reused. No healthy process was
stopped or duplicated to resume. The original seven REDs are not erased by
resuming later files, and whole-candidate acceptance remains false.
It already contains one existing test timeout: `memory-delegation.test.ts`,
`a thousand generated originals drain bounded catalogs with complete independently
reviewed coverage`, 121556 ms against its own unchanged 120000 ms limit.
The unchanged selected case passes 1/1, no skips, exit 0 in 81915 ms:

```sh
node --import tsx --test \
  --test-name-pattern='a thousand generated originals drain bounded catalogs' \
  --test-timeout=150000 apps/server/test/memory-delegation.test.ts
```

`/tmp/mote-recovery7-thousand-exact.log` preserves that exact rerun. The outer
150000 ms runner bound does **not** change this case's explicit 120000 ms limit.
The selected pass does not erase the required-gate failure. A resource sample
showed 18 logical CPUs, 76% system memory free and zero throttled pages; it did not
establish whole-machine saturation. No other lane was stopped or throttled.
Read-only inspection of the owned gate process tree confirmed subsequent test
files were running while earlier-file output was buffered. This is a suite timing
failure so far, not a reproduced canonical-data/authority assertion defect.
The committed-delta dry-run plan is also retained in
`/tmp/mote-recovery7-affected-committed-plan.log`; runtime and test files have no
diff against `942995ef` after this invocation started.

A second existing failure is independently reproducible without changing code:

```sh
node --import tsx --test \
  --test-name-pattern='actual model proposals paginate without gaps' \
  --test-timeout=120000 apps/server/test/multiuser-actions-catalog.test.ts
```

`/tmp/mote-recovery7-actions-catalog-exact.log` is 0/1, exit 1:
`actual action job for other-source: false`, from the fixture's 15000 ms
`waitForState` deadline. A temporary copy of this runner adds only read-only
observations around that existing failure. It records one completed source job,
the other pending with an `actions.extract` task still running, and no public
progress error. A second observation keeps the original error, permits the real
task to continue and then **throws that same error**: the second job completes
19322 ms after the original failed wait, both jobs become completed and progress
is no longer running or errored. Evidence:
`/tmp/mote-recovery7-actions-catalog-diagnostic.log` and
`/tmp/mote-recovery7-actions-catalog-observe.log`.

This confirms a reproducible fixture readiness failure, rather than a permanently
stuck job or a demonstrated data/authority assertion defect. The catalog's later
pagination assertions were not reached in these failing runs; eventual job
completion alone is not counted as their pass. No common Actions runtime or
global timeout was changed. The existing durable case and exact commands are
the handoff to Joint/M12 for a bounded fixture-budget decision.

M08 also exhibits fixture completion timing failures in the full suite:
`parent cannot cite a successful child handle or prior-fragment originals without
current disclosure` and `pause/resume and restart preserve successful child
checkpoints and replace cancelled generation authority`.
The first original case independently fails at its existing 20000 ms Ask wait
while event receipts show ongoing child/model validation, rather than an
accepted forbidden citation: `/tmp/mote-recovery7-ask-citation-exact.log`, 0/1.
A temporary copy adds a failure-only observation around those original waits
without changing their 20000 ms deadlines. With both cases selected, they pass
2/2 in 50.434 seconds, including the original citation, child-start count and
retained child-checkpoint assertions; neither failure-only observation executes.
That is instrumented-copy evidence (`/tmp/mote-recovery7-ask-observe.log`), not a
new passed full gate or a claim that the earlier original invocation passed.
No M08 product code or original test is modified. These timing-sensitive cases
are retained for Joint/M08 fixture review; no confirmed authority violation is
inferred from a completion wait expiring.

The full suite also fails the existing `multiuser-file-controls.test.ts`.
An unchanged standalone rerun is 0/1, exit 1:
`/tmp/mote-recovery7-file-cancel-exact.log`. At line 25 it expects generic retry
of the still-physically-active cancelled ASR child to return 200, while the
actual response is 409 `task_retry_invalid`. Read-only diagnostics confirm it
selected the correct original, the child is cancelled with an issued external
fact, and the File remains `canCancel:false, wait:running`.
`/tmp/mote-recovery7-file-cancel-diagnostic.log` retains that RED and safe state.

A temporary diagnostic continuation **retains the original assertion error**,
checks the actual 409 and executes every remaining original assertion. They all
pass: the old physical call settles without publication; B and another A file
finish; cancellation prevents automatic revival; personal export includes the
exact cancellation intent; an invalid owner link fails import; same-account
import retains cancellation; real app restart and stopped backup/restore retain
the original and cancelled state; old login fails; a new explicit File retry
issues one new ASR call and publishes; retry receipt replay adds no call or old
task revival. It records `remainingOriginalAssertionsPassed:true, asrCalls:2`
and then throws the retained error, so its result remains 0/1, exit 1.
Evidence: `/tmp/mote-recovery7-file-cancel-continuation.log`.
This bounded continuation differs only at the old generic-retry expectation;
it does not prove that generic retry was acknowledged while physically active.
The current physical fence contract supports rejection. Joint should resolve
this test expectation explicitly rather than weaken production fencing.

The binary private-route/CSRF case in `multiuser-auth.test.ts` also fails in the
full suite. Its raw suite evidence is handed to the cross-user/Joint scope;
this lane does not duplicate the other E2E lane's common authentication repair.

### Seven emitted failures before interruption

All seven below are from candidate `2528a67d` plus test-only `942995ef`, with
locked dependencies copied and host Node 26 selected. They are distinct from
earlier sandbox/missing-dependency/ABI setup failures.

| Exact test title | Classification and reproduction |
| --- | --- |
| a thousand generated originals drain bounded catalogs with complete independently reviewed coverage | Full-suite 120 s timeout; original selected case passes 1/1 in 81.9 s. |
| actual model proposals paginate without gaps and the read-only catalog filters all sources before its limit | Original selected 0/1: `actual action job for other-source: false`, fixture 15 s wait. Observation after the original error shows natural completion 19.3 s later; original RED retained. |
| parent cannot cite a successful child handle or prior-fragment originals without current disclosure | Original selected 0/1: `Ask timeout`, still running at the fixture's 20 s wait. Failure-observation copy paired with the next case passes 2/2 within unchanged original waits; observation branch not used. |
| pause/resume and restart preserve successful child checkpoints and replace cancelled generation authority | Full-suite failure; original detailed error unavailable after interruption. Paired observation-copy original assertions pass; no separate unchanged failing reproduction. Classification remains provisional. |
| failed real child retries only its own model branch while successful checkpoints remain single-use | Full-suite failure at 21.79 s; detailed error unavailable after interruption; not independently reproduced or classified. |
| authentication composes with a binary private route while Cookie mutations still require CSRF | Full-suite failure at 339 ms; detailed error unavailable after interruption; not independently reproduced or classified. Cross-user scope handoff. |
| original Files cancel fences the held recording without cancelling another A file or equal-ID B and survives restart | Original selected 0/1: line 25 expects 200, gets 409 `task_retry_invalid` for the correct still-active cancelled child. Failure-preserving diagnostic continuation passes every later original assertion, including stopped restore and fresh File retry. |

### Resumed Server failures and the lane's observer correction

The 99-file resume is a **stage result at `942995ef`**, not a replacement for an
uninterrupted gate. It emits these five failures:

| Exact test title | Actual failure / scope |
| --- | --- |
| real M03 intake automatically admits a durable pipeline while its receipt still attests only reception | `multiuser-processing.test.ts:82`: task-kind array contains an extra `memory.materials`. Not independently rerun or classified as a production duplication defect. |
| processing rejects missing/forged identity, malformed inputs, foreign originals and unknown formats without partial publication | `multiuser-processing.test.ts:96`: response is outside expected `[400,401]`; original assertion does not print the actual status/input case. Not independently rerun; contract review remains with Joint/M06. |
| caught nested admission failure rolls back every child row while the publishing Material transaction succeeds | `multiuser-processing.test.ts:272`: the same extra `memory.materials` in task kinds. This does not itself prove a leaked failed child or broken transaction; Joint/M06 must inspect the changed admission contract. |
| late external HTTP ACK cannot publish after disable | This lane's observer SELECT races a real child-process writer: `SQLITE_BUSY`, errcode 5, `database is locked`. HTTP revocation/late-callback checks have already run. Corrected in `dc2b0801`, as detailed below. |
| Web feature metadata describes real routes and Library keeps owned canonical material/source paging | `multiuser-web.test.ts:78`: `do not advertise absent legacy runtime`. Not independently rerun; metadata/runtime expectation review remains with Joint/Web. |

The lane's sole correction adds connection-local `PRAGMA busy_timeout=5000` to
its **read-only test connection**, matching `scope/storage.ts`. It does not
change application SQLite behavior, assertions, production task authority or
public timeouts. The actual RED remains in the resumed log. After this correction,
three real HTTP/SIGKILL/import rounds pass 12/12 and the complete focused set
passes 103/103. The post-correction scope-plan dry run is
`/tmp/mote-recovery7-probe-fixed-scope.log`; it is explicitly only a plan, not an
executed full gate. The complete required gate has **not** been rerun at the new
test leaf, and final uniform acceptance remains pending with the module owners.

The `&&` stages following the failed workspace test command were independently
covered without changing the failed gate result: Central supervisor runner exit 0
(`/tmp/mote-recovery7-central-runner.log`), release tools 52/52, no skips, exit 0
(`/tmp/mote-recovery7-release-tools-host.log`). The first restricted release-tool
attempt also hit local `listen EPERM` and remains a failed environment attempt.

Earlier attempts are retained, not reclassified as passes:

- Default sandbox local `listen` returned `EPERM`; approved host execution ran
  the same generated loopback cases. `/tmp/mote-recovery7-http-initial.log` and
  `/tmp/mote-recovery7-neighbors.log` are environment failures, not product REDs.
- The first affected run lacked copied server-nested `mem0ai/oss`; the existing
  locked nested dependencies were independently copied without changing peer
  directories or installing a new dependency. `/tmp/mote-recovery7-affected.log`.
- A Node 24 recovery-neighbor run reached 65/66; native Mem0 could not load the
  installed SQLite ABI 147. Direct native-module probes established the ABI
  mismatch. Node 26 resolves it, including the same native Mem0 case, in 103/103.
  The obsolete Node 24 broad gate was stopped after verifying its root cwd and
  descendant process tree belonged only to this checkout.
- The initial image overlay build used an image ID in `FROM`, which BuildKit
  parsed as a remote repository and rejected. The existing local tag's full
  immutable ID was checked before the successful `--pull=false --network=none`
  build. No dependency layer was downloaded by these attempts.

## Handoff and remaining limits

No new confirmed product defect was found in the four added seams; the observed
test-only SQLite race was corrected without a production fix. The two minimal
test commits `942995ef` and `dc2b0801` are cherry-pickable for Joint, published on
`codex/mote-recovery-lifecycle-validation`. Integration was remotely verified at
the baseline. Opening this composed
branch as another integration PR would repeat the full upstream module stack,
so this lane has not opened a duplicate all-stack PR.

The attempted Joint message returned `earlier turn submission is not yet
confirmed`, and the parent status message returned `thread not found`. Neither
is claimed delivered or blindly retried. This document, commentary and
`/tmp/mote-recovery7-handoff.md` preserve the handoff.

Final M13/M15/Desktop consumer candidates, profiles/rules and image-profile
execution are not frozen here. The eventual unified candidate must rerun this
lane. No real central data or derived private artifacts were used; no merge,
deployment, CI enablement, existing service cleanup or live inference occurred.


## Follow-up: failure classification and nonzero Docker counters

The frozen test/runner leaf is `f09e4f312285075263a1e994d31fa46e6b3be64d`.
Its production tree remains identical to candidate `2528a67d`; `git diff
2528a67d HEAD --name-only` lists only tests, their helper, this report and the
new opt-in runner. Earlier failures and gate outcomes above remain unchanged.

| Original failure | Follow-up evidence and disposition |
| --- | --- |
| Automatic Processing admission and caught nested admission expect four tasks | Unchanged originals reproduce 0/2. A diagnostic continuation retains both original errors, then proves the two `memory.materials` tasks have the same capture/hash with distinct operations. `MemoryCaptureMaterials.bind` enqueues ingress intake and subsequent M06 publication separately. All failed-child, orphan task/grant/resource/operation, fairness and progress counts are zero; five legitimate tasks have five grants and sequence 5. This is an obsolete fixture count, not demonstrated rollback leakage. |
| Processing malformed `../../private` expects 400/401 | Peer preserves the exact 404. `Originals.original` rejects the invalid digest with `missing()` before a filesystem read; this matches the foreign/absent private-object 404 contract in `docs/design/multiuser-private-data.md`. The other malformed/forged cases retain their existing expectations. |
| Files cancel expects generic child retry 200 | A cancelled coordinator cannot be restored by retrying its cancelled child. The frozen Files contract fences live calls. Original RED and a continuation retaining its error prove that all subsequent late-ACK, A/B, import, restart, stopped restore and fresh explicit retry assertions pass. The test now expects 409 and checks both original parent and child stay cancelled. |
| Ask failed-child branch retry | Unchanged exact original passes 1/1, 14.450 seconds, with its original 20-second wait: `/tmp/mote-recovery7-ask-failed-child-exact.log/.exit`. The broader failure remains recorded; no production defect is inferred from that run alone. |
| Ask pause/resume/restart | Unchanged exact original passes 1/1, 20.265 seconds for the whole multi-phase case, retaining the original per-wait budget: `/tmp/mote-recovery7-ask-pause-exact.log/.exit`. No assertion or wait duration was changed. |
| Web legacy Imports metadata and binary auth | Cross-user lane owns these, so this lane did not repeat them. That lane reports the Web metadata assertion obsolete after scoped Imports restoration. It separately retains a production auth RED: the global octet-stream parser admits only PUT Imports, making private binary POST return 400 `invalid_data` instead of native A200. Its evidence is `/tmp/mote-crossuser-repaired-narrow.log/.exit`; the auth fix belongs to Joint/M01/M03. |
| Plugin stop/delete physical process retirement | Cross-user lane reports two unchanged reproducible REDs, `/tmp/mote-crossuser-processing-plugin-repro.log/.exit`. They were not duplicated or fixed here. |

Exact unchanged Processing reproductions are preserved at
`/tmp/mote-recovery7-processing-three-exact.log/.exit` (0/3, exit 1).
The diagnostic continuation is `/tmp/mote-recovery7-processing-diagnostic.log/.exit`
(0/2, exit 1, both original errors retained; subsequent atomic absence checks pass).
After the four fixture corrections, the exact final committed checks are:

- `/tmp/mote-recovery7-fixtures-final.log/.exit`: 7/7, no skips, exit 0,
  14.286 seconds. This includes the full Files cancel/import/restart/stopped
  backup/restore journey and the three neighboring atomic Material hook cases.
- Server noEmit: `/tmp/mote-recovery7-fixture-types.log/.exit`, exit 0.
- Scripts noEmit after importing the real Files fixture:
  `/tmp/mote-recovery7-generation-script-types-fixed.log/.exit`, exit 0.
  The first scripts attempt exposed the helper's `unknown` payload typing;
  `/tmp/mote-recovery7-generation-script-types.log/.exit` retains exit 2.
  A test-only `InjectOptions` payload annotation resolves it without changing
  the fixture's runtime input or the production app.

The new `scripts/validation/recovery-file-generation-container.ts` closes the
previous **nonzero counter Docker** gap using only generated bodies, original
production APIs, an existing fixed production image and its own labelled volumes.
It passes from clean `f09e4f31`, 1/1 with no skips, exit 0, 9.777 seconds:
`/tmp/mote-recovery7-generation-container-final.log/.exit`.
Its runner SHA-256 is
`f821f4eaec52922763dea8e3246b09afbb95fbac9eed904ff4c55758a69ba2f9`.
The exact command is:

```sh
MOTE_CONTAINER_VALIDATION_IMAGE=mote-recovery7-validation:2528 \
MOTE_RECOVERY_CANDIDATE=2528a67d48e5c1ab8f44fc89e521eab1d0f6e2bd \
node --import tsx --test scripts/validation/recovery-file-generation-container.ts
```

The production image remains
`sha256:50fd77030d446bf6af30f2cd35702d305e8ad059209dfa5362a3cd16cca0c076`.
A real file forget/allow advances generation 0 to 1; real source deletion and
same-ID upload advance it to 2. Both old tickets already fail under the original
credential before backup. Stopped backup/profile restore then starts the normal
production container twice: generation stays 2, four stale first-send DELETEs
return 409, fresh tickets read exact bytes, cross-owner ticket reads return 404,
and equal-ID B remains readable with its independent generation 0. A new explicit
A deletion advances to 3; a second stopped readback preserves that counter and
B's original. The container and every created volume were removed after label
checks. No pull, fresh dependency install, model call or existing instance was used.

This supplements the earlier Container and ManagedHindsight results; it still
is not one combined app-plus-Hindsight archive. The 103-case set has not been
rerun at `f09e4f31`, and the full required affected gate is still **not accepted**.
The declared Joint candidate remains bounded `2528a67d`, with final public/client
freeze pending. These new results do not promote that candidate to whole acceptance.


## Bounded parser composition: f6889867

A newly declared independent consumer freeze,
`/tmp/mote-parser-public-freeze.md`, contains the exact lineage
`2528a67d` → tests `69243430e8db26856b3d91c70044821e31894962` → owner fix
`caf0551975fac56347f5e944d2a7e3b7a06f61f8`. The verified local owner repository
was fetched read-only; no peer files were edited. This lane merged only that
three-file freeze into its own feature, producing clean composed candidate
`f688986723bb0109f0c10b67f47d3df5cba2cc41`. The original owner retains the
production fix; this lane made no independent shared-backend repair. The new
production delta over `2528a67d` is only `scope/ingress-routes.ts`.

This supersedes the **unfixed binary parser** status above. The parser owner's
41/41 auth/Imports/ingress result belongs to its exact `caf05519` source and
`/tmp/mote-parser-standalone-green.log/.exit`; it is separate peer evidence.
Joint review was requested but remains unconfirmed. No owner-review acceptance,
new whole Joint freeze or all-module acceptance is inferred from this composition.
No Web cache, policy, configuration relogin, plugin, theme or client WIP was taken.

Fresh execution from the same clean composed `f6889867` is:

| Check | Exact current result |
| --- | --- |
| Previous 13-file recovery set plus full Files controls journey | 104/104, 0 skips, exit 0, 97.248 seconds; `/tmp/mote-recovery7-parser-composed-focused.log/.exit`. |
| Six Processing admission/malformed/atomic-hook cases | 6/6, 0 skips, exit 0, 20.640 seconds; `/tmp/mote-recovery7-parser-processing-fixtures.log/.exit`. These six are distinct from the 104 cases. |
| Server production compile | Exit 0; `/tmp/mote-recovery7-parser-composed-build.log/.exit`. |
| Scripts noEmit | Exit 0; `/tmp/mote-recovery7-parser-composed-script-types.log/.exit`. |
| New existing-dependency image overlay | Exit 0; `/tmp/mote-recovery7-parser-image-build.log/.exit`; current compiled Server replaced in an independently copied context. Input file hashes: `/tmp/mote-recovery7-parser-image-input-hashes.json`. |
| Actual stopped instance/container restore and production restart | PASS, exit 0, two clean startup/shutdown cycles; `/tmp/mote-recovery7-parser-container.log/.exit`. |
| Actual nonzero-generation container restore | 1/1, 0 skips, exit 0, 17.724 seconds; `/tmp/mote-recovery7-parser-generation-container.log/.exit`. Clean candidate and unchanged runner hash are in its JSON receipt. |
| Actual native ManagedHindsight restore | PASS, exit 0; `/tmp/mote-recovery7-parser-hindsight.log/.exit`. |

The newly compiled production image is
`mote-recovery7-validation:parser-f6889867`, immutable ID
`sha256:b1b99e099553e8bcb02ea2b2f7fbb6e105cb6635e88a238c9d2fa48612a7c92f`.
Its source label is the exact composed candidate. The trusted dependency base
remains `sha256:2e0a192ec624a902d9396a1b0308782a0018a6c02e3af70e279e3f526563d48b`;
image creation used `--pull=false --network=none` and no install or download.
The ordinary container runner retains two equal-ID A/B originals, unknown facts
and identities while retiring old credentials/task authority, rejecting corrupt
archives before Docker and preserving an occupied valid volume. The generation
runner retains the 0→1→2→3 sequence, current bytes, old-intent and ticket fences,
and B isolation through actual compiled startup and stopped readback. Native
Hindsight restarts its real offline API, reopens the managed runtime, verifies
two generated canonical bodies, rotates runtime identity and rejects old tokens;
unknown operation facts persist and external model calls remain zero.
All three Docker runs use independent random names/volumes and clean only their
own labelled resources. They ran concurrently without observed test failures;
no claim about absence of all-machine resource contention is made.

The opt-in commands were the previously recorded commands with
`MOTE_CONTAINER_VALIDATION_IMAGE=mote-recovery7-validation:parser-f6889867`,
`MOTE_CONTAINER_VALIDATE_STARTUP=1` for `container-recovery.ts`, and
`MOTE_RECOVERY_CANDIDATE=f688986723bb0109f0c10b67f47d3df5cba2cc41` for the
nonzero-generation runner. `hindsight-recovery.ts` ran directly from clean
`f6889867`. No old-image result is attributed to this new production source.

The peer has also corrected its plugin status: transparent PID observation
passes 2/2 in 3.799 seconds, while the old 10-second RED is unresolved. Joint is
investigating an async marker open/write → empty string → PID 0 process-group
probe false-negative. Those observations are **not a confirmed production
process-retirement defect** and have not been independently rerun here.

The full affected gate remains unaccepted; it has not been rerun at `f6889867`.
Final M13/M15/Desktop and later Joint configuration/policy/profile changes are
outside this bounded candidate. The lane continues tracking the next declared
uniform candidate. The single combined app-plus-Hindsight archive boundary is
still not claimed; native and app container restore are separately exercised.


Six additional existing file-lifecycle neighbors pass 6/6, no skips, exit 0,
26.444 seconds: `/tmp/mote-recovery7-parser-file-lifecycle-neighbors.log/.exit/.sha`.
The exact checkout was documentation-only descendant
`e815c15a1b73f8ac65600ce1843f92c9dff46cb7`; its production and test files are
identical to clean runtime candidate `f6889867`. These distinct cases retain
admitted processing after logout, reject an old personal archive while forgotten,
mint a new allow decision during data-only restore, preserve other owners,
defer held exact pins, retire held transport, require fresh same-byte admission
and reject parentless old task authority. No new regression code or production
change was needed. The bounded cohort is therefore 104 + 6 + 6 = 116 distinct
cases across three commands, all passing; this is still not a full affected gate.

## Frozen policy checkpoint: a2cbf3aa

The resumed lane consumed only Joint runtime
`a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695`, with `2528a67d` verified as an
ancestor. Composition `1357b5e119fb3d2bf83deb2120e3ce458e8fe256` has no production
diff from that checkpoint. Later Joint HEAD and its root/Imports work were not
consumed. The limited contract is
[multiuser-file-processing-contract.md](../design/multiuser-file-processing-contract.md).
This phase adds tests and a generated-only Docker runner, with no backend repair.

| Current-checkpoint seam | Evidence and actual result |
| --- | --- |
| Retired configuration cache after relogin; scalar/service changes; genuine disabled automatic originals; restart/enable/manual cancellation; named raw-stage dependency cache | `/tmp/mote-recovery7-a2-new-lifecycle.log/.exit`: six cases, 6 pass, 0 fail/skip, exit 0, 14.983 seconds. |
| Admitted work after logout and late-publication fencing; named policy change cannot replay an unknown physical call | `/tmp/mote-recovery7-a2-authority-neighbors.log/.exit`: three cases, 3 pass, 0 fail/skip, exit 0, 8.620 seconds. |
| Nonempty new policy tables through stopped native backup/restore and source reopen; old token/grant retirement; omission of each table rejected before target publication | New `multiuser-recovery-policy-lifecycle.test.ts`, first case. Exact immutable policy/plan/binding rows, A/B text and completed pipeline history survive. Missing-table copies have recomputed checksums and are still rejected. |
| Same-instance/same-account personal merge/restart preserves existing plans without new processing grants; repeated import; real account erasure removes A's three tables and preserves B | Same new file, second case. This is preservation of existing local plans, not complete applied-plan reconstruction from a personal archive. |
| Held named HTTP media call → logout/relogin → disable/enable → late ACK | Same new file, third case. Logout retains the admitted grant; disable creates a fresh genuine blocked coordinator with zero attempts; enable cannot replay the live physical request; even explicit unknown consent returns 409 while live. Old execution is cancelled and loses its fence. Only the fresh call's generated response enters chunks; B's local text succeeds independently. |
| Three new regression cases together | `/tmp/mote-recovery7-a2-policy-seams-verified.log/.exit`: 3/3, 0 fail/skip, exit 0, 36.297 seconds. |
| New compiled production image: nonempty policies/plans/bindings, stopped restore, two default-CMD startup/shutdown cycles, exact stopped readback, old credentials/grants retired, account erasure isolated | `/tmp/mote-recovery7-a2-policy-container.log/.exit`: 1/1, 0 fail/skip, exit 0, 26.797 seconds. All three tables initially have two rows, one per generated owner; first stopped readback equals all source rows; final readback retains only B's rows. |

The six-case command selected `multiuser-configuration-relogin-processing`,
`multiuser-processing-policy-settings-change`,
`multiuser-processing-policy-service-change`, and
`multiuser-processing-policy-stage-reuse` test files. The three-case neighbor
command selected `a new named policy cannot replay`,
`logout preserves admitted account work`, and
`Web logout keeps admitted background` from the policy-page, configuration and
execution files. Both used `node --import tsx --test --test-concurrency=2
--test-timeout=120000`. The new cases ran with concurrency 1 and the same timeout.
The opt-in Docker command was:

```sh
MOTE_CONTAINER_VALIDATION_IMAGE=mote-recovery7-validation:a2cbf3aa \
MOTE_RECOVERY_CANDIDATE=a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695 \
node --import tsx --test --test-timeout=240000 \
  scripts/validation/recovery-policy-container.ts
```

The 13 current-phase checks above all pass; this count is not added to the old
116 as a claim of globally distinct coverage. Old unchanged full cohorts were
not rerun. Server noEmit, fresh Server build and scripts noEmit all exit 0;
logs are `/tmp/mote-recovery7-a2-server-types.log`,
`/tmp/mote-recovery7-a2-server-build.log`, and
`/tmp/mote-recovery7-a2-new-runner-types.log`, each with its `.exit` file.

The new local image is
`sha256:0ac524104e57e93d561390539fd4a20da75af8f52cb94740bb1d97deaa89f82d`,
labelled with exact runtime `a2cbf3aa`. It overlays that checkpoint's freshly
compiled Server and current scripts on the existing immutable `f6889867` image
dependency layers, without pulling or downloading. Shared/Agent/Web source has
no delta between those runtime checkpoints. This proves the compiled Server and
backup scripts in that image, not a new dependency installation or final client
UI. Build log: `/tmp/mote-recovery7-a2-image-build.log/.exit`. Docker run identity
is `mote-recovery7-policy-772f0e7b-7076-43ab-937b-bf6ab6dd7527`; its randomly named
containers and volumes are cleaned after label verification. Execution checkout
was `1357b5e1` with the two new runner/test files uncommitted; their exact hashes
are recorded separately, rather than claiming a clean commit execution.

Early new-case failures were fixture/observer assumptions, not confirmed backend
defects: canonical policies supply the default diarization processor; task kind
belongs to `execution_steps`; intentionally damaged FK-linked tables require
foreign keys disabled only in the copied damaged fixture; missing tables may
fail integrity validation before catalog validation; cancelled execution loses
its fence without necessarily setting the durable authorization history bit.
Original logs remain in `/tmp/mote-recovery7-a2-new-table-seams*.log`,
`/tmp/mote-recovery7-a2-live-policy-seam.log`, and
`/tmp/mote-recovery7-a2-policy-seams-final.log`. Corrected assertions verify actual
old-fence retirement and exclusion of the retired ACK's text, rather than
requiring an invented revocation-bit contract. No newly confirmed production
defect required an owner handoff in this phase.

Actual personal export includes the configuration `filePolicy` graph. Its
processing payload contains annotations, artifacts, controls, derivations,
diarization, formats, imports, publications, reviews and steps, but no applied
plans/bindings. Complete applied-plan personal export/import/restore therefore
remains OPEN as declared by Joint; the passing merge case preserves existing
same-account rows and cannot close that gap. Shared/default model watching,
test-local/root/import/attachment overrides and custom recipes remain outside
the checkpoint. New tables combined with ManagedHindsight in one archive were
not exercised. Old actual Hindsight evidence retains its original SHA; no old
image or 116-case result is relabelled as `a2cbf3aa`. Full affected checks and a
uniform public-runtime plus final Web/Android/Desktop combination remain open.
