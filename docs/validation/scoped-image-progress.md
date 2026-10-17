# Scoped original image progress

This is a narrow ImageProgress handoff, not an M13 or Joint final freeze.
M13 explicitly authorized exact baseline
`9565bc7fbec0d0ee90ce47ed49d8f7df75af1abf`, including the declared Joint
`a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695` contracts. No later owner WIP was taken.
The PR targets `codex/mote-multiuser-integration`; no main merge or deployment.

## Boundary and wire

KEEP the original Files, LibraryBrowse and evidence-detail ImageProgress entry
points, five separate original/OCR/understanding/Material/Memory states, explicit
unknown confirmation and separate complete/recompute actions. CHANGE the missing
legacy route to a host-authenticated presentation of M03 originals, M05 tasks,
M06 publications and M07 intake/job receipts. REMOVE the assumption that an
original, OCR success or Material publication implies Memory completion.
EXCEPTION: external OCR/language transports in tests return generated responses.
UNKNOWN: this receipt does not establish real-model semantics or the later Joint
custom-profile/attachment processing chain.

`GET /api/images/:captureId` returns:

- `proof`, bound to deployment/user, original/hash, persistent original generation,
  processing control generation, applied policy and attachment generation;
- `original.state`, `automatic`, `understandingEnabled`, `enabled`,
  `processingRequired`, `policy`, `wait`, `canCancel`;
- `jobs[{name,state,error?}]` from the latest admission's original/file/settings/
  policy/attachment fences; no admission means no historical task scan;
- `products[{id,name,kind,text}]` and `materials[{id,state}]` from visible M06
  publications; `memory[{state,count,error?}]` from exact M07 material receipts.

`POST /api/images/:captureId/retry` requires
`{proof,operationId:UUID,mode:'complete'|'recompute',confirmUnknown:boolean}`.
It uses the existing M06 retry transaction, durable operation receipt, M05
physical-call/unknown checks and file-control fence. `complete` reuses successful
OCR and schedules only missing derivatives; fully complete work is a no-op.
`recompute` uses the existing fresh generation and calls the processors again.
The same operation ID/body recovers a lost admitted ACK. The Web stores only its
owner-bound command in `mote.image-retry.v1`, separate from file retry intent.

`POST /api/images/:captureId/cancel` requires `{proof}` and uses existing M06
cancellation. Source disable/deletion, foreign data and stale proofs reject before
new admission. Administration does not grant another user's private projection.
No second pipeline, scheduler, ledger, provider configuration or model store.

M03's existing `ig_file_generations` also records raw-image capture retirement
under reserved source key `@capture` (not a valid external source ID). The counter
survives capture/source deletion, so first GET → delete → identical raw ID/bytes
cannot revive an old proof, ticket or admitted M06 input. Account lifecycle already
erases this counter table. Existing Files forget/allow-again intent is unchanged.

## Acceptance evidence

Exact baseline RED: the original `FileDetail` with generated M03 image data
failed to expose its image progress controls and rendered
`scope_unavailable`. The identical journey passes with this thin fix.

`TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test
apps/web/test/multiuser-image-progress.test.ts apps/web/test/image-exclusion.test.ts`
exercises actual scoped application services and the original React components:

1. Original Files detail, generated same-ID A/B, genuine OCR and Material,
   admitted ACK loss/remount/replay, complete reuse, recompute, cancel, restart,
   A/B isolation, real list pagination/cursor ownership and source disable.
2. Account and selected-image changes, ignored aborts, delayed response and empty
   selection cannot publish old content or retain actionable old controls.
3. Raw screen (Files correctly returns 404), first GET/delete/same-ID reintake,
   persistent proof changes, unknown physical outcome/restart without replay,
   original UI checkbox confirmation, successful retry, deletion and B positive.
4. Real generated OCR and Anthropic transports: failed understanding is retried
   without another OCR call; all-success complete calls neither provider;
   recompute calls both. No helper-seeded success or numeric fake completion.
5. Existing metadata exclusion regression remains green.

