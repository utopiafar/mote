# M13 Web validation — incomplete checkpoint

Baseline M08 PR13758944f00837c89bc1d302ecd7be7a568db4abe44 includes accepted
M07 PR136cd7a306cce0f6cd5fec3c9e91e6dee0761352115 and public-contract PR135.
Own branch codex/mote-multiuser-m13-web, independent task17 clone. No dirty main
workspace used, no integration/main mutation, no PR/push/merge/deploy/CI action.
Final M11 remote98d76945e091d7234217ebcf532ebeff3350937c was verified and
merged in4eb1513c. M12 handoff remains denied/pending user authorization;
final M13 remote/PR verification has not occurred.
The original Web capability matrix is [the required acceptance ledger](../design/multiuser-web.md).
OPEN rows block complete Web acceptance; no feature is silently removed.

## Regression / characterization receipts

Commands use existing Node24 `/tmp/mote-node24-runtime-20261014/node-v24.21.0-darwin-arm64/bin/node`.
Logs and `.exit` files below are local evidence, not overlapping test totals.

| Source/test/fix | Actual command / result | Evidence |
| --- | --- | --- |
| baseline589 + test00a377cd -> fix15a64aa6 | `node --import tsx --test apps/web/test/multiuser-api.test.ts`: RED0/3 EXIT1; focused existing API characterization + new tests GREEN15/15 EXIT0 | `/tmp/m13-api-red.log`, `/tmp/m13-api-green.log` |
| test79887e02 -> runtime9d2593d8 | new masked-view editing method contract RED1fail EXIT1; config-service characterization + new scenario31/31 EXIT0 | `/tmp/m13-config-red.log`, `/tmp/m13-config-green.log` |
| runtime9d2593d8 | own auth/API/draft8/8 EXIT0; session/login/notes characterization22/22 EXIT0 | `/tmp/m13-auth-unit.log`, `/tmp/m13-characterization.log` |
| runtime9d2593d8 | `node --import tsx --test apps/server/test/multiuser-web.test.ts`: actual buildApp/Accounts/SQLite/Ingress with Web Api, synthetic Cookie transport through Fastify inject,3/3 EXIT0 | `/tmp/m13-real-http-inprocess.log` |
| real renderer9d2593d8 -> test5298bf9f -> fix22b14deb | old A-viewed loginRequest persisted through B re-login; actual RED then actual IAB GREEN. No client grant issued | `/tmp/m13-approval-route-red.md`, `/tmp/m13-iab-checkpoint-22.md` |
| test47ee1679 -> runtimeeda455ee | `node --import tsx --test --test-name-pattern='Web feature metadata' apps/server/test/multiuser-web.test.ts`: actual503 RED0/1 EXIT1; same assertion GREEN1/1 EXIT0, actual formal-note producer/canonical revision/source facets/A-B/current-session | `/tmp/m13-library-red.log`, `/tmp/m13-library-green.log` |
| test5162526f -> runtimeb64afe07 | `node --import tsx --test --test-name-pattern='Web attachment transport' apps/server/test/multiuser-web.test.ts`: old file-sync route actual503 RED0/1 EXIT1; actual original-byte ticket read/retry/same receipt/foreign404/stale409 GREEN1/1 EXIT0 | `/tmp/m13-attachment-red.log`, `/tmp/m13-attachment-green.log` |
| attachment increment | `node --import tsx --test apps/web/test/note-attachments.test.ts apps/web/test/multiuser-api.test.ts apps/server/test/multiuser-web.test.ts`:11/11 EXIT0 (five actual server-boundary cases, old upload characterization and Api) | `/tmp/m13-web-increment-focused.log` |
| test029fba7c -> fix5438b1ce | delayed ticket/new login adoption contract RED0/1 EXIT1 (missing rejection); `node --import tsx --test apps/web/test/login-handoff.test.ts apps/web/test/multiuser-web-auth.test.ts apps/web/test/multiuser-api.test.ts`:12/12 EXIT0 | `/tmp/m13-ticket-race-red.log`, `/tmp/m13-ticket-race-green.log` |

Masked editing is a new contract (missing-method RED), not proof of an old
production bug. One initial config test attempt lacked local dependency dist;
it is an environment failure, not an isolation failure. A changed handoff fixture
initially resolved a barrier before serialized request admission; waiting for the
actual request repaired the invalid fixture timing without weakening assertions.
Attachment typecheck first found a missing explicit default `deleted:false` in
the typed manifest; fixed and typecheck EXIT0, not a business-runtime RED.

## Actual renderer/backend checkpoint

Hidden existing Codex in-app browser, two temporary tabs; generated accounts and
content only; production buildApp shared SQLite/services/single executor, actual
loopback HTTP and built Web main. No real provider/model/user data/actions.
Original host61031 runtime9d; restarted host62909 runtime/bundle22 for fix proof.
Tool-driven actual DOM/AX checks are separate from unexecuted Electron automation.

Verified at22:
- username/password login, own current account; ordinary user lacks administrator UI;
- identical A/B note UUID isolation; A draft reload and same-account re-login
  recovery; B empty composer; actual B rendered save reaches B Ingress/SQLite;
- actual A response entered the hold before switching to B; B positive first,
  then release old successful A response, B remains positive with no A/draft;
- already-open native approval detail retires with A, URL loginRequest removed;
  explicit B re-login cannot resurrect it, original request still pending;
- failed login leaves old private tree absent;
- actual credential revocation then rendered refresh clears private UI;
- actual account disable then rendered refresh clears private UI;
- actual A rendered save admitted to Ingress then held ACK; logout/switch B,
  release ACK; A record26ff4304-5398-4235-aa74-2d8d3e71ba3b remains A, B has only
  B notes/empty composer, no A content. Logout does not cancel admitted work;
- administrator Settings lists generated account metadata and shared-model entry,
  without A/B private note bodies. No password reset/real credential grant UI run.

Detailed receipts `/tmp/m13-iab-checkpoint-22.md`, `/tmp/m13-lifecycle-checkpoint.md`.
Invalid test assumptions are explicitly excluded: an earlier unconfirmed gate
held B, not A; immediate reads before lazy page settlement saw empty fields; a
running static host cannot serve hashes from a later build and was restarted.
None is called an old production bug or counted as a successful assertion.

## Build/review/environment boundaries

- Own shared build EXIT0 `/tmp/m13-shared-build.log`.
- Own Web typecheck/build at22 EXIT0 `/tmp/m13-web-types.log`, `/tmp/m13-web-build.log`.
  Existing Vite chunk-size warning retained. This does not validate later bundles.
- Web typecheck after attachment implementation EXIT0 `/tmp/m13-web-types-attachment.log`.
- i18n8359 keys EXIT0 `/tmp/m13-i18n.log`; Android English JSON synchronized.
- scope scanner actual[] ateda, diff-check0; final gates still pending.
- M11 bounded read-only independent review exact589..22: no new confirmed
  P0/P1/P2 in Api/session/drafts/secret-CAS/context scope, no independent tests
  run. `/tmp/mote-m11-review-m13-22.md`. Later increments are NOT reviewed yet.
- Reviewer suggested delayed-ticket and direct-stream follow-up, not confirmed
  findings. Delayed-ticket migration contract gained RED/GREEN above. Current
  Web sources have no direct ReadableStream/getReader/SSE consumer; do not claim
  raw body-method tests prove a future direct stream consumer.

Default sandbox host listen returned EPERM before binding. Parent supplied new
explicit authorization for the original synthetic loopback host standard
escalation; automatic review allowed that exact host action. Hidden Electron
startup separately aborted at macOS ___RegisterApplication. A later standard
request to run hidden Electron `apps/web/test/multiuser-browser.cjs` was explicitly
DENIED before execution: that escalated renderer approach was not specifically
authorized and the existing IAB path was available. No retry, renamed command,
proxy runner or OS/network/security change followed. Existing hidden IAB + the
separately approved synthetic loopback host is the safe validation path.
`multiuser-browser.cjs` is durable scenario source, UNEXECUTED/unaccepted; its
presence is not a green automation receipt.

## Remaining gates / blockers

1. Complete the original capability matrix. Actual missing589 scoped projections
   include capture browser sessions/albums/image/OCR, import confirmation/read
   view, typed file review/speaker/export, private storage/encryption/backup and
   instance diagnostics/update. Memory/connector/plugin old response shapes need
   domain contract mapping; do not assume aliases prove equivalence. See exact
   pages/API/dependency/minimum approach in the ledger. M13 thin metadata/library
   and attachment increments still require fresh renderer proof.
2. Final accepted M11/M12 remote heads and composition on own feature only. M12
   open-action-dialog/current-review/version/target/epoch/revoke interleavings
   and actual final approval UI chain remain pending. Current checkpoint is not
   final acceptance of either dependency.
3. Newer-auth adoption overlap real IAB proof; same account/deployment rotation,
   missed-tab signal/backend session guard, expiry and final subscription/dialog
   matrix. Existing real HTTP stale-tab mutation negative complements actual IAB
   storage-event retirement, but is not a lost-event renderer rerun.
4. Independent incremental code review after22, fresh own builds, complete Web
   suite, required `npm run check:affected -- --base origin/codex/mote-multiuser-integration`
   including actual Android, final scope/diff/i18n. Serial heavy slot is held by
   no other module is persistently assigned here; M13 final full gate has not started or been counted passed.
5. Push own branch and create/attach Draft PR to integration only after acceptance;
   final remote head/base SHA checks. No PR URL exists at this checkpoint.

Last independent narrow checkpoint at runtime5438b1ce:
`node --import tsx --test apps/web/test/multiuser-api.test.ts apps/web/test/multiuser-web-auth.test.ts apps/web/test/login-handoff.test.ts apps/web/test/note-attachments.test.ts apps/server/test/multiuser-web.test.ts`
20/20,0skip/fail/cancel,EXIT0,6810.550625ms,
`/tmp/m13-final-narrow-checkpoint.log/.exit`. This is not the complete Web suite.
Parent subsequently paused M12 at a clean non-final checkpoint; its contract
handoff was denied pending explicit user authorization. No proxy transfer or
wake-up of M12 is performed. Current three slots are M13/M14/M15; M11 is complete and is not awakened.
M13 has released its latest short build/suite window.

## Increment9659 (still incomplete)

Own head9659d6df1e0f4348df6f70156c074e5762098803. M15 public Wire2
107004df cherry-picked asda2b030e (two new-file conflicts retained exact
source test/ledger); M14 public source-CASfdc cherry-picked as6ff66860. No
M12 content was consumed. Public Web projection-only freezec6b092ed has parent
fdc50cdc and no Web/native/M12 runtime; M14/M15 composition is separate.

| Test/fix or checkpoint | Receipt | Evidence |
| --- | --- | --- |
| M11 final composition4eb1513c | Actual Web backend6/6 and Web tsc/Vite EXIT0 | `/tmp/m13-m11-composed-web{,-build}.log/.exit` |
| Missing model inventory selection6d04dbe6→bf6a4a22 | Actual M01/M04 empty/selected account contract1/1 EXIT0; unconfigured is a normal state | `/tmp/m13-ask-selection-contract-red.log`, `/tmp/m13-ask-selection-green.log` |
| Original unopened connector panela1917→ada084 | RED actual eager old/status request; component GREEN16/16 | `/tmp/m13-source-panel-red-valid.log`, `/tmp/m13-source-panel-green.log` |
| Original Memory lifecycle fields91f16117 | Original controls characterization12/12, typecheck0; IAB field save revision0→1 | `/tmp/m13-memory-fields-{characterization,types}.log` |
| Missing owned MCP preparationce855→fc28/697 | Actual Ingress/configuration/CAS1/1; same-ID component draft retirement RED→GREEN17/17; narrow combined22/22 | `/tmp/m13-mcp-preparation-{red,green}.log`, `/tmp/m13-mcp-draft-{red,green}.log`, `/tmp/m13-697-narrow.log` |
| Skills9f708→78a60 | Actual503 RED→1/1 GREEN; initial registration before topology hook separately RED→moved registration GREEN | `/tmp/m13-skills-{red,green,topology-red,topology-green}.log` |
| Insight default selectiond8e5→4d2d | Original per-request global selector incompatible, SSR contract RED→GREEN2/2; per-request capability still OPEN pending M15 seam | `/tmp/m13-insight-model-{red,green}.log` |
| Query citation796431→d658 | Actual IAB old capture-browser path503; route reader preservation RED→GREEN8/8, real component context reader7/7; actual IAB5e citation and reload GREEN | `/tmp/m13-query-evidence-{route-red,green,component}.log`, `/tmp/m13-iab-query-5e.md` |
| Raw capture45b99→5e26 | Original text reader old route RED→M02 GET GREEN8/8 | `/tmp/m13-raw-capture-reader-{red,green}.log` |
| ACK identity2d09/51101→c1b6 | Actual M03 response corrupted only at external transport,9 negative scenarios RED (10total incl parent), same tests + original positive/retry/A-B12/12 GREEN | `/tmp/m13-receipt-identity-red{,-expanded}.log`, `/tmp/m13-receipt-identity-green.log` |
| Run scope/turn metadata06564→3529 | Actual IAB InsightProgress scope.after crash + backend RED2/2; own persisted metadata GREEN2/2; actual IAB report/text/citation/history refresh GREEN | `/tmp/m13-query-metadata-{red,green}.log`, `/tmp/m13-iab-insight-3529.md` |
| Public reader probe9659 | Real backend with no Web helper imports2/2 EXIT0 | `/tmp/m13-public-web-projection.log/.exit` |
| Full Web tests9659 | `node --import tsx --test test/*.test.ts`, cwd apps/web,485/485 EXIT0 | `/tmp/m13-9659-web-suite.log/.exit` |
| Fresh builds9659 | shared0, Web tsc/Vite0, server after dependency repair0 | `/tmp/m13-9659-{shared-build,web-build,server-build-repaired2}.log/.exit` |

Node24 remains the runtime. The initial complete `npm run test -w @mote/web`
failed before tests because tsx CLI IPC pipe creation was EPERM; same CWD and
files through Node's loader passed482/482, then485/485 after the reader increments.
That environment failure is not a product/isolation RED. Server first build and
first repair attempt EXIT2 missing nested mem0ai/oss. The independent dependency
copy guard rejected `.bin` before copying; it was corrected to exclude generated
executables and verify all12 nested registry package versions against lock and
reject symlinks. Independent APFS copies then fresh server build EXIT0; no peer
workspace/dependency tree was modified. Original failed logs remain.

Invalid fixture attempts remain excluded: async React model-selection fixture
did not settle correctly and was removed, not counted as a runtime fix; the first
source-panel test used wrong JSX CWD; first raw reader GREEN fixture intercepted
DELETE as GET, then method predicate repaired with original assertions retained
(the log was overwritten, transcript retains that invalid failure). Insight
fixture originally dated captures later than asOf; changed only generated date
for a meaningful positive bounded report. A post-clean-host-close browser reload
returned connection refused; new tab in the same existing browser recovered.

M14 bounded independent read-only review exact22..5e plusc1b6/3529 found no
new confirmed P0/P1/P2; ACK P2 is closed. `/tmp/mote-m14-review-m13-5e26b473.md`.
M14's tests were not run by this reviewer; its report does not replace final
renderer/whole-module gates. M13 independently re-reviewed M14's account/window
fix at29d without running Electron/tests: `/tmp/mote-m13-review-m14-29d.md`.

Finite remaining original capabilities: per-request models (M15 minimal M04
seam in progress), M10 vendor cards, M07 normal/audit/jobs/recipes/binding and
selection/progress mapping, M09 instances/admin packages, raw albums/session/
image/OCR filters, import confirmation/recovery/typed file review/export/aggregate
activity, Agent startup/trace, per-user storage/backup/index and explicit instance
management facades, and M12 Todos/Actions approval. These are required old
abilities, not optional new work. Missing domain projections are not replaced
with empty lists, invented counts or unrelated operations. M12 handoff is the
explicit user-authorization dependency; parent domain ownership/contract decisions
for genuinely absent management/import facades remain to be resolved.

Final freeze still requires incremental independent review, final actual
renderer/backend matrix (incl attachments/MCP and delayed auth overlap), fresh
related builds, full required affected including actual Android, scope/i18n/diff,
then own push/Draft PR/attachment/remote head-base verification. No final gate or
whole-module completion is claimed. Finite coordination details are preserved
in `/tmp/mote-m13-finite-closeout.md`; primary capability ledger above remains
authoritative for OPEN rows.

