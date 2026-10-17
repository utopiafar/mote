# Final multi-user joint acceptance: fixed scope and preparation ledger

Status: **PREPARATION; NOT final acceptance**, updated 2026-10-17 UTC. All final-gate
rows below are pending unless an actual execution receipt explicitly says otherwise.
The 15 delivered modules (including resumed M14) and architecture review are
dependencies, not proof that all17 modules work together. M13/M15 remain
checkpoints with known capability gaps. No whole-project completion, final
candidate or final joint PR is claimed.

## Authority, composition and evidence rules

The governing sources are [AGENTS](../../AGENTS.md), the
[original multi-user ADR](../adr-multiuser-scope.md),
[module and joint contract](../design/multiuser-modules.md), PR135's
[public contracts](../design/multiuser-public-contracts.md) and
[representative-chain specifications](multiuser-public-contracts.md).
Their single shared SQLite, shared services and one executor remain the design.
The original domain ADRs retain their business semantics; this preparation does
not introduce a framework, owner selector, additional runtime or new product limit.

Own clone: `/Users/utopiafar/Documents/Codex/2026-10-17/task/mote`.
Own branch: `codex/mote-multiuser-joint-validation`.
Actual host: `guangmodeMac-Studio`; the handoff's Bogon label is not machine proof.
The user's main working directory is not used for writes. Main and integration
were independently read from GitHub at `6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`.
Only this feature may compose dependencies. No merge/push to main or integration,
deployment, CI enablement, real data migration/deletion, real calendar/mail operations or system permission changes are authorized by these tests.
The later user instruction permits a separately reported real-model regression
through the locally signed-in Codex GPT-6.1 sol entry only; see J14.

Use generated A/B accounts with equal source/device/external/revision/batch IDs,
operation keys and original bytes. Keep actual Accounts, production app/listener,
SQLite, domain services, shared executor, worker and client adapters. Substitute
only external transport/model/provider I/O. Observe real entry/checkpoint/ACK
barriers with bounded state waits. Read-only DB observation is evidence; explicitly
label fault injection. A refusal needs a legitimate subsequent positive and B's
unchanged private state. Do not prove isolation by closing a whole capability.

An execution receipt records exact code/test SHA, command, runtime/ABI, selected
test names, pass/fail/cancel/skip, exit, duration and log SHA-256. Historical logs,
static review, copied build artifacts and new source runs are distinct categories.
An interrupted process without an exit receipt is not a pass or a code failure.
The 16:02 interruption at107 is retained as interruption; the resumed required
command actually completed EXIT0. Documentation-only deltas require link/format
review, not mechanical application reruns. Runtime changes trigger the affected
consumer checks and relevant matrix rows.

## Frozen delivered dependencies

GitHub metadata was independently read during preparation: these 15 PRs are OPEN
Drafts with base `codex/mote-multiuser-integration`; PR135 is architecture review,
not an eighteenth module. The snapshot is `/tmp/mote-joint-pr-snapshot.json`.
Main/integration readback: `/tmp/mote-joint-baseline-remote.txt`.

| Module / PR | Exact delivered head |
| --- | --- |
| M00 /126 | `5031b754915d3fbba0dbe0c050b6d103a02966ef` |
| M01 /127 | `443726d2a95ef55db9466d06aa44ea1061ca56e4` |
| M02 /128 | `8ecccb8ecf0093cc655fadd8bbc5e1637220f9fd` |
| M03 /131 | `b1f6700a7e68b60318b7b05f631a47d12fd93c24` |
| M04 /129 | `bc5323e1b5ee337c20dee58d4a8e9c25bc2adbbf` |
| M05 /130 | `7f72e9040872dbbb351f3c9a22afa6f069aa59c8` |
| M06 /133 | `470516b7ed4ab7ee8b0fba344883c6b42bb7ce56` |
| M07 /136 | `cd7a306cce0f6cd5fec3c9e91e6dee0761352115` |
| M08 /137 | `58944f00837c89bc1d302ecd7be7a568db4abe44` |
| M09 /132 | `cdc5c34c36fc5743049007ee2c76d705fde3dd7f` |
| M10 /134 | `7572b573b03437ff743652c13181b9fdcf251fda` |
| M11 /138 | `98d76945e091d7234217ebcf532ebeff3350937c` |
| Architecture /135 | `094b69d0c4d623a3b478ae4c05ee249b024ba73b` |
| M12 /140 | `a50d1c88647780ebd27d7a247ec4ffbc170ab87f` |
| M16 /141 | `eec967c66304fef78f683e3445900287e75bac21` |

Initial own combination `5656b5999c8f5c27fca11271a89cda3587a28325` merges
M12's final documentation into M16's delivered head. Relative to tested
`10748005a5d007695ecc9401d0d57dc9dea94919`, only
`docs/design/multiuser-actions.md`, `multiuser-actions.md` in this directory and
`multiuser-m16-lifecycle.md` differ. No runtime/test delta exists at this point.

An ancestry check found M02/M03/M04 delivered heads are **not** literal ancestors:
earlier composition copied their commits with new IDs. This must not be described
as all final heads being ancestors. Known mapped implementations are M02
`1323c7e1→12c1b44f`, shutdown `d8aaef97→e77faca9`; M04
`a5e91664→c4e4e8bc`, snapshot `e76f1fe6→463d5299`; M03
`fffe1d12→c21062a1`, staging fix `14858e86→d44963f5`.
The original M05 and M03 ledgers explain the composition. Verify remaining
patch/merge differences and retain later legitimate domain fixes; blindly merging
old branches must not restore superseded code. Other listed delivered heads,
including PR135, are literal ancestors of5656.

## Client readiness and remaining original capabilities

M13/M15 entries are **CHECKPOINT**, not final candidates; M14's module delivery
is final within its declared boundary. Finalization requires each remaining
owner's explicit final tested SHA, final affected/native/UI receipts, bounded
review and exact remote Draft PR head. Later WIP is never imported as a freeze.

| Owner | Explicitly reported composable checkpoint | Remaining gate / original capability |
| --- | --- | --- |
| M13 Web | **CHECKPOINT; later parent reports turn recovery pending**, tested short build/types `815c5fe6`; later `84e3f9b85e2a3dc2cdc5edceb878133a643b7077` remains narrow-only | Consumed declared Joint43db Imports PREP; actual renderer upload/private-preview/confirm/A-B and lost commit/admission ACK/file-slice retirement have owner narrow receipts. Lark UTF8/task-identity/large calendar inventory have actual RED/GREEN and bounded read reviews; latest types/build/full affected/IAB/push/PR remain due. Earlier fullWeb515/515 belongs to its earlier candidate. New M06 unknown candidate is not consumed. |
| M14 Desktop | **FINAL module delivery** remote `cd46f25a030bdbe593bc138adc375577b4d032ae`; tested `45467379c5645dec62cc4b03e891b404b675193b`, later only two docs | Own independent GitHub readback confirms PR139 OPEN/Draft/base integration/exact final head (`/tmp/mote-joint-pr139-final-readback.json`). Owner required actual EXIT0: Desktop501/501, Server2626 pass/0 fail/1 existing OS opt-in skip, Web515/515, Android352/352/no failure/error/skip, types/root/shared/CLI0, Agent317+1 opt-in skip. Real generated Desktop native-calendar→M12 fixed review→M05 plus Ask/offline A/B/SIGKILL/restart passed; M13 bounded review no new confirmed finding. Handoff `/tmp/mote-m14-final-delivery-resumed.md`. No joint Files writes were in454; this is not whole joint proof. M14 ended, do not awaken. |
| M15 Android | Latest owner-tested composed `d524140f0e93844058cb82348274b76ed7e855a7` plus file-retry runtime `dc6345699991a7968e27f660585d88437d258be3`; later7589 checkpoint is explicitly uncompiled | Owner fresh JVM357/357 and fixture app/testAPK40s EXIT0 apply to d524, not current Kotlin WIP; production debugAPK353/353 evidence remains earlier48a. Native file retry/lost admission ACK1/1 passes within that boundary. New default DELETE body, Personal MCP writer and invitation/delete recovery cases remain uncompiled/unrun; emulator recovery/short build waits parent allocation after Desktop→Joint types. Joint8177 was composed for source-only HTTP; M15's source-recreation DELETE RED is independently reproduced and repaired here519. This is no M15 final freeze, final affected, push or PR. Generated local Codex Ask is peer evidence separately in J14. |
| Desktop v2 QR consumer | New independent slot fixed runtime `32f8215cd9caad6296ec624936889683fb897c67`; current full affected running, not final | Parent-authorized successor to completed producer PR144. Own Desktop/Swift build0, parser+production HTTP86/86 and hidden Electron same-invitation RED→GREEN are owner evidence. M14 PR139 does not close this newly added QR consumer. Await final affected/native receipt, explicit final tested SHA and Draft PR; do not compose running WIP. Theme PR143 stays separate. |

Shared-page ownership remains in the owners' existing ledger
`/tmp/mote-m13-shared-page-contract-map.md`,
[Web design](../design/multiuser-web.md),
[Memory parity](../design/multiuser-memory-parity.md),
[Desktop](multiuser-desktop.md) and [Android](multiuser-android.md).
Missing original capabilities are blockers; a new route or generic Material list
does not substitute for their intended user outcomes. Route changes allowed by
the MVP do not authorize capability removal.

Own composition `abbb3a786ab1cc5daa44a1fed20a2f5dde15cf4c` includes M14finalcd46,
M13CSS10f11 and M15stable220c. Android native main differs from220c only in the
shared translation catalog, retaining equal messages; no peer Android runtime
was edited. Four append/history conflicts took the delivered final/native test
versions after checking the concrete conflict. Two prior duplicate-key cleanup
commits deleted opposite occurrences, causing14 keys to disappear on merge;
own check:i18n actual RED then `d7990a85` restores exactly those14 shared/Android
keys once. Same checker GREEN8439 synchronized messages/call sites. This is a
joint merge repair, not a failure in M14's tested tree.

Later bounded client deltas are not yet imported here: M13Google0384,
original-byte reader17fd and raw Library entrybe6e; M15new7eca/107f work.
The exact17fd original-byte delta was independently source
reviewed here with no new confirmed P0/P1/P2; report
`/tmp/mote-joint-review-m13-file-original-17fd.md`, no test/build rerun. Its3/3
runtime result belongs to M13. The earlier no-frozen-QR state is superseded by
producer6a84ec6a477bb4698002234fd81bb669ce98cc06 in Draft PR144, contract
`docs/design/multiuser-qr-pairing.md` in the independent task-4 checkout. It retains
Generate invitation consent, origin confirmation and device-only PKCE/poll/ACK;
no additional browser confirmation. Owner20/20 narrow and Server types are not a
full gate: its complete affected timed out124 and remains pending repaired rerun.
Web/Android consumer acceptance is separate, and the producer explicitly leaves
Desktop v2 import unimplemented/unverified. Prior M14 final139 cannot close that
newly frozen consumer contract. Username login and MCP QR are not substitutes.
All final joint QR outcomes remain OPEN until actual composed client execution.

## Independent preparation probes: narrow scope only

Own read adapter `e27444881c63b0841be6098f6e55023f12ba18ae` restores actual
owner-filtered Files list/detail/chunks, authenticated M03 original playback and
existing tar formatting from M06 publications. Node24.21.0, source entry;
`multiuser-file-views.test.ts` plus the existing tar algorithm case3/3, no skip,
EXIT0. `/tmp/mote-joint-files-read-freeze.log`, SHA256
`0976d5c33199eca9e9bf0a67eb9f45f38ec161396987340dd758343d975fa322`.
Fresh shared build, server types and scope boundary passed separately. This is
partial Files, not whole recording/Imports parity or final compiled proof.

M13's exact-e274 independent review found export source errors were not forwarded
through `.pipe(gzip)`. Own durable actual-helper child process atbf00 reproduced
uncaught source error/EXIT1. Minimal07c0adf switches to `pipeline`; same source
failure plus existing tar positive2/2/no skip/EXIT0, source Node24.21.0.
`/tmp/mote-joint-export-stream-green.log`, SHA256
`5b647d9a8a8c0cc5df3e517a5d17171b2eb7845bfd7a9b4a05a1f9c93cf90b09`.
M13 reviewed exact07c and closed the code path with no new confirmed finding in
`/tmp/mote-m13-review-joint-files-e274.md`. This is not a full HTTP timing proof.

The owner correction/speaker candidate has actual2/2 missing-route RED at7faf;
`/tmp/mote-joint-files-corrections-red.log` SHA256
`15ec6b293b6186ab9cbda3c036194a73b83dcd551229e4f7a8eb4c883090aaae`.
Its later older-portable merge probe validly failed `archive_conflict` at Memory's
current-only evidence reader after a legitimate Material revision; diagnostic
instrumentation was test-only and removed. `/tmp/mote-joint-files-corrections-merge.log`
SHA256 `e8ddbe34e8286244d6f754bdca047867f0e95644d0d571c8b21f399b9ed00c53`.
After minimal retained-recovery adaptation, source candidate3/3/no skip/EXIT0,
4.39s: exact A/B correction, preserved raw/corrected tar, confirmed names,
older-name merge/current-name preservation, replay/corrupt-link rollback, physical
A deletion with B unchanged, offline backup/restore and old token401.
`/tmp/mote-joint-files-corrections-merge-green.log` SHA256
`0db603788a0fea4d7ee2b2016ac3be7e21bf9b0d3eafc551b86797ac2889f8c1`.

One additional actual production Memory/portable test using generated loopback
model I/O passes1/1/no skip/EXIT0,11.82s: retain old evidence/history, preserve
grants/call count on import, reject old pinned execution409, and execute a new
current owner request positively. Sandbox listener EPERM was environmental;
the same command passed under normal authorized review, no real model contacted.
`/tmp/mote-joint-memory-retained-import.log` SHA256
`76eb490621a4a704e850cc83f1c30dd4524f18c37c57d646252eb7f99be2c153`.
These write/recovery changes remain a candidate until types, adjacent checks and
bounded review complete; no final affected or module claim is inferred.

**Current shared thin freeze: `a10effd109e64651e5cafe801b686238271964bf`.**
Its write core is643812, with M14final composition and the catalog repair above.
M13 independently reviewed exact643812 and the exacta10 two-line format filter,
no new confirmed P0/P1/P2, `/tmp/mote-m13-review-joint-files-6438.md`; no reviewer
test rerun. At9b96 an actual retained source-item JSON envelope incorrectly
appeared as an external file: valid RED `/tmp/mote-joint-files-envelope-red.log`.
a10 limits the common owned-read base to M06's trusted `file`/`processor:*`
format. Reference captures remain readable through their own source entry; no
playback/download authority is fabricated from their retained JSON wrapper.