Supported hidden IAB also used the built original Web UI: username/password →
Files list → image detail → complete; OCR and Material became ready while Memory
remained waiting. Switching through the original account settings to same-ID B
showed historical-unscheduled OCR and waiting Material, without A's result.
Generated fixture runner: `node --import tsx scripts/scoped-image-progress-browser.ts`.
Screenshot is local `../image-progress-iab.jpg` (generated-only, not private data).
ImageProgress source SHA256:
`57e0a4a44e606e77d599c34c48fe134a3b7c5c07937965043f1c8c5e9d286787`.

Independent review found and corrected: accidental audio recipe selection for
image reuse; historical success masking current work; redoing successful
understanding on complete; raw capture incarnation reuse; and attachment binding
proof omission. The last attachment change reuses the existing M03 binding only;
this does not claim later Joint attachment/profile WIP acceptance.

Scope inventory, production import boundary, `git diff --check`, focused tests,
Web/server type checks and `build:central` have passed during development.
The full required affected gate is recorded separately below when it terminates;
these bounded receipts are not a whole-platform final acceptance claim.

Source-withdrawal follow-up: the presentation binds its original through the same
owner/enabled-source condition as Files. A disabled source returns 404, allowing
the existing resource cache to erase denied data. The original Files regression
also holds the next read, refreshes, unmounts and remounts the same account/ID;
previous progress never reappears. A component-only denial latch was rejected in
review because it could lose that boundary on remount. Focused tests are 5/5 green.
Earlier broad runs are diagnostic/superseded, not final gate receipts: one lacked
the locked Electron binary; later source-withdrawal changes invalidated the old
snapshot. Only the final fixed-snapshot gate below is a delivery gate.

## Fixed-snapshot runtime receipts

Production/test snapshot: `4a7168f1bf42a153607bdeccd3e9412ac38ff2f7`
(on `9b037b9e3867618cd037030f2385683e85ddf0c2`). Independent review of
that final source-withdrawal delta found no further actionable issue.
The focused original-component tests passed 5/5 on that snapshot.

Dependencies were installed locally from the lockfile with offline `npm ci`,
then the locked native module was rebuilt locally. No peer `node_modules` was
copied. Same-runtime, generated in-memory constructor/read smoke passed for both
root and `mem0ai/oss`-resolved `better-sqlite3`, with no model/network calls:

- Node `v26.11.1`, ABI `147`, executable
  `/opt/homebrew/Cellar/node/26.11.1/bin/node`;
- both module resolutions use this workspace's
  `node_modules/better-sqlite3/lib/index.js`;
- actual native binary is this workspace's
  `node_modules/better-sqlite3/build/Release/better_sqlite3.node`.

Generated-only local proof artifacts (outside Git):

| Receipt | SHA256 |
| --- | --- |
| `../image-progress-iab.jpg` | `639fe7cc7d50da5251c778dd5b0e8592f1cfdb009a9808fd1a3ef116815aab4e` |
| `../image-progress-iab-b.jpg` | `91adae6b0f5eec1ce4b77b574f6b265941f2a5e169fc15241ecb8bccb966d762` |
| `../image-focused-final.log` | `f7633c3682d81257f90c9b33f46d67fd3039833071e0bb1b89bdad0978527c95` |
| `../image-desktop-triage.log` | `008ad91f3497d724425642d276b1f89c4f2861b2ce9a621083b10753588c7a59` |

A parent-requested read-only resource sample at 2026-10-17 05:17–05:18 UTC
observed 18 logical CPUs, 64 GiB RAM, load 18.01–19.65, and CPU idle
37.73–40.27% (user about 36%, system about 24–26%). `memory_pressure -Q`
reported 67% system-wide free; compressor usage was 15 GiB, with zero new
swapins/swapouts across the two samples. The workspace volume had 605 GiB
available. Multiple heavy Node/npm processes were concurrent, but this sample
alone does not prove CPU saturation, active paging or resource causation for the
platform failures. No other task arguments, data or processes were changed.
The complete local resource receipt remains outside Git at
`../image-resource-snapshot.txt`.

## Required affected gate: failed, Draft remains blocked

`JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/Users/utopiafar/Library/Android/sdk npm run check:affected -- --base origin/codex/mote-multiuser-integration`
ran to its natural exit **1** on production snapshot `4a7168f1`. It was not
interrupted. The source remained unchanged afterward; `68174ed2` updates only
the retained component test fixture to the required proof/operation/ACK wire.
That correction and the existing real scoped tests passed together **32/32**.
This bounded pass does not turn the full gate green.