## Request-model and plugin/control increment (not final gates)

- M15 db88 composed as7f2fe173. Original control SSR RED41337d12 →cde70676
  GREEN3/3; same-ID model ownership REDa39db8c0 →705d0207 combined5/5 EXIT0,
  `/tmp/m13-model-owner-{red,green}.log/.exit`. M14 bounded readonly review
  `/tmp/mote-m14-review-m13-705d.md` has no confirmed P0/P1/P2; no rerun claimed.
- Actual hidden IAB alternate-model query at705d completed and archived. The
  later read-only provider/default queries lost their transport. After parent
  steering, readonly git/artifact/browser checks succeeded, original archived
  query remained visible and the old fixture HTTP listener was gone. No replay.
  Provider model/default post-state remains unverified; this is environment
  evidence, not a model-isolation failure or a passed provider assertion.
- Public c6 standalone omitted the full branch's exact pure `web-assets.ts`
  scanner allowance. Independent16cdf1619c89340b75c5c91de2e5c722773a1e09 adds
  only that single file; exact tracked tree scanner[] EXIT0 in
  `/tmp/m13-public-scope-16-complete.log/.exit`. First archive lacked
  fixtures/legacy-app.ts and exited1, retained separately; no broad allowance.
- Actual M09 metadata/masked-reference edit contract RED8cc78a64 0/2 EXIT1
  `/tmp/m13-plugin-metadata-valid-red.log/.exit` →ff91b6f8 GREEN2/2 EXIT0
  `/tmp/m13-plugin-metadata-green.log/.exit`. Same-ID A/B plus stale CAS,
  no hidden references in HTTP view, checked versus unsupported capabilities.
- Original PluginCenter + production Fastify/Accounts/M09/SQLite RED54238eb9
  crashed on the old view shape;71a2230c GREEN1/1 in
  `/tmp/m13-plugin-page-green.log/.exit`. This is a scoped-host migration gap,
  not an old single-owner production defect.
- Missing original M07 control REDf4ed4df1 and missing durable owner preparation
  REDd1e16e92 retained in `/tmp/m13-memory-control-red.log/.exit` and
  `/tmp/m13-memory-reload-red.log/.exit`. Actual backend + original renderer
  control GREEN4/4 `/tmp/m13-plugin-memory-green.log/.exit`; expanded actual
  reload→verification→activation and open-stop A/B switch GREEN1/1
  `/tmp/m13-plugin-memory-lifecycle.log/.exit`. Generated empty binding tests
  do not prove nonempty external-provider body migration.
- Reused the original modal and retained legacy PluginCenter characterization:
  `/tmp/m13-plugin-memory-modal.log/.exit`11/11 EXIT0. First new i18n check
  failed on a missing key; exact English/Android catalog sync then
  `/tmp/m13-plugin-i18n-green.log/.exit` EXIT0 (8365 messages).

Final affected, all builds at the final composition, real browser plugin/admin
journeys and all OPEN original-capability rows remain outstanding. No PR or
remote final head has been created. M12 handoff is still denied pending explicit
user authorization; M16 lifecycle is an explicit owned dependency.

### Memory reader characterization (after 9f305c81)

The canonical-Material-ref expectation in the first added test was invalid. Both `/tmp/m13-memory-anchor-red.log` and `/tmp/m13-memory-anchor-valid-red.log` failed only that expectation; following the actual returned `capture:<M07 evidence UUID>` through `/context/read` already succeeded with A's text. The uncommitted exploration that changed backend output was withdrawn; no `memory.ts`/`ask.ts` production change was shipped. `/tmp/m13-memory-anchor-green.log` therefore is not a delivered-fix result.

Corrected characterization runs the real M07 publication chain, follows the declared context reader, verifies raw `/captures/<same evidence UUID>` is 404 and B cannot read A's Memory/Material. Exact command `node --import tsx --test --test-name-pattern='Memory evidence navigation retains' apps/server/test/multiuser-memory.test.ts`, Node24 with synthetic local HTTP model fixture, standard approval: 1/1 EXIT0, `/tmp/m13-memory-reader-characterization.log` and `.exit`. This proves the reader boundary, not original Memories page closure.

### Original Memories consumer increment

Existing M07 real fixture was extracted unchanged into `test/fixtures/scoped-memory-host.ts` for reuse by the original React page test; normalized pre-extraction function SHA256 `dc71c512f6c2c92065d299e6162c6bb132f05bdf26a0a8e6d2fca7b782dfa063`, no fixture body/semantic assertion change. Generated A/B use equal Material IDs, real Ingress publication, local model HTTP, independent review and Memory commit.

- c191368c renderer RED: actual published memory absent because ordinary read sent `includeStale=true` (400), old job/recipe/queue endpoints also observed. `/tmp/m13-memory-page-red.log` EXIT1. bdba5655 published query + direct evidence/context reader GREEN1/1 `/tmp/m13-memory-page-reader-green.log` EXIT0.
- Expanded Memory nested evidence valid RED e22c55f8: actual callback emitted raw `capture:<M07 evidence UUID>` instead of keeping context reader; `/tmp/m13-memory-nested-reader-valid-red.log` EXIT1. First `/tmp/m13-memory-nested-reader-red.log` only observed pending renderer initialization, not a product RED. c6ee7453 nested reader GREEN1/1 `/tmp/m13-memory-nested-reader-green.log` EXIT0.
- fc82f5d0 job-history RED: original page requested legacy `/memory-jobs`; `/tmp/m13-memory-job-consumer-red.log` EXIT1. Scoped job history now reads actual M07 signed pages, and progress shows persisted batches/tasks/publication IDs without inventing legacy input-plan counts. Actual renderer opens completed receipt, direct/nested evidence, then B with A detail retired: `/tmp/m13-memory-jobs-renderer-green.log` 1/1 EXIT0. This is a bounded read/history increment; stale audit, manual selection, correction/integration and queue settings remain separate open mappings.
- i18n including synchronized Android catalog: `/tmp/m13-memory-i18n.log` EXIT0, 8368 messages. No full affected/build claim for this increment yet.

### 0cc composed build and actual IAB increment

Shared build, Web tsc/Vite, server tsc and scope all EXIT0 at runtime `0cc7311af17463f17ba3b8664741bb9ac8f6b1ef`: `/tmp/m13-plugins-shared-build.log`, `/tmp/m13-plugins-web-build.log`, `/tmp/m13-plugins-server-typecheck.log`, `/tmp/m13-plugin-composed-scope.log` with corresponding `.exit`. M09/plugin-ingress/Web-plugin/Android transport four-file run: 35 total, 34 pass, one `listen EPERM` before assertions, EXIT1 `/tmp/m13-plugin-ingress-regressions.log`. Exact failed real-HTTP shutdown characterization under standard approval: 1/1 EXIT0 `/tmp/m13-plugin-loopback-characterization.log`. The first command remains failed, not relabeled.

Fresh distinct IAB run used existing available in-app browser3, generated accounts/temp SQLite/local SSE and generated package transport; Web bundle 0cc, runtime e295e02b fixture-only addition. Receipt `/tmp/m13-iab-plugins-model-0cc.md` and `/tmp/m13-iab-plugins-model-receipt.json`: original Ask personal temporary model ID reaches all three A-only provider requests, Memory/chat default unchanged; administrator package preview/install/uninstall/reinstall; A nonempty masked reference edit/check/enable/disable; old open A editor retires on B switch in another tab, reload discovers B empty; B Memory pause persists; generated B MCP read credential issue/hide/revoke. Trace binds all mutations to original account credentials, not B-adopted A operations. Runner close acknowledged and exited0, generated resources removed. This is separate from the interrupted prior IAB query receipt and does not fill its missing provider observation retroactively. No Web Electron action was executed.

M14 bounded static independent review exact705d..72c3 `/tmp/mote-m14-review-m13-72c3.md`: no confirmed P0/P1/P2; not a substitute for final renderer/integration gates. Public plugin/control freeze65a contract and scope check recorded in `/tmp/mote-m13-public-plugin-contract.md` and `/tmp/m13-public-plugin-scope.log` EXIT0.

Memory increment original characterization `manual-memory.test.ts` + `memory-recipes.test.ts`: 5/5 EXIT0 `/tmp/m13-memory-original-characterization.log`. First Web typecheck found a JSX `unknown` condition (implementation type defect, no runtime test failure); fixed with explicit error presence check. Rerun `/tmp/m13-memory-web-typecheck-green.log` EXIT0. Neither is final affected acceptance.

Delayed login-ticket versus a second tab's B login was characterized through actual M01/browser Web Locks and onSend gates: `/tmp/m13-iab-ticket-cross-tab.md`. At observed gates old A remained signed-out and absent after release; B positive reached ready with only its private note. The static suspicion did not reproduce, so authentication runtime was not changed. Initial non-PTY host stdin issue, exact fixture PID stop and cleanup are recorded separately. Final fixture close acknowledged/EXIT0; temporary second tab closed.

### Original Memory correction follows durable publication

cb3fbf24 valid RED: original React form received nonempty owner input, POST `/memories/:id/correct` actually returned400 with legacy flat body. `/tmp/m13-memory-correction-valid-red.log` EXIT1. `/tmp/m13-memory-correction-first.log` only failed fixture React input initialization, excluded as product evidence; dynamically initializing React DOM after jsdom made the input event real.

Consumer sends M07 `{operationId,correction}` and retains that operation ID for an uncertain retry of the same account/card/body; no default-model write or backend change. It follows actual `/memory/jobs/:id` to the publication result and reads the new Memory. Diagnostic `/tmp/m13-memory-correction-receipt-diagnostic.log` shows a successful correction is `state=committed`, task `succeeded`, `current=false` because it superseded its original input. Progress now retains historical completion while reporting changed input versions separately; current Memory reads still enforce backend proof/grants. This corrects the initial M13 adapter's completion interpretation, not a claimed backend defect.

Complete generated original renderer -> actual M07 correct task -> new published body, A unchanged: `/tmp/m13-memory-correction-publication-final-green.log` 1/1 EXIT0. Initial admission-only `/tmp/m13-memory-correction-green.log`1/1 did not prove publication and is superseded by this expanded journey. `/tmp/m13-memory-correction-publication-green.log` EXIT1 retained the adapter completion failure. i18n synchronized8369 EXIT0 `/tmp/m13-memory-correction-i18n.log`. Final type/build/affected still pending at this new increment; M14 holds the agreed sole-heavy required window at its earlier exact composition.

### Manual Memory model contract consumes existing M04 lease

508aa1b4 valid backend RED: strict M07 job request rejects explicit owned modelReference/modelOverride with400 before admission; `/tmp/m13-memory-request-model-actual-red.log` EXIT1. The earlier `-red` and `-valid-red` files failed configuration setup when a masked read projection was copied as writable data (including masked headers/extraBody); those are invalid fixtures, not production RED. Final fixture uses only explicitly generated model configuration.

M07 now calls the existing M04 leaseReference and retains explicit request metadata in its existing durable task schema. No M04/Ask implementation or global default is changed. `/tmp/m13-memory-request-model-green.log`: actual local provider receives alternate model under A key through extraction and independent review/publication; default selection metadata unchanged, identical operation retry succeeds, changed requested model with the same operation409, B cannot select A-only profile and sends no provider request. 1/1 EXIT0; old no-reference automatic task inputs unchanged. Whole M07/M04/consumer regressions/typecheck still required after the sole-heavy window.

Explicit Material boundary RED3df79eb6: revision-pinned job input rejected400 and original selection preview absent503, two real backend cases0/2 `/tmp/m13-memory-material-boundary-red.log`. Existing M07 canonical materialEvidence is now exposed as a bounded preflight projection (no job/admission), with exact revision and declared recipe requirements. Optional materialRevisions pins all selected IDs at admission. Same two actual producer/API/publication cases2/2 EXIT0 `/tmp/m13-memory-material-boundary-green.log`: selected old revision conflicts after update without model calls; B cannot use A revision; partial pin map400; preview creates no mm_job; equal A/B Material IDs yield owner-specific evidence; actual subsequent publication uses preview's evidence IDs. UI consumption and final regressions still pending.


### Original Material to manual Memory renderer

af685d21 actual renderer RED: original Material detail reads the real canonical body, but has no manual-Memory link because scoped M02 does not return legacy memorySource. `/tmp/m13-memory-material-renderer-red.log` EXIT1. After consuming M07 preflight for the detail link, the unchanged original form still disables canonical selection; `/tmp/m13-memory-material-form-red.log` EXIT1. These are migration consumer failures, not claims about the old single-owner implementation.

Original detail and Memories now consume exact-revision M07 preflight, keyed by the actual selected recipes. Manual admission sends canonical materialIds plus complete materialRevisions and owned request modelReference through the existing durable job. Identical uncertain retries retain their operation UUID; backend admission still repeats revision/dependency/authority checks. Raw/range selection and stale audit remain OPEN, not silently mapped to all Materials.

`/tmp/m13-memory-material-renderer-green.log` 1/1 EXIT0 first complete journey. Expanded `/tmp/m13-memory-material-renderer-retry-green.log` 2/2 EXIT0 includes the original published-memory/correction journey and Material detail → selection → nondefault personal model → a lost real admission ACK → identical retry → actual extraction/review/publication. All provider requests use A's generated key and selected model, feature default metadata stays unchanged, B same-ID Material produces no B Memory. Synthetic localhost HTTP fixture only; no actual third-party action. Final type/build/affected and independent review of this delta remain required.


### M16 owned export consumer increment

Own feature merged M14 stable a439 and explicitly composed M16 e30/f24 + credential cleanup2a48/23e + reset tombstone d8/487 + account deletion locator75fef1f8. No integration/main or peer worktree change. M14's current required run remains on a439 and excludes these later M13/M16 changes.

ea36c689 original storage route RED: null global status hides the entire page despite an authenticated M01 session; `/tmp/m13-portable-renderer-valid-red.log` EXIT1. First `/tmp/m13-portable-renderer-red.log` only had a fixture feature-registry import cycle and is excluded. Original storage route now remains available, with owner portable export controls in its original Vault location. Completed receipt verifies account/deployment/operation, coverage exclusions, content type, ETag, exact byte count and SHA256 before browser download. Semantic phases/domains are displayed without fabricated record totals.

`/tmp/m13-portable-renderer-first-green.log` actual M01 Web Cookie/session/CSRF → original storage renderer → M16 receipt → verified content download 1/1 EXIT0; held A download released after B switch produces no file; fresh B export/download succeeds. The test uses createApi and app.inject at the external fetch transport, no fake lifecycle implementation, generated accounts/temp SQLite only. Personal import, separate old metadata/data export modes, private storage/index statistics and encryption remain explicit OPEN UI/domain mappings; disabled controls and notices preserve those capability gaps instead of fabricating success. Final IAB/type/build/affected and bounded independent review still required.


### Administrator deletion consumer

5f0d712b original account-list RED: no durable deletion entry, `/tmp/m13-account-deletion-renderer-red.log` EXIT1. Original account management now opens the established modal, captures original Api/target/operation UUID, retires the confirmation on identity change, and reads only M16 metadata receipts. Tombstones expose their original deletionId for refresh/retry, with no reset/reenable controls. Self-deletion uses the existing serialized authentication-change path and closes its initiating Api after actual admission. No alternate-account credential is adopted.

`/tmp/m13-account-deletion-renderer-green.log` and `-diagnostic.log` failed because the test selector matched generated-admin when looking for generated-a; actual last_administrator rejection was correct, not a product failure. Correct exact username selector: expanded export/A-held-download/B-positive/admin-held-confirmation/delete/refresh journey `/tmp/m13-account-deletion-renderer-final-green.log` 1/1 EXIT0. Separate self-deletion extension is recorded below after its result. First i18n check found missing new catalog keys; synchronized shared/Android catalogs then `/tmp/m13-portable-i18n-green.log` EXIT0,8394 messages. No final type/build/affected claim yet.

Self-deletion extension `/tmp/m13-account-deletion-self-green.log` 1/1 EXIT0: a generated replacement administrator permits current administrator deletion; the real admission triggers one browser authentication-change event, closes the initiating Api, old account login401 and replacement administrator login200. No user data or real external side effect. This is a synthetic renderer/backend boundary, not a final IAB claim.