Earlier speaker/backup cases used structured source-item metadata. They are
superseded for external-recording proof by actual generated WAV M03 upload→M04
lease→M05→M06, substituting only the external loopback ASR response. Current
seven source tests (three file views, three correction/speaker/recovery, one
stream-failure regression) pass7/7/no skip/EXIT0,8.65s:
`/tmp/mote-joint-files-real-recording-green.log/.exit`. The old export algorithm
positive separately passes1/1. Server types at643812 passed; the current exacta10
types and adjacent complete portable suite receive their own receipt below.
The freeze was offered to active M13/M15 consumers, not ended M14. It closes only
these listed seams; review proposals/acoustic assets/controls and Imports remain
OPEN. Whole final candidate/required/compiled/native/client acceptance is pending.

Exacta10 server noEmit exits0 (`/tmp/mote-joint-a10-types.log/.exit`, SHA256
`d92fa527b2cf6e7a734a389df70ded049e13fde5d094ded997bb6d7bd18c61e9`).
The complete affected personal-portable suite passes15/15/no skip/EXIT0,33.57s,
`/tmp/mote-joint-a10-portable.log/.exit`, SHA256
`0caa291aa0843e97741243d610a6306ce4cb6b595ea559fa5a7eb56da7cf9efd`.
The current seven Files cases' log SHA256 is
`95901430f445b32fb99c4e29e1f68fd3e7f06c4ac7070506ee49082ec1c47978`.
These are independent source-entry receipts, no compiled/server-wide gate claim.
All Joint processes completed and the heavy slot is explicitly RELEASED.

The parent assigned a released slot to container validation
`01a145c1-31b7-75e9-b834-56885c972010`, based on M16eec. Its new runtime/scripts
remain separate until the final freeze. The original daemon failures are
historical: Docker became accessible, the standard repository image actually
built EXIT0 (immutable2e0a192e...), and owner13515436 actual production restore
ran two clean start/stop cycles and rebackup with equal capture IDs, distinct
A/B text, original bytes, old-token401, no active old task grants and preserved
unknown issuance. Direct offline Hindsight recovery06fd also passed with two
canonical bodies and old-token401/workerfalse. The later production Managed
Runtime/Engine.read seam first failed generated fixture digest normalization;
258f787d corrects only fixture schema normalization and same-case actual EXIT0
then proves two canonical reads, wrong-model pre-refusal, fresh credential, old
API401, workerfalse, zero inference, stop/rebackup. Later final271 gate EXIT2
(script fixture types) and final2b722 EXIT1 (MCP raw-note timing fixture) are
preserved. Deterministic fixture RED1f1897→GREEN0efc separates retired note raw
refs from actual unprocessed M03 Unicode windows; no production change. Current
ab7069aa2a1c59eda1a0775ae8d52c0632a70c89 required3 ended EXIT0; final723cc0b7 is doc-only thereafter, independently checked here. No
new whole-container gate or combined Joint backup-schema acceptance is inferred. Source reviews are in
`/tmp/mote-joint-review-container-actual-fixtures.md`; owner logs are separate.

## Finite final acceptance matrix

The following 14 rows are the final scope. Reuse the named tests/fixtures and add
only a missing concrete regression when evidence requires it. Paths below are
relative to the repository; most server suites are in `apps/server/test/`.
Every row is **FINAL PENDING**. Owning-module history is supporting evidence only.

| ID / real entry | Required finite journey and observations | Reused evidence / blocking condition |
| --- | --- | --- |
| J01 Accounts/private HTTP/MCP | A/B equal business IDs and bytes; valid login→read/write; exchange ID/cursor/download/token; admin cannot browse B; logout leaves previously admitted work; disable/reset rejects late publication. Verify counts and errors do not disclose B; retain original device pairing/QR outcome against canonical M01 contract. | `multiuser-auth*.test.ts`, `private-data.test.ts`, `multiuser-ingress*.test.ts`, `multiuser-mcp*.test.ts`; real production route registration, no default owner. Canonical device QR producer final PR144/485 is delivered and its auth contract is composed here08fa (own bounded16/16); final Web/Android/new Desktop consumer equivalence remains OPEN. Username login and MCP authorization are not substitutes. |
| J02 Web renderer | A→B, old tab/API/modal/draft, slow read and held write; old A request cannot use B's cookie; B positive request succeeds. Include actual Actions/OQ revision and portable import/export UI. | M13 current IAB journey and actual host; owner-reported old hidden Electron action was denied and unexecuted, so do not retry it or count it as a pass. Final IAB receipt pending. |
| J03 Desktop main/preload/collector | A offline queue/draft/source→B explicit start→process death/restart→late A ACK→A resumes; exact original bytes; same-account token rotation preserves owner; same URL/new deployment stops bytes; old local format refuses before mutation. | `apps/desktop/test/multiuser-desktop.test.ts`, existing headless native runner and final M14 Actions path. Settings/current status, source edits, original file scan and raw/context readers remain positive cases. |
| J04 Android Activity/WorkManager | Same queue/switch/death/late ACK/rotation/deployment matrix; native notes/capture/source/snapshot recovery and original bytes; stale detached modal/page/CalendarWorker does not adopt B; new B note/capture positive. | Existing `MultiuserWorkerInstrumentedTest.kt`, JVM tests and isolated headless fixture APK. Actual system grant/revoke and physical-device behavior remain separately unrun; do not change system permissions. |
| J05 A: original→M06→Material→Memory | Equal A/B IDs/bytes; original receipt is saved, not processed/indexed; real decoding/OCR/ASR and exact source/revision; automatic extraction+independent review; restart and success checkpoint reuse. Coding tool/envelope excluded, legitimate multipart/text/mail/image and long tail preserved; retained pre-fix projections stay retired. | `multiuser-processing*.test.ts`, `multiuser-memory*.test.ts`, retained Coding cases and original M07 parity ledger. Both current and retained/history/restore reads matter. |
| J06 B: Memory→Ask/Insight→MCP | Actual provider/Harness/SDK, equal IDs; before-LIMIT full transitive filtering; original disclosure before citation; full context/history/paging and InsightSnapshot; revoke/delete/recreate across provider await preserves first proof; B normal result unchanged. | `multiuser-mcp-representative.test.ts`, `multiuser-ask-read-races.test.ts`, `multiuser-mcp-{memory,query}.test.ts`; captured actual model requests contain only owner evidence. |
| J07 C: single executor→revoke→SIGKILL | A backlog/B ready fairness and shared capacity; real in-flight external call entered→revoke→SIGKILL→natural recovery; unknown is not reissued; worker physically retires; successful model/ASR children not replayed; B continues. | `multiuser-execution-core.test.ts`, `multiuser-memory-outcome-process.test.ts`, `multiuser-processing-process.test.ts`; seeded journal/graceful restart alone does not prove death. |
| J08 Actions/Todos/native adapter | Fixed reviewed revision/source/content/target/account/device; OQ CAS, create/update/cancel/complete, sameAs/timezone/full Unicode/paging positive; stale approval rejected; issued successful native write+host/native SIGKILL reconciles exactly once without model/native replay. | `multiuser-actions-*.test.ts`, fresh compiled host `multiuser-actions-process.test.ts`, real client consumer cases; fake external calendar only. |
| J09 personal portable import | Same deployment/account later export→earlier stopped instance→missing originals/Memory/conversation/Todos merge; existing new records win and repeated import deduplicates. Wrong user/deployment/format/coverage/corrupt original rejects atomically; no old auto grant/plugin/action authority revives after restart. | `multiuser-portable-import.test.ts`, `multiuser-actions-portable.test.ts`, real client modal/content entry. Personal merge is not historical per-user restore. |
| J10 account deletion | A has issued unknown external fact/held late result and shared bytes; revoke admission/publication first→durable result_unknown→exact late ACK settles only old fact→retry physically erases private metadata. A stays unreadable; B hashes/rows/credentials unchanged; missing/late hook blocks false success. | `multiuser-lifecycle.test.ts`, `multiuser-actions-lifecycle.test.ts` (actual M16 waits for calendar fact), provider deletion cases. Unknown cannot be marked physically complete or resubmitted. |
| J11 native instance/production package | Stopped backup CLI→empty isolated target→fresh emitted server twice; preserve deployment/account IDs, originals/hash, canonical Memory/history, conversations/config/plugins/Todos and succeeded/unknown facts; all authority retired. Old epoch/corrupt/missing domain/schema/native content rejects before target writes. | `multiuser-instance-backup.test.ts`, `multiuser-backup-{capture-updates,actions}.test.ts`; use `MOTE_M16_COMPILED_HOST=1 MOTE_M16_PACKAGED_BACKUP=1` after own fresh build. Copy-only dist is not fresh-build proof. |
| J12 shared config/plugins/connectors/old UI | Shared model key/reference and weight/code reuse with independent personal config/usage; M04 CAS/pinned snapshot/restart/explicit failures. Generated package formal install and actual worker; A stop leaves B active. Gmail/Calendar/Lark/document/recordings native formats and long text; OAuth reversed/replayed callback and account switch; no credential/cursor sharing. | Existing config/plugin/connector process tests, original algorithms and final owned client UI. Preserve Memory binding prepare/drain/migrate/activate/cancel and source import/Files/review/export/advanced settings capabilities in the owner ledger. Missing projections/UI block this row. |
| J13 Docker retained recovery | Disposable epoch5 Docker profile publication and stopped target recovery through production CLI; actual owned Hindsight Docker volume snapshot/restore and canonical/history re-open, without old execution authority. No deployment or existing-volume access. | **OPEN final container freeze/gate and Joint schema combination**. Owner13515436 actual generated production image restore/start/stop/restart/rebackup passes; direct offline Hindsight06fd canonical/API recovery passes. Managed Runtime/Engine.read258f787d actual same-case EXIT0 follows the preserved fixture-normalization failure; final required3ab706 ended EXIT0 after two separately preserved gate failures; local composition1a42 retains both originals and provider checks, with new narrow proofs below. Immutable image built EXIT0; old daemon/build-pending states are historical. Do not move the earlier d181 required gate to newer runtime or Joint Imports tables. |
| J14 real-model regression and private-data boundary | User amendment `Sentinel_90402956f4b881918763a8a61d350969`: retain deterministic mocks for isolation/retry assertions. When a real-model regression is needed, first verify the exact locally available Codex model/interface for the user’s “GPE 6.1 sol” (parent interpretation: GPT-6.1 sol), then use that signed-in local entry. Do not silently substitute another model/provider or create credentials. Prefer generated data. Optional local Central reads must be copied read-only to an isolated directory outside the repository before testing. | **PARTIAL: owner M15 actual generated Native Ask1/1,11.281s EXIT0** on retained48a baseline, using the existing M01/M04/M08 plus locally signed-in Codex `gpt-6.1-sol`. CLI0.162.1 catalog and ephemeral no-turn handshake selected the exact same model; no fallback/new provider credential. This is owner execution, not Joint rerun or an Imports semantic-model claim. Final composed model entry and privacy audit remain pending. Record only identifier/interface/SHA/result, no private content. Central originals and every derivative—prompts/responses, summaries, embeddings, screenshots, exports, logs, fixtures—must stay outside Git, including add/commit/stash/branches/remotes, PR text/comments and shared attachments/logs. Audit staged diff and new files individually; gitignore alone is insufficient. If private material has entered Git, stop push and report to parent; do not rewrite history or permanently delete it. Joint has used generated data only so far. |

## Historical receipts, deliberately not independent reruns

At107 the common M12/M16 executor was **M16**, with M12 checking its receipts.
`check:affected` EXIT0 included Desktop492, Server2626pass/1existing opt-in skip,
Web505, Agent317pass/1existing opt-in skip, Shared192, Diagnostics5, root81,
client5 and actual Android352/352 (74 XMLs, no fail/error/skip). Catalog4 and fresh
compiled Actions SIGKILL1/1 passed at107. Compiled/package backup40/40 and fresh
Desktop passed at `6f5bdeb6`; only Actions catalog runtime later changed.
See [M12 exact receipts](multiuser-actions.md) and
[M16 exact receipts](multiuser-m16-lifecycle.md). These results are neither this
thread's independent execution nor final proof for later client code.

Docker read-only environment probe in this workspace: sandbox attempt EXIT1
`permission denied` on socket; approved read-only `docker version --format
'{{.Server.Version}}'` EXIT1 `Cannot connect to the Docker daemon`. No daemon,
image, container, volume, permission or system setting was changed. The independent
source inspection also confirms `restoreProfile`'s explicit epoch5 Docker refusal.

## Execution order and release gate

1. Finish dependency mapping and documentation checks; compose only agreed
   freezes in this branch, preserve both sides of shared seams and inspect diff.
   Report preparation probes separately; do not repeatedly run whole suites while
   clients are changing. Dependencies are private copies with local workspace links.
2. Wait for all three final deliveries: exact tested SHA, final gap list, affected
   and relevant UI/native receipts, review and remote Draft PR verification. Any
   still-missing KEEP capability blocks the relevant row and whole-project claim.
3. Agree one final runtime/test combination and exclusive heavy window with the
   active owners. The parent's four current slots are M13/M15/Joint/container
   recovery; M14 has ended. No fifth thread and no awakening M12/M14/M16.
   Build shared libraries/Central/Desktop/current APK as relevant; run J01–J14's
   existing representative cases and actual client entry journeys on that tree.
4. Execute the repository-required
   `npm run check:affected -- --base origin/codex/mote-multiuser-integration`
   once against the frozen candidate with JDK21 and the existing Android SDK.
   Capture actual exit and Android XML counts. Run compiled/package restart checks
   from fresh own output, not another workspace's dist. Serial heavy phases only.
5. Record failures by responsibility and retain RED→minimal fix→same GREEN where
   a real new production defect is confirmed; rerun affected consumers/rows. Do not
   create a generic test infrastructure or rewrite old tests just to obtain green.
6. Only after this thread's applicable acceptance passes, publish its own Draft PR
   to integration, never merge. Verify exact remote head/base/Draft and CI status;
   Checks/Component checks stay disabled. Unrun Docker/physical/live-model/provider
   checks stay explicit, and prevent claiming acceptance across their scope.