| Suite | Natural full-run result |
| --- | --- |
| Desktop | 500 pass, 1 fail (60 files) |
| Server | 2,762 pass, 10 fail, 3 cancelled, 2 skipped / 2,777 tests |
| Web | 541 pass, 4 fail / 545 tests; one old ImageProgress wire fixture subsequently corrected |

The failed workspace test command short-circuited the root post-workspace tests
and Android check; those checks are not claimed as passed. The following list
retains every unsatisfied scenario, including cancelled timeouts. Unrelated
Ask/Memory/Actions implementations were not changed. Root cause of the broader
failures remains unestablished; concurrent-process observations do not substitute
for regression attribution. Parent explicitly authorized a narrow Draft with
this full-gate blocker, without indefinite unrelated repair work.

| Component / test | Observed failure or follow-up |
| --- | --- |
| desktop: revokes the old actual document before replacing private stores or publishing the new collector | 1-second diagnostics entry wait; unchanged single-test rerun passed |
| server: a thousand generated originals drain bounded catalogs with complete independently reviewed coverage | 120-second test timeout |
| server: HTTP import of a thousand generated originals rolls through bounded background packages without planning | 300-second prefix deadline; 807/999 checkpoints, event-loop max 25.75 seconds |
| server: real ordered Agent subtasks deduplicate proposals and disclose fresh original receipts before parent citations | Ask timeout |
| server: Insight research children receive their narrowed request without the parent report coverage snapshot | Ask timeout |
| server: parent cannot cite a successful child handle or prior-fragment originals without current disclosure | Ask timeout |
| server: pause/resume and restart preserve successful child checkpoints and replace cancelled generation authority | Ask timeout |
| server: failed real child retries only its own model branch while successful checkpoints remain single-use | Ask timeout |
| server: automatic Insight waits for interval AND increments, freezes archive candidates and revokes late output with the owner policy | 120-second test timeout |
| server: actual M03 Coding archives project only complete declared dialogue through M06 and Memory organizers for equal A/B identities | expected M06/Memory organizer publication not ready |
| server: two real HTTP host processes retain Memory state and original user/model grants across SIGKILL during feedback | 90-second test timeout |
| server: native Hindsight uses the real engine, independent review and exact private read banks across A/B and restart | HTTP 503 memory_provider_unavailable |
| server: raw screenshot daily observations wait for real M06 OCR and enabled pixel understanding for both owners, then consume each recipe once | 25-second aggregate deadline; OCR succeeded, pixel analysis still running |
| server: summary page checkpoints and original M04 snapshot survive restart without replaying completed model pages | analysis became stale/input_changed after provider_unavailable |
| web: the original question entry binds the actual calendar.update review to its required native target | actual model related-change wait |
| web: original Actions walks actual opaque owner pages and retires a held old page on account replacement | actual model-produced page wait |
| web: the original Actions dialog displays the actual immutable M12 review before an OwnerQuestions approval | actual Actions proposal wait |
| web: image progress keeps ready OCR visible after vision failure and reports a successful empty Memory result | old fixture omitted required proof and task ACK; corrected in 68174ed2, 32/32 compatibility tests pass |

Full generated-fixture log: `../image-required-delivery.log`, SHA256
`731a7f651f531e20cc59f57dd849f95f804ac7c4d63f8d7d7237bec0c449e2af`.
Machine-readable exact locations are retained locally in `../image-gate-failures.json`.

Post-gate bounded follow-up: `68174ed2` changes only the old component fixture's
wire. Its existing OCR/vision/empty-Memory assertions remain, while requests now
assert the owner proof and UUID operation ID and the fixture returns a task ACK.
A second independent review accepted this test-only delta. The 32-test command
includes `read-state-closure.test.ts`, `multiuser-image-progress.test.ts` and
`image-exclusion.test.ts`; all passed. Default-sandbox loopback `listen` initially
returned EPERM, so the authorized generated local-server check ran with its
normal supported execution permission; that environmental failure was not a pass.