At cd7 composition, fresh shared build0, server typecheck0 and scope0: `/tmp/m13-cd7-{shared-build,server-typecheck,scope}.log/.exit`. Web typecheck and first build failed on new lifecycle components accessing the legacy/Web Connection union without narrowing; logs `/tmp/m13-cd7-web-typecheck.log`, `-green.log` and `/tmp/m13-lifecycle-web-build.log` retain EXIT2. Explicit Web identity guards and captured stable user ID then full Web tsc+Vite EXIT0 `/tmp/m13-lifecycle-web-build-green.log/.exit`; generated lifecycle renderer including self-delete rerun1/1 EXIT0 `/tmp/m13-lifecycle-typeguard-renderer.log/.exit`. This is an implementation type defect repaired, not an environment error or backend isolation failure.

M16 bounded independent read exact b6c1c0d5+cd7d4b40 `/tmp/mote-m16-review-m13-cd7.md`: no confirmed P0/P1/P2 in receipt owner/deployment/operation/hash/coverage, each-await download retirement, immutable deletion intent, durable deletionId, self-auth change/close and honest unknown/retry states. It did not run tests/build/IAB; later type-only guards were not independently rerun there. Final affected at the final M13 composition remains outstanding.

### Actual browser portable export and terminal-state correction

`/tmp/m13-iab-portable-8109.md`: actual existing in-app browser3, own background tab4 and synthetic localhost host, Web/runtime8109092e. Original route/M01 sign-in/export receipt/download produced 15,585 exact bytes, SHA256 `8b64cd555b4de2c72cfa3b0ef23eee48815163adeb135082751e4ce7baf1a8c1`, portable3 A identity/body, B body and credential hashes absent. Browser download tool returned only after4116.8477s; it was not repeated or bypassed. Confirmed file copy `/tmp/m13-iab-portable-a.json`; original exact generated download remains outside writable roots, cleanup not attempted without approval. This is a distinct IAB acceptance increment, not B/deletion/M12 browser proof.

The same browser exposed a new M13 UI defect: detail completed while history remained working, with unnecessary terminal polling. ef06415d durable actual renderer RED `/tmp/m13-portable-terminal-red.log` EXIT1. Minimal fix polls only working receipts and invalidates owner list pages on terminal transitions; `/tmp/m13-portable-terminal-green.log` 1/1 EXIT0 verifies completed list state and no subsequent receipt poll, plus earlier owner/download/admin lifecycle assertions. Fresh build/IAB of this later fix still pending the M16 sole-heavy release. Existing browser screenshot was emitted; no fabricated local screenshot path. Browser tab left blank, host close acknowledged/EXIT0 and temporary resources removed.


### Existing owner audit consumed by the original stale filter

623079c7 actual renderer RED: after M03 publishes a real new Material revision, original Memories needs-revalidation filter sends ordinary status=stale, which M07 correctly rejects400. `/tmp/m13-memory-audit-renderer-red.log` EXIT1. This is a consumer migration defect, not a claim that ordinary Memory proof should admit stale bodies.

The original filter now uses the existing owner-only M07 /memory/audit?kind=stale signed pages and /audit/:id?version exact human-review body/evidence. No backend change. Retained statements are clearly not usable in answers; citation navigation stays within displayed retained evidence, without opening ordinary context/read, model/plugin surfaces, correction or integration controls. Selected revision and Api identity fence the review state. Existing time/search/category controls are explicitly unavailable for this audit-only contract; complete old audit filter parity remains OPEN, not silently claimed.

`/tmp/m13-memory-audit-renderer-green.log` first1/1 EXIT0. Expanded exact renderer suite `/tmp/m13-memory-audit-final-green.log`2/2 EXIT0 preserves previous publication/correction/Material/model/lost-ACK tests, adds real revision invalidation→owner audit retained body/evidence→A switch retires B review. New i18n first check lacked one reused empty-state key; corrected to existing message, final check below. No final IAB/build/affected claim for this later UI increment yet.

Owner audit i18n final `/tmp/m13-memory-audit-i18n-green.log` EXIT0,8395 messages; earlier missing empty-state key is retained in the failed first log. Final same-SHA build/IAB/affected still pending.

New audit consumer plus terminal export poll fix Web typecheck `/tmp/m13-memory-audit-typecheck.log/.exit` EXIT0 in the explicitly borrowed short slot; no server/full affected/Android run in that slot.


### M16 management original-page consumer

Own feature composed e91d381e926ecc0c7ca1077053a4ab958d12c015,1976bcf9763f03dc89d23248f4e223f44619796e,d7879a9e98a0e24cb85228e790a1dd0036ed0883. Only the management test hunk of mixed a21cc0148c96137434c74547eaede13695f89ec6 was applied as own1954b827; its unrelated backup RED was not imported. Documentation conflicts retain only the corresponding changed domain sections, without claiming unfinished CLI/backup code was composed here. Backend tests/type/affected for the resulting own combination remain pending.

56ba6620 actual renderer RED `/tmp/m13-management-route-red.log`: original diagnostics route is empty for an authenticated Web session when global status is absent. First post-route attempt `/tmp/m13-management-snapshot-red.log` only hit a fixture omission: the login grant was used without actual auth/self administrator metadata. This is excluded as a product RED. Corrected fixture performs actual M01 self discovery; with only original Diagnostics temporarily restored from committed source, `/tmp/m13-management-snapshot-valid-red.log` EXIT1 reproduces TypeError reading missing snapshot.queue.reportedPending. The pending fixed file was then restored unchanged; no peer worktree change.

`/tmp/m13-management-renderer-green.log`1/1 EXIT0: original route -> real M01 self/administrator -> M16 safe snapshot/log page -> original diagnostics metrics without private queue/index/services zeroes -> actual signed manifest checker with only external fetch substituted -> verified0.5.0, exact administrator check POST; switching ordinary B retires the administrator tree and sends no admin/old-global configuration fallback requests. Scope/coverage and unavailable instance YAML editing are explicit. No updater, deployment, real network/service or M12 action. Later copy-clipboard retirement and retained version-mismatch warning are small follow-ups awaiting the same test/type checks.

M15 independent bounded review05c+58+e57 `/tmp/mote-m15-review-m13-memory-e57.md` found no confirmed P0/P1/P2 in complete pins/current owner/recipes/retained M04 lease and original Api+body operation retry. Its own backend3/3 is separate actual evidence; it did not run Web UI or review94c audit. M13 bounded review of M16 e91/1976 and d787 is recorded in `/tmp/mote-m13-review-m16-e91-1976.md` and `/tmp/mote-m13-review-m16-d787.md`; known async reply P2 is statically closed at d787, not retroactively accepted at1976.


Management final narrow renderer `/tmp/m13-management-renderer-final-green.log`1/1 EXIT0, including the small clipboard lifecycle guard and retained version-mismatch warning. i18n `/tmp/m13-management-i18n.log/.exit` EXIT0,8401 messages. Fresh final Web/server build/type/affected and actual IAB for this management increment remain pending M16's sole-heavy gate.


### Original Activity consumer after M14 composition

ce3f2144 actual renderer RED `/tmp/m13-activity-route-red.log` EXIT1: a real M07 publication is already returned by the composed M14 work-activity API, while the original Web Activity entry renders Processing instead of goal cards. Restoring the existing Activity entry reaches a second business RED `/tmp/m13-activity-evidence-loopback-red.log` EXIT1: Memory evidence is opened as a raw capture rather than the declared M08 context reader. The first restricted attempt `/tmp/m13-activity-evidence-red.log` only failed listen EPERM before business assertions and is an environment failure, not another RED.

The original Activity component is reused with full Api identity retirement. Only Web Memory/Ask/Insight producers mark capture references as context reads; ingestion File/Image cards retain their raw-capture boundary. No backend aggregate or runtime is duplicated. `/tmp/m13-activity-memory-green.log/.exit` 5/5 EXIT0 covers the actual Material→chosen model→lost admission ACK→same operation→publication→Activity card/detail→evidence/context read chain, earlier actual Memory correction/audit/account boundaries, and three legacy Activity characterization cases. This is narrow renderer evidence; fresh type/build/IAB/full affected of the resulting candidate remain pending.


### Activity export receipt links

58fc4ea5 actual renderer RED `/tmp/m13-portable-activity-link-red.log` EXIT1: an existing completed M16 receipt cannot be selected by the exact Activity artifact URL `#/system/storage?export=<UUID>`. ScopedVault now restores only a UUID from that query and follows same-page hash navigation using its existing owner-validated receipt reader. Selecting/creating a receipt retains that query for reload. `/tmp/m13-portable-activity-link-green.log/.exit`1/1 EXIT0 includes refresh/same-page selection, completed polling stop, held A download retired on B, original admin/self deletion and B positive assertions. No new backend/download protocol. Server/Web combined typecheck `/tmp/m13-raw-browser-typecheck-green.log/.exit`0 also covers this consumer; first attempt had a new raw-album row inference error and remains failed in its separate log.


### Raw capture browser first scoped increment

90ad309e durable list/group tests and b7c1b773 image test. `/tmp/m13-raw-browser-red.log` and `valid-red.log` include invalid new fixtures (pending OCR without an image, then activity window-title content); these are excluded as list business REDs. Corrected fixtures first reach actual old endpoint503 for both list/group in `/tmp/m13-raw-browser-valid-red2.log/.exit`2/2 failed. List/group minimal GREEN `/tmp/m13-raw-browser-green2.log`2/2; initial implementation had an incorrect original-size SQL column, fixed by joining the existing owner-bound object table. `/tmp/m13-raw-image-red.log` is a valid real-M03 intake→missing original detail503 RED. First image GREEN attempt reached an invalid new disable body `enabled` rather than M01 `disabled`; fixed fixture only, not a product failure.

`/tmp/m13-raw-browser-image-green2.log/.exit`3/3 EXIT0 uses real shared SQLite, M01 accounts and M03 intake: 70 later distractors before-filter paging, complete owner/query-signed cursor rejection, original album/Session counts and app-return/gap behavior, equal UUID A/B different bytes, actual sharp thumbnail, and original A account disable behind sharp's actual async output barrier→401 JSON before image headers. Every SQL producer uses PrivateSql; images use M03 original descriptors and all immutable parts, with no global thumbnail cache. Server/Web typecheck first failed an album row inference; explicit typed row fixed it, `/tmp/m13-raw-browser-typecheck-green.log/.exit`0. This first increment does not yet close central OCR artifacts/completion, historical-source navigation or full raw-view renderer acceptance. No per-user runtime or legacy Store was restored.


Raw image follow-up confirmed a new migration race at5abd56ac: with actual sharp output held, deleting A's capture then recreating the same UUID with different M03 original bytes allowed the old thumbnail200. 3f7bb229 retains the actual RED `/tmp/m13-thumbnail-recreate-red.log/.exit` (200 !=409). The response now compares the captured original ref/hash and current raw record binding after the await and before headers; unchanged full suite `/tmp/m13-thumbnail-recreate-green.log/.exit`4/4 EXIT0 includes new A replacement and unchanged B positives. This claim concerns the new scoped adapter only; no old-system bug is asserted.


A second new adapter race is retained at ad43f472: releasing the actual M03 snapshot behind sharp's output barrier still returned thumbnail200 because a length0 original read checks metadata, not the bytes grant. `/tmp/m13-thumbnail-release-red.log/.exit` is valid200!=410. The final fence now reads one byte through the existing M03 availability/pin check before headers. `/tmp/m13-thumbnail-release-green.log/.exit`5/5 EXIT0 preserves earlier image/account/replacement positives and returns410 JSON after snapshot release. No change to M03 expiration or pin policy.


### Actual central OCR read projection

9cb3899a is the real-M01/M03/M04/M06 RED: generated PNG/worker and a successful actual processing task still leave original browser completed-filter count0 (`/tmp/m13-central-ocr-red.log/.exit`, expected1). No input record is rewritten. The new reader joins only the current visible M06 publication, exact original membership and matching ready extraction artifact; summary/image-understanding cannot substitute the OCR body. `/tmp/m13-central-ocr-green.log/.exit`6/6 EXIT0 and expanded `/tmp/m13-central-ocr-device-restart-green.log/.exit`6/6 EXIT0 include actual M06 binary transport, owner status filter/detail, unchanged raw intake, device-only ingress updates versus denied private route, different-device403, credential revoke401 and actual host restart preserving its numeric device cursor. New per-owner/device journal is a derived notification only, cleared on M03 deletion and excluded by existing portable receipt-history coverage; it never admits work. Rebuild/paging/renderer/final schema acceptance remain pending the next increment.

### Stable derived device cursor and raw renderer increment

608e03d8 retains valid future-cursor RED `/tmp/m13-ocr-cursor-rebuild-red.log/.exit`: a future numeric cursor returned200 instead of409 and could suppress later records. The fix preserves persistent per-owner/device counters, deduplicates exact capture/artifact notifications and reconciles only a bounded page of current canonical extraction. `/tmp/m13-ocr-cursor-rebuild-green.log/.exit`6/6 EXIT0; expanded `/tmp/m13-ocr-pages-green.log/.exit`6/6 EXIT0 adds three actual M06 publications through numeric one-item pages and deletion of the highest event without counter rollback. No model/task is admitted during reconciliation.

New actual React timeline/Session→M01 Web cookie→M03 original backend renderer test `/tmp/m13-raw-archive-renderer3.log/.exit`1/1 EXIT0 preserves original filter, real thumbnail Blob, captured raw references, held A response retired on B, B reload and A Session restoration. The first fixture lacked JSDOM IntersectionObserver; the second incorrectly expected OCR text in an existing image card that displays its image/title. Both are fixture assumptions, not production REDs. Only the viewport I/O is substituted; backend bodies and account authority are real. This is not full ImageProgress or IAB acceptance.

First final narrow type attempt `/tmp/m13-raw-freeze-types.log/.exit` EXIT2: new projected `ocr.status` widened to string. An explicit existing CaptureRecord return type corrects the declaration without changing behavior. Final types/scope results are retained separately. The public interface/schema and remaining limitations are in `docs/design/multiuser-capture-browser.md`.

Final narrow Server/Web types `/tmp/m13-raw-freeze-types-green.log/.exit` EXIT0; exact scope inventory/import boundary `/tmp/m13-raw-freeze-scopes.log/.exit` EXIT0. Only the explicit return-type annotation changed after the six-case run; no runtime behavior change. Full affected, builds and IAB are pending the composed candidate.

### Identical-image recreation fence

M15 independent review of0172 confirmed a distinct P2 using identical original bytes. Its durable36a9dbc3 was applied as own47405f0d. Own unchanged case `/tmp/m13-raw-identical-incarnation-red.log/.exit` EXIT1 reproduces oldthumbnail200!=409 on the actual composed backend after delete/recreate with identical UUID, ref, hash and bytes. M13 now captures the existing M08 originalReadReceipt and rechecks it before image headers; its persistent original incarnation distinguishes the recreated record. There is no new identity table/runtime, no raw/context fallback and no intake rewrite. Complete narrow actual backend `/tmp/m13-raw-incarnation-green.log/.exit`7/7 EXIT0 also preserves prior owner/image/retention/OCR/cursor cases. Types and final combined gates are tracked separately.

Identical-image fix with current M14/M16 composition Server/Web typecheck `/tmp/m13-incarnation-composed-types.log/.exit` EXIT0. The eight-second types slot is released. The M16 backup63 bounded helper review `/tmp/mote-m13-review-m16-backup-63.md` has no new confirmed finding; it does not substitute for M16's actual corruption cases.

### Same-account portable3 original Web import

Current feature composed stable M14 exact76745cc3 (including M16 import89dd/1fd and prior lifecycle/backup runtime) as c04317e4. Conflicts retain full M16 ingress synchronous merge/rollback and union the two M13 deletion tables, scope surfaces and append-only validation evidence. M16 two-table backup REDb24/fix63 are also composed as aef86400/9a74d1e6. No integration/main, M12, deployment or CI changes.

23b347c9 retains actual renderer RED `/tmp/m13-portable-import-red.log/.exit`: generated M01/M03 archive exported successfully and its original account record was deleted, while the original Vault file picker remains disabled. The thin consumer reuses the original select-file→import flow and M16's canonical import engine. It checks original deployment/account before POST, retains exact operation id/body for uncertain retries, reads owner-bound durable history/deep links on reload and reports semantic coverage; it stores no full archive in local storage and produces no fake download artifact.

First actual `/tmp/m13-portable-import-green.log/.exit`1/1 EXIT0; expanded export/import/raw renderer `/tmp/m13-portable-raw-renderer-composed.log/.exit`3/3 EXIT0 preserves existing export/hash/download/admin/self-deletion and raw filter/image/Session journeys. Import includes actual M03 deleted-record restoration, B same-ID unchanged, real admitted response ACK loss→same id/body retry, durable refresh, terminal polling stop, A file.text held across B switch, foreign-account archive rejected before POST and a genuine held domain read→user cancel→cancelled receipt. Latest same test with a synchronous in-flight event guard `/tmp/m13-portable-import-final-green.log/.exit`1/1 EXIT0.