Waiting conditions are substantive: three final client deliveries, closure of
missing original capabilities, an exclusive heavy window, and a decision/closure
for epoch5 Docker publication plus available Docker/Hindsight validation. Waiting
does not remove these rows. Current preparation has no final gate/PR receipt.


## Current shared Imports candidate — source-only checkpoint, not final parity

The original generic wire contract now uses M03 private staging and the existing
M06 host / M05 executor. It preserves raw four-MiB parts, stable upload/request
IDs, inline originals, one-day staging cleanup, host restart, deterministic text,
pinned bounded ZIP expansion, configured hash-pinned Python Source Packs, private
model-assisted previews, explicit review/confirmation, exact deduplication,
original archive links, cancel/retry and actual same-account portable merge.
No legacy Store, per-account runtime/executor or uploaded script capability is
constructed. Model mapping uses the existing read-only context reader; a separate
bounded host-control preview fragment may preserve original indexes or append
validated records only to the private preview. It grants no path, capture,
Material, Memory, provider or task authority. The original10000-record/32MiB
manifest bound and existing format-worker limits are retained; long text is not
truncated to fit one model answer.

The current15 cases in multiuser-import-jobs.test.ts and
multiuser-import-uploads.test.ts actually pass15/15, no skip,28.23s, EXIT0:
`/tmp/mote-joint-import-entry-composed.log/.exit`, Node24.21.0 with the existing
macOS Python OS-sandbox opt-in. This includes M03 real worker, M04 frozen import
lease, M05 task fence, immutable preview, a forged known-digest task refusal,
A/B equal business IDs, exact old inline wire, real ZIP worker, real Python
sandbox, long original + repeated fragment ACK, held model response through A
retirement/re-enable, completed import export/erase/B unchanged, and restored
unconfirmed preview requiring new preparation/confirmation. Model/ASR transport
uses generated loopback substitutes; Python/container decoding remains real.
First sandbox loopback EPERM was environmental and is retained separately; the
same authorized localhost command passed. The first inline/ZIP probe expected
raw archive text in public capture metadata; it correctly found empty text under
M03's contract. Corrected assertions read exact bytes through current M03 tickets
and explicitly require public capture text to stay empty; no production guard
was weakened.

Import media/read-only progress separately passes the same actual WAV chain1/1,
including explicit confirmation, exactly one ASR call per owner, exact ticket
bytes, live processing task/searchability, Memory disabled rather than falsely
completed, source-retired A unavailable and equal-ID B still current. Progress
projects existing M06/M08 receipt/material/task data only; it admits no work.
Non-disabled Memory recipe/batch progress is still awaiting its full user-journey
characterization. Server types passed after the sole new parts-array annotation
repair (`/tmp/mote-joint-import-expanded-types2.log/.exit`); subsequent projection
classification-only deltas need their final affected gate.

The M15 post-handler/onSend export observation was independently reproduced here
in multiuser-files-stream.test.ts (EXIT1). The producer now starts lazily on the
consumer read and checks exact current file/source/artifact proof before each
returned compressed chunk. Same held-source retirement + equal-ID B positive
and original source-error child process pass2/2/no skip/EXIT0:
`/tmp/mote-joint-files-stream-composed.log/.exit`. This closes that concrete
pre-consumer boundary; it is not a cross-account leak claim or all socket timing.

Still OPEN before whole Imports/Files acceptance: image profile/attachment image
pipeline equivalence (explicit image profile currently blocks rather than being
silently ignored); partial-commit recovery/ambiguity/fault branches; full Memory per-recipe/batch progress; Files review
proposals/acoustic samples/per-file overrides/reprocess/cancel/retry/forget and
complete recording export. Current source checkpoint is not a compiled/final
candidate, client consumer acceptance, required affected gate, or joint PR.


Deletion and stopped-instance import seams (post-ead narrow checkpoint): the
last-import delete previously left its private original downloadable (actual
RED against ead; /tmp/mote-joint-import-delete-red.log/.exit). M03 now removes
unreferenced archived file metadata and staging receipts, retaining other jobs
and capture links, and uses existing object GC when no M03 activity is active.
The same last-delete case passes, including actual absent A object path and
same-upload-ID B bytes. Personal unconfirmed export -> delete -> restore -> new
preview/confirmation also passes: two selected cases, 2/2, no skip, EXIT0 in
/tmp/mote-joint-import-delete-restore-approved.log/.exit. The initial sandbox
run's localhost listen EPERM is retained as environment failure, not code RED.

A new real stopped backup/restore case preserves A private preview and equal-ID
B completed history, rejects the pre-restore token and old confirm, then uses a
fresh model lease/preview/explicit confirmation before importing A. B capture
IDs stay unchanged. 1/1, no skip, EXIT0 in
/tmp/mote-joint-import-instance-restore.log/.exit. This is generated SQLite/FS/
production HTTP/backup script evidence with synthetic localhost model transport;
it does not substitute for physical clients, provider accuracy, partial-commit
recovery, pin-held deferred GC characterization, or the final affected gate.
Scope inventory passes; no new types/build/fullsuite was run during theme's
soleheavy window.


The 1a9d deletion checkpoint received a bounded source review from the container
owner (/tmp/mote-container-review-joint-import-gc-1a9d.md). Its late-GC concern
was reproduced with two generated originals and a fault after actual object GC:
HTTP503 rolled job/archive SQL back while its original bytes stayed absent
(/tmp/mote-joint-import-delete-gc-red2.log/.exit). Physical GC now runs after the
outer deletion metadata commit; failure leaves deleted metadata committed and
garbagePending=true for the existing GC retry. A surrounding host transaction
also defers physical GC. Actual real M03 pin retention initially returned a false
settled flag (pin RED); removed-hash pins now explicitly defer reclamation.

Four selected cases pass4/4/no skip/EXIT0, 7.04s in
/tmp/mote-joint-import-fault-pin-resume-green.log/.exit: successful last-delete
with sibling/B preservation; first record durable + injected second publication
failure -> host restart -> exact checkpoint resume (no first-record replay); late
GC failure -> committed deletion/pending GC -> retry; actual Originals.pin ->
metadata deletion/physical retention -> release -> physical GC. This closes these
concrete branches, not partial instance-restore or every ambiguity/external-I/O
path. No final types/affected/compiled/client acceptance is inferred.


Non-disabled Memory progress now has two concrete real entry cases, not merely
SQL seed coverage. /tmp/mote-joint-import-memory-composed-green.log/.exit is
2/2/no skip/EXIT0, 13.53s: same import ID A/B, two original records and two
selected recipes per owner, actual M03/M06/M08 workers with two-record batches,
then A cancellation of one selected recipe while its sibling commits. Both
selected recipes must complete before an original is completed; cancelled A
originals do not inherit B completion. The external model transport supplies
generated empty candidates with exact target coverage, not real model accuracy.

The missing-A-model case exposed an actual GET Import404 while the saved import
and original existed: mm_intakes had a proposed job_id but admission's actual
M05 task was stale/grant_revoked before mm_jobs existed. That failure is retained
in /tmp/mote-joint-import-memory-model-wait-red2.log/.exit. Projection now catches
only that missing Memory job, reads its actual intake task, and exposes failed
progress without a nonexistent job link; B completes through B model only. The
actual stale receipt is not relabelled waitingForModel. Media job links also join
actual owner mm_jobs. New known-model-wait/paused/backoff/restore branches remain
unverified, as does semantic extraction accuracy; current code still needs final
types/affected/compiled/client acceptance.


Partial instance recovery now has its separate actual case: before second M03
record publication a generated fault leaves exactly one committed record and
one durable checkpoint. Stop -> real epoch5 backup -> fresh target restore ->
old confirmation409 -> fresh model preview with zero new publications -> explicit
owner confirmation imports only the second record and deduplicates the first;
the original first capture ID survives. 1/1/no skip/EXIT0, 7.43s in
/tmp/mote-joint-import-partial-instance-restore.log/.exit. It uses actual M01/M03/
M04/M05/M06/SQL/FS/backup entry points with a synthetic model transport. No
production change was needed for this scenario. Unknown external results, image
profile parity, remaining Memory states and the previously listed Files gaps
remain OPEN; this case does not replace a final candidate gate.


Generic upload erasure seam: a real M03 original worker is held before its actual
prepareArchive transport while account A is deleted. M16 returns result_unknown
and retains A physical root until settlement. Equal upload-ID B commits and its
bytes remain readable. Release makes retired A commit401; explicit existing
admin erasure retry completes and A physical root is absent, B bytes unchanged.
1/1/no skip/EXIT0, 1.03s in /tmp/mote-joint-import-upload-erasure.log/.exit.
This proves the local live-activity erasure barrier for the new generic-upload
path; it is not an external provider unknown-result settlement assertion. No
production change was needed, and final affected checks remain pending.

M06 unknown-result repair candidate: original bare-503 fixture actually issued
four calls rather than one (RED /tmp/mote-joint-file-unknown-red.log/.exit).
The existing M05 issuance ledger now guards each real M06 I/O stage. Two new
production HTTP cases pass 2/2 in
/tmp/mote-joint-file-unknown-late-green2.log/.exit: bare503 retains unknown with
one A call and B success; a held valid ASR ACK after account deletion settles
only the exact old external fact, publishes no A artifact, and permits the
existing erasure retry to remove A physical originals while B stays indexed.
The earlier misleadingly named late-green log ran only the first case after a
fixture rewrite failed; it is not evidence for the second case.

Adjacent actual cases: ASR+diarization checkpoint restart and explicit unknown
retry 2/2 in /tmp/mote-joint-file-unknown-explicit-adjacent2.log/.exit; media
cancel, original M16 processing deletion, scoped summary and cancelled summary
4/4 in /tmp/mote-joint-file-unknown-fences-adjacent.log/.exit. Explicit retries
start a fresh attempt budget; two confirmations and four actual calls leave two
old unknown external facts unresolved. Initial candidate nested-admission and
fixture budget assertions failed and remain in their own logs; these are not
baseline behavior failures. No full affected/type/compiled acceptance is inferred
from these narrow generated transport cases, and no real provider was called.

M05 adjacent issuance capability: a completed first stage permits the second
issuance, replaying the first ACK leaves the second issued, and settling A's
second fact never readmits its blocked task or changes B. This new case plus
the existing unknown-effect restart/owner-confirmation case pass 2/2 in
/tmp/mote-joint-file-unknown-m05-adjacent2.log/.exit. These are task-authority
checks, not new client or arbitrary socket-timing coverage.

Additional cross-operation characterization: a fresh operation ID was accepted
and actually issued a second ASR request while its original remained unknown
(1/1 RED, /tmp/mote-joint-file-unknown-new-operation-red2.log/.exit). Admission
and issuance now check the existing owner's unacknowledged M05 calls for that
original. Same-operation ACK retry remains idempotent. The extended bare503,
late account-delete ACK and two synchronously queued no-model parents with real
asynchronous M04 children pass 3/3/no skip in
/tmp/mote-joint-file-unknown-operation-queue-green2.log/.exit. Initial queued
fixture wrongly attempted synchronous model admission and was rejected409; it
was corrected to genuine no-model parents, without changing production rules.
Existing cached duplicate operation, ASR checkpoint and explicit confirmation
recovery pass 3/3 in
/tmp/mote-joint-file-unknown-cross-operation-adjacent.log/.exit. The new admission
query does not turn a replay confirmation into outcome settlement. Types,
independent review of this additional delta and final composed gate remain due.

Two additional Imports→Memory projection journeys need no production change.
A real held extraction is paused by its owner, its successful checkpoint settles,
then host restart retains paused1/completed0; resume runs the still-pending
independent review and completes, while equal import-ID B remains complete and
cannot control A's job. 1/1/no skip/EXIT0,4.995s,
/tmp/mote-joint-import-memory-paused-restart.log/.exit. A separate real429
Retry-After60 capacity response leaves the saved Import completed but Memory
pending1/completed0/failed0 and no spent execution attempt. Host restart/tick
preserves that future wait without another model request; B cannot retry A;
explicit owner job retry performs the missing work and completes.1/1/no skip/
EXIT0,5.570s,/tmp/mote-joint-import-memory-capacity-restart.log/.exit. Only model
transport responses are generated; actual M01/M03/M04/M05/M06/M08 receipts and
host restart order are exercised. Missing-model intake failure remains the
previous distinct actual stale receipt, not a fabricated waitingForModel pass.
Unavailable snapshot recovery and additional Files/image-profile parity stay OPEN.

A genuinely unavailable retained M04 snapshot now has its distinct composed
case: after real429 capacity waiting, corrupt only the generated exact encrypted
snapshot tag, restart, and owner retry. The actual M05 task blocks with
model_snapshot_unavailable; GET Import remains saved/completed but reports
Memory waitingForModel1/completed0/failed0, with zero additional A model calls
and B still complete. Restore only the exact retained encrypted tag, restart,
and owner retry completes through the original snapshot.1/1/no skip/EXIT0,
5.304s,/tmp/mote-joint-import-memory-snapshot-recovery.log/.exit. Ciphertext and
keys stay in the generated temporary fixture/in-process memory, never in Git or
logs. This is a snapshot fault/recovery assertion, not permission to substitute
a fresh model for a withdrawn snapshot or a real-model semantic validation.

M13 bounded read-only reviews of exact1a3bf5d9 and exactce3572ce report no new
confirmed P0/P1/P2 in /tmp/mote-m13-review-joint-unknown-{1a3b,ce357}.md. The
reviewer did not execute the tests or compose the candidate. Existing generic
private-preview/confirmation plus equal-ID WAV Imports→real M03/M04/M05/M06
adjacent cases pass2/2 in
/tmp/mote-joint-unknown-import-entry-adjacent.log/.exit on the new runtime. This
supports the narrow candidate; fresh source types and final gates remain due.

The atomic cross-operation guard rejects before transport begins. Its existing
ExecutionFailure fact now explicitly records executionStarted:false, so the
queued rejected task retains zero spent attempts as well as no second issuance
or activity. The same three cases pass3/3/no skip/EXIT0 in
/tmp/mote-joint-file-unknown-no-issuance-budget.log/.exit. This flag is a host
pre-I/O fact, never inferred from a provider message or used to settle the older
unknown call. ce3572 review covers the preceding query; this final one-fact delta
is separately identifiable for the reviewer and current types remain pending.