The original, unchanged M06 summary-page restart test passed when run sequentially
with the raw-image combination check. The raw daily-observation test still
expired while OCR was succeeded and both image analysis tasks were running;
Memory correctly remained `memory_image_products_pending`. No success or Memory
publication was fabricated to satisfy its deadline. Exact-baseline comparison is
recorded separately below.

Later Joint freeze `2349a341da658ff6bb2ee16e67574908dd1d6325` was announced after
this bounded implementation. It is not consumed here and this is not a custom
recipe/whole-image final. Future composition must consume named `image:<name>` /
`image-ocr:<name>` derivation IDs and typed `mote-image-product-v1`, including
noOCR policies with no primary artifact/material; it must not invent
`rawArtifactId` or infer success from indexing alone. M13 owns the later union.

Exact-baseline attribution check: the unchanged raw daily-observation test also
failed on this task's separate worktree at
`9565bc7fbec0d0ee90ce47ed49d8f7df75af1abf` (32.50 seconds, same 25-second
window and same OCR-succeeded / image-analysis-running /
`memory_image_products_pending` snapshot). The fixed branch separately failed
that unchanged combination at 49.54 seconds. This is a demonstrated pre-existing
baseline gap, not a green integration receipt. It remains for the owning
M06/M07/Joint composition rather than this progress projection.

## Final bounded delivery receipts

Final `build:central` on `68174ed2f62e83dc9f630ac8064b219270ef293f`
passed. The production source is identical to `4a7168f1`; the ImageProgress
source hash remains the IAB-verified hash above. The entire affected Web suite was
rerun after the test-only correction: **544/545 pass**, **1 fail**, 104.35 seconds.
The remaining failure is `multiuser-actions.test.ts` — “the original Actions
dialog displays the actual immutable M12 review before an OwnerQuestions
approval” — waiting for an actual proposal while its job remained running.
All image-progress tests, including the retained component regression, pass.
The earlier Actions review-target and paging failures passed in this rerun.
This is still a failed Web/platform gate, not an aggregate pass.

| Additional local receipt | SHA256 |
| --- | --- |
| `../image-compat-final.log` (32/32) | `6e66589c366e72b61e0b11e4a8a0a1913b951a237f3db2248e1b25e0da3f20ca` |
| `../image-build-delivery.log` (pass) | `9f487b4c79dac753c94acf8a4e6faf5ab879e834ab372183f5c19f3afaca8ea9` |
| `../image-web-delivery.log` (544 pass / 1 fail) | `0f8bba8f5fa9cb2169c459ba95a3d25b7590ffcf183e6029892447d14d316d26` |
| `../image-related-triage.log` (summary pass / raw combination fail) | `4701f50740c59d75fc7662be50d2fa94a6265170c8cf742eeaf2f978b2f62b77` |
| `../image-raw-baseline.log` (same raw gap at exact 9565 baseline) | `d7faa41394ffbbb387e199bb9bd7d9414f5b9b5832d03c55675a03547e86ab20` |
| `../image-resource-snapshot.txt` | `58fefc5fb0c9334f3ab1616dc03f824ff9415c47dc9fa8f1fac6e0802fbc159b` |

A direct parent-thread status notification returned `thread not found` once and
was not retried; this task's commentary/final provides the automatic handoff.
M13's bounded status handoffs were delivered. An earlier Joint checkpoint
notification had an unconfirmed submission and was not blindly retried.

## Installed image recipe consumer continuation (PREP)

This continuation is isolated in local branch
`codex/mote-image-recipe-consumption-probe`; it is not yet in PR151 or a final
producer/consumer freeze. Exact mechanical composition
`10bd84e9c4fe8477174cc6d2246f8fd37cc35dde` combines declared Joint candidate
`2349a341da658ff6bb2ee16e67574908dd1d6325` with the full original PR151
`21e97819f275944e39025eadcdd7675e4610782d`, retaining M13's Files and original
retirement prerequisites. Later observer and attachment WIP was not consumed.
PR151 was freshly verified OPEN and Draft, with that unchanged head and the same
integration target. The earlier receipt's custom-recipe UNKNOWN is narrowed below;
the platform-gate failures above remain recorded and have not been rerun.