First new i18n check lacked `取消导入`; after adding the authored English message and synchronized Android catalog, `/tmp/m13-portable-import-i18n-green.log/.exit` EXIT0 (8411 messages). Final type/build/IAB/affected and bounded review of this consumer remain separate pending checks.

Import first narrow Web typecheck `/tmp/m13-portable-import-types.log/.exit` EXIT2: the new component did not explicitly narrow the Api connection union to Web before reading its account/deployment. The same existing ScopedVault Web guard and captured immutable identity fix the declaration; `/tmp/m13-portable-import-types-green.log/.exit` EXIT0. This slot is released; fresh builds/IAB/affected are still not claimed.

### Import receipt closure review follow-up

M16 bounded review of ee4 found a malformed same-owner receipt could claim completion with empty/unfinished domain rows or a wrong phase. This was a static candidate, not a claimed M16 producer failure. e674a68f durable RED uses an actual successful M16 admission/receipt, mutating only its presentation fields before the production parser: `/tmp/m13-import-receipt-closure-red.log/.exit` EXIT1, ten malformed cases accepted (11 failures including the parent). The parser now requires unique imported/preserved coverage, exact union with all rows, preserved/complete states, exact phase and no export artifact fields. Required five canonical domains are a subset of the complete declared union, allowing explicit registered extensions without guessing authority.

`/tmp/m13-import-receipt-closure-green.log/.exit`13/13 EXIT0 includes all ten unchanged negatives and both original real import/export renderers; the additional fully declared-domain parser positive is format compatibility only, not a claim that an extra execution provider was installed. No backend policy/runtime changed. Final types/review of this small fix are separate.

Strict import receipt final Web typecheck `/tmp/m13-import-receipt-types.log/.exit` EXIT0 and unchanged i18n8411 `/tmp/m13-receipt-i18n.log/.exit` EXIT0. Slot released. This is a Web parser follow-up to the independently reported malformed-response boundary, not a new server import implementation or whole-module acceptance.

### First owned Gmail business chain

608d5365 retains the original-card actual M10 host RED `/tmp/m13-gmail-owned-red.log/.exit` EXIT1: there is no owned connection selector and the old global status path is incompatible. The new Web-only card reuses the original location and presentation with an explicit owned M10 connection, real OAuth admission and M05 task receipts. Only Google OAuth/network I/O is synthetic; M01/M04/M09/M10/M05/M03 and the renderer are production code.

Initial actual archive success in `/tmp/m13-gmail-owned-expanded.log/.exit`1/1 EXIT0 did not prove the result presentation. Adding the actual durable-task count assertion exposed a new implementation mistake in `/tmp/m13-gmail-owned-result.log/.exit` EXIT1: the consumer expected a UUID although M05 task IDs are64-character hashes. Correcting that contract yields `/tmp/m13-gmail-owned-result-green.log/.exit`1/1 EXIT0, covering OAuth→real Gmail parsing→M03 archive and real task counts, admitted sync ACK loss→same operation/body retry, A/B same connection IDs, retired A disconnect, actual A disconnect preserving archived mail, and a held A authorization response discarded on B. This is a new consumer defect, not a claim about the original single-owner system.

New message catalog synchronization `/tmp/m13-gmail-i18n.log/.exit` EXIT0 (8413). M16 owns the heavy slot, so fresh types/build/IAB/full affected are not claimed. Existing connection configuration CRUD/CAS and uncertain disconnect retry, plus Google Calendar/Lark/recordings consumers, remain OPEN. M12 handoff is now explicitly cleared by the parent; stable35d contract was read but is not yet composed here, and later M12 lifecycle REDs are not accepted.

The next unchanged renderer journey injects response-only ACK loss after the real M10 disconnect200. `/tmp/m13-gmail-disconnect-ack-red.log/.exit` EXIT1 reaches a second identical operation/body returning409 connector_command_conflict. The first operation really disconnected A and preserved its M03 archive; this is a migrated M10 operation retry defect, not an assertion about the old single-owner implementation. Fix and rerun follow separately.

b98dc625 retains that RED. The minimal existing-command branch delegates to the same M10 submit fingerprint/current-generation/account-epoch validation before any extra retirement. `/tmp/m13-gmail-disconnect-ack-green.log/.exit`1/1 EXIT0 returns the original task ID; expanded `/tmp/m13-gmail-disconnect-generation-green.log/.exit`1/1 EXIT0 also proves the connection generation advances once. No prior task input or snapshot is replaced. Current Server/Web typecheck `/tmp/m13-gmail-types.log/.exit` EXIT0; the short slot was explicitly released to M15. Targeted old M10 regression checks and independent review are recorded separately, as are final build/IAB/full affected.

Targeted existing M10 current-configuration/duplicate-sync/encrypted-Lark/disconnected-reference tests `/tmp/m13-gmail-disconnect-regressions.log/.exit`4/4 EXIT0 on a88da778. This checks neighboring admitted identity and secret revocation without claiming the entire connector suite passed.

### First authorized M12 composition

After the parent explicitly confirmed the original handoff succeeded, M13 read M12 instructions/design/validation. The newer stable4a0e82dbb28908e6ec34a6703e86fcd1229dfaf5 (runtime5172f099; contract unchanged from35d) is composed on this feature branch. Conflict resolution retains the Gmail test fixture's optional external-I/O ports, current raw journal wording, both translated catalogs, newer original Desktop native evidence and append-only domain validation records. Existing app composition preserves lifecycle/Activity/static assets/raw capture and adds Actions/Todos; no integration/main change.

Current scope/import inventory `/tmp/m13-m12-composed-scopes.log/.exit` EXIT0 and bilingual catalog `/tmp/m13-m12-composed-i18n.log/.exit`8423/0. No build/types/whole gate of this new combination is claimed yet. M12's unknown/deletion/portable fixes have only its reported narrow results; backend13-table backup retirement still belongs to M16's next actual combination. Original Actions/Todos renderer approval and already-open dialog account/revocation matrix are the next M13 consumer work.

### Original Actions fixed-review consumer RED

The first new renderer command `/tmp/m13-actions-review-red.log/.exit` failed listen EPERM before business assertions. The exact synthetic loopback fixture was then allowed by standard approval; `/tmp/m13-actions-review-loopback-red.log/.exit` is the valid business RED: real M03 evidence→M12 Harness→A/B proposals and owner targets exist, but the old modal directly calls compatibility confirm without first displaying the returned immutable review and its target account. No real provider/calendar action is used. This is a new multiuser-contract consumer gap; it does not claim the old single-owner approval flow was defective.

f2c7567f retains that RED. The original edit modal now prepares a fixed M12 review and shows its actual event, version, evidence and device/calendar/account before an explicit OQ reply; the original OwnerQuestions entry uses the same fixed-content renderer rather than its generic text composer. The server still owns fingerprints, source/target/account epochs and all grant admission. Web uses M03 registered device metadata and keeps opaque cursors encoded without numerical conversion; full paging acceptance remains a later test.

`/tmp/m13-actions-review-green.log/.exit`1/1 EXIT0 is the first real model/Harness/backend/renderer approval positive. Expanded `/tmp/m13-actions-review-matrix.log/.exit` and `/tmp/m13-actions-review-entries-matrix.log/.exit` each1/1 EXIT0 add original question entry, malformed same-owner target receipt rejected before a button, actual open B review→A retirement, retired tab rejected before transport, actual held B review→A discarded, revocation409 and account disable401 while the fixed modal is open. A approval leaves B proposed. These are scenario assertions in one genuine fixture, not artificially counted as separate tests. No real calendar I/O, grant or external account is touched.

New Web typecheck `/tmp/m13-actions-review-types.log/.exit` EXIT0; i18n `/tmp/m13-actions-review-i18n.log/.exit`8426/0. The later changes only stop terminal review polling and guard evidence navigation, exercised by the expanded test; final same-candidate type/build/full Web/IAB/affected and bounded independent review remain pending. Native bridge execution, Todo/full signed pagination and module capability OPEN rows are not accepted by this matrix.

M12 bounded review of1b30 reports two new consumer P2s, `/tmp/mote-m12-review-m13-actions-1b30.md`. Own real root StrictMode wrapping reaches valid RED `/tmp/m13-actions-strictmode-red.log/.exit` EXIT1: actual proposals load but edit is silently refused after effect setup→cleanup→setup, and the original modal is absent. The new mounted ref's setup did not restore true. This is a defect introduced by1b30; fix and unchanged-matrix rerun follow separately. Native update/cancel target omission is the second reported candidate, with actual response-corruption reproduction still pending.

StrictMode RED01a135b6 closes with the minimal effect setup restoring mounted=true while keeping cleanup=false. `/tmp/m13-actions-strictmode-green.log/.exit`1/1 EXIT0 reruns the unchanged actual original dialog/question/account/revocation matrix inside the real StrictMode wrapper. This does not yet close the separately reviewed missing-native-target case or constitute a whole Web gate.

The native-target fixture first produced only a file-level failure with no usable assertion (`/tmp/m13-actions-native-target-red.log/.exit`1); its diagnostic reached the renderer and was intentionally stopped130, not counted as business RED. Printing the DOM button itself in an equality failure was replaced with the same Boolean assertion. `/tmp/m13-actions-native-target-valid-red.log/.exit` then reaches the real semantic assertions: update/cancel2fail, Mote-only complete1pass. Both actual M12 original success receipts and related model-generated changes exist; only the returned review's target and targetDetails are removed at the HTTP response boundary, and the original question entry still exposes approval. No real calendar write is performed. This confirms M12's second reported P2 in the new Web parser.

4673239a retains that valid RED. The parser now requires a target for create and for update/cancel with an existing native externalId, matching M12's native predicate; it does not impose that requirement on Mote-only completion. `/tmp/m13-actions-review-final-green.log/.exit`4/4 EXIT0 (39.89s) serially reruns both native negative cases with unchanged exact-target positives, completion exception and the original StrictMode dialog/question/account/revocation matrix. M12 tiny-delta independent re-review is requested separately; fresh types/build/whole Web/IAB/affected still await the shared heavy slot and final combination.

M12 bounded tiny-delta re-review `/tmp/mote-m12-review-m13-actions-tiny-4ea.md` confirms both original P2 code paths closed, no new confirmed P0/P1/P2, without rerunning the four tests or changing M13 files. This does not expand its review to whole Web/pagination/native bridge.

### Original Todo characterization through M12

`/tmp/m13-todos-characterization.log/.exit` first fails a new fixture assumption that default page length is20; the actual M12 Todo default is30 and correctly returned all23 existing rows. No production defect is asserted. Correcting only the fixture size/expectation yields `/tmp/m13-todos-characterization2.log/.exit`1/1 EXIT0 (1.27s actual case): original Actions/Todo UI in StrictMode, thirty-row signed first page and next page, A/B equal IDs with actual CAS completion, no default due date, admitted create ACK loss→same ID/body retry, held admitted A output→B's unsaved draft preserved, detached old form cannot submit and fresh B creation positive. It uses actual M01/M12 HTTP/SQLite; no new Todo runtime/helper or production change was needed.

### Original Actions opaque-page characterization

`/tmp/m13-actions-opaque-characterization.log/.exit`1/1 EXIT0 (55.87s) uses real M12 discovery through the synthetic external model to create21 A proposals and1 B proposal. The original StrictMode renderer walks the opaque signed20→1 page, restores the first page, and retires a held successful A page when B replaces the account. B rejects A's cursor and keeps its own single proposal after the old response releases. No SQL-created proposals, real calendar mutation, new paging helper or runtime change is involved. This verifies paging and old-response retirement; native bridge execution and other OPEN capability rows remain separate. Tested source composition is f8b4051c2435a63b491020e5bdd4e00209aa9e91 plus this test; M16's shared gate on107 does not include the new Web UI increments.

M12's bounded tiny-delta re-review `/tmp/mote-m12-review-m13-actions-tiny-4ea.md` closes both original1b30 consumer P2 paths without a new confirmed finding. It did not execute tests or review the whole Web module. The4/4 renderer evidence remains M13's own execution, separately from that static review.

### Empty-account Gmail settings and explicit lifecycle

07a81f88 preserves actual original-card RED `/tmp/m13-gmail-settings-red.log/.exit`1: an empty current account has no new-connection entry. This is a migration completeness gap, not an old-version defect claim. The first implementation run `/tmp/m13-gmail-settings-green.log/.exit`1 clicked the newly disabled inventory-loading button before readiness; this is a new test timing assumption, not a product RED. Waiting for actual inventory readiness yields `/tmp/m13-gmail-settings-green2.log/.exit`1/1 EXIT0.

The original Gmail card now creates a disabled M09 instance through the existing M10 route, edits the existing M04 domain with full revision CAS and same-entry masked-secret preservation, and exposes explicit M09-backed enable/pause/stop plus revision-bound removal. The form reads a fresh baseline on every opening, keeps schema auto-sync/interval defaults, and does not enable, authorize or synchronize when saving configuration. Secret input starts blank; blank retains the same row's saved secret and an explicit clear control removes it. Private drafts and pending callbacks remain in the account-keyed card.

Expanded `/tmp/m13-gmail-settings-final-narrow.log/.exit`2/2 EXIT0 (5.77s) serially runs the real M01/M04/M09/M10/M05/M03 renderer chains: empty A creation remains disabled; A/B same connection ID; actual client ID with redacted secret; unchanged secret on edit;409 concurrent CAS with fresh reopen; old A form cannot submit under B; B explicit enable/pause, clear secret and remove do not affect A; held admitted A save cannot retire/refill B's unsaved editor. The existing OAuth→real Gmail adapter→M03 archive, actual task counts, exact lost sync/disconnect ACK retry, one generation retirement, preserved archive and late OAuth URL test also passes. Only external Google OAuth/network I/O in that second case is synthetic; settings and lifecycle use the actual host and database.

`/tmp/m13-gmail-settings-i18n.log/.exit`1 first identified one missing authored message (`确认移除`); adding its English translation and synchronized Android catalog yields `/tmp/m13-gmail-settings-i18n2.log/.exit`0,8437 messages. Same-candidate types/build/IAB/full affected and bounded independent review remain pending. Other provider views are still OPEN. M16 alone owns the resumed107 required stage; none of these new Web increments is claimed covered by that gate.

M15 bounded review `/tmp/mote-m15-review-m13-gmail-711.md` of711d61d1 reports no new confirmed P0/P1/P2 in the two UI files and adjacent immutable Api/M04 boundaries. No reviewer test/build/edit is claimed. Its separate backend configure-await/CAS concern remains an unconfirmed candidate: it must be checked against actual M04/M09 serialization and a real interleaving before reporting a defect.

### Original Sources and real outbound MCP renderer

`/tmp/m13-mcp-renderer-red.log/.exit`1 is sandbox loopback listen EPERM, before the intended assertion. The exact single generated loopback action passed standard review; `/tmp/m13-mcp-renderer-loopback-red.log/.exit`1 is valid migration RED: the full original Sources page successfully discovers real MCP resources but still requests the absent global `/api/connectors/status` and displays404. defe2574 retains the test. The minimal Web condition now leaves the old status read only to the explicit legacy bearer branch; actual Web Gmail/MCP retain their own current-account APIs. It does not fabricate global Google status or claim other provider UI complete.

`/tmp/m13-mcp-renderer-green.log/.exit`1/1 EXIT0 (2.04s) uses two actual temporary Mote instances and the real inbound/outbound MCP SDK, not a mocked Api. Scoped browser A selects a saved connection, discovers `mote://sources`, imports an actual remote A source catalog through M03, and repeats with the real duplicate count. A held successful discovery retires on B; equal connection/source/resource IDs then import only remote B's catalog. Bodies contain only owned connection/source/selected resource IDs, never endpoints, tokens or a chosen user. No third-party service, real data, write tool, model call or real calendar effect is used. Final IAB/full Web/build/affected are separate pending gates.

M16 bounded review `/tmp/mote-m16-review-m13-sources-108c.md` of the exact108c Sources condition and immediate consumers reports no new confirmed P0/P1/P2; it ran no test/build and does not accept other provider flows. Current combined Web typecheck at108c `/tmp/m13-108-web-types.log/.exit` EXIT0, including the Gmail/Actions additions. The5–8s slot has ended. M16 has separately reported literal107 resumed required EXIT0 and compiled Actions SIGKILL EXIT0; that common backend gate excludes these later Web increments and is not an M13 final gate.