Explicit narrow release: c45fdb4a2518fef0d5072b02aafbe8f46cb5a90b Server source
noEmit ACTUAL EXIT0, /tmp/mote-joint-unknown-current-types.log,
/tmp/mote-joint-unknown-current-types.exit and .sha. It was a few-second idle-gap
claim after Container final3 explicit release, with immediate Joint RELEASE.
M13's final c45 pre-transport fact review also has no new confirmed P0/P1/P2,
/tmp/mote-m13-review-joint-unknown-c45f.md. Together with the exact narrow actual
receipts, this permits clients to compose this thin checkpoint. It is not a new
module-final/full affected result and does not close remaining original outcomes.

Frozen container composition is now local merge
1a42f2e9fd015e29bbf26a6e43209cc8c0440990 of declared source723cc0b7. Verified
ab706→723cc changes only one validation document; all runtime inputs match the
owner's final3 EXIT0. Its Server2641/Desktop492/Web505/Android352 (fresh74XML,
zero fail/error/skip, actual unit execution/compiled inputs reused) remain owner
evidence. Container has ended and must not be awakened. Parent restored Theme
only for independent PR143 review; no theme source is merged here.

Automatic composition retains both archived-file original completeness and
strict Hindsight canonical provider/body verification, with Joint's extended
schema catalog intact. Own narrow protocol run passes15/15/no skip/EXIT0 in
/tmp/mote-joint-container-merged-protocol.log and .exit. SQL/FS/YAML staging and
native host reopening are real; Docker transport remains substituted there.
Own actual stopped-Import private-preview/equal-ID recovery plus partial
first-record dedup/fresh-owner-preview recovery pass2/2/no skip/EXIT0 in
/tmp/mote-joint-container-import-composed-restore2.log and .exit. Only model
transport is generated. The first similarly named command matched no test
names and produced a file-level success; it is explicitly not case evidence.
Combined actual Docker/Managed Hindsight production and final client/affected
proof remain pending. Content audit:
/tmp/mote-joint-container-composition-content-audit.md.

Files cancellation candidate after host recovery: baseline original endpoint
returns503 scope_unavailable (actual RED,
/tmp/mote-joint-file-cancel-entry-red.log and .exit). The pre-disconnect same-case
GREEN session57818 had an unknown outcome until recovery. On restored Bogon,
its saved log/exit proves1/1/EXIT0; scoped process inventory confirms no old test
is still running. Transport disconnect/ps sandbox denial are environment facts,
not code failures. The five original uncommitted files were preserved.

The extended actual cancel case now includes held A ASR, unaffected other A file,
equal-ID B, missing B original404, valid late completion/no A publication,
retained original, sticky cancel across ordinary restart, private portable export/
merge, corrupt original-control link rejection, and stopped-instance restoration
with old token401/no resumed cancelled work.1/1/no skip/EXIT0 in
/tmp/mote-joint-file-cancel-lifecycle.log and .exit. Latest missing-owner check plus
unknown503 cancellation pass2/2/no skip/EXIT0 in
/tmp/mote-joint-file-cancel-unknown-isolation.log and .exit: wait remains unknown,
old external fact remains unresolved and B is still indexed. A separate real
language-agent cancellation retains the completed raw Material, rejects the held
late summary and allows exact owner text correction;1/1/EXIT0,
/tmp/mote-joint-file-cancel-owner-edit.log and .exit. All transports/content are
generated; M01/M03/M04/M05/M06/M16 and restart/backup/portable entries are real.
Types, independent bounded review and current affected/compiled/client gates are
pending for this candidate. c45 remains the previously declared thin consumer
freeze until a new one is explicitly released; file retry is not implemented here.

The pre-existing multi-page summary recovery fixture assumed automatic replay
after a bare503. That expectation conflicts with the original issued-call guard:
the actual old expectation fails in
/tmp/mote-joint-summary-unknown-original-expectation.log (EXIT1). The fixture now
uses the existing owner retry confirmation, verifies no unconfirmed replay,
keeps the successful first-page checkpoint and original model snapshot, and
checks that acknowledging replay does not settle the old external fact.
/tmp/mote-joint-summary-unknown-explicit-recovery2.log and .exit pass1/1/EXIT0.
The first updated driver only polled SQLite after restart and never triggered
Fastify startup; its EXIT1 is retained separately in the unnumbered recovery log.
The successful driver uses an actual owner task GET to start the restored host.
No production behavior was weakened. Exact3dd Server and scripts noEmit are
also EXIT0 in /tmp/mote-joint-file-cancel-types.log/.exit/.sha. Independent
exact3dd bounded review reports no new confirmed P0/P1/P2 in
/tmp/mote-theme-review-joint-file-cancel-3ddfd60d.md; old-input ACK identity remains
a separate upgrade acceptance gap. Theme has ended and is not being reawakened.

The generation-zero identity caveat has now produced a durable actual RED in
a0afd5d9: real owner admission differs from the historical M05 identity formula
when the default zero field is serialized. The narrow fix normalizes only zero
to the historical absent field; nonzero cancellation generations remain admitted
inputs. /tmp/mote-joint-file-generation-identity-green.log/.exit pass2/2/EXIT0:
the independently evaluated old identity, persisted zero-format parent/child
inputs, restart/lost-ACK lookup with no extra tasks, and the real held-summary
cancellation fence. This is not an execution of an old production binary or a
general historical archive migration claim. The original RED remains preserved.

Files explicit reprocessing candidate (not a consumer freeze): the original
POST retry route first returns503, /tmp/mote-joint-file-retry-entry-red.log/.exit.
Fresh owner transcribe after cancellation/stopped restore succeeds and same
operation returns its one durable task. The additional actual owner-task
confirmUnknown-before-transport-return case reveals200 instead of409 in
/tmp/mote-joint-file-retry-physical-ack-red.log/.exit. The fix checks physical
activity independently from replay acknowledgements. The same case plus bare503
unknown/required confirmation/foreign owner rejection/new task/old fact intact/B
positive pass2/2/EXIT0 in /tmp/mote-joint-file-retry-physical-ack-green.log/.exit.
Summary explicit reprocess preserves raw/current evidence and old summaries,
reruns both requested pages under the current selected model, and repeats ACK
without extra calls;1/1/EXIT0 in
/tmp/mote-joint-file-summary-reprocess-green.log/.exit. All inputs/transports are
generated; no Central original or derivative was read or staged. Diarization-only
retry/overrides, acoustic assets/reviews and broader Files outcomes remain OPEN.

Diarization-only candidate: actual initial partial pipeline has accepted raw ASR
but no exposed exact raw locator;1/1 EXIT1 in
/tmp/mote-joint-file-diarize-only-red.log/.exit (durable test a060e73f).
After adding canonical stage references, the first implementation attempt's
misplaced code block returned503; /tmp/mote-joint-file-diarize-only-green.log/.exit
is retained as a failure, not a fixture/environment reclassification. Corrected
same case passes1/1/EXIT0 in the green2 log. Latest extended case passes1/1/EXIT0
in /tmp/mote-joint-file-diarize-portable-green.log/.exit: invalid raw ID409,
no repeated ASR during diarize-only, stable ACK, file-specific speaker count,
restart retention, fresh full transcription with sticky policy, explicit null
reset, B default policy/foreign raw rejection, personal export/merge without task
IDs, future-generation proof rejection and retained valid raw reference.
Adjacent cancel/unknown/zero-identity/diarize cases pass4/4/EXIT0 in
/tmp/mote-joint-file-retry-diarize-adjacent-green.log/.exit. Current AST inventory
and transitive production boundary pass in
/tmp/mote-joint-file-controls-scope.log/.exit; declarations add only the four
owner-keyed M06 tables and original cancel/retry endpoints. No Central data or
real media/model input was read; all artifacts and fixtures are generated.
This candidate still awaits types, independent review and the affected/compiled/
client gates; the declared consumer freeze remains c45.

A separate original Task cancel→confirmUnknown→fresh Processing operation
combination actually issued a second held provider call before the first ended:
/tmp/mote-joint-processing-physical-ack-red.log/.exit,1/1 EXIT1, durable c2403df1.
The shared M06 admission and pre-I/O guard now both inspect physical activity
independently of replay acknowledgement, not only the Files retry endpoint.
The corrected same case is recorded separately; no acknowledgement marks a fact
succeeded or frees a live worker. This extends the earlier endpoint-local fix,
not a new confirmation policy or executor.

Acoustic export: original accepted diarization has no preview artifact in the
first actual RED /tmp/mote-joint-file-acoustic-export-red.log/.exit (c3e1007b).
New private WAV asset/metadata and complete archive same-case GREEN1/1 are in
/tmp/mote-joint-file-acoustic-export-green.log/.exit. Current adjacent3/3/EXIT0
/tmp/mote-joint-file-acoustic-export-adjacent.log/.exit covers that case, actual
HTTP onSend source-retirement/B-positive and child-process gzip error settlement.
The later precise RTTM newline/CSV CRLF plus invalid WAV/last-good-retention test
passes1/1/EXIT0 in /tmp/mote-joint-file-acoustic-export-newlines-red.log/.exit:
that filename was provisional; the run is GREEN and does not establish a format
bug. Metadata-only lookups keep export stream fences from reparsing large raw or
acoustic bodies on every gzip chunk. Generated fake transport only; actual host
storage/authorization/executor/archive stream are used. The broader M06 physical
occupancy fix51d same case is1/1/EXIT0 in
/tmp/mote-joint-processing-physical-ack-green.log/.exit. Current types and bounded
review remain pending, and these outcomes do not close model reviews/calendar
associations, image-policy/attachment parity, forget/allowagain or final gates.

Exact36ffde5c Server source and scripts noEmit ACTUAL EXIT0:
/tmp/mote-joint-file-current-types.log/.exit/.sha. Source stayed fixed throughout;
parent fresh QR EXIT124/RELEASE followed by M15 short Gradle terminal/RELEASE
preceded the claim. Joint released all heavy work immediately afterward. The
subsequent stronger partial-export test adds no production change and passes2/2
with the zero-identity case in
/tmp/mote-joint-file-current-partial-export-green.log/.exit: partial manifest
explicitly processed=false/indexed=false/current raw artifact, exact bad-WAV
failure code, retained previous publication and B-positive. Types and these narrow
runs do not replace an independent bounded review or own final affected/compiled/
client acceptance. QR's full affected timeout124 is not a passing gate here.

The existing export child-process fixture was root-CWD dependent: the actual npm
Server workspace entry fails ERR_MODULE_NOT_FOUND in
/tmp/mote-joint-export-workspace-entry-red.log/.exit. Its test-only fix resolves
the module relative to import.meta.url. Same fixture now passes1/1 both in the
Server workspace and repository root, respectively
/tmp/mote-joint-export-workspace-entry-green.log/.exit and
/tmp/mote-joint-export-root-entry-green.log/.exit. No runtime source changed;
QR's parallel prerequisite-fixture repair remains its own work/evidence.


Current bounded M06/Files component regression naturally terminates EXIT0,
53/53 pass,0failure/cancel/skip,69.462s, fixed test HEAD
e2d3b1b20a80287161212e09ce994cadc659eebf (production36ffde5c):
/tmp/mote-joint-file-component-current.log/.exit/.sha. The six files are
multiuser-processing, multiuser-file-controls, multiuser-file-unknown,
multiuser-files-stream, file-export-stream and scope-architecture. Actual
M01/M03/M04/M05/M06/M09/M16 paths, generated external transports, no skipped
case; this is neither full Server nor affected/compiled/client joint proof.
Source and tests stayed fixed throughout. All heavy work was released immediately.
Under the parent's22:08 resource ruling QR is the next sole heavy owner; Joint
and M15 await parent allocation afterward and do not infer another slot from old
status files. The producer's124 and stopped superseded gate remain non-passing.

## Current original Files reviews — narrow candidate evidence, not final gate

After tested production36ff, the original term/calendar review workflow is being
adapted through one existing M05 executor and personal M04 file-model leases.
The term entry actual503 RED is committed atf5d4ff86. Test4ca9f9cd preserves its
normal confirmation/retained-history case plus calendar/lifecycle boundaries.
Current production changes remain a candidate pending types, bounded independent
review and own affected/compiled/client acceptance; the53-case component gate
above does not cover them.

Actual generated-data executions:

- Term proposal→explicit selected correction retains original immutable text and
  B's equal-ID data; processing-domain export/delete/restore rejects a forged
  source range and preserves accepted history with no task ID/model replay.
  Calendar archived-input proposal→explicit association leaves both calendars
  unchanged; detail/export show only A's confirmed association. Initial combined
  two-case receipt `/tmp/mote-joint-file-review-retained-data.log/.exit`,2/2 EXIT0.
- The archived/reference calendar confirmation history now passes actual domain
  restore/restart with forged confirmation-reference rejection and zero new tasks;
  source disable hides link/body, source re-enable reopens the same retained proof,
  and real private capture DELETE removes dependent review/link data while B's
  same event UUID remains unchanged. `/tmp/mote-joint-file-review-calendar-portable.log/.exit`,2/2 EXIT0.
- Metadata-only reference fixture first had invalid layer/body setup, preserved as
  non-runtime failures. Valid reference data then produced stale/zero external
  issuance because no original exists, `/tmp/mote-joint-file-review-calendar-reference-red3.log/.exit`.
  Minimal metadata-only projection marks bodyAvailable=false and the same case
  passes1/1, `/tmp/mote-joint-file-review-calendar-reference-green.log/.exit`.
- Source-context change, owner correction and file cancellation while the actual
  generated provider response is held each prevent the late proposal publishing;
  no retired reason is returned and old raw text remains. Three cases EXIT0 in
  `/tmp/mote-joint-file-review-held-lifecycle.log/.exit`.
- Before-LIMIT selection:205 newer disabled-source calendar records must not
  displace the one allowed owner candidate. Initial setup through full Ingress
  admitted unrelated background work and exceeded the narrow12s wait (running
  task, not a completed functional result); that failure remains preserved.
  The candidate-order fixture now uses the real owner-bound M02 metadata service
  for the hidden-only rows, with actual M03 for the allowed A/B inputs. Same
  ordering/negative-content assertions pass1/1 in
  `/tmp/mote-joint-file-review-calendar-limit2.log/.exit`. No production change
  was made to obtain that fixture-only timing result.
- The original quarantined term and calendar algorithms still pass their two
  targeted characterizations after pure prompt/schema extraction:
  `/tmp/mote-joint-file-review-legacy-contract.log/.exit`,2/2 EXIT0.