KEEP the original five phases, retry operation IDs, cancellation, unknown
confirmation, owner/source/original generation fences and real Memory receipts.
CHANGE the existing image projection to read declared named recipe steps and
explicit derivation artifact/material IDs. Parse typed interpretations with the
canonical `mote-image-product-v1` schema, including original metadata and empty
region descriptions. Legal noOCR recipes expose `ocrEnabled:false`; no primary
OCR/raw artifact is invented. Additional named OCR remains separately readable
without being labelled model interpretation. Missing installed recipes are
blocked while retained products and the original remain readable. REMOVE the
assumption that global understanding settings describe a custom recipe, or that
its derived Material is an OCR product. EXCEPTION: generated OCR and installed
stages exercise the actual scoped producer in tests. UNKNOWN: producer complete
reuse for noOCR and partially failed recipes is still RED on this exact candidate;
Joint owns that fix, typed Files export and snapshot original lifetime.

Consumer production candidate after the production-import correction:
`b14922465bd3f1018b123efcc611c043f90be358` (the browser UI ran the
identical UI/behavior bytes at parent `9e8a910b86b5be66a24662d8b5e84683ca3b53d9`;
the correction only changes the StoreError import to existing execution-storage).
`apps/web/test/multiuser-image-recipes.test.ts` exercises original FileDetail and
createApi Web login against actual M03/M05/M06. Four generated cases cover OCR,
noOCR, partial failure and two named OCR steps, explicit typed artifact reads,
complete/recompute/cancel, cancelled late results, A/B same IDs, retired controls
and held account responses, restart without replay, and removed recipe blocking.
The original two display RED cases are retained in local logs; named OCR also had
a real hidden-product RED before the consumer change. No helper inserts success.
Independent read-only review of this consumer candidate found no new confirmed
permission, phase or evidence-boundary issue.

`build:central` passed with the current production bytes. Fresh probe-local
locked dependencies (no copied peer node_modules) passed Node26.11.1/ABI147
better-sqlite3 constructor/write/read/close through both the root and actual mem0
resolution. Diagnostics build and scripts type check passed. The positive OCR
and double-OCR original UI cases passed 2/2 after test teardown changes.

Supported hidden IAB ran the built original Web app using
`scripts/scoped-image-recipes-browser.ts`: generated A login → Files → original
image detail → complete showed OCR, understanding and Material ready, while
Memory remained waiting. Original account settings switched to same-ID B, whose
noOCR recipe showed OCR unarranged, its own pixel-only interpretation and Memory
waiting. No A result appeared in B. The actual local OCR provider recorded one
call for A and none for B. Both own fixture processes and the browser tab were
closed; generated temporary server data was removed. This is generated-provider
UI evidence, not a real-model quality or final producer acceptance claim.

Local generated screenshots (outside Git):
`../image-recipes-iab-a.jpg` SHA256
`a866d81732da5444abe7045451e1a046e67f4c5118e253badcbd431efbdb0f5b`,
`../image-recipes-iab-b.jpg` SHA256
`70f607fc83c6b0de4a86ec2688fae350daf8143bc0011033b54aa7527659d2b1`.
ImageProgress source SHA256:
`38682d0596e31290147ca0946cf3a9b19cb56d5d58f36b7f8269259477d99240`;
projection source SHA256:
`268fa3663cd31941286c0ec3bef60aabfef97488542eff59ccef6df67af00330`.

The direct 36-case suite after test teardown correction finished 34 pass /
2 fail / 0 cancelled / 0 skipped in 83.753s; only noOCR and partial recipes
failed the real complete assertion (interpretation executions 3, expected 2).
Local log: `../image-recipes-direct-current.log`. A subsequent scope gate
correctly rejected a StoreError import from the old Store; the import was
changed to existing execution-storage without an allowlist exception. Scope
inventory/production boundary then passed (`../image-recipes-scope-fixed.log`),
and `build:central` passed (`../image-recipes-build-current.log`). The four
custom recipe cases were rerun after that import correction: 2 pass / 2 fail /
0 cancelled / 0 skipped, 45.839s, with exactly the same two complete assertions
(`../image-recipes-custom-import-fixed.log`). Independent
review verified the correction and found no further confirmed issue.

Final combination, direct affected acceptance and PR update await Joint's narrow
reviewed producer freeze. This probe is not a substitute for the final union's
required gate. Per the parent instruction, inherited whole-platform checks were
not rerun for this continuation.