Current fresh Central build first `/tmp/m13-e195-central-build.log/.exit` EXIT2 in shared TypeScript: the Gmail increment added an already existing `清除已保存密钥` property to the translation literal. The JSON-based i18n check had not rejected duplicate keys. Removing only the new duplicate and resynchronizing Android preserves the original translation; `/tmp/m13-gmail-i18n-central-build2.log/.exit` EXIT0 builds fresh shared/agent/server/Web. The original failure is a new increment compile defect, not an environment or old product failure. Full Web tests follow on this fixed source.

First full Web at03fdcdea `/tmp/m13-full-web.log/.exit` EXIT1,515 total/514 pass/1 fail (58.98s). The one new Gmail case reads SQLite after a fixed30ms while its save is still in flight; it sees the previous redirect before the response. The fixture now waits for the actual successful edit acknowledgement/editor retirement, and waits for the actual409 before checking a conflicting save. It retains all values, secret/CAS/A-B assertions and the original production code. `/tmp/m13-gmail-settings-ack-fixture.log/.exit`1/1 EXIT0 (2.31s); full-suite rerun remains required, no whole-suite pass inferred from this narrow result.

Same-runtime full-suite rerun at aed42550 `/tmp/m13-full-web2.log/.exit` EXIT0,515/515,no skips (57.24s). Only the new test's semantic completion waits differ from03fd; no runtime assertion, deadline or model script changed. Fresh Central build is the preceding successful same-runtime build; this increment has not yet passed an own final affected/Android run or new IAB acceptance. All heavy work is released.

Read-only remote `git ls-remote` independently verified M12 PR140 head a50d1c88647780ebd27d7a247ec4ffbc170ab87f, M16 PR141 head eec967c66304fef78f683e3445900287e75bac21, integration6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed. Default sandbox could not connect to the configured proxy; the same read-only command passed standard review and returned those exact heads. Own composition includes their tested literal107; the final delivery heads add docs. No M13 push/PR has been attempted; those remote dependencies' gates do not replace M13's remaining gates or OPEN capability rows.

### Current IAB fixed-review journey and presentation RED

The approved temporary `/tmp/m13-actions-iab-host.mts` reuses the real M12 model fixture and production host, synthetic local model only; IAB browser3 tabs1/2 load current compiled Web on localhost61470. Actual A login→original editable dialog→fixed review shows the stored version, quote, Generated device/calendar/account A. B's original current-account switch retires the entire old A private tree and approval button in tab1. B displays only its own fixed target and explicitly approves. A remains proposed and B becomes approved in actual metadata `/tmp/m13-iab-actions-state1.json`; no native calendar actor or real external service exists in this fixture.

The same real renderer exposes a presentation acceptance failure: the active flat theme sets `--mote-panel-background:transparent`, whose later generic `.panel` rule overrides the action dialog's surface. Both original editable FORM and fixed-review DIV compute transparent background, and background page prose overlaps the fixed content in the captured screenshot. This is a current-composition IAB RED, not yet a claim about historical production behavior or a defect unique to the new review component. The existing589 stylesheet contains that generic rule, but no589 runtime reproduction was run. Minimal floating-dialog surface priority and exact IAB recheck follow separately; no product redesign is proposed.

57ae47c9 retains that IAB RED. The minimal `.panel.action-dialog` specificity reuses the current `--mote-surface` token. Web TypeScript/Vite build `/tmp/m13-action-surface-web-build.log/.exit`0, then actual IAB edit and fixed panels both compute rgb(35,34,32), matching the #232220 theme surface; readable opaque-panel screenshot is captured in this task. Rebuilding while the original host was already running initially left new assets unregistered404; a controlled own fixture restart resolves that test lifecycle issue and is not called a production regression. Full steps, state snapshots, first stdin-control limitation and exact cleanup are in `/tmp/m13-iab-actions-gmail-c211.md`.

Same fresh IAB host original Sources/Gmail card creates an owned disabled connection and reopens its actual client/callback fields with blank, preserved-secret input. Start authorization remains disabled; actual snapshot confirms syncAuthorizedfalse and B empty. No Google authorization or native calendar action occurred. Both temporary tabs are closed, fresh fixture returns closed:true/EXIT0 and its database directory is absent. The earlier host was stopped only after verifying its exact script/port/disposable directory. No M13 test/service/build remains running. Bounded style re-review and final own affected remain pending; all OPEN capability rows remain explicit.

M14 bounded exact10f style re-review reports no confirmed finding; it did not independently run IAB. `/tmp/mote-m13-review-m14-calendar-c56.md` is M13's separate read-only review of that peer's own calendar increment, no new confirmed finding and no test/build execution. Shared Files e274 review `/tmp/mote-m13-review-joint-files-e274.md` identifies a new source-stream error forwarding gap; the joint owner independently reproduced the unhandled source error in a production-exportTar child process and reports its minimal pipeline fix/positive tests separately. It is not an M13 runtime change or a historical exporter failure claim.

### Original Google Calendar card: owned migration RED

`/tmp/m13-google-calendar-red.log/.exit`1 reaches the actual original Sources card with real installed/enabled M10 Google Calendar instances for A/B. The card has no owned connection selector and remains tied to absent global Google status. This is a migration completeness RED, not a claim that the old single-user runtime failed. Only Google external OAuth/calendar network I/O is synthetic; original renderer, M01/M04/M09/M10/M05/M03 are actual. The test retains the subsequent authorization, selected calendar, durable sync ACK and account-transition assertions for GREEN.

The Google source card now reuses the existing owned Gmail settings/lifecycle component with an explicit provider discriminator. Calendar list and selection use the existing M10 durable operations, and sync/disconnect keep original operation IDs for uncertain admission ACKs. The original calendar chooser and read-only authorization remain in Sources; no new backend runtime, permission or configuration default is introduced. Both cards continue to use the account-keyed subtree and the original immutable Api.

First implementation run `/tmp/m13-google-calendar-green.log/.exit`1 identifies an authored parsing mistake: the actual sync result's `calendars` is a count, while list-operation `calendars` is an array. Treating only the list array as choices fixes the new implementation without changing the actual backend or test assertions. `/tmp/m13-google-calendar-green2.log/.exit`1/1 EXIT0 then passes; expanded `/tmp/m13-google-gmail-composed.log/.exit`3/3,no skips EXIT0 (14.95s) also reruns both original Gmail settings and OAuth/task/ACK/account matrices.

The expanded original Sources test creates a disabled Google instance, reopens its actual provider-specific configuration without exposing the secret, authorizes A and B with equal connection/calendar/event IDs, reads the actual calendar-list task, explicitly saves choices and ingests their separate original events through M03. A sync ACK is lost only after real admission; the retry body/operation remains identical and displays the durable imported/duplicate result. Detached A calendar-save controls emit no B request, and a held successful B authorization link cannot fill A after switching back. No real Google service or native calendar effect occurs. `/tmp/m13-google-i18n.log/.exit`0 checks8441 authored messages and synchronized Android catalog. Types/build/IAB, independent small-delta review and final affected remain pending; M14's already-running fixed candidate excludes this later Web increment.

M15 bounded exact0384 review `/tmp/mote-m15-review-m13-google-0384.md` reports no new confirmed P0/P1/P2 without tests/build/IAB or edits. The separate M10 configure-await concurrency concern remains unconfirmed; the UI review does not establish its outcome.

### Shared Files read composition and original-byte renderer RED

Only shared stable e274 + stream regression bf00 + pipeline fix07c were picked, own d851/927/2ed; the intervening correction RED/WIP was excluded. The only composition conflict was the formerly deleted file-views test, resolved by retaining the new actual scoped fixture. No peer runtime or store was recreated. `/tmp/m13-file-original-red.log/.exit`1 reaches the original FileDetail with real M01/M03 same-ID A/B generated WAV originals: it assigns the authenticated M03 URL directly to the audio element, without the required original Api headers. This is a consumer migration RED, not a claim about the old bearer-compatible file server. Full shared Files correction/speaker/review/Imports parity remains OPEN.

FileDetail now obtains the existing play ticket and fetches its exact original reference through the captured Api before exposing a Blob URL to image/audio or download. Web results must stay on the current origin and original ID; status, full-body size and SHA-256 must match the actual descriptor before publishing. Account/session remount and controller retirement revoke media/download object URLs and suppress late body/hash results. Existing bearer fixture behavior uses the same authenticated fetch; no new server path or permission is added.

`/tmp/m13-file-original-green.log/.exit`3/3 EXIT0 first passes the original-byte renderer plus both legacy snapshot/summary characterizations. Expanded `/tmp/m13-file-original-final-narrow.log/.exit`3/3,no skips EXIT0 (3.34s) verifies generated same-ID A/B WAV bytes, actual Wire2/Ingress3/session headers, A and B full downloads, revocation of A media URLs, detached A download emitting no B original read, a held successful A byte body not creating any new B Blob, fresh B playback and a damaged actual successful body rejected before download publication. Only transport timing/corruption and browser download sinks are synthetic. Actual M01/M03 admission, original bytes and tickets are used. Pending correction/speaker/review/import/backend writes are not declared accepted by this read-only matrix. Same-candidate types/build/full Web/IAB and bounded small-delta review remain pending.

Joint exact17fd bounded review `/tmp/mote-joint-review-m13-file-original-17fd.md` reports no new confirmed issue; it ran no tests/build or IAB. A further actual full-entry check `/tmp/m13-file-entry-red.log/.exit`1 reveals another migration gap: original Files card→Library capture reader reaches the archived capture but omits FileDetail, because the scoped raw reader does not expose the existing client `fileArchive` presentation proof. This is distinct from the now-working direct FileDetail byte chain. The next fix will expose that marker only for the current owner's real enabled M03 file original, never infer it from an arbitrary file-kind/reference-only record or create another Files store.

The raw reader's tiny presentation marker now joins the current owner's real M03 original, enabled source and M06 original-format receipt. Only physical file/processor inputs qualify. The first new negative `/tmp/m13-file-entry-green.log/.exit`1 correctly caught my initial implementation treating the archived JSON envelope of a reference SourceItem as the referenced file original; this is a defect in the new marker, not an historical server claim. The exact format proof fixes it. `/tmp/m13-file-entry-green2.log/.exit`2/2,no skips EXIT0 (3.20s) reruns original Files→Library→FileDetail and original byte/account chains, including A-only404/B same-ID positive, reference-only negative, paused A source marker removed and B retained. No Files store or projection is duplicated.

Current short gates all EXIT0: `/tmp/m13-google-files-shared-build.log/.exit` fresh shared TypeScript; `/tmp/m13-google-files-types.log/.exit` full Server and Web noEmit; `/tmp/m13-google-files-web-build.log/.exit` Web TypeScript/Vite. The source includes Google0384, stable shared Files e274/bf00/07c, original bytes17fd and the tested raw file marker. IAB for these two increments, final affected/remote head and raw-marker independent review remain pending. Heavy slot is explicitly released; M14's454 affected pass is earlier, separately reported dependency evidence.

Joint bounded exactbe6 review `/tmp/mote-joint-review-m13-file-entry-be6e.md` reports no new confirmed P0/P1/P2; it performed no tests/build. Actual IAB at cleanbe6 now exercises original login/Sources/Google Calendar OAuth-task/calendar selection/sync: the UI displays1 new version, and actual A metadata contains that event while B has no connected calendar or event. Only the external Google I/O is generated. The same built renderer follows Files card→Library detail→authenticated original Blob, loads A's generated64×64 image, then the original account switch shows only B's equal-ID file and separately obtained64×64 Blob. Browser screenshots and actual host state are recorded in `/tmp/mote-m13-iab-google-files-be6e.md`. The default host listen EPERM preceded browser work; the identical local synthetic fixture passed standard review. Tab closed, host close returned closed:true/EXIT0, disposable directory absent.

This actual entry also exposes an OPEN migration gap: ImageProgress still requests absent `/api/images/:id` and displays503 scope_unavailable even while the original bytes are readable. Image status/retry/cancel and whole Files parity are not accepted. The narrow byte and account tests remain separate evidence.

Shared Files write freeze643812 + reference-envelope regression9b96 + filter/actual-WAV fixa10 are now composed as d7d94d44/c8ccc337/8ba06870. Only absent joint test/docs modify-delete conflicts were resolved by retaining the incoming complete actual tests/docs. The bounded algorithm/filter review `/tmp/mote-m13-review-joint-files-6438.md` found no new confirmed issue; joint execution evidence is7 Files cases,15 portable cases and types/scope0. Own composed renderer/type/build/final gates still follow; these peer results do not become own acceptance.

An attempted non-sensitive coordination message to M15 was denied by automatic approval before sending because explicit authorization for that destination was not recognized. Known NOT SENT, no retry/proxy/alternate channel. Exact a88 runtime/regression dependency information remains in `/tmp/mote-m13-m15-disconnect-handoff.md` for parent review. This does not block local implementation or tests.

The composed shared write contract has an actual original-renderer migration RED: `/tmp/m13-file-corrections-red.log/.exit`1. Actual generated WAV→M03→M04 lease→M05→M06 external-ASR-only fixture produces the owner transcript with SPEAKER_0 and its original FileDetail expands/corrects the canonical segment. The old naming form is absent because it requires a separate legacy diarization artifact. No raw artifact, speaker or task row is fabricated. Subsequent same-artifact naming/correction/A-B assertions remain in the durable test for GREEN. Shared model-assisted review/control gaps remain separate OPEN rows.

The minimal original FileReview now presents the current artifact's actual loaded anonymous speaker labels and existing owner-confirmed names, with the original naming copy/control. It submits the fixed artifact ID through the shared name endpoint; retirement aborts and disables old callbacks, and an artifact change remounts the review draft. It invents no acoustic samples or diarization output. `/tmp/m13-file-corrections-green.log/.exit`1/1 EXIT0; expanded actual ASR/naming/correction + original card/bytes + legacy snapshot/summary `/tmp/m13-file-corrections-final-narrow.log/.exit`5/5,no skips EXIT0 (2.70s). The expanded test also admits A naming before holding its real successful response, switches to B and edits B's fresh input, then proves the late A result neither overwrites B nor reports B success. A's already admitted fact is preserved; explicit B naming is a separate positive. Independent review, current type/build/whole Web and own affected remain pending.

An additional actual same-chain label RED `/tmp/m13-file-current-label-red.log/.exit`1 reaches successful owner correction, then finds the current M06 transcript still described as “尚未校正”. Scoped `transcript` denotes the current extraction and does not assert an uncorrected artifact; the old bearer diarization label cannot be inferred from that kind alone. No old single-user runtime failure is claimed. The fix will use the existing neutral transcript wording for this scoped shape, retaining the old explicit uncorrected fixture label and raw/current export distinction.

The one-line scoped label condition now uses the existing neutral transcript wording; the unchanged bearer fixtures retain their explicit raw label. `/tmp/m13-file-current-label-green.log/.exit`5/5,no skips EXIT0 (2.71s), including the same actual corrected-body assertion and delayed owner-confirmation/A-B matrix. No source/history/artifact policy or backend changed. Current types/build and independent tiny-delta review remain pending while the container thread holds the full heavy gate.

Bounded native-consumer reading prompted an additional own Web matrix:101 actual ASR segments place a pre-confirmed second anonymous label only on page2. `/tmp/m13-file-speaker-pagination-red.log/.exit`1 confirms my new Web naming implementation posts only visible-page names and removes that later confirmation. This is a defect in957, not a historical product allegation or a peer defect. The shared contract replaces the complete exact-artifact name map; the Web form must therefore read every current-artifact page before submitting. The unchanged later-page preservation assertion is retained for GREEN.

The form now reads the complete current-artifact chunk sequence before exposing a name-map submission. Each page retains the same artifact proof; invalid/nonadvancing pagination or inconsistent confirmations reject, and account/artifact retirement aborts the read. Existing confirmations from later pages remain in the fixed full map, including when editing the first visible text page. `/tmp/m13-file-speaker-pagination-green.log/.exit`5/5,no skips EXIT0 (4.67s), retaining the101st-segment confirmation, correction/name retention, actual admitted A late ACK→B draft and fresh B positive plus original-byte/legacy characterizations. No backend merge semantics or new segment limit was introduced.