- Scope inventory/private-SQL/import boundary EXIT0 in
  `/tmp/mote-joint-file-review-scope2.log/.exit`; raw validation SQL was changed
  to the existing owner-bound PrivateSql metadata-validation pattern, without
  granting data access. Current source noEmit has not yet run for this candidate.

All data/providers/archives are generated. There was no real calendar/mail write,
Central-content read, real-model request, new CI/deploy or remote branch change.

### QR87 compatibility supplement

Core expired-input preflight before external issuance is source-compatible with
Joint's physical-call/generation guards; the previous unconditional pin-release
statement is qualified. Generated production Ingress primitive actualRED:
acquire exact pin→admin disables owner→invoke the exact acquired disposer throws
invalid_identity and leaves one pin, `/tmp/mote-joint-pin-disposer-review-red.log/.exit`.
This is not yet a composed87 held-M06-response reproduction. QR owner received the
bounded finding and cleanup-only exact-pin recommendation; Joint has not duplicated
or merged the fix. Account deletion, which clears pins, is a different boundary.
No independent reviewer execution or whole QR acceptance is inferred.

Original Files forget/allow-again is still an actual capability gap, not merely a
source suspicion: generated same-capture-ID A/B file DELETE currently returns
scope_unavailable503 in `/tmp/mote-joint-file-forget-entry-red.log/.exit`,1/1 EXIT1.
The durable test retains the old410 forgotten-resync guard and explicit allow-again
outcome as its target; assertions after the first failure are not executed evidence.
The current74fe review implementation does not claim to implement file forgetting.
Before closing this gap, preserve per-source/external-ID tombstones, all owned
revisions, derived visibility retirement, late-worker/old receipt/ticket fences,
post-commit pin-aware physical GC and personal merge/restart semantics. A simple
DELETE alias or metadata-only hide cannot count as original capability parity.

Current forget implementation0095c897078fce04ce75c687a0e1fc6abc81b479 closes the
original503 route RED in its bounded scope. Same original user entry now passes
with B isolation,410 resync refusal, explicit allow-again without automatic content,
and rejection of an old signed ticket even after the deterministic original ID is
reimported. Full personal old-archive import fails archive_conflict with no canonical
resurrection, followed by restart; content-free tombstone Ingress-domain export/
delete/restore retains the block. `/tmp/mote-joint-file-forget-portable-green.log/.exit`,1/1 EXIT0.
The stronger final two-case receipt `/tmp/mote-joint-file-forget-revisions.log/.exit`
is2/2 EXIT0: all two owned revisions retire, an old revision cannot undo the newer
forget intent, exact held pin defers physical cleanup, independent same bytes and
B survive. `/tmp/mote-joint-file-forget-held.log/.exit`,1/1 EXIT0, exercises a real
held generated media transport: no late A artifact, one old call fact only, B
processes normally, exact manual pin remains until release and existing GC then
removes A's physical object. No live provider is involved.

Parent23:03 allocated only a5–10s type window after QR's fresh release. Fixed0095
Server and scripts noEmit ACTUAL EXIT0 in about5s:
`/tmp/mote-joint-file-reviews-forget-types.log/.exit/.sha`. PTY23986 was read to
terminal0, all heavy work explicitly released to QR's post-disposer final affected.
No full suite/build/Gradle was appended to that short window. Scope AST on current
forget source0 (`/tmp/mote-joint-file-forget-scope2.log/.exit`). Independent review
of the new review and forget implementation remains pending; no final joint gate.

Independent QR readonly review accepted the74fe review producer with its source-only
limits (`/tmp/mote-qr-review-joint-owner-review-74fe.md`). Its0095 forget review found
one incarnation path requiring actual proof (`/tmp/mote-qr-review-joint-forget-0095.md`).
Joint actual automatic=true same-byte/original/receipt allow-again+restart returned
the retired successful task: `/tmp/mote-joint-file-forget-incarnation-red.log/.exit`,1/1 EXIT1.
A parentless old extract retry actually executed again and failed instead of being
stale: `/tmp/mote-joint-file-forget-parentless-red.log/.exit`,1/1 EXIT1. Durable
regressionsb024d64a;0095 is not accepted for those paths and its types do not cover
this later fix.

Fix056380c2c036f48d32241e8db3a59e8081cf5e4c binds M06 input/current/cache and review
base to the existing M03 forgotten-original generation. This is independent of
per-file cancel/retry generation; zero is omitted from serialized identities and
stage fingerprints, preserving historical tasks/cache. No new table, route,
executor, grant renewal or wire request is added. Exact two regressions plus the
existing historical generation-zero/lost-ACK identity case pass3/3 EXIT0 in
`/tmp/mote-joint-file-forget-incarnation-green2.log/.exit`. The first post-fix run's
extra-call assertion incorrectly expected zero despite the actual initial decoder
call; its failed receipt is preserved. The final fixture compares the actual
pre-retry count and keeps the stale-before-execution assertion unchanged. Fix0563
is submitted for bounded independent review; new noEmit/whole gates remain pending.

M15's earlier36ff source-only acoustic publication concern was actually reproduced:
real M03/M04/M05/M06 generated ASR/diarization, fixed A response held in Fastify
onSend, then source disable or exact diarization replacement, still returned the
captured WAV. Both cases fail in `/tmp/mote-joint-file-sample-publication-red.log/.exit`,
2/2 EXIT1; durable8393bca1. Minimal679a175c40b9c20c3fb0b6789f089188c8ac0dd7 replaces
the eager Buffer response with a lazy direct Readable, rechecking owner/source and
exact current diarization before each64KiB block. Fastify observes the returned
stream's errors; no intermediate pipe can swallow them. Same two cases and each
B-positive WAV response pass2/2 EXIT0 in
`/tmp/mote-joint-file-sample-publication-green.log/.exit`. This is not an execution
of every backpressure/network/UI mode. New source types/independent delta review
and final affected/clients remain pending;0095 types do not cover679a.

M15's separate legal-large-artifact/8MiB native JSON concern is still unexecuted;
raw full diarization arrays in detail were also part of the original legacy shape.
No new quota, silent array truncation or invented paging framework is added from
that source-only observation. Preserve it for bounded consumer/old-path comparison
before deciding whether it is a regression or an existing scaling limit.


### Exact delete decisions —4be0cb4c

M15's independent same-capture replay report is /tmp/mote-m15-review-joint-files-0095.md;
its2cc60c20 actual execution remains M15 evidence. Own durable9360ca56 reproduces
two failures at real M01/M03/M06 HTTP entry: stale first allow-again after a second
forget returns200 and permits upload200 (expected409/410), and lost DELETE ACK
retry returns404 (expected fixed200 receipt). Own /tmp/mote-joint-file-forget-decision-red.log/.exit
is2/2fail EXIT1. This is separate from0563's already-fixed task incarnation issue.

Minimal4be0cb4c adds exact decision CAS, expected original generation and stable
owner operation receipts. /tmp/mote-joint-file-forget-cas-final-narrow.log/.exit is
10/10pass, 0skip/fail,8.397s EXIT0: two original same-path fixes, missing/stale
metadata, old independent delete intent, actual app restart before ACK replay,
schema/partial-upgrade initialization, historical-zero task identity, older archive
conflict+data-only tombstone restore/old decision rejection, all revisions/shared
bytes/pin, held fake transport+B, automatic same-byte reimport and parentless old
retry. No real provider or personal content was used. Scope inventory0 in
/tmp/mote-joint-file-forget-cas-scope.log/.exit. Earlier intermediate green2 is3/3;
prior neighbors6/6 selected only by name, and is not a complete file suite.

Current4be0cb4c noEmit/independent source review/affected/compiled/native/client/
Docker schema combination are pending. Previous203997 types cover0563/679a but
not this changed wire. Profiles/rules and parent-bound imported image preparation
remain OPEN; the new attachment target test has no production implementation and
its first503 denial is not a positive attachment/Memory proof.

### Exact retained attachments —3d2cad43/770f548c

Original positive HTTP preparation entry was actual503 RED1/1 at46d1d9f8,
`/tmp/mote-joint-file-attachment-entry-red2.log/.exit` (earlier first foreign-denial
failure is not positive entry proof). New3d2cad43 implements actual parent/archive
relation, current binding, same M06 executor and M07 pure organizer. Initial child
OCR/parent retirement passed, but the added joined-caption assertion exposed
M02 asset quarantine, legacy chunk UUID evidence adaptation and the archived source
caption being omitted. Those intermediate failures remain in attachment-joined
logs; only later unwrapped real handler execution is used as GREEN.

Waiting for the actual rebuilt joined Material and re-projecting its image anchor
then confirmed old navigation revival (settled-red EXIT1); Material binding lineage
fix passes. Data-only Ingress+Processing restore separately reproduced the same
old-anchor problem at e3913d26 in attachment-restore-anchor-red EXIT1. First image-ID
fix collided with old unique evidence block identity (final-narrow EXIT1), retained.
Minimal770f binds both block and image ID to the new M03 relation; non-attachment
image identities remain unchanged.

`/tmp/mote-joint-file-attachment-final-narrow2.log/.exit` is5/5pass,0skip/fail,
8.221s EXIT0: original preparation/actual OCR and joined original parent caption,
real Memory read_image, same-parent UUID retirement/recreation/new task and Material
revision with exact raw OCR reuse, held A provider response across parent deletion/
source disable/head replacement with B processing and no A artifact/pin, and
accepted OCR/domain data restore with old ticket/image-anchor rejection plus fresh
image navigation. Pure generated2px PNG, captions and fake loopback OCR only;
no model inference or real user data. Full HTTP personal import, producer noEmit,
independent review, native/client/compiled/container and full affected are pending.

### Frozen QR plus current Files composition

Producer PR144 head48547e8f/test672 finalrequired960s0 is read-only owner evidence;
no completed owner thread was awakened. Joint08fa2ba1 uses exact frozen auth
source and selective M05/M06/Originals pin/retry deltas. It retains all Joint
incarnation, per-file cancel/retry/raw cache, owner review and attachment fields.
Own `/tmp/mote-joint-qr-composed-narrow.log/.exit`:16/16,0skip/fail,2.823s EXIT0,
real generated M01 QR claim/revoke/ACK/known-device/reauthorization routes, pin
disposer and three retry-hook transaction rollback modes.

Own `/tmp/mote-joint-qr-files-composed-neighbors.log/.exit` was33cases,29pass/4fail,
EXIT1. All four were own pre-existing fixture pin-count assertions after a
coordinator's public terminal state, while the actual media activity remained
active. No production failure or physical pin leak was inferred from that point.
`/tmp/mote-joint-qr-files-physical-phase.log/.exit` repeats exactly those four
with actual media completion as the boundary:4/4,5.614s0. Diagnostics actually
show activeMedia1 and the held pins before completion, then original no-A-artifact,
zero provider pins/manual pin retained, eventual GC and B assertions pass. Tests
only changed; all first failures remain. This is not a second full33-case green
receipt or a full Server/affected gate. New source types/review remain pending.

Attachment retained-object admission later4c55761f avoids copying/re-reading the
whole already-admitted archive object; existing M03 metadata, checksum readers
and reference-only admission remain authoritative. Six narrow cases passed in
10.274s `/tmp/mote-joint-file-attachment-retained-object-narrow.*`; the added
reference-only assertion passed separately1/1 in0.813s in
`/tmp/mote-joint-file-attachment-reference-admission.*`. Scope checker0. No large
file throughput/production performance claim follows from these generated cases.

### Model-less original OCR/ASR reference

Own e458bf1e durablecase gives actual M04 OCR lease scope_unavailable503 at
/tmp/mote-joint-empty-media-reference-direct-red.log/.exit; original legal media
service model:'' is not a language model. Earlier pipeline-only stale observation
is retained in empty-media-reference-red and not substituted for the direct proof.
Minimal69f8133e feature-aware check passes samecase including actual generated
MoteMedia OCR, unchanged blank model in usage, ASR lease without execution, and
chat/memory rejection. The full bounded ModelResources value suite plus this
HTTPcase is16/16,2.492s0 in /tmp/mote-joint-empty-media-reference-neighbors.log/.exit,
including shared/personal credential/locality/no-fallback/withdrawal/environment
checks and new shared blank-media language-feature negatives. No real inference.
NoEmit/current fullgate and independent delta review are pending.

The new processing-policy-contract pure value checks3/3 in0.244s0
/tmp/mote-joint-processing-policy-value.log/.exit only. It has no registered route,
M04 domain, M03 intake or M05 processing behavior yet. Keep the actual public
profile/settings/import-choice group OPEN.


### Library entry and explicit limited PREP8177

After composing M13 declaredbe6 source slice, own actual Library record has the
real fileArchive proof. Parent deletion still returned raw-detail200 (expected404)
in `/tmp/mote-joint-attachment-capture-browser-red.log/.exit`,1/1 EXIT1,0692552c.
8177's common relationship predicate is applied before count/LIMIT; actual raw
positive, retired404/count0, forged declaration404/count0 and the other attachment
flows pass6/6,0skip/fail,11.647s EXIT0 in
`/tmp/mote-joint-attachment-capture-browser-green.log/.exit`. Source head lookup
uses the existing owner/source/external primary key. This is source/presentation
adaptation, not another file projection or Material processor. Scope checker0 in
`/tmp/mote-joint-current-public-prep-scope.log/.exit`; policy values after final
parser/error refinement3/3 in processing-policy-value2 EXIT0.

Explicit consumer PREP source8177 is now released with current noEmit, source
reviews, full affected/compiled/native/clients and current portable/container
combination PENDING. Historical203997 types do not cover it. This permits consumers
to implement the fixed API bodies now, not to mark final acceptance. Parent has
allocated Desktop QR soleheavy; no Joint build/fullsuite/Gradle/Docker was started.
There is no pending user approval or policy denial; M15's message routing returned
earlierturnunconfirmed, not an approval request or confirmed delivery. Exact shared
handoff `/tmp/mote-joint-files-public-freeze.md` is available for parent relay.

### Source recreation DELETE CAS — new confirmed gap and repair

Independent M15 reproduction16532 and Desktop bounded4be review identified an
unadmitted old generation-zero DELETE accepted after source/capture recreation.
Those are peer evidence. Own durable50527b80 uses the actual source DELETE,
registration and multipart intake: same captureUUID, before0/after0, late DELETE200
and replacement404 instead of409/200. Actual1/1fail EXIT1 in
`/tmp/mote-joint-file-source-incarnation-red.log/.exit` (2.009s). This is a new
boundary beyond the previous forget-cycle/lost-ACK regression, not that old bug.