Delivered M12 a50d1c88647780ebd27d7a247ec4ffbc170ab87f and M16 eec967c66304fef78f683e3445900287e75bac21 are now explicit merge ancestors. Their diff from already-tested107 is only the3 design/validation files, with no application/package/script/protocol delta. Current new Files source is9d89227201172f828e43c04da8e377e76d83afd8; later dependency merges/design edits are documentation only. Own current type/build/whole-Web/affected remain unrun for this new runtime. The container thread retains sole heavy ownership; no borrowed peer gate is claimed.

Original Lark page has a separate real-host migration RED `/tmp/m13-lark-owned-valid-red.log/.exit`1: installed/enabled real M10 same-ID A/B connections exist, but the original page has no owned instance selector and still uses its retired global vendor facade. Only CLI I/O is generated. The durable renderer scenario retains actual environment-check/task-progress/authorization and A/B retirement assertions for the thin consumer adaptation; no CLI installation or real external authorization occurs.

The first thin adaptation reuses the original Lark panels through a fixed owned-instance M10/M05 presentation adapter. It does not create another runtime or server alias. The existing real task progress already carries the device-code authorization job; environment check waits for its actual completed result instead of treating a fresh adapter's default flags as a CLI probe. The original shared settings form supports Lark's ordinary connection settings without Google fields, preserving disabled creation and explicit M09 lifecycle. CLI installation remains visibly unavailable/OPEN because M10 has no such ordinary operation; no shell or installation is exposed.

`/tmp/m13-lark-owned-green.log/.exit`1/1 EXIT0 (3.94s) exercises actual owned selection, real CLI-check task, real waiting job progress/QR link, A→B retirement and a detached old cancel emitting no B cancel. The React QR async act warning is retained; it is not a product failure. Document/calendar scope, source-ID projection, preview/sync/context/partial retry, broader lifecycle, types/build and independent review are not accepted by this first narrow pass. The separate Files runtime Web TypeScript/Vite build `/tmp/m13-files-speakers-web-build.log/.exit` EXIT0 ran before this Lark runtime.

Expanding the same actual chain confirms the source-projection candidate: `/tmp/m13-lark-source-identity-red.log/.exit`1 reaches real Lark login and saved document selection, with an actual registered M03 connector source. The M10 task result instead exposes its adapter-local lark-docs ID, so the original SourceContextEditor requests that nonexistent public source404 and pause/context controls cannot bind the real source. This is a public scoped-contract migration defect, not an old single-owner production allegation. The next minimal existing-M10 projection will map only owner+instance+local ID through connector_sources; UI must never guess a source hash or add an alias.

The existing M10 status/task publication now projects Lark's document source through the exact owner+instance+local mapping. No source, queue, task, credential or model work is created by this projection. `/tmp/m13-lark-source-identity-green.log/.exit`1/1,no skip EXIT0 (4.12s) retains the same real scope-save and requires the original SourceContextEditor to read the actual registered M03 source/context200; no local-ID404 remains. This tiny backend change still requires current typecheck, bounded independent review and connector adjacent regression; it is not a complete Lark/recording freeze.

At runtime0a3f268d3e8ddfaa0ae97e6261c763c31be37aaf the fresh shared build, full Server noEmit and Web TypeScript/Vite build all EXIT0: /tmp/m13-lark-{shared-build,server-types,web-build}.log/.exit. The short heavy slot is released. These are build/type checks, not whole-Web, affected or complete Lark acceptance.

Expanded actual original Lark renderer chain now passes metadata-only preview (zero document fetch), explicit first confirmation→M03 original body, A-only source context CAS and original pause/resume. `/tmp/m13-lark-sync-expanded.log/.exit`1 then reaches a real blocked M05 sync after generated document I/O failure: the UI shows the terminal failure but still displays the previously cached documentSync0 failures and exposes no per-document retry. This is a defect in the new thin presentation adapter's terminal-failure refresh, not an historical product claim. The unchanged real partial-failure/retry/cancel/calendar assertions remain for GREEN.

Terminal failures/cancellations in the thin Lark adapter now read the existing owned M10 status GET for the complete durable document journal and saved scope. The last actual CLI probe flags are kept distinct from a newly opened adapter's unprobed defaults; no new task, CLI call, progress payload or framework is created. `/tmp/m13-lark-journal-green.log/.exit`10/10,no skips EXIT0 (13.94s) reruns the unchanged failure/retry scenario plus9 original Lark UI characterizations. The actual chain also verifies explicit source pause/resume/context, exact same-revision original dedup, cancelled held document I/O preventing new original publication, real calendar-list/selection/event sync and B isolation. An earlier development attempt used a final task-progress status snapshot and passed1/1, but was removed before commit because task metadata has a32KiB bound; it is not the delivered approach. Current full types/build/whole-Web/affected and independent delta review remain pending.

A legal fifty-document preview with1900-character provider titles now has an actual size-boundary RED. `/tmp/m13-lark-large-preview-valid-red.log/.exit`1 first proves the real owned M10 status contains all50 entries and exceeds24KiB, then the original renderer remains on its prior running view instead of showing that complete preview. M10 safeResult reduces oversized task results to completed:true, which cannot convey the real CLI snapshot or document state. The initial test used an incorrect later button label; the durable version checks the producer's full snapshot separately and the correct first-confirmation button. No increased UI/operation limit or truncated preview is proposed.


The oversized real Lark status task now keeps its actual CLI snapshot/job metadata and an explicit statusInConnection:true marker; the existing owned M10 GET supplies the full saved scope/document journal. Only Lark status-shaped task results use this variant. Other provider results retain their prior behavior; no new endpoint/store/scheduler, title limit or preview truncation is added. `/tmp/m13-lark-large-preview-green.log/.exit`10/10,no skips EXIT0 (16.09s) retains the unchanged valid size-boundary scenario plus9 legacy characterizations. Expanded `/tmp/m13-lark-large-reload-green.log/.exit`1/1,no skips EXIT0 (16.53s) additionally remounts a fresh actual A session/CLI-check task over the already-large persisted preview and verifies all50 entries and actual version/connected controls recover.

This is the last minimal check before the parent's requested pause for a separate theme task. Current compact-result source has not run Server/Web types/build, whole Web, affected, or independent review. UTF-8 byte-vs-character task metadata boundaries and oversized calendar inventories are explicit UNVERIFIED cases, not claims of a confirmed failure or full Lark parity. No new regression is started while pausing. Every dataset/identity/provider response in these tests is generated; no local central private data or real model was used. The new user rule requires a verified local Codex GPT-6.1 sol entry for future real-model regression and forbids central private data/derivatives in Git; staged source/test/docs were reviewed accordingly.

Resumed original M13 at clean72ee; no theme code is included. The previously unverified UTF-8 task-result boundary now has an actual renderer/backend RED: `/tmp/m13-lark-utf8-valid-red.log/.exit`1,1case. A legal20-document preview with600 Han characters per title is fully persisted by real Lark discovery. JSON has fewer than24000 characters but exceeds32768 UTF-8 bytes; actual M05 terminal state is blocked rather than succeeded. The fixture checks the real completed journal and task receipt separately, not merely a UI timeout. Earlier ASCII50 preview success does not cover this input. Only generated CLI output is used, and the container's sole heavy gate remains undisturbed by this single source-level fixture.

UTF-8 Lark status receipts now choose the existing compact variant by actual UTF-8 byte length, with an explicit same-budget check on the compact metadata itself. No preview/title is cut, no generic-provider policy is changed, and an unrepresentable summary fails honestly before M05 storage. Same unchanged actual20-Han-title case `/tmp/m13-lark-utf8-green.log/.exit`1/1,no skips EXIT0 (17.84s); prior50-ASCII/current-login/source/retry/cancel/calendar/A-B assertions remain. The post-GREEN compact-summary guard is still subject to current type/adjacent gates; no full acceptance implied. Joint bounded review of72 source reports no new confirmed finding (/tmp/mote-joint-review-m13-files-lark-72ee.md), independent of its noted actual UTF-8 follow-up, still-open large calendar and malformed-task candidates.

Joint explicitly declared43dbf8ab6e55f747bd4c941d0419a86955826123 consumer PREP freeze (production1f377, two later generated tests/docs). Own feature now composes it, including its delivered M14final lineage, generic staged uploads/private previews/confirmation/GC/portable fixes. Add/add shared Files/export/fixtures/docs and M06 import/lifecycle conflicts retain the exact newer Joint implementations; original M13 Web/source proof and Lark changes remain. App keeps all existing registrars/authority bindings and adds the configured fixed SourcePacks argument. English/Android catalogs are the exact union; `/tmp/m13-joint43-i18n.log/.exit`0 (8444 messages), `/tmp/m13-joint43-scopes.log/.exit`0. No builds/fullsuite/Gradle occurred during the container's sole-heavy gate. Only declared synthetic source/tests/technical docs were staged; no private Central data or theme PR content is included. Shared Imports still needs original Web renderer consumption and current composition gates; the newer unknown-worker M06 issue is Joint WIP, not consumed or counted closed here.

Original Imports renderer characterization on composed Joint43db: `/tmp/m13-imports-renderer-first.log/.exit`1/1,no skips EXIT0 (8.52s), actual original file picker/ImportQueue→raw staged parts→M01/M03/M04/M05/M06 private preview→explicit confirmation→one saved capture. Before confirmation A has0 captures. Equal-ID B is created through the real entry, old A confirm emits0 requests after B switch, B displays only its own history, and fresh A restores/continues the durable preview. No new consumer/runtime code was necessary for this normal boundary. External model HTTP is generated and restricted to the exact loopback fixture, never a live vendor. React act warnings are retained. Optional legacy image-profile/settings calls and other OPEN capabilities are not accepted by this positive.

Default sandbox first command stopped at listen EPERM before business assertions. The identical command passed standard exact-action review and ran successfully. The first log pathname was inadvertently reused; the original command's actual unread stdout and EXIT1 were recovered from its completed execution session to `/tmp/m13-imports-renderer-sandbox-first.stdout` and `.exit` (captured stdout, not an invented full raw log). Temporary fixture HTTP/app/DOM resources closed via test cleanup. No hidden Electron, private Central data, software installation or heavy gate was used.

At exact815c5fe6884f196fd2a2cefae7ae56d813cb2a8a, current composed short gates all actually EXIT0: `npm run build -w @mote/shared`, `npm run typecheck -w @mote/server -w @mote/web`, and `npm run build -w @mote/web`; logs `/tmp/m13-composed43-{shared-build,types,web-build}.log/.exit`. This includes declared Joint43db, original Imports characterization and the Lark UTF-8/compact-summary guard. Vite retains its existing large-chunk warning. Heavy slot explicitly released before the container's next final gate. Whole Web, own affected/Android, new representative IAB and all OPEN capability rows remain unaccepted by these build/type checks.

Expanded unchanged original Imports producer/renderer `/tmp/m13-imports-fault-expanded.log/.exit`1/1,no skips,EXIT0 (7.43s). The transport drops an actual successful staged commit ACK, then an actual202 import admission ACK. Original retry controls preserve upload ID and exact admission body/request ID; real server reports the committed file, so only one part PUT and one commit occur, and only one import is present. A fully authorized200 history response is held across switch to equal-ID B and cannot refill B; a real File.slice read is separately held before upload PUT, then A retirement prevents any further part or admission with either account. Fresh A preview/explicit confirm and B positive remain. No runtime change was required by these characterization/fault cases; all temporary model I/O is generated loopback. React act warnings remain recorded.

Joint exacta4df bounded review `/tmp/mote-joint-review-m13-lark-a4df.md` reports no new confirmed P0/P1/P2 in UTF-8 full/compact result budgeting, without test/build execution. Own bounded M15 WIP recording reader37c8 review `/tmp/mote-m13-review-m15-recordings-37c8.md` similarly has no new confirmed issue; it does not declare that producer or its untested consumers frozen. No peer file was modified and no restricted message retry occurred.

The malformed-task candidate is now an actual transport-boundary RED: `/tmp/m13-lark-task-identity-red.log/.exit`1,1case (25.63s). Only the `id` of a real successful pending Lark preview's GET task receipt is changed to another valid64hex value. Original renderer accepts it and reports the pending preview completed instead of rejecting the mismatched receipt. All real backend/earlier matrix assertions pass first. This is a new thin-consumer identity-validation defect, not evidence of a server producing wrong IDs or cross-account disclosure. The same regression is retained for a minimal response-fence fix.

The thin Lark adapter now compares every polled/cancelled response to the captured pending task ID before applying progress or completion. Sync/disconnect admission also validates the same64hex format already required by other owned operations. `/tmp/m13-lark-task-identity-green.log/.exit`1/1,no skips,EXIT0 (21.35s), unchanged actual malformed-response case plus the complete existing Lark journey. It rejects the damaged response while preserving actual server work; no new permission, query or task is introduced. Current post-fix types/build/full-Web and bounded follow-up remain required.

The oversized-calendar candidate is now actual RED: `/tmp/m13-lark-calendar-large-valid-red.log/.exit`1,1case. Real Lark provider returns20 permitted calendars with600-Han-character names; actual M05 calendar task is blocked instead of succeeded, so original renderer cannot show all choices. The preceding earlier large document preview and normal calendar selection remain positive. First `/tmp/m13-lark-calendar-large-red.log/.exit`1 reaches the same missing choices through the original UI; the durable version separately asserts the actual task state, without a timeout-only inference. This is a new scoped result-budget migration gap, not an old production allegation. Full labels must be preserved and remain owner/connection/task bound.

Complete large Lark calendar inventory now reuses the existing encrypted connector vault and owned status GET. The admitted task stores its exact generation/task ID and full choices; only its small `{calendarInventory:taskId,count}` marker enters task metadata. Consumer requires exact task proof/count, well-typed unique choices, original Api/signal; status revalidates its captured connection after adapter close. Small calendars and other providers keep their previous result contract.

First same-case `/tmp/m13-lark-calendar-large-green.log/.exit`1/1,EXIT0 (20.20s). Expanded final generation/identity code `/tmp/m13-lark-calendar-snapshot-green.log/.exit`1/1,no skips,EXIT0 (18.57s) additionally verifies complete20 names, same-ID B lacking A snapshot, actual status receipt with only snapshot task ID damaged rejected, fresh exact snapshot positive, and the existing malformed task/UTF8/document/source/partial-failure/cancel/A-B chains. Only a later formatting change expands the status method into readable lines. No current type/build, full-Web or independent review is claimed yet; container remains sole-heavy.

Original Imports capability RED `/tmp/m13-imports-directory-red.log/.exit`1 (1.52s): actual same-account generic import contract rejects a generated server-directory request403 before any filesystem access, but the browser form still offers that route enabled. Existing local folder picker remains present. This is a consumer/established scoped-contract mismatch, not a new directory policy or a historical host-import failure. The fix must retain the explicit unavailable entry and local file/folder intake, while bearer characterization retains its server-directory behavior.

The original host-directory entry now remains visible but unavailable only for Web connections, with explicit local file/folder wording and a submit-time fence. It follows the already declared scoped403 policy; bearer fixtures retain their original directory route. `/tmp/m13-imports-directory-green.log/.exit`1/1,no skips,EXIT0 (6.44s) retains the actual403 plus all staged-byte/admission-ACK/preview/confirm/A-B/late-history/File-read checks and enabled local folder picker. `/tmp/m13-import-directory-i18n.log/.exit`0 (8445 messages) precedes one final local-folder heading copy and its synchronized translation; current whole i18n/type/build remain next. No server policy/runtime changed.

Original credential page actual concurrency RED `/tmp/m13-credentials-concurrent-red.log/.exit`1 (1.35s): two same-batch original form submit events produce two real M01 MCP grants although the existing busy-state guard intends one operation. Only the last secret is displayed. No mock credential, private account or MCP authorization is fabricated; actual account routes produced both. This is a current page concurrency defect; no old baseline runtime reproduction or cross-account disclosure claim is made. Subsequent source-scope, normal-private rejection, secret retirement and revocation assertions remain for GREEN.

A synchronous ref now guards the original credential page's existing operation boundary before React state can commit. `/tmp/m13-credentials-concurrent-green.log/.exit`1/1,no skips,EXIT0 (1.85s), unchanged concurrency assertion plus actual original feature-page read grant/all-own-source semantics, explicit existing-source write grant, normal privateAPI denial for MCP, one-time secret hiding, same-source-ID B positive, held admitted A mint ACK→B no secret fill, retired revoke control emitting no B DELETE, fresh A inventory without recoverable token, actual A revoke invalidating its original MCP authorization while B/A-read remain valid. Only synthetic accounts/data, actual M01/M11 authorization; no SDK/provider/runtime is mocked. Existing main account/viewScope remount is retained by the actual feature entry fixture. Full current types/build/whole-Web/affected and independent tiny review remain pending.

Expanded credential characterization explicitly calls real `/api/auth/logout` while the already admitted A mint ACK is held, then logs in B and releases A. `/tmp/m13-credentials-logout-green.log/.exit`1/1,no skips,EXIT0 (1.64s): previously issued read/write MCP grants retain their original A account across browser logout, B cannot receive the old secret, and subsequent exact A revocation preserves B. Earlier wording about logout is now backed by an actual logout route, rather than only a login replacement. No runtime change after15f was needed.

Existing bearer directory failure/edit characterization `/tmp/m13-import-directory-legacy.log/.exit`1/1,no skips,EXIT0,0.57s is retained; current `check:i18n` `/tmp/m13-current-i18n.log/.exit`0 validates8446 messages with synchronized Android. These are narrow source/static checks during the container's exclusive gate, not whole-Web/type/build evidence.

At exact6201603ed4a73881c92d2d8f988536834a5f7b52, fresh shared build, Server/Web noEmit and Web production build actually EXIT0 (`/tmp/m13-620-{shared-build,types,web-build}.log/.exit`, `/tmp/m13-620-short-gates.sha`). Standard-reviewed full Web same-SHA run actually EXIT1:522 total,518 pass,4 fail,0 skip,56.92s (`/tmp/m13-620-full-web.log/.exit/.sha`). This failure is preserved, not counted as a gate pass.

The four failures were legacy media fixture mismatches after the authenticated-byte reader17fd: request-only Api stubs supplied playback URLs but no raw-byte method, and image assertions still demanded naked source URLs. No production change was made. The fixtures now supply generated JPEG/byte Responses through their captured Api.raw; image assertions verify the produced Blob bytes, resize reuses one byte read, and retired playback results cannot start a stale byte read. Existing image-error, session-retirement, correction/chunk and audio-seek assertions remain. `/tmp/m13-media-fixture-green2.log/.exit`4/4,no skips,EXIT0 (0.52s) from the Web workspace. First narrow invocation from repository root selected the wrong JSX tsconfig and failed React-is-not-defined before the intended assertions; `/tmp/m13-media-fixture-green.log/.exit` is retained as command-context error, not a product RED. Actual M01/M03 binary identity/authentication proof remains the separate multiuser-file-original test; these legacy fixtures do not replace it.

Joint explicitly declared c45fdb4a2518fef0d5072b02aafbe8f46cb5a90b and doc-only f6ac6cd1 frozen. They are composed by de312ad650d08d2bdd867f67fc5df6d0c95414a2 without conflicts. Own bounded reads of1a3b/ce357/c45 found no new confirmed P0/P1/P2; owner source tests/types remain owner evidence. No later Joint Files/forget/attachment/profile WIP or Theme code was composed. Current post-merge whole-Web/types/affected remain unrun.

Representative actual IAB Imports journey completed on de312 backend source and unchanged620 Web build. Original browser login and file chooser selected one generated31-byte text file; original form name/instruction queued actual M03 upload begin/part/commit and202 import. Real M04/M05/M06 plus a generated localhost provider produced an owned private preview. Before confirmation, actual A captures were0. A click on the original explicit-confirm control produced one saved record. A distinct B job was admitted through the actual route using the exact same import ID. Original account-settings switch/logout/login then displayed only B title/body; a real browser reload restored B without A text. `/tmp/m13-iab-imports-final.json` retains exact ID, states/counts and method/path/status metadata; `/tmp/m13-iab-imports-b.jpg` contains only the generated B page. B fixture admission is backend setup, not an additional browser upload claim. No live model, external vendor, real personal data, hidden Electron or persistent permission was used.

The earlier IAB upload call lost transport. On recovery, the original host no longer listened and its exec session did not exist; read-only original fixture SQLite showed imports/archived files/upload parts/captures all0, while the old tab remained an empty form (`/tmp/m13-iab-interrupted-state.json`). Nothing was blindly replayed. A new independent generated fixture was started after exact-action review, and the completed journey above was performed there. Its own tab closed and host acknowledged cleanup closed:true/EXIT0. Browser file selection was unusually slow; that tool latency is not a product failure or a cancelled successful upload. This IAB positive does not accept the separate delayed-response matrices, named image profiles, attachment pipeline, wider controls, or final affected gates.

Joint bounded tiny review `/tmp/mote-joint-review-m13-credentials-import-ui.md` found no new confirmed P0/P1/P2 in15f synchronous credential operation locking or bd908 Web directory guards; no independent tests/build were run. The existing scoped403 boundary does not establish native bearer directory parity.

Consumer-requested pure Server Lark bundle is retained on local branch `codex/mote-m13-public-lark-results`: parent M15 declared49347f929c3919a6e8471efbe458e6c0806a79fa, RED335a167c, fixd259c28bc17efdfa1f816081ab1af3ddd0cce93d. Its diff adds only one Server regression file and the already reviewed a4df/84e-equivalent connectors.ts logic, not the Web/Android WIP. Actual production parent with final test content fails both actual M05 budget assertions (`/tmp/m13-lark-public-result-valid-red.log/.exit`2fails/EXIT1); the same tests with minimal patch pass2/2/no skip/EXIT0 (`/tmp/m13-lark-public-result-green.log/.exit`,2.57s). Existing original real Lark docs/calendar/partial retry/restart characterization on literald259 passes1/1/no skip/EXIT0 (`/tmp/m13-lark-public-legacy.log/.exit`,3.63s). First setup attempt omitted the actual login operation and failed before the target assertions; `/tmp/m13-lark-public-result-red.log/.exit` is fixture setup error, not the valid budget RED.

Public bundle reuses the exact current owner/source/task/epoch/vault contract and changes no routes, schema, permissions, discovery semantics or background runtime. Borrowed existing installed dependencies were symlinked only into its temporary isolated Git worktree; no install or peer-file write occurred. Current620 Server/Web types cover the equivalent production logic, but no public-branch fresh type/build/full affected pass is claimed. The same backend regression file is retained on the M13 feature for composed checks.

Current composed literal ece2e30ffd2059f7e16dba577e62f233d1087067 actually passes fresh Shared build, Server/Web noEmit, Web production build and complete Web522/522,no skips,EXIT0 (77.73s). Exact logs `/tmp/m13-ece-{shared-build,types,web-build,full-web}.log/.exit`, `/tmp/m13-ece-current-gates.sha`. This retains the earlier620 full failure and test-only fixture repair rather than relabelling it. Current composed actual Server Lark cases also2/2,no skip,EXIT0 (4.56s), `/tmp/m13-lark-composed-result-green.log/.exit/.sha`. No own affected/Android/full shared-module acceptance is implied.

New consumer composition b165def6b9492ecd9a842b5354d274f7f6df9927 merges declared Joint PREP8177 plus required source-incarnation repair519dc3f5; scope includes frozen QR production source, completed Container source and newer common Files controls/attachments. No later silent JointHEAD or Theme source is taken. This invalidates whole-combination gate claims for the new candidate; ece remains its own completed checkpoint.

M15-authorized browser-purpose consumer a648 (with underlying edf producer already in the QR/Joint source) is adopted without merging the Android feature. Original component regressions41f25299/23e19b95 are retained as local RED af1027b5: actual M01/M03 Accounts/SQLite renderer3/3fail,EXIT1 (`/tmp/m13-client-purpose-valid-red.log/.exit/.sha`). Default device consent wrongly promised all Central features; request-ID replacement reused old ready text; an actually committed held approval reply invoked done after unmount. The exact tested M15 immutable Api+request binding, purpose wording, abort and layout retirement fix closes the same3/3,no skips,EXIT0 (3.91s), `/tmp/m13-client-purpose-green.log/.exit`. First command used a wrong workspace-relative file path and never reached tests; `/tmp/m13-client-purpose-red.log/.exit` is command error, not the valid RED. Only synchronized wording was added to English catalogs; no device/private API grant widened or second approval/auth service introduced. Current types/build/full-Web remain next for this new source.

Expanded unchanged fix characterization now mirrors `main.tsx` account-keyed private Suspense under StrictMode. Actual A approval commits, its successful HTTP reply is held, original browser logout and B login occur, then release cannot invoke the retired done or send an old A button with B Cookie. Both actual M01 poll grants retain their original A/B users and central purpose; B's fresh consent remains positive. `/tmp/m13-client-purpose-strict-ab2.log/.exit`4/4,no skips,EXIT0 (19.74s), all original three cases retained. The first extension mistakenly reused the same DOM button across an unkeyed prop update, so its old variable was actually B's live control; `/tmp/m13-client-purpose-strict-ab.log/.exit`3pass1fail is an invalid retirement assumption, not a production regression. Adding the real account tree key corrected the fixture; no production change was needed.

Independent rendered finding at Joint2528/production519: the unchanged browser journey twice timed out waiting for B's note while a successful A GET response was held. No A disclosure was observed. Inspection confirms the fixture pauses only its first matching response, not all B requests. An allowed IAB characterization using the production Api, actual M01 Cookie login/logout and M03 same-ID notes reproduces the browser's shared URL cache-entry wait: default GET B completes after20,006ms while A remains held; explicit request `no-store` completes in2ms with A still held. The common server already sets response `Cache-Control: no-store`, but those headers cannot release the browser cache entry while the response is paused before headers. Evidence: `/tmp/m13-notes-cache-iab-red-and-control.json`, `/tmp/m13-note-cache-probe3.log`. This is a private-read availability defect, not evidence of cross-owner content disclosure.

The minimal Api fetch change forces request `cache: 'no-store'` after caller options. The durable regression is RED f502e94f (`/tmp/m13-notes-cache-unit-red.log/.exit`,1fail/3pass) and preserves fixed authority while checking normal GET, caller `force-cache`, and native/bearer raw reads. Same suite plus Web auth and background Notes refresh is24/24,no skips,EXIT0 (`/tmp/m13-notes-cache-adjacent-green.log/.exit`); Web production build0 (`/tmp/m13-notes-cache-web-build.log/.exit`, existing large-chunk warning retained). Actual original Notes UI in IAB: seed A note and A draft; hold its Refresh response; navigate via original Settings and account switch to B, then original feature link back to Notes. B's same-ID note appears within the5s observation while A is still held, B draft is empty, and releasing A does not refill B. Exact server order and page proof: `/tmp/m13-note-cache-probe-green.log`, `/tmp/m13-notes-cache-iab-green.json`, `/tmp/m13-notes-cache-iab-b.jpg`. The generated host and IAB tab closed successfully. The denied hidden Web Electron action was not executed, and neither independent failure log is relabelled as passing. Full current Web regression remains separately recorded after completion; own affected/module-wide acceptance remains open.

Full Web at exact e2a46110896cd9fca6c79c55cde4dfd144c6afeb actually ends527total526pass1fail,0skip,80.61s,EXIT1 (`/tmp/m13-notes-cache-full-web.log/.exit/.sha`). The sole failure is Actions paging fixture preparation before rendering: page1 still has8 proposals and its second genuine model task is running at the existing30s state wait. Unchanged standalone samecase passes1/1,no skips,EXIT0 in76.37s (`/tmp/m13-notes-cache-actions-paging-diagnostic.log/.exit`); no runtime, assertion or timeout is altered to make it pass. The whole-suite failure remains unresolved as a whole-run gate and is not replaced by the narrow result. The independent note-wait regression and allowed original-Notes IAB proof are complete; whole M13 acceptance is not claimed.

### QR v2 original Web consumer

Actual original connections feature RED5f316e4d fails at the missing Generate device QR button (`/tmp/m13-qr-web-red.log/.exit`), before any invented grant. The restored invitation panel reuses original local QR/JSON/download/cancel/address/original-device controls and is reached from the original Devices entry. M01 v2 response identity, exact device purpose, chosen origin/device and complete URI encoding are checked before publication; device consent no longer promises owner/private-library authority. Known-device options union actual owned credentials, M03 devices and M02 source device IDs. The first GREEN attempt exposed the source-only known-device case and failed its unchanged assertion (`/tmp/m13-qr-web-green.log/.exit`); consuming that third registered inventory closes it. Actual renderer M01/M03 grant/PKCE poll+ACK/private403, cancellation410, original-device selection, held A response→B retirement, fresh B positive and damaged-success owner rejection pass with the adjacent MCP issuance suite2/2,no skips,EXIT0 (`/tmp/m13-qr-web-green2.log/.exit`). No server/QR producer changes, token fallback or second pairing service. i18n8449/0 and Web noEmit0 (`/tmp/m13-qr-i18n.log/.exit`, `/tmp/m13-qr-types2.log/.exit`); the first noEmit rejected an unknown-typed error in a React conditional and was corrected with an explicit boolean. Actual built IAB QR and final same-candidate gates remain pending; React act warnings retained.

### Original Files retry / unknown / cancel consumer

RED8886eb96 uses actual M01/M03/M04/M05/M06 generated WAV and bare503 ASR to reach an honest unknown result, then original confirmation sends retry400 because the old consumer omits required operationId (`/tmp/m13-file-control-red.log/.exit`). The consumer now captures the exact command before admission, stores only operation/options under stable origin/deployment/user/file, and offers explicit same-body retry after an ACK loss or component remount. M06 still owns authorization/current-source/unknown/live-call checks; a local intent grants nothing and is never automatically submitted/rebased. Removing a local pending submission explicitly leaves already admitted Central work alone. Web successful ACKs must contain queued:true and the exact-shape task ID before local state clears. Bearer characterization bodies remain unchanged. Acoustic options use the raw ASR artifact, retaining the original single-file controls.

The same scenario passes1/1,no skips,EXIT0 (`/tmp/m13-file-control-green.log/.exit`): explicit unknown consent, actual admitted ACK loss, remount/same body+task, actual physical wait/cancel, old A callback emits no B request, B same-ID indexed positive. Adjacent first run exposed a test ordering flaw: it cancelled a queued retry before ASR had actually entered, so the assertion expecting2 physical calls failed; `/tmp/m13-file-control-adjacent.log/.exit` remains1. Added a genuine second-ASR entry barrier, keeping byte/task/cancel/owner assertions. A first attempted patch used the wrong cwd path and did not edit the test; its separate run is retained, not the corrected verification. Final corrected neighbors53/53,no skips,EXIT0 (`/tmp/m13-file-control-adjacent3.log/.exit`) include original media views, physical wait/unknown dialogs, API retirement, transcript and full-page speaker preservation. i18n8452/0 and Web noEmit0 (`/tmp/m13-file-control-{i18n,types}.log/.exit`), production Web build0 (`/tmp/m13-qr-controls-web-build.log/.exit`). Current full Web/affected and independent review remain pending, and the earlier526/527 full failure remains unchanged.

### QR IAB and file review adoption (343 checkpoint)

Original built Connections device QR → actual M01 PKCE redeem/poll/self/ack on generated A succeeded; the device credential's private read was 403. Refresh/cancel retained the ACKed device, the original-device selector was exercised, and original Settings switch to B cleared A invitation, label and selected device. Screenshots `/tmp/m13-qr-iab-{a,b}.jpg`, proof `/tmp/m13-qr-iab-proof.json`; controlled fixture printed `closed:true`, its temporary directory was removed. No hidden Web Electron was executed.

Current full Web at343: 529 total, 528 pass, 1 fail, no skips, 80.54s (`/tmp/m13-343-full-web.log/.exit`). Actions opaque-page preparation passed; diagnostics show real watch tasks waiting and all three extraction tasks succeeded. The sole failure is original-byte renderer's immediate post-click assertion (B download count1 vs2); this remains unresolved and is not replaced by an isolated pass.

New durable file-review adoption RED (`/tmp/m13-file-review-red.log/.exit`): actual original terms button reaches strict M06 POST400 because the old body lacks operationId. The test exercises real M03 extraction/M04 profile/M05 model proposal, lost admitted ACK, reload/same-body retry, explicit correction and B same-ID isolation; only generated external model I/O is substituted. No deadline or semantic assertion was weakened.