The repair preserves request bodies and keeps a private monotonic incarnation
counter across canonical file/source retirement. Initial green1 retained the same
failure because the source FK cascade may remove original rows before the Capture
trigger; that trigger now uses the canonical file identity, not the presence of a
child original row. green2 is5/5. green3 is6pass/1fixturefail because the existing
SQL error mapping returns503, not the fixture's500; the explicit fault and rollback
assertions remain. Current green4 is **8/8,0fail/cancel/skip,7.163s EXIT0** in
`/tmp/mote-joint-file-source-incarnation-green4.log/.exit`. It includes actual
restart after source recreation, old signed ticket404/new ticket exact bytes,
Capture-only retirement, prior forget/allow plus source retirement, shared-SQL
fault rollback, actual M16 account erasure and unchanged B, and the original four
exact-decision/schema-upgrade regressions. All data is generated.

Scope inventory/production boundary and diff whitespace checks passed:
`/tmp/mote-joint-file-source-incarnation-scope.log/.exit`. The six selected M06
neighbors first returned5pass/1environmentfail (`listen EPERM`, no provider request)
in `/tmp/mote-joint-file-source-incarnation-processing-neighbors.log/.exit`.
Only the held localhost-provider case is rerun under the standard approved local
execution; its separate terminal receipt is recorded without relabeling that first
run. Current source noEmit, independent repair review, full affected, rendered
clients and native/container restore remain pending. No PR or whole acceptance.

Attachment3d/770/4c independent bounded review has now been read from
`/tmp/mote-m15-review-joint-attachments-3d-770-4c.md`: no new confirmed P0/P1/P2
within its stated source scope. It did not rerun owner tests or review this new
source-incarnation repair. M13 exact84e3 large Lark calendar inventory received a
separate Joint source-only bounded review with no new confirmed finding:
`/tmp/mote-joint-review-m13-lark-calendar-84e3.md`. No M13 runtime was composed.

The approved exact held-provider rerun is1/1,0skip,3.026s EXIT0 in
`/tmp/mote-joint-file-source-incarnation-held-approved.log/.exit`; it observes
coordinator retirement while activeMedia1/pins2, then waits actual completion.
Together with the five successful selected neighbors, this covers six distinct
cases across two executions; it is not a six-case green rerun or whole suite.
A test-only refinement additionally restores a live nonzero-generation file before
source retirement, verifies exactly one increment for explicit forget and a further
increment for source deletion:1/1,1.611s EXIT0 in
`/tmp/mote-joint-file-source-incarnation-nonzero.log/.exit`. Runtime remains519dc3f5.

A new generated source-only native recovery check covers the519 counter specifically:
`/tmp/mote-joint-file-source-incarnation-native2.log/.exit`,1/1,1.467s EXIT0.
Actual stopped backupScopedInstance→restoreScopedInstance→production buildApp
reopen retains exact generation and identity, retires old credentials, refuses an
old unadmitted DELETE with a newly authenticated same owner, reads exact original
bytes through a fresh signed M03 ticket, rejects that ticket under B, and permits
fresh A deletion while B remains readable. No build, compiled entry, packaged CLI,
Docker/Hindsight provider or full J11/J13 gate was run by this case. An initial
source-only native1/1 pass is retained separately before final cleanup/byte checks.

### Original processing policy page: implementation checkpoint, NOT release

The existing source consumer freeze2528a67d now has actual Server/scripts noEmit
EXIT0: `/tmp/mote-joint-current-types.log/.exit/.sha`. Parent subsequently removed
the blanket heavy serialization constraint for isolated resources; this check did
not use Desktop's dist, Gradle, port, database, simulator or container. New E2E and
recovery owners received exact2528 and remaining gaps, not subsequent WIP.

Own durablee3b7c030 characterizes the original settings page GET503, actual1/1fail
EXIT1 `/tmp/mote-joint-processing-policy-page-red.log/.exit`. Current intermediate
implementation restores read/save/match, M04 reference graph, original shared
profile/parameter validation, immutable M06 plan metadata, original-only/new-file
processing and fixed personal/shared model reference hydration. It is not a full
policy-page/old capability acceptance or a declared consumer freeze.

`/tmp/mote-joint-processing-policy-page-green5.log/.exit`:4/4,0fail/cancel/skip,
12.630s EXIT0. Real original routes/SQLite/M04/M05 cover source/exact-MIME/wildcard/
default matching, stale save CAS, invalid parameter and embedded-key rejection
without partial multi-domain writes, A archive-only with zero fake tasks versus
same-ID B text processing, deletion of bound plan metadata with B unaffected,
and same-ID named image services using different complete private endpoint/key
references while global OCR selection remains empty. Only a generated loopback
OCR responder was substituted; no real inference/provider data. Earlier green3/4
failures retain a fixture's400 expectation versus generic configuration
prepare503; moving original profile validation into the existing M04 schema phase
restores a real invalid-config400 and atomic rejection. No global ConfigService
failure handling was relaxed.

Original unscoped algorithm characterization after extracting its pure validator:
`/tmp/mote-joint-processing-policy-original-validator.log/.exit`16/16,27.784s0,
no skip. That remains legacy algorithm evidence, not new scoped lifecycle proof.
Current scoped legacy neighbors `/tmp/mote-joint-policy-legacy-processing-neighbors.log/.exit`
3/3,9.805s0 cover actual text→Material, exact historical generation-zero/lost ACK,
and real M09 bounded processor entry. A final view-only refinement keeps file
recipes instead of overwriting them with image recipes; its explicit capability
assertions pass1/1,2.522s0 in `/tmp/mote-joint-policy-capability-view.log/.exit`.
Server/scripts noEmit is0 in `/tmp/mote-joint-policy-wip-types4.log/.exit`, boundary
checker0 in `/tmp/mote-joint-policy-wip-scope4.log/.exit`. No whole affected,
compiled/UI/native/container recovery or independent source review of this new
policy checkpoint is claimed. All remaining implementation items are listed in
the design checkpoint above; especially unfinished work is not yet reconciled.

### Named graph reconciliation: bounded implementation evidence

93dd6daa adds the unfinished-work target. Its first run waited only for `blocked`,
while the original missing-service failure can be `failed`; the test timed out
(cancelled1) and is not a business RED. After the fixture waits for either actual
unfinished terminal, exact a250 runtime was restored temporarily in the own tree
and run serially, then the saved WIP file restored in a finally block. This valid
old-source RED is1/1fail,3.532s EXIT1:
`/tmp/mote-joint-processing-policy-reconcile-red2.log/.exit`, processingRequired
remains true after selecting archive. No peer tree or running build was modified.
The same case GREEN is1/1,3.341s0; including completed/cancelled preservation,
`/tmp/mote-joint-processing-policy-reconcile-neighbors.log/.exit` is2/2,9.608s0.

New real loopback request-body acceptance followed by socket loss proves a
physical unknown. Named service reference changes admit a new coordinator but no
new provider request without explicit file confirmation. B's equal-ID request
still succeeds; after confirmation exactly one new A request succeeds and the
old issuance remains un-settled. Current actual1/1,6.915s EXIT0:
`/tmp/mote-joint-processing-policy-reconcile-unknown3.log/.exit`. First unknown1/2
failures were a fixture that selected only state `unknown`, while a durable
unsettled fact may still be `issued`; the first attempted correction did not
actually change that SQL predicate. Both failures are preserved, not claimed as
product RED. The corrected predicate explicitly observes issued/unknown IDs and
null settled_at before/after, without weakening byte/request-count/B assertions.

The changed common coordinator guard also reran11 exact legacy extraction/ASR/
diarization/retry/parentless scenarios,0fail/cancel/skip,67.029s EXIT0 in
`/tmp/mote-joint-policy-reconcile-retry-neighbors.log/.exit`. These are source
cases with generated localhost services, not a whole affected/compiled/physical
or full runtime-fingerprint acceptance. Current types and boundary receipts are
`/tmp/mote-joint-policy-reconcile-types2.log/.exit` and
`/tmp/mote-joint-policy-reconcile-scope.log/.exit`; final result is checked before
this implementation checkpoint is committed. Public consumer freeze stays2528.


### Configuration relogin admission subject

Actual generated HTTP logout → same-account fresh login → processing settings
save failed503/config_prepare_failed on the unchanged M04 cached-entry code
(durable RED80ac30ee; `/tmp/mote-joint-configuration-relogin-red.log/.exit`,
1/1fail,1.162s). Domain factories capture their admission subject; an entry
keyed only by account epoch still held the logged-out credential. A current new
caller now drains and closes that retired entry before opening domain handlers
with its own immutable subject. The old subject is never rebound to new authority.
Same regression passes1/1,1.096s in
`/tmp/mote-joint-configuration-relogin-green.log/.exit`, including old-token401
and unchanged sibling configuration. Three existing M04 suites pass18/18,8.282s
(`/tmp/mote-joint-configuration-relogin-neighbors.log/.exit`), including admitted
work after logout, pinned leases, reset/deletion, restore and credential fencing.
This is a narrow source correction, not whole client/recovery acceptance.


### Named reference publication checkpoint (not consumer freeze)

Durable f45af053 exercises absent `same-media` → blocked original → publish
complete personal M04 connection with the same ID and unchanged policy. Sandbox
listen EPERM occurred before product execution and is retained. The authorized
localhost run actually failed to resume within6s (EXIT1,7.438s),
`/tmp/mote-joint-policy-service-change-red-approved.log/.exit`. M04's existing
domain resolve now derives only canonical referenced-connection fingerprints;
its ordinary effective-change transaction triggers the existing unfinished-plan
reconciliation. YAML and applied-plan metadata keep references/hashes, never a
second endpoint/key store. Only the selected profile's connection hashes enter
the immutable plan identity. Same-case GREEN1/1,2.472s EXIT0 is
`/tmp/mote-joint-policy-service-change-green2.log/.exit`; green1 reached processing
success but compared the raw input policy to canonical defaults, so its final
fixture assertion failed and is retained. Green2 compares the actual saved policy
without weakening request-count, output, plan-change or sibling assertions.
Server noEmit0: `/tmp/mote-joint-policy-service-change-types.log/.exit`.
Shared-instance change notification, global/default selections, processor-version
startup reconciliation, raw-stage reuse and complete applied-plan lifecycle remain
OPEN; this bounded personal-reference case is not whole fingerprint acceptance.


### Independent plugin retirement discrepancy remains unresolved

The cross-user owner reports two repeated10s PID-presence failures on2528 for
source stop/delete, preserving its RED logs. Joint's unchanged plugin runtime,
worker, scoped host and generated plugin fixture run the same two cases2/2
EXIT0,2.776s (`/tmp/mote-joint-plugin-retirement-red.log/.exit`; the planned
filename does not imply RED). Tightening the PID probe to accept only ESRCH as
exit proof, propagating every other OS error, passes2/2,2.282s
(`/tmp/mote-joint-plugin-retirement-esrch.log/.exit`). Temporarily restoring
exact2528 configuration.ts and restoring current bytes in finally also passes
2/2,2.459s (`/tmp/mote-joint-plugin-retirement-before-relogin.log/.exit`).
The relogin cache correction is therefore not established as its cause/fix.
No plugin production change or closure claim is made; failed-process PID/state
diagnostics are requested from the independently failing workspace. These narrow
results cannot replace that owner's required gate or whole plugin acceptance.


### Original settings-page atomic connection edit

The old processing page saved service configuration and policy in one action.
Durable57691558 shows the new route rejected its personal M04 connection edit
400 (1/1fail,2.672s `/tmp/mote-joint-policy-atomic-editor-red.log/.exit`).
The scoped page now accepts optional complete personal `models` beside settings
and reference-only policy; all domains use the existing M04 `updateMany` replace
transaction and existing stable-ID masked-secret handling at one CAS revision.
There is no shared-resource write, second secret store, or second user step.
The route returns redacted personal connections and shared read-only metadata.
Same-case GREEN1/1,1.282s0 (`/tmp/mote-joint-policy-atomic-editor-green.log/.exit`)
checks revision+1, secret redaction/retention, invalid-profile atomic rejection,
stale409 and sibling unchanged. Current four-file policy/relogin combination
10/10,22.742s0 is `/tmp/mote-joint-policy-atomic-editor-neighbors.log/.exit`;
Server types and scope checker both0 in corresponding `-types`/`-scope` receipts.
These backend entry checks do not establish client page integration or whole
policy/final joint acceptance. Public limited consumer candidate remains2528.


Plugin fixture timing characterization: a generated-only150ms hold after the
real marker file open and before its write reproduces the exact stop failure
with `GENERATED_PID_RAW="" PID=0`,1/1fail11.627s in
`/tmp/mote-joint-plugin-marker-timing-red.log/.exit`. This PID probes a process
group, not the worker. Publishing the generated PID via same-directory temporary
file→rename, asserting a positive safe PID and requiring ESRCH, passes both
stop/delete under the identical held-write timing2/2,4.630s
(`/tmp/mote-joint-plugin-marker-timing-green.log/.exit`, actual86038/86052).
Only the durable generated marker protocol is corrected; no production worker
code changes. The ignored `.mote/joint-fixture-pid-probe*.test.ts` files preserve
the deterministic timing instrumentation locally. The independent owner's
original failed runs still need its own diagnostics/recheck before closure.


### Original preview and explicit reprocess entry checkpoint

Durable2e4352d2 records actual missing preview503 RED1/1fail,5.035s
(`/tmp/mote-joint-policy-preview-red.log/.exit`). The added entry reuses the
existing Files owner projection and existing M05/M06 file retry body, extracting
its synchronous core so the batch has one transaction rather than awaiting
inside a SQL transaction. The first GREEN attempt reached reprocess but its
fixture waited only for an old indexed publication, then retried while the new
root was running409; this retained failure is not a product regression. It now
waits for the actual new job succeeded state before starting another action.
Owner A/B equal-ID, one-use token, cross-account409, stale-file rejection and
late second-item SQL admission fault rollback/retry pass2/2,12.541s in
`/tmp/mote-joint-policy-preview-green3.log/.exit`. Trigger faults are generated
fixture SQL; no system permissions or real data are changed. Current final
preview cases plus11 ASR/diarization/extraction-retry/authority/parentless neighbors
pass13/13,45.713s0 (`/tmp/mote-joint-policy-preview-retry-neighbors.log/.exit`).
Server+scripts types2 and scope receipts both0. Capacity/expiry/unknown reprocess
and UI/whole recovery remain unclaimed. Public consumer freeze still2528.