Original FileReview minimal consumer: fixed owner-keyed component, operation identity/options retained before admission, exact-body retry after ACK loss/remount, strict queued task/review receipt, actual review polling and explicit confirmation. Export/voice-sample reads retain the original Api/signal; samples are fetched only after user audition and generated export URLs retire with the account tree. No new server runtime or model policy. Same actual terms scenario1/1, original media/resource adjacency52/52 no skips0 (`/tmp/m13-file-review-green2.log`, `/tmp/m13-file-review-adjacent.log`); first attempted edit used the wrong cwd and did not alter production, its mislabeled green log preserves the unchanged RED. Web types2 and synchronized English check2 both0; the earlier types ref initialization and catalog comma errors are retained. Original-byte test now waits for its actual download/error terminal outcome, with unchanged byte/hash/account assertions and unchanged wait budget.

File forget original-entry RED: `/tmp/m13-file-forget-red.log/.exit`1, original FileDetail has no reachable forget action after real A/B same-ID file upload. New durable scenario retains opening-confirmation zero writes, frozen originalGeneration/operationId, actual commit ACK loss,404/remount/replay exact receipt, exact allow-again decision and old-A callback/B positive. Only the browser transport fault is substituted; M03 deletion is real on generated temporary data.

Forget minimal consumer samecase1/1/no skip0 (`/tmp/m13-file-forget-green2.log/.exit`): fixed confirmation sends nothing until explicit consent; exact operationId/originalGeneration is retained before DELETE, and reload at real404 exposes original-body retry. Receipt replay preserves the fixed decision, allow-again sends that exact decision, old A callback sends nothing under B and B file remains readable. Cleanup is labeled as the receipt-time observation, not live physical progress. Server and current schema are unchanged. Web types0/i18n0. Early wrong-cwd edit commands made no source changes and their unchanged-case logs are not counted as verification.

Expanded terms test also performs actual generated M05 calendar proposal, zero association before explicit accept, exact association after accept and B remains unassociated (`/tmp/m13-file-review-calendar-green2.log/.exit`1/1/no skips0). Original source text, calendar data and model responses are generated; no actual calendar mutation or model inference is claimed.

Current fixed f5a full Web531/531/no skips/EXIT0 in69.27s, build0 (`/tmp/m13-file-actions-full-web.*`, `/tmp/m13-file-actions-web-build.*`); this does not cover later Agent preview or the whole affected gate. New original Agent startup actualRED `/tmp/m13-agent-preview-red.log/.exit`: real M07 A/B publications complete, but POST agent-view/startup503. Regression requires actual private Memory leads, read-only tools, zero new model calls/tasks and scoped evidence/UTF16 read; no historical input reconstruction.

Agent preview exact adaptation now uses the same existing M08 `memory.opening(limit8)` and pins as a real new conversation, plus the pure context/system/tool builders; the earlier attempted legacy opening helper requested removed proposed-status filtering and correctly returned400. No model is constructed and no run/job is inserted. Actual A/B Memory/evidence/startup1/1/no skip0 (`/tmp/m13-agent-preview-green3.log/.exit`), server types0, inventory0 and i18n8462/0. The preview copy now reports M08's existing8-lead maximum instead of the old5. A default catalog actual400 was independently observed because HTTP default20 violated the existing reader maximum12; the HTTP catalog now uses the established12 bound, without changing pagination authority. Existing Material title is retained in segment-directory metadata; no new store/provider/runtime.

Original Agent renderer also gave a durable actual read-path failure after that title projection: it sent a declared `material_read` entry through the capture-evidence endpoint and got404 (`/tmp/m13-agent-renderer-read-red2.log/.exit`). The earlier title-only failure and wrong-cwd edit attempts remain recorded, not mislabeled as successful content reads.

Declared Material reader regression now passes through original Agent UI (actual M03/M06 Material, `material_read` declaration → M08 exact read, original startup tab and A→B account-keyed reset):1/1/no skip0 `/tmp/m13-agent-renderer-green.log/.exit`, Web types0. The wrapper does not infer a raw capture reader or use404 fallback. Backend preview/evidence and this client increment still need neighboring/full current gates and independent bounded review; historical runs/events remain OPEN and cannot be synthesized from this preview.

Agent historical-input first attempt `/tmp/m13-agent-trace-red.log/.exit` is an invalid fixture: it assumed a personal diagnostics domain and failed before the events route. It does not prove an endpoint RED. The corrected actual request `/tmp/m13-agent-trace-optin-red.log/.exit` reaches M04 and returns `400 config_invalid` because the original opt-in has no personal-domain mapping. The scenario explicitly enables A, keeps B disabled, and requires actual recorded initial/tool payloads, owner-bound pagination, no administrator grant and current source retirement. All content and provider responses are generated.

Historical trace implementation keeps the existing M08 owner/run `ma_traces` journal. The former detailed-trace switch is mapped to an explicit M04 personal `agentTrace` domain, default off; instance diagnostics supplies only its existing byte/file/entry retention bounds. Opening the pane never enables tracing. Immediate opt-out is checked at every event, compaction and byte/count expiry remove only retained payloads, and current source/Memory proofs are rechecked before private historical reads. Existing global metadata diagnostics is not granted private payload access. No new store, scheduler, schema, model or logging runtime is introduced.

Actual Harness output is retained as typed `provider.event` / `tool/result` messages, rather than rewritten into a Codex event. The original viewer displays exact returned Material text and offsets, rejects calls/user/error/truncated messages as reads, and uses owner/run-bound opaque pagination. Original Agent UI under StrictMode saves personal CAS opt-in, renders a genuine recorded question and retires held A event responses plus old A controls under B: renderer/adjacent6/6 no skips0 (`/tmp/m13-agent-trace-renderer-green.log/.exit`). Real A/B provider, original/source retirement, administrator denial, signed pagination, immediate mid-call opt-out and retention are6/6 with M04 effective-snapshot/Agent-startup neighbors (`/tmp/m13-agent-trace-adjacent.log/.exit`). Server and Web types0; scope inventory and exact pure retention-constant dependency0; synchronized catalogs8466/0. These are current narrow proofs, not full Web/affected or independent-review acceptance.

Original Files follow-up actual REDs: generated M06 literal speech `[SPEAKER_0] ...` reaches the real correction editor but loses its prefix (`/tmp/m13-file-literal-original-valid-red.log/.exit`,1/1fail); the first attempt had an unescaped test regex and is not the valid proof. Separately a real M04/Harness/M06 summary exists in the owner artifact API while original FileDetail displays only its heading (`/tmp/m13-file-products-red.log/.exit`,1/1fail). That test also keeps transcript/derived identities distinct and the later positive adds actual semantic grouping. Both use generated data and retain B/retirement assertions.

Both exact Files cases now pass2/2/no skips0,12.91s (`/tmp/m13-file-products-green.log/.exit`), Web types0. Scoped transcript chunks keep their current extraction identity; summary/dialogue/image publications read the captured owner API's exact artifact and original reference separately. The original bearer fixture keeps its older embedded sections/transport-prefix characterization. M06 literal text is not stripped as a legacy FileStore prefix, including the correction request and grouped display. The generated actual Harness adds semantic grouping and summary, verifies both stored publications, expands the exact transcript, then holds A product bytes across B replacement; no invented summary citations or new backend projection. Earlier wrong-cwd git staging attempts did not commit and are not validation evidence.

Device-status migration actualRED: original account device page receives real M03 heartbeat fields but displays only registration name/platform, omitting its paused/sync/error details (`/tmp/m13-device-overview-red.log/.exit`,1/1fail). The same generated-account regression retains a registration-only device, actual M06 WorkActivity receipts, same-ID B heartbeat and held-A inventory retirement. No heartbeat defaults or empty queue are invented for a registration without an observation.

Device observation adaptation now reuses the original DeviceOverview only for schema-valid real heartbeat observations; registration-only rows are separately labeled without synthetic status/queue defaults. Today restores its recent5 real WorkActivity cards and existing progress/state components. Same actual M03/M06 owner/held-response journey1/1/no skips0,4.56s (`/tmp/m13-device-overview-green.log/.exit`), Web types0. Whole Today navigation/overview parity and module gates are not inferred from that bounded case.

Current fixed Web runtime de012031 full suite536/536,0fail/0skip,93.28s (`/tmp/m13-de012-full-web.log/.exit/.sha`); fresh build:central0 (`/tmp/m13-de012-build-central.log/.exit`). Independent crossuser owner separately reports its selected cache:no-store runtime on Joint2528/519: actual renderer10checks0, Web515/515/build0 and HTTP/MCP5/5; that is peer evidence and not permission to retry this thread's previously denied hidden Web Electron operation.

Bounded pure-server Agent freeze245308de2a195c105e3d031cad569531dd7fa54f is on M15 declared a324c347 parent, with isolated source tests2/2,Server types0,scope0. DTO `multiuser-agent-http.md` and `/tmp/mote-m13-agent-public-freeze.md` specify exact startup/evidence/personal opt-in/native event/cursor semantics. It excludes Web product changes and model copy/probe/provider-directory work. No whole M13/affected/PR acceptance is inferred.


### Configuration relogin and trace observer retirement

Exact source test3334534a retains a real M04 processing-save failure after logout/relogin: fresh configuration view succeeds but saving processing returns503 (`/tmp/m13-configuration-relogin-red.log/.exit`,1/1fail). Isolated M15 fda6 handler-cache repair is applied as a51ded41, reopening handlers whose bound admission subject retired instead of mutating that subject. Samecase/effective-snapshot neighbors5/5/no skips0 (`/tmp/m13-configuration-relogin-green.log/.exit`).

The new trace relogin matrix ae25c769 then exposes an actual privacy failure: a held already-admitted query completes after relogin/explicit opt-out but the old observer still records later payloads (`/tmp/m13-agent-relogin-optout-red.log/.exit`,1/1fail). The minimal observer identity check retires detailed recording with the settings entry while retaining original authority/generation checks and leaving admitted execution intact. Same trace suite+relogin3/3/no skips0 (`/tmp/m13-agent-relogin-green-approved.log/.exit`,38.08s); the initial restricted run hit127.0.0.1 listenEPERM before the two Agent cases and is not a product failure. No private content, endpoint/key or new observer runtime is introduced. Public245308de alone is superseded pending the exact tinyfix freeze; previous2/2 proof remains historical.

The5cb required gate's first attempt had no local integration ref; after read-only fetch of the existing6272 integration, run2 completed Desktop501/501 then its own runner vanished without an exit file midServer. `/tmp/m13-5cb-required-affected-run2.interrupted` records the absence of own processes. This is interrupted/unverified, neither PASS nor a product FAIL, and peer healthy processes were not touched.


### Same-ID original generation retires the original forget UI

Independent E2E owner wire test c8055a5d confirms request-generation0→new-original-generation1 while the late decision also has generation1; decision generation alone is not the current intent. Its subsequent original-page case66a20c93 and own original DOM/API case395bc4db independently reach the visible failure: real new FileDetail is present, but a held older committed DELETE success says “deleted” and hides the new delete action (`/tmp/m13-file-generation-red.log/.exit`,1/1fail). Server A/B originals remain safe; no cross-owner deletion is claimed.

The original delete component now remounts for an observed original generation, retaining the last observed generation through the expected404 after an admitted deletion. A saved intent for another known generation is not loaded into the new component or rebased; it is not automatically resubmitted or silently erased. Its retired callback cannot publish. A new explicit confirmation captures a new operation and the new descriptor generation. The original ACK-loss404/remount/replay/allow-again scenario and the new held-ACK/new-generation/new-explicit-delete/B-positive case both pass2/2/no skips0,15.32s (`/tmp/m13-file-generation-green.log/.exit`). Exact request generation, rather than the decision's incremented generation, owns the UI state.


### Declared file-processing PREP and original page restoration

Only Joint's explicitly declared a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695 was merged, including its isolated configuration relogin and bounded binary parser repairs. No later arbitrary Joint HEAD/policy WIP is consumed. This is its limited20-case source checkpoint, not wholeM06/Imports/joint acceptance. Contract `../design/multiuser-file-processing-contract.md` keeps named profiles, source/MIME matching, one M04 transaction and exact preview tokens.

Original Web settings entry actualRED68fb5c1d (`/tmp/m13-file-settings-red.log/.exit`,1/1fail): the account settings registry has no reachable “file and voice” category, even while the scoped host has a real named-policy endpoint. The original FileProcessingSettings now remains at the original category query, with its profiles/parameters/source rules/match/preview/reprocess layout. Scoped services select personal/shared M04 references and use the original model editor in the same Save. No endpoint/key copies enter policy; hidden same-profile secrets pass M04's replaceViews transaction. Shared references stay read-only. Global model installation/test-local have no scoped admission contract at this checkpoint, remain explicitly OPEN, and their bearer-only controls are not used as personal authority.

Actual original account page → named settings → service reference + source rule + max-audio edit → one successful M04 Save with saved boolean secret → real owner-only preview/reprocess1 → held A successful Save across B and detached A button passes1/1/no skips0,4.22s (`/tmp/m13-file-settings-green3.log/.exit`). B's complete generated YAML is byte-identical; A's synthetic secret is retained internally and never appears in the DOM. Initial green invocation used the root cwd and did not find the Web test; green2's entry lookup lacked an accessible category name and is preserved. The test now uses that explicit accessible name; its exact dynamic preview action and actual default120-minute B setting replace fixture assumptions, without changing transaction or isolation assertions. Server/Web types0 and scope0 are recorded separately.

Agent runtime ddc64fe9a4eeb57b763669c324d9afd099aa97c3 (docs successor19c5592f) supersedes245 for the relogin observer defect; isolated traces2/2+startup1/1,no skips0,types0,scope0. Own M04 effective snapshot neighbors4/4/no skips0 (`/tmp/m13-agent-effective-adjacent.log/.exit`). M15 separately reports composed server3/3 and strengthened original native Agent1/1 plus bounded nofinding review; those are peer evidence, not owner executions or wholeM13 acceptance.

### Selected-card Memory integration original journey

Durable source RED `0bc87b03`: actual M01/M03/M04/M05/M07 selected Memory and
recipe POST returned503, including the stale-pin case. First restricted run
failed loopback EPERM and is not product evidence; the same command through
normal approval reached the real503. `/tmp/m13-memory-integration-valid-red.log/.exit`.
Original-page RED `8c118c60`: legacy global settings aliases returned503 and
left its start button disabled, `/tmp/m13-memory-integration-ui-valid-red.log`.

New actual source8/8 no skip0 `/tmp/m13-memory-integration-server-final.log/.exit`
includes the original three manual-Material/model neighbors, recipe pin,
operation idempotence, A/B same Material identities, stale version, model-lease
await then actual completed correction, explicit cancel, and separate selected
personal/Coding domains while the global default stays personal. An earlier
race fixture released the lease immediately after *admitting* correction; it
was corrected to await its actual successful task and assert the retired pin
before release. That earlier200 is not attributed to a production failure.

Original-page lost committed ACK/remount (no second POST/model replay), honest
zero output, held later A ACK, detached A controls/B positive and original bearer
page neighbors passed51/51 no skip0
`/tmp/m13-memory-integration-ui-neighbors.log/.exit`. This command ran the two
existing files it found; an accidentally supplied nonexistent third filename is
not additional coverage. Web and Server types/scope/i18n checks are recorded
separately. Subsequent permitted IAB proof at953 used the actual original A
Memory detail and explicit integration, reload of the same completed receipt,
then actual account switch to B, its own card and a new successful integration.
`/tmp/m13-memory-integration-iab-proof.json` records six generated provider
requests across the two extraction and two integration jobs; A/B screenshots
are `/tmp/m13-memory-integration-iab-a.jpg` and `-b.jpg`. This closes this
selected-card page journey, without inferring broad range/raw extraction,
multiple-recipe UI coverage or whole affected acceptance.

### Original queue overview owner migration

IAB953 exposed the genuine old execution-settings503; new source regression59ca
reached404 task_not_found for /api/tasks/queues (no alias was present). Source
samecase1/1 no skip0 /tmp/m13-execution-queue-green.log/.exit: held A running and
queued work, equal business ID in B, B own waiting-only row, admin own empty,
owner spoof/anonymous denied, no GET admission. Original component9cbad1af
validRED was scope_unavailable; new owner-only branch plus held A response/B
empty positive and original bearer/cache/manual neighbors pass in
/tmp/m13-execution-queue-ui-green.log/.exit,31/31 no skip0. The added actual
unacknowledged issuance case remains blocked with external uncertainty1 while
running occupancy is0; source queue and original M05 lifecycle neighbors pass
13/13 no skip0 in `/tmp/m13-execution-queue-server-neighbors.log/.exit`.
Server/Web noEmit, scope inventory and synchronized i18n8474 pass separately.
These are narrow consumer proofs;
953's540 full Web predates this queue delta and is not relabeled current full.