Generated source-plugin original full file, after atomic marker publication,
passes9/9,30.686s0 (`/tmp/mote-joint-plugin-marker-full.log/.exit`): source reads/
publication, pause/drain, stop, grant revoke, plugin/ingress delete, account disable
and restart. These are Joint execution receipts; the independent cross-user
owner must still confirm its originally failing workspace. No production plugin
change was made to obtain this result.


Settings-only named work: the first target accidentally increased the default
maximum timeout beyond its schema limit and returned400; it is retained as a
fixture error, not product RED. Corrected in-range timeout change with the policy
unchanged produces valid RED84cd5df1: no fresh admission under the new processing
generation (1/1fail4.807s `/tmp/mote-joint-policy-settings-change-red2.log/.exit`).
The existing processing-domain completion now calls the same named-policy
reconciliation after publication; unchanged plan ID is insufficient to skip a
changed processing generation. Same case1/1,6.671s0 is
`/tmp/mote-joint-policy-settings-change-green1.log/.exit`, Server types0. This
does not yet close disable/resume, global-policy-null legacy work, derived phases
or raw-extraction reuse after downstream-only changes.


### Independently owned binary parser correction composed

E2E minimal producer69243430→caf05519 is reviewed and selectively composed as
192703dc/41c5d413; its runtime blob equals the producer main feature b084. Global
Buffer decoding remains bounded4MiB; selected Imports routes retain MIME and
decimal-part validation, with existing owner/credential/protocol/CSRF/hash/length
checks unchanged. Unknown MIME/oversize errors retain the original503 mapping;
unknown binary routes remain rejected by scope fallback (503 instead of former
parser400), without staging writes. Own current profile combination targeted
auth/CSRF+Imports bounds2/2,9.527s0 is
`/tmp/mote-joint-parser-composed-narrow.log/.exit`. Source review is
`/tmp/mote-joint-review-binary-parser-caf.md`. Producer41/41 and Recovery104/104/
new compiled recovery are peer evidence on their exact candidates, not Joint's
new policy-table restore proof. Own full affected/final clients remain pending.
The independent cross-user original stop/delete cases also pass2/2,6.552s after
the fixture-only PID patch (peer e88e1727, `/tmp/mote-crossuser-plugin-marker-green.*`).
Old failure logs remain preserved; no production plugin fix was inferred.


### Disabled processing and fresh resume checkpoint

Durable a2409841 shows disabling named processing cancels the old root and loses
its resumable state (actual1/1fail9.507s, `/tmp/mote-joint-policy-pause-resume-red.*`).
The first fix produced a genuine blocked M05 root, but Files ignored the actual
M05 admission error when no attempt failure receipt existed; green1 retains that
missing projection failure. The projection now reads the actual task error.
The original-policy-null intake is separately RED-characterized against exact
190ff2ab processing.ts/processing-files.ts, temporarily restored and returned in
finally: job remained null while disabled,1/1fail7.492s
(`/tmp/mote-joint-processing-legacy-pause-red.*`, test69696080).
Current scalar/named/global-default cases3/3,9.147s0 are
`/tmp/mote-joint-policy-pause-resume-green3.log/.exit`: zero-attempt disabled root,
new intake while disabled, restart, fresh enabled admission, explicit file cancel
not revived, equal-ID B's successful artifact unchanged. No policy is invented
for legacy data. Source hashes are in `/tmp/mote-joint-policy-pause-source-manifest.json`.
Full retry/policy neighbor and types reruns for this checkpoint are pending;
these results alone are not a consumer freeze or whole final acceptance.


Exact27706804 policy/relogin/preview/pause combination15/15,52.932s0 and distinct
legacy ASR/retry authority neighbors11/11,53.046s0 are recorded separately in
`/tmp/mote-joint-policy-pause-composed.*` and `-pause-retry-neighbors.*`.
Server+scripts types and boundary checker0. Those26 tests precede the next
stage-dependency source change and are not its full regression receipt.

Named-stage reuse: first target supplied a server root instead of the original
ASR `/transcribe` endpoint, so both accounts failed before the intended assertion;
that fixture error remains in `stage-reuse-red`. Corrected durableab9d6117
reaches real accepted raw ASR, changes a complete private connection, then changes
only downstream speakerCount. It fails with an extra raw request2!=1,1/1fail
7.151s in `/tmp/mote-joint-policy-stage-reuse-red2.log/.exit`. The implementation
uses the original per-processor dependency fingerprint instead of the entire
named plan/settings generation for raw stage cache identity; diarization and
alignment keep their own dependency inputs. Legacy policy-null keys are unchanged.
Same case1/1,5.234s0 (`-stage-reuse-green1`); adding explicit full-transcribe plus
fixed repeated receipt passes1/1,7.143s0 (`-stage-reuse-green2`). Tests prove changed
credentials do not reuse old raw, speaker-only change does, explicit force does
execute again, and equal-ID B retains its own result/call count. Server types0.
The new stage source still needs selected consumer/legacy neighbor verification.

Recovery of this execution turn: HEADab9d6117 and its2dirtyfiles+1newMD were
verified and preserved as `/tmp/mote-joint-recovered-dirty.patch` and a separate
contract copy. Existing8 terminal receipts were read rather than rerun; lsof
read-only cwd inspection returned no Node process in the Joint checkout. This
proves preservation/current resources, not the reason the earlier turn failed.


Frozen a2cbf3aa bounded policy composition16/16,75.825s0
(`/tmp/mote-joint-policy-stage-composed.log/.exit`) and distinct legacy ASR/
diarization/M09/retired-original4/4,23.334s0 (`-stage-legacy-neighbors`) pass.
Server noEmit, scripts noEmit and boundary checker receipts are respectively
`-stage-reuse-types`, `-stage-scripts-types`, `-stage-scope`, all0. These are
limited route/consumer-development evidence, not full affected or recovery proof.
Parent confirms independent source-only277-vs190ff review without new confirmed
findings; it did not execute this source or review the later stage-reuse delta.
The declared limited client checkpoint is a2cb, with exact supported wire shapes
and remaining OPEN features in `docs/design/multiuser-file-processing-contract.md`.
Do not trigger repeated whole recovery gates for this partial delivery; final
same-SHA client/runtime closure remains required. The recovered test owner has
ended; its116-case/actual recovery receipts remain separately versioned, and
Joint does not wake it merely for another source review.


### Explicit root profile: narrow implementation checkpoint

The first fixture used a text processor as the universal fallback and correctly
failed original policy validation400; that setup failure is retained. Valid
text/* plus archive fallback produces durable9efd3eb6 RED: a root upload's
existing processingProfileId=archive was ignored and bound the text rule
(1/1fail5.310s `/tmp/mote-joint-profile-root-red2.*`). The M03 commit now awaits
the trusted M06 profile preflight outside its SQLite transaction, then binds
that same current owner's profile metadata after original attachment and before
ordinary acceptance listeners/admission. Rechecks follow the awaited preflight;
no endpoint/key or context is supplied by the request. An unknown profile rejects
without publishing captures, and a cached commit receipt is replayed first.
Same root/ACK/unknown/B-positive case1/1,8.086s0 is
`/tmp/mote-joint-profile-root-green1.log/.exit`; Server noEmit0.
This checkpoint supports saved named graphs only; unsaved defaults, Imports and
attachment overrides remain OPEN and are not added to the a2cb client freeze.


### Saved profile overrides: Imports image-only publication

Root and confirmed generic media imports now use the same M06 saved-profile
preflight and bind before ordinary acceptance listeners. The imageProfileId
override is passed only for image/* file originals, with account/task admission
rechecked after the asynchronous M04 preflight. It is included in the existing
intake receipt digest when present; unprofiled receipt hashes stay unchanged.
Archive-only media projects processing.required=false and skipped/archive,
without claiming successful OCR, searchable text or Memory.

Actual root + distinct A/B same-ID PNG/ticket byte checks: 2/2 EXIT0 in12.038s
(`/tmp/mote-joint-profile-import-image-green4.*`). Additional mixed PNG/WAV
confirmation proves image archive selection leaves audio on its own saved rule,
with a genuine M05 coordinator: all3 cases EXIT0 in12.118s
(`/tmp/mote-joint-profile-import-mixed-green2.*`). First mixed fixture wrongly
expected confirm200 instead of the existing202 ACK; retained as a fixture failure.
Server/scripts noEmit, fresh shared build and scope checker EXIT0. This is a
limited saved-graph increment, not a replacement client freeze or full gate.
Attachment overrides, unsaved default graph, health probe and custom recipes
remain OPEN.

### Saved attachment profile: lineage rechecked after preflight

Durable b103822e reproduces original attachment processingProfileId503 instead
of200 (1/1fail1.540s `/tmp/mote-joint-profile-attachment-red.*`). The existing
attachment entry now preflights its saved M06 profile before opening the SQLite
transaction. It re-resolves the owned parent/head, archive link, MIME and retained
object after that await; binding publication still occurs in the existing intake
transaction after the exact attachment relation and before admission listeners.
An existing attachment ACK wins over a later profile body, preserving the old
plan until explicit reprocessing. No new original or permission store is added.

The same case GREEN plus held-preflight parent deletion/B positive and the root,
image-only and mixed-media cases all4/4 EXIT0 in13.573s
(`/tmp/mote-joint-profile-all-entry-green.*`). Existing real generated OCR
attachment lineage/cache/recreation/late completion/data restore suite6/6 EXIT0
in12.629s (`/tmp/mote-joint-profile-attachment-neighbors.*`). Original media,
inline idempotency and partial publication/restart consumers3/3 EXIT0 in9.960s
(`/tmp/mote-joint-profile-import-neighbors.*`). Server/scripts noEmit and scope
checker EXIT0. First scope launcher used a nonexistent filename and exited1;
correct existing check-scope-contracts.mjs exited0, both logs retained. No new
full gate, compiled client or provider acceptance is assigned to this increment.

### Independent applied-plan archive final77 composed

Joint bounded read-only review of owner77a2818e is recorded in
`/tmp/mote-joint-review-policy-archive-77a2818e.md`: no new confirmed P0/P1/P2.
Only five declared module commits were selected on top of Joint's saved-profile
entry fixes, ending at716bec5d. Production helper and lifecycle hunk match the
owner final; no earlier recovery lane or peer WIP was included. Existing target
policy/binding/control wins, missing controls receive a fresh generation fence,
and corrupt local plan parents reject rather than reactivating old input. Old
processor contracts are not fabricated from incomplete historical metadata.

Own composed personal-plan archive suite27 plus current profile-entry4 cases:
31/31 EXIT0,0skip,63.227s `/tmp/mote-joint-policy-archive-composed.log/.exit`.
Server noEmit EXIT0. Initial composed scope checker EXIT1: the conservative
AST check treats the archive helper `.prepare` call as raw SQL. This is a
composition check failure, not a passing boundary check. Owner final27/related9/minimal-a2-5 remain
separate peer evidence. This does not move the earlier failed owner full gates
or claim final client/container/native union acceptance.

The archive preflight helper was mechanically renamed prepare→preflight in its
export and single M06 caller. Existing boundary checker now EXIT0
(`/tmp/mote-joint-policy-archive-scope2.*`), Server noEmit0, selected actual
merge/restart and corrupt-local-parent cases2/2 EXIT0 in5.602s
(`/tmp/mote-joint-policy-archive-preflight-rename.*`). No checker exemption,
execution or data semantics changed. Initial scope failure stays retained.

### Unsaved default profile selection

Durable cbfc27a5 demonstrates the advertised default archive profile returning503
unless the user first saves a named graph:1/1fail (`/tmp/mote-joint-profile-default-red.*`).
The existing M04 effective file-policy mirror now derives the displayed default
reference graph from current personal/shared selections, retaining references and
fingerprints only. Explicit overrides may bind it without saving a raw policy.
The finite original default IDs remain explicit aliases to their original
processor choices, without duplicating editor profile rows or borrowing instance
credentials. Automatic legacy files still keep their original no-plan path.
Own six entry cases6/6 EXIT0 in25.610s include legacy profile.audio.http through
actual generated A/B ASR using equal capture IDs/different private keys, plus
unsaved default archive/restart and saved root/import/attachment cases
(`/tmp/mote-joint-profile-default-composed.*`). Existing named policy editor,
service change/settings/preview/reprocess seven cases7/7 EXIT0 in28.710s;
Server types and scope checker0. Default missing-connection reconciliation is
separately being characterized; this increment is not yet a consumer freeze.

Default connection recovery characterization first stalled before the M04 save:
the original missing-service coordinator can already be stale, so accepting only
blocked/failed was a fixture error (all initial red/green1/green2 logs retained,
not used as post-save proof). With the actual retired state admitted as the
initial observation, original017e production still remains unindexed after the
real M04 save: `/tmp/mote-joint-profile-default-resume-valid-red.*` EXIT1.
The repair uses the same effective-M04 completion callback and reconciliation:
explicit default bindings retain their chosen profile when reselected, changed
default reference graphs trigger fresh reconciliation, and stale unfinished work
is eligible only after rechecking current original/head/source and cancellation.
Completed and manually cancelled work remain outside that path. No old grant is
retried or resurrected. Same case now confirms a different actual M05 admission
ID, new plan and one generated OCR call, B unchanged, no saved policy:
1/1 EXIT0 in5.592s `/tmp/mote-joint-profile-default-resume-valid-green2.*`.
The preceding runtime reached indexing but an assertion used job.id on the
public state-only job projection (undefined); it is retained as a fixture error.

### Saved local worker health through the shared authority ledger

Original POST /api/file-processing/test-local returned503 at6e87b1bc's durable
case (`/tmp/mote-joint-processing-health-red.*`). It now resolves only a saved
ASR service's complete current M04 reference (or the current ASR selection when
no serviceId is supplied), checks mote-media plus loopback, and sends the old
bounded GET /health:10s/4096bytes/schema unchanged. Caller endpoint/key fields
reject before transport. The existing executor runs one processing.health control
step, with existing M04 lease and M05 external issuance/M06 physical activity.
No model inference, file processing artifact, separate runtime or new table is
introduced. Late exact completion can settle its issuance without publishing an
old health result; the old request remains retired.

Own first same-case1/1 EXIT0 in3.048s; current18 bounded profile/default/health
and direct policy consumers18/18 EXIT0 in65.381s
(`/tmp/mote-joint-profile-health-composed.*`). Extended same original route proves
A logout response refusal while its transport is still held, independent B
positive, fresh A login, actual M16 account deletion result_unknown with one
active transport, late exact settlement then retry/physical cleanup of A's
policy/task/external rows, B positive, and nonloopback refusal with no request:
1/1 EXIT0 in3.013s `/tmp/mote-joint-processing-health-account-delete.*`.
Server/scripts/scope0. Strict targeted new-test noEmit initially exposed the
existing shared fixture unknown-payload/Fastify overload error; the owner's
already reviewed type-only InjectOptions payload cast was selected, and strict
new-test noEmit2 EXIT0. No runtime fixture behavior changed. Whole affected,
compiled client/native/UI and final same-SHA production/backup remain pending.

### Next-gate native dependency admission

Parent-required same-runtime constructor smoke found copied better-sqlite3 ABI147
under Node24.21.0/ABI137 in this checkout (both server and actual mem0 resolver):
`/tmp/mote-joint-final-native-db-smoke.*` EXIT1. Rebuilt only own locked12.10.0
source using existing official Node24 headers and installed node-gyp, offline;
`/tmp/mote-joint-node24-sqlite-offline-rebuild2.*` EXIT0. First launcher had a
wrong relative working-directory path and never started compilation; retained.
No dependency manifest/lock or peer binary changed. Same Node actual constructor,
write/read/close smoke2 EXIT0, resolving mem0 to apps/server/node_modules/mem0ai/
dist/oss/index.js and its native DB to own root better-sqlite3. This is required
preflight evidence, not a complete Memory/model gate.

### Confirmed remaining instance-only observation gap

At503, a real admin shared-resource replacement does not resume the current
unfinished A pipeline while B's equal-ID personal pipeline succeeds. Actual
1/1fail11.495s `/tmp/mote-joint-processing-instance-change-red.*`; no physical
shared retry after the replacement. Current-owner personal model saves are a
separate passing path. Technical boundary/proposal is
`/tmp/mote-joint-shared-observer-decision.md`: derived M04 refresh plus a genuinely
M05-authorized continuation, never fabricated user contexts or revived old
session/grant. This RED remains a whole-gate blocker until resolved.

### Desktop final PR149 selected into current Joint feature

Delivered Desktop f319513a / owner tested0a32aeeb was selected through its five
Desktop production/test commits, ending Joint239e2428. Existing Joint M01/QR
sources already exactly match that final; unrelated owner inherited triage patches
were not imported. `git diff HEAD f319513a -- apps/desktop` is empty. The sole
catalog conflict retained all8439 prior Android values and added the one Desktop
message from the merged shared source; checker now8440 messages/EXIT0.
Official final module validation document copied from deliveredf319, keeping
its26m34 full gate and cached-versus-actual Android provenance as owner evidence.

Own composed consumers3files109/109 EXIT0 in64.83s
(`/tmp/mote-joint-desktop-final-consumer.*`), fresh Shared/Server builds and Desktop
noEmit0, i18n0. This is source consumer verification, not another emitted Electron
20-case run or whole final union. Completed Desktop owner was not awakened.
Runtime/output final-CI acceptance remains the later same-SHA combined step.

Exact current terminal log hashes and version/provenance boundaries are also in
`/tmp/mote-joint-current-evidence.json`. Whole affected is deliberately not called
successful while the committed instance-change RED still exists and M13/M15
final candidates remain outstanding.

### Current emitted production entry and actual process recovery

Fresh compiled Server from current runtime (Desktop union239e; later3125 docs
only) runs original production auth/listener startup, actual credentialed account
management, natural restart/session persistence and revoke:1/1 EXIT0 in9.082s
(`/tmp/mote-joint-current-compiled-auth-process.*`, explicit dist/index.js entry).
Compiled dist/app.js M06 actual SIGKILL + natural shared-M05 lease recovery keeps
two owners' accepted ASR checkpoints/original model snapshots/private Material,
with no repeated completed extraction:1/1 EXIT0 in43.887s
(`/tmp/mote-joint-current-compiled-processing-process.*`). All external media
calls remain generated localhost fixtures. These are independent emitted process
checks, not an emitted final Electron/Android/Docker/client union. No whole
project completion follows while the instance-only observer RED is outstanding.

### Recording disconnect preserves accepted archive authority

Actual original routes for both feishu-recordings and dingtalk-recordings:
M10 fixed provider/CLI transports→M03 originals→M04/M05/M06 ASR/Material→
disconnect→old original ticket returned404. Durablecd6942c0,2/2fail
`/tmp/mote-joint-recording-disconnect-history-red.*`. Removing the adapter's
source.enabled=false restores history without retaining connector credentials.
The next assertion then exposed a second real transport gap: a disconnected
manual sync called provider status before checking missing saved account.
Actual fixed-history Feishu32!=31 calls RED is
`/tmp/mote-joint-recording-disconnect-transport-red.*` (not inferred from code).
A pre-provider saved-account guard now rejects that attempt as not connected.

Both same original scenarios2/2 EXIT0,0skip,85.521s
`/tmp/mote-joint-recording-disconnect-history-green2.*`: exact audio original bytes,
Files presence/export200, six accepted Material products, independent B rows,
disconnected sync0 provider calls, real host restart, B sync positive and explicit
source disable still fences original reads. Export contents/native Web UI are
separate existing/consumer checks; the nonempty200 here is not expanded into
whole archive-tar byte verification. Account replacement in an existing recording
connection is not covered by this disconnect-only result. New custom image recipe
fixture separately actual1/1RED image_recipe_unavailable remains WIP.

### Recording collection pause versus source privacy (2026-10-17)

The parent's new actual renderer pause4→0 report was independently reproduced
through the existing generated Feishu M10→M03→M04/M05/M06 journey: unchecking
collection and completing the real select task hid accepted archived files
(`/tmp/mote-joint-recording-pause-history-red.log/.exit`,31.80s,EXIT1).
The adapter now registers new recording archives readable and never rewrites
Source.enabled from collection selection. The existing registration path preserves
an existing source's privacy choice. This does not migrate or alter real data.
Both Feishu/Dingtalk exact backend journeys pass2/2,0skip,64.71s
(`/tmp/mote-joint-recording-pause-history-green.log/.exit`): pause/resume and
saved enabled selection preserve history, explicit source withdrawal remains
false through selection saves, disconnect preserves audio bytes/Files/Material/
export, B remains unchanged, restart and explicit final read withdrawal are valid.
Full renderer/export contents remain the recording consumer owner's evidence.

### Non-default installed image recipe closure, narrow evidence

The original M06 rejection `image_recipe_unavailable` was actual RED. The first
implementation exposed a Material artifact-name schema error; mapping its public
name to the existing path syntax fixes only that publication boundary. A later
no-OCR actual RED found Memory's unconditional Material-parent assumption; only
original-image anchors are now admitted for that case. Explicit recipe replacement
also reproduced a stale current primary OCR Material; the no-OCR recipe retires
that current publication while preserving actual accepted raw history.

`/tmp/mote-joint-custom-image-final-narrow.log/.exit` is4/4,0skip,36.124s EXIT0:
A/B literal same ID OCR+derived and restart/cache; no-OCR interpretation with empty
region description, exact navigation-only Memory evidence, corrupt-hash refusal
and data restore/restart; M04 file-model lease plus real Messages read_image of
generated PNG pixels without OCR; held custom step/source withdrawal with B
positive. The first journey also exercises real preview/explicit reprocess,
removed output withdrawal and OCR→interpretation-only replacement. Server noEmit
and scope checks are0 (`custom-image-types4`, `custom-image-scope3`). The Messages
and OCR networks are loopback generated transports, not live models. One sandbox
EPERM before listen and an intermediate syntax typo are retained in their own
failed receipts; neither is overwritten or counted as runtime acceptance.
Final union/consumer/compiled/backup acceptance remains pending. Optional disabled
recipe dependency behavior and all legacy custom packs are not inferred from this
finite matrix.

### Named image completion, finite producer freeze

Compose only PR151's declared9b037b9e/4a7168f1 production and68174ed2 test delta
plus the parent's declared2a1abd26/d10a6a4f consumer PREP; no full M13 baseline
was merged. M15's parent-confirmed769a30b0 exact blocked-summary-parent retry
was selected separately, preserving its own10-case evidence and limited docs.

Both noOCR-complete and partial named-step replay were independently reproduced
on this composition:2/2 actual RED (`custom-image-complete-red`). The existing
M06 graph now recognizes actual named accepted outputs before admission; partial
completion carries verified same-plan/recipe/dependency artifact data into the
new current step generation. Existing mp_file_steps keys gain a dependency hash;
the first PREP key remains readable, using exact accepted Material input refs
when dependencies exist. No old execution grant/context is used for this cache.

Exact backend cases2/2,7.064s EXIT0 (`custom-image-complete-green1`), original
Files/ImageProgress OCR/noOCR/partial journey3/3,38.565s EXIT0
(`mote-joint-image-recipes-original-ui1`) preserve no-op complete, successful
steps on partial failure, explicit full recompute, actual cancel/late result,
A/B same ID, restart and registry-unavailable states. Server noEmit3 passes;
consumer flatMap annotation and explicit string-valued status typing repair
PREP TypeScript inference without changing scheduling. These source paths are
frozen only for named completion. Typed export and snapshot lifetime fixes and
the stronger physical-pin matrix are separate subsequent work, not covered by
this producer freeze or advertised as final by these original UI cases.


### Named image products: truthful export and graph-local original lifetime

The producer now exports canonical `mote-image-product-v1` JSON per named product,
plus Markdown/CSV views under `image/<name>` or `image-ocr/<name>`. A graph without
OCR has no invented transcript/raw-extraction entries; its manifest explicitly
reports `uncorrectedPreserved:false`. Existing audio/document export entries and
authorization/current-stream checks remain in place. Typed original hash and MIME
are checked before export. The exact exported JSON, including empty regions, is
compared with the accepted artifact in durable tests.

Custom recipes retain one existing M03 physical pin across the admitted graph.
Each executing child retains that pin until its actual promise settles, including
after coordinator retirement. This grants neither a fresh expired-input admission
nor a download ticket: the expiry cases assert a new HTTP ticket is denied while
the admitted pixel reader can finish. Successful whole-graph commit releases the
transient snapshot; source withdrawal prevents late publication while physical
cleanup waits for the actual held child. No new route, table, grant or executor
was added. This is graph-local byte ownership over M03, not a replacement lifetime
framework.

Actual pre-fix RED receipts: `custom-image-export-red` (2/2 failing),
`custom-image-snapshot-red` (1/1 failing). Producer matrix
`/tmp/mote-joint-custom-image-final7.log/.exit`:7/7,0skip,57.646s EXIT0.
It covers OCR+derived, no-OCR export and data restore, model-only original pixel
reads, held privacy retirement with equal-ID B, partial completion/recompute,
custom snapshot expiry and model-child expiry. Existing snapshot recovery and
export-stream neighbors4/4,14.134s EXIT0 (`image-lifetime-adjacent`).
Server noEmit, strict image-test noEmit and scope checks are0
(`image-lifetime-final-types`, `image-lifetime-final-strict`,
`image-lifetime-final-scope`). The image owner's b149 import correction was
selected as0d8c8169.

The original Files export-only button is separately owned by the image consumer.
Its latest consumer/runtime56d3 has not yet been composed into Joint; the producer
freeze does not claim that UI or whole affected acceptance. Independent bounded
review and final combined check:affected/recovery remain pending. CI is disabled.


### Independent image review: later OCR pin and retired OCR export

Consumer91c17e8ab3a9a212e1a49cd5597363ad0ae334a7 exposed two additional
producer failures after f555. Joint independently reproduced both in durable
backend scenarios (test60f60fea):2/2 RED,11.020s
(`/tmp/mote-joint-image-lineage-history-backend-red.log/.exit`).
The derived-first graph had an actual existing M03 pin and denied a new expired
HTTP ticket, yet later OCR blocked before its provider call. Explicit policy
preview/reprocess from OCR to noOCR preserved genuine raw history but tar
incorrectly made that history the current transcript.

The extraction child's original hold now validates its exact owned image-stage
input/root lineage and retains the same existing graph pin; ordinary extraction
keeps its existing hold path. No new hold permission, recovery issuer, table or
lifetime mechanism was added. Named-image export now takes current transcript
identity only from its current publication; historical raw extraction remains
explicitly raw and does not populate current transcript/manifest identity.
Raw-only history export remains possible under the same owner/current-stream
checks.

Same backend pair2/2 GREEN12.226s, complete producer8/8 GREEN28.420s
(`image-lineage-history-backend-green`, `image-lineage-final8`).
Exact immutable consumer91c source, root package metadata and shared own
React/locale dependencies were used for original Files six journeys:6/6,0skip,
85.303s EXIT0 (`/tmp/mote-joint-image-review91-green2.log/.exit`).
Only frontend import paths/classic JSX loader environment were adapted; the
product assertions stayed unchanged. The first snapshot copied without root
`type:module` produced dual i18n state/English labels and failed before intended
checks; `image-review91-locale-identity-failed` remains an environment receipt,
not a production RED. The final fixture restores exact frozen module metadata.
Server, strict producer-test and scope checks0 (`image-lineage-types/strict/scope`).
Independent source re-review and final combined gate remain pending.

### Default image recipe ID with a different version

A real policy preview/reprocess to the default recipe ID at version `2`, with
only a named pixel-derived step, exposed a remaining export identity mismatch.
M06 correctly treated the version as a custom graph, but export checked only the
ID and relabelled retained raw OCR as the current transcript. The durable first
custom-recipe journey failed its tar assertion (1/1 RED,9.310s,
`/tmp/mote-joint-image-version-red.log/.exit`). Export now compares both ID and
version, matching existing processing selection. The same journey passed1/1,
12.286s (`/tmp/mote-joint-image-version-green-approved.log/.exit`), including
same-ID A/B isolation, exact recipe replacement, raw history preservation and
no additional OCR call. A prior sandbox loopback EPERM is retained separately
in `image-version-green`; it did not execute the intended journey. This narrow
closure does not supersede the still-failed combined gate or establish whole
module acceptance.
