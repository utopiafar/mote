# M13 Web account and management migration

Base: M08 `58944f00837c89bc1d302ecd7be7a568db4abe44`, including M07
`cd7a306cce0f6cd5fec3c9e91e6dee0761352115` and the public contract PR135.
Final M11 PR138 `98d76945e091d7234217ebcf532ebeff3350937c` is composed.
The parent has confirmed the M12→M13 handoff succeeded and lifted the wait.
Stable M12/M16 unified10748005a5d007695ecc9401d0d57dc9dea94919 is composed
for development, including catalog source-incarnation/revocation fencing,
lifecycle and Actions backup retirement. Its HTTP approval contract matches4a.
The delivered M12/M16 heads and M14 finalcd46 lineage are composed. Their completed
checks remain dependency evidence; M13 final acceptance remains pending.
Final M13 composition and checks are separate gates.

## Capability ledger before implementation

| Disposition | Existing capability and entry | M13 responsibility / acceptance |
| --- | --- | --- |
| KEEP | `main.tsx`, feature registry, workspace/sidebar/settings navigation and presentation packs | Reuse page locations, components and visual hierarchy. No product navigation redesign. |
| CHANGE | `LoginDialog`, `session.ts`, ticket handoff; owner-token browser login | Username/password and M01 HttpOnly Cookie session, protocol 2, CSRF, immutable credential ID. Reload discovers current identity before rendering private content. |
| REMOVE | Browser owner-token prompt, token persistence, local lifetime pretending to extend a server grant | Retired credentials never silently become an account; only server session expiry controls validity. |
| KEEP / CHANGE | `createApi`, ResourceCache generation, per-Api resources | Recreate on account/session/deployment change; guard before sending, after awaits and before publishing. Old tab carries original session ID and cannot borrow a replacement Cookie. |
| KEEP / CHANGE | ImportQueue, OperationFeed, evidence/client/action dialogs and component drafts | Account transition disposes private trees, pending admission and subscriptions. Already admitted server work survives logout. Held callbacks retain original Api. |
| CHANGE | Notes local outbox and draft; origin-only namespace in `features/notes.tsx` | Stable origin + deployment + user namespace. A survives A re-login but never appears or submits in B. Legacy unbound local drafts are not adopted. |
| CHANGE | Settings entry, existing configuration registry/CAS and user model references | Personal settings use M04 user domains; shared resources and account administration require administrator authority. No private owner selector. |
| KEEP / CHANGE | Connections inventory, MCP issuance and client approval | Consume M01/M11 actual contracts; credentials and generated secrets remain within the current account tree. |
| EXCEPTION | Legacy bearer Api fixtures / native handoffs | Bearer transport remains explicit for algorithm/consumer fixtures; the Web login/restoration path only adopts validated Cookie sessions. Native clients remain M14/M15. |
| UNKNOWN | Browser lifecycle, revocation/disable, slow replies, concurrent auth/submit, open approval dialog | Must close with generated data in a hidden actual renderer plus actual production backend. M11/M12 final remote heads and independent review remain required. |

## Validation obligations

New migration regressions retain RED parent/test/fix evidence. Characterization
retains old normal caching, navigation, settings CAS, pending work and draft behavior.
Use equal A/B business IDs, actual Accounts/SQLite/shared services/single executor;
only external I/O may be synthetic. Cover A→B, reload, same-account credential
rotation, stale tab, delayed body/response, logout versus submit, failed login,
open approval, account disable and credential revocation. Explicitly separate
emitted renderer/backend integration from JSDOM/unit fixtures. Final validation
uses `npm run check:affected -- --base origin/codex/mote-multiuser-integration`,
related builds, same composed dependency SHA, independent review and remote PR
head/base verification. No merge, deployment, CI enablement or real private data.

## Original Web consumer compatibility audit (in progress)

This is a required acceptance ledger. A safe session does not prove domain
compatibility. Status **OPEN** means not accepted, not removed from the product.
Existing navigation and page components remain the intended consumer. The
scoped host has no legacy runtime/store mounted. Audit is against the actual M08
589 composition; M11/M12 final integration will update it.

| Page / existing consumer | Old endpoint(s) | Actual scoped public capability | Minimal adaptation / status |
| --- | --- | --- | --- |
| Login/current account/native browser handoff | owner bearer, `/login/exchange` bearer | M01 `/auth/login`, `/auth/self`, Cookie exchange, session binding/CSRF | Implemented; actual IAB + backend positive/negative chains. |
| Personal settings / shared models | `/configuration`, `/model-settings*`, global settings | M04 user configuration/CAS, `/models`, administrator models | Implemented personal reference/profile editing and masked-secret preservation; characterization + actual backend; complete settings UI parity remains OPEN. |
| Account administration | no multiuser page | M01 `/admin/accounts` metadata/create/disable/reset | Implemented at existing Settings entry; actual UI read pending. |
| Credentials / MCP | `/connections`, old MCP issue | M01/M11 credentials, strict MCP issue/revoke | PersonalConnections consumes actual contract; final M11 head composed. Actual original feature renderer issues read and source-bound write grants, hides one-time secrets, revokes exact A credentials and retires held A ACKs/dialogs before same-ID B. Concurrent form RED→synchronous lock GREEN; final current build/affected remain pending. |
| Registered devices / Today / usage | `/devices`, global `/status`, old usage view | M03 `/ingress/devices`; M02 `/data/statistics`; M04 `/usage` | Actual M03 heartbeat observations now reuse the original DeviceOverview; registration-only devices stay explicitly unobserved with no synthetic queue/status. Today retains real recent5 WorkActivity cards, with actual owner/held-A/B renderer proof. Complete home navigation/storage diagnostics remain OPEN. |
| Feature gate / discovery / renderer packs | `/features` | Real registered scoped Fastify routes; existing FeatureRegistry contract | Implemented eda455ee: actual onRoute → existing FeatureRegistry; backend positive/negative gate. Actual IAB page gating passed; never advertise missing routes or providers. |
| Library formal list / filters / pagination | `/library/catalog`, `/library/descriptor` | M02 `/materials` + `/sources`, scoped cursor and exact pinned material read | Implemented eda455ee thin catalog: existing PrivateData canonical page/cursor and own source-count projection; no scoped presentation pack is claimed. Original LibraryBrowse consumer remains; actual IAB A/B canonical/source increment passed. |
| Formal detail / citation / attribution | `/materials/:id`, revisions/read/members/context; optional descriptor/source-view/index retry | M02 exact same material read/revision/members/context; M08 canonical context | Core routes available. Source-view/presentation/index-retry do not exist in589 scoped host: optional presentation must use established generic body fallback, retry must not claim unavailable index work. Explicit Memory Material links and manual selection consume M07 canonical preflight and pin the selected revision again at admission; returned evidence remains under the declared context reader. |
| Raw records / evidence / albums / sessions / image OCR | `/capture-browser*`, image/ocr; capture delete | M02 captures, M03 originals, exact current M06 extraction through scoped raw projection0172+729 | Implemented before-LIMIT owner/source/app/privacy/OCR filters, albums/sessions, original image/thumbnail and current extraction; actual backend seven-case and original timeline/Session renderer pass. Persistent device journal and same-byte record-incarnation fencing are composed. Pending/failed processing controls and complete raw UI parity remain OPEN; immutable intake is retained. |
| Sources metadata/history/context | `/sources`, `/source-items`, history/context | M02 same owned endpoints | Available normal metadata contracts; actual renderer compatibility pending. |
| External source settings / OAuth / recording connector | `/connectors/status`, vendor paths, old sync/delete | M10 `/connectors` per-instance config/revision, `/start`, `/sync`, `/disconnect`, `/operations` | Original Gmail and Google Calendar cards select an owned connection, keep M04 masked-secret CAS and explicit M09 lifecycle, and follow actual OAuth/task/selected-calendar/sync receipts. Actual renderer/backend ACK/account matrices, bounded review and built IAB chains pass. Lark now has a tested thin owned-instance consumer of its original panels for actual check/auth progress, explicit scope/preview/confirm, source context/pause, partial retry/cancel and calendar sync. CLI installation, recordings, complete provider status/items/steps and current whole-module gates remain OPEN; no provider-name alias infers an account. |
| External MCP discovery/import | `/connectors/mcp/discover`, `/import` | M11 strict discover/import, user mcpConnections domain | M11 final composed; owned preparation/CAS and same-ID draft retirement pass real backend/component tests. IAB connection/source save passed. Full original Sources renderer now discovers/imports/duplicates through two real Mote MCP SDK endpoints and retires held A discovery on B. Old global status404 has actual RED→GREEN. Final IAB/build/affected remain pending; contract `/tmp/mote-m11-web-contract.md`. |
| Web reference import | PUT `/sources/:id/items` | M03 explicit device/source registration + POST ingress items/batch receipt | Implemented5b042c4b; actual M03 metadata/retry/history/A-B tests and IAB save/switch passed. Identity-corrupted actual ACK RED51101a26 → strict c1b6f159 GREEN; no URI is fetched. |
| Notes and chat attachments | `/sources`, `/file-sync/v1/uploads`, parts/commit | M03 ingress devices/sources/uploads/parts/commit with actual file revision/receipt | Implemented b64afe07 transport adapter using original chunk algorithm, exact user/deployment/source/batch/hash/byte receipt validation. Actual HTTP byte read/retry/isolation and old upload characterization pass; renderer attachment increment pending. Text notes already actual Ingress3. |
| Imports / confirmation / local upload queue | `/imports*`, `/import-uploads*`, `/import-source-packs` | Joint declared PREP43db plus frozen c45 unknown-result fence: existing M03 staged uploads, M06 private preview/exact confirmation and M05 tasks | Original renderer consumes this common contract: actual staged parts, preview with zero captures, explicit confirm, same-ID A/B, commit/admission ACK loss with same-body retry and held history/file-read retirement pass. Actual IAB original upload→preview→confirm→account switch→same-ID B→reload also passes. No second ImportManager. Image-profile/attachment pipeline, full controls/settings, ambiguity/fault/restart breadth and final affected remain OPEN; host-directory imports are forbidden by the shared scoped contract, not silently reopened. |
| Files / audio / review / speakers / export | `/files*`, `/archived-files*` | Shared M03 original + M06 read/correction/speaker/tar thin freeze a10; authenticated renderer bytes | Actual original Files→Library→FileDetail and authenticated A/B original-byte chains pass. Exact owner text correction and anonymous speaker naming now use the original controls; full artifact pagination preserves later-page confirmations and retires stale owner callbacks. Current transcript uses neutral wording, raw/current tar remains separate. Actual proposed terms/calendar review now uses fixed operation/task receipts and explicit confirmation; retry/cancel/forget exact-generation journeys pass. Summary/dialogue/image artifacts read their exact own publications without replacing editable current transcript. Literal speaker-like text is preserved. Original named processing profiles/source-MIME rules/service references/one-transaction Save and explicit preview/reprocess now consume declared a2cb PREP with actual renderer+M04/M06 evidence. Same-owner original-generation changes retire old delete UI receipts and actions. Acoustic/sample/export breadth, saved-service health, root/image/attachment overrides and complete recording outcomes remain OPEN; no second FileStore. |
| Processing/activity | `/processing` workflow list, `/work-activity`, `/operations` | M05 actual `/operations`; M06 processing configuration/submission | Operation component reused; M14 actual WorkActivity aggregate is composed; original Web goal/card/detail/evidence consumer is verified with real M07 publication. M07/M08 evidence preserves the context reader; technical processing-list shape remains OPEN; actual retained Agent inputs now use the existing owner trace journal. |
| Ask/conversations/query progress | `/conversations*`, `/query-runs*`, `/query`, work activity | M08 same conversation/run routes with strict Ask input; canonical evidence reader | Existing consumer largely same; per-request selection uses M15 db88 owned modelReference and personal model ID override through M04. Actual IAB+real M08/Harness+generated SSE I/O/material tools/conversation/citation/refresh passed. A held provider→B positive→releaseA passed. Original model controls restored cde70676/705d with same-ID account retirement RED/GREEN; provider-model post-read during one IAB run remains unverified. M14 WorkActivity projection and original Web card/evidence consumer are verified with the M07 publication journey; Ask/Insight Activity combination breadth remains OPEN; retained Agent input narrow proofs are now recorded separately. |
| Insights/history/report | `/insights`, `/insight-runs`, `/skills`, artifacts | M08 actual insight routes/artifacts; fixed shared skill engine | Actual `/skills` uses bundled catalog; actual missing run scope RED06564f97→3529e18b. IAB report iframe/text/citation/history refresh passed. Original preset control restored through the same owned-reference seam; bounded M14 review9659..705d found no confirmed P0/P1/P2. |
| Memory list/correction/delete | `/memories*`, `/memory-jobs*` | M07 memories same; `/memory/jobs*`, `/memory/recipes`, `/memory` view | Published list, actual M07 job history/receipts and direct/nested context evidence readers adapted and validated with real M07 publication. Original valid owner correction now uses operationId + correction and follows its committed task to the new published version. Canonical Material manual selection retains recipes, owned request model and operation ID through publication; owner stale review now uses the existing M07 audit-only page/read and retained evidence, with no active Memory/context/model publication; audit time/search/category parity and manual range/raw selection remain OPEN; use real provider facade, no raw store body. |
| Memory settings/recipes/bindings/integration | `/memory-settings`, `/memory-recipe-settings`, `/memory-spaces*`, `/memory-recipes` | M04 memory domain, M07 `/memory` control, binding prepare/activate/cancel, M09 plugin snapshots | Original plugin-page M07 pause/resume/stop and prepare/read/activate/cancel mapped to actual receipts; durable preparation discovery is read-only and owner-bound. Recipe catalog and persisted job batch/task progress are adapted; manual selections, settings, integration and unavailable legacy input-plan projections remain OPEN; never restore authority from a local draft. |
| Plugins / personal instances / admin package install | `/plugins`, instances, resolve/install/uninstall | M09 same package and instance endpoints but strict expectedRevision/user snapshots; administrator package mutation | Owned M09 editor metadata, explicit masked-reference preservation under CAS, personal/shared reference choices, explicit capability/source/history grants and separate administrator catalog revision implemented ff91/71a2. Actual original React page + actual M09/M07 isolation/edit/reload/activation chain passes; Actual IAB administrator preview/install/uninstall/reinstall and A masked edit/check/enable/disable passed; nonempty Memory-provider migration remains OPEN. |
| Agent inspector / startup/context trace | `/agent-view/*`, `/context/*` | M08 scoped catalog/read/search/retrieve/bundle/status; startup/runs/events availability must be checked | Actual no-model startup reuses M08 opening/context/tools; original catalog honors declared Material reads. Personal M04 opt-in retains actual M08 events, compaction/retention, source/Memory proof retirement and opaque owner-bound pagination. Original renderer and actual server suites pass; current final affected/IAB and complete remaining catalog/scope breadth are separate gates. |
| Todos / calendar action approvals | `/todos*`, `/actions*`, `/devices`, native calendar bridge | M12 scoped Todos/Actions + M03 device metadata | Stable107 composed, not final accepted. Original Actions edit→fixed review→OwnerQuestions approval and question entry show fixed target/account/evidence; StrictMode, modal switch, slow review, target corruption, revocation and disable matrix pass. Original opaque Actions20→1 and signed Todo30→next renderer characterization pass with real backend producers/CAS/lost-ACK retry/late-account fences. Native bridge and current final dependency gates remain OPEN. |
| Storage/encryption/backup/index | `/content-storage*`, `/vault*`, `/storage-statistics`, backup/restore | No equivalent scoped management surface in589 | M16 owned portable3 receipt/list/cancel/retry and verified download are consumed in the original Vault; the original route no longer requires global status. Admin account deletion uses durable metadata receipts and original operation ID, including refresh/retry and self-session retirement. Same-original-deployment/account portable3 import is consumed in the original Vault with durable receipt/history and exact retry; actual renderer/backend evidence is recorded, while final IAB/affected remains pending. Separate metadata/data modes and encryption/index/statistics remain OPEN scoped contracts; instance-safe diagnostics are covered by the management row below. Instance backup/restore is M16 offline CLI; administrator authority never grants private export access. |
| Diagnostics/runtime/update/deployment settings | `/diagnostics*`, `/runtime*`, `/software-update*`, global status | M16 administrator-only safe metadata and signed release check | Original route/diagnostics/update consumer now uses explicit instance-safe coverage and readonly signed check. Private queue/index/services counters, complete runtime settings and instance YAML editing remain OPEN; no private traces or automatic updater. |

No OPEN row is counted as M13 complete or silently deleted. Thin adapters must
have real backend tests and representative renderer journeys. Missing domain
semantics need owning-module follow-up; this audit is not evidence that the old
single-owner production behavior was defective.


Increment after independent freeze22: 47ee1679 RED -> eda455ee metadata/library;
5162526f RED -> b64afe07 attachment transport; 029fba7c RED -> 5438b1ce
newer-auth intent fence for delayed ticket exchange. This last RED is a new
migration adoption race contract, not a claim of an old-system production bug.
M11 reviewed589..22 only; all these increments still need independent review.
No existing Web consumer directly reads getReader/SSE; raw Response body-method
consumers are fenced. Direct stream adoption is not counted tested or supported
by that body-method proof.

## Bounded closure checkpoint9659

See the finite closeout list in [M13 validation](../validation/multiuser-m13-web.md).
M14 independently reviewed22..5e and c1b6/3529. Its ACK identity P2 gained
real M03 transport-corruption RED→GREEN and was re-reviewed closed. No new
confirmed P0/P1/P2 in that bounded increment; no independent test rerun is claimed.
Public reader-only freeze c6b092eda5404dde2f99ea601e2f3ef13c55d386 sits above
final M11 plus M14 source CAS; M14/M15 can compose it without Web/native/M12 code.
It is not whole-module acceptance.

## Increment after9659

M15 db88 per-request model lease seam is composed as7f2fe173. Original Ask and
Insight controls were restored; same-ID A→B component selection REDa39db8c0
→705d0207 GREEN5/5. M14 bounded review9659..705d has no confirmed P0/P1/P2.
One actual IAB alternate-model query completed and archived, but transport loss
prevented provider model/default post-state reads. A readonly recovery confirmed
the rendered archived answer and clean705d; HTTP host was no longer listening.
No query was blindly replayed and the missing post-state proof is not counted.

M16 owns personal export/instance backup/restore/delete lifecycle. Existing
`features/storage.tsx` still selects `ContentStorage` and `Vault`. Entries are
GET `/export`, GET `/export-bundle?mode=metadata|data`, POST `/import`,
POST `/index/retry`, GET/PUT `/content-storage`, POST `/content-storage/decrypt`
and its `/cancel`. They remain explicit dependencies; M13 creates no second
backup implementation. M14 collector snapshot recovery is a separate capability.


Management consumer increment: M16 e91 lifecycle registry coverage and1976 safe
metadata, plus a21 management-only regression and d787 post-read revocation fix,
are composed on this feature. No backup-only RED or unfinished backup runtime
was imported with that selected test patch. The original diagnostics route accepts
a Web administrator without legacy global status. Ordinary accounts receive an
access notice and fetch no management fallback. Diagnostics render only declared
instance-safe metadata coverage; private queue/index/services counts are not
fabricated. Update checks reuse the signed read-only service. Instance configuration
editing remains startup-YAML only, and no HTTP update/rollback is executed.

## Recorded implementation decisions

| Problem | Decision | Reason | Impact | Validation |
| --- | --- | --- | --- | --- |
| Canonical imports and restarted native OCR cursors | Persistent owner/device update counter and exact extraction journal; bounded read reconciliation | Import restores data without re-admitting processing; deleted events cannot rewind issued cursors | Instance backup preserves both tables; portable excludes derived history; future cursors409 require identity-confirmed resync | Actual M01/M03/M04/M06 seven-case suite; M16 backup corruption/round-trip evidence; independent bounded reviews |
| Awaited image with identical UUID/ref/hash after recreation | Reuse existing M08 original incarnation receipt before and after the await | Semantic content hashes do not identify the lifetime of a record | Old thumbnail409; no new table/runtime or wider read authority | Independent durable RED, own samecase RED→GREEN and seven-case backend suite |
| Original Vault file picker with new same-account merge engine | Original select-file→submit flow; transient archive in the account tree, durable server receipt/deep link and exact retry body/id | Reuses M16 engine and avoids a second archive store or a new confirmation policy | Reloaded failed imports require reselecting the same file; no private archive in localStorage | Actual renderer/backend same-owner restore, lost ACK retry, refresh, A→B late file fence, cancellation and terminal polling; types/i18n pass |
| Editable Action draft must not stand in for the server's immutable approval | Keep original edit fields, then display returned fixed review before an explicit OwnerQuestions choice; reuse that same renderer at the question entry | M12 requires fixed content/version/evidence/target/account and OQ revision/request ID, independently of mutable list or browser identity | Account-keyed tree retires the modal and callbacks; no compatibility-confirm shortcut, new grant or automatic native mutation | Actual M03→M12 Harness→original dialog/question entry→OQ approval; switch/slow/revoke/disable/malformed target matrix |
| Empty Gmail account has no owned connection to select | KEEP original card and OAuth/sync flow; CHANGE setup to M10 disabled-instance creation and M04 same-entry masked CAS edit; explicit M09-backed lifecycle buttons | Existing connector contract separates settings, plugin admission and external authorization; configuration must not silently enable collection | Auto-sync/interval retain schema defaults; blank secret keeps its same-owner saved value, explicit clear removes it; no new configuration store or backend facade | Actual empty-account creation, same-ID A/B, disabled save, secret preservation/clear, conflict/reopen, explicit enable/pause/remove and late-save retirement |
| Google Calendar card still expects global Google status | KEEP the original Sources card, read-only OAuth, explicit calendar selection and archived evidence; CHANGE to an owned M10 instance and durable operations/tasks, reusing the existing Google settings form and lifecycle | Same adopted multi-user identity/lifecycle contracts as Gmail; calendar read authorization remains separate from Actions/native calendar writing | No new provider runtime, permission, semantic dispatch, settings default or navigation; Lark/recordings remain separate OPEN rows | Actual M01/M04/M09/M10 OAuth, calendar-list/select tasks, same-ID A/B, lost sync ACK and late authorization retirement through the original renderer |
| M03 original URLs require authenticated reads | KEEP original FileDetail playback/image/download controls and raw original bytes; CHANGE media publication to the captured Api's authenticated fetch and disposable Blob URL | Shared Files stage-1 contract delegates tickets and bytes to M03; URLs carry no substitute credential and cannot be assigned naked to media or download elements | No new original store, server facade, retention rule or media limit; owner retirement revokes presentation URLs and suppresses late byte bodies | Actual A/B same capture ID and differing generated original bytes, protocol/session headers, full download, held A body→B retirement and B positive |


Decision provenance: the table above implements [multi-user scope: Decision and provenance, Clients, Storage and recovery, Supersession](../adr-multiuser-scope.md#decision-and-provenance), the [M13 module boundary](multiuser-modules.md#模块改造与验收矩阵) and [public identity/lifecycle mechanisms](multiuser-public-contracts.md#已复用能力及责任边界). The multi-user ADR itself records the adopted original discussion and its later authorization; this ledger does not invent an earlier separate vote. Raw images retain the [MVP KEEP rules for immutable originals, stable receipts and retention](../adr-mvp-baseline.md#supersession) and [Central file authority](../adr-central-file-evidence.md). Read reconciliation repairs current derived presentation only; it is not an old-format reader, startup data migration, model backfill or restored execution grant. Existing data and issued counters are retained.

The Vault interaction keeps [UI presentation Decision / Contracts and ownership](../adr-ui-presentation-packs.md#contracts-and-ownership): page locations, local renderer and domain commands remain separate, and presentation cannot create authority. Same-original-account merge is the explicitly authorized M16 [Personal portable3 import contract](multiuser-lifecycle.md#personal-portable-3-import), preserving current configuration and operations rather than promising a personal point-in-time rollback. The stricter receipt parser keeps required five canonical domains as a subset of a unique, completely declared union; this follows the registered-domain extension boundary, accepts no implicit domain/task authorization and changes no backend policy. Current settings continue to use [ConfigService ownership and transaction](../adr-unified-configuration.md#responsibilities-and-transaction); no second configuration framework or compatibility runtime is introduced. Structural pages and numeric cursor bounds follow the [Central admission structural exception](../adr-central-request-admission.md#supersession-check), not request/backlog quotas.

Actions preserves those same page/component boundaries and follows the explicit
[M12 fixed-review HTTP contract](multiuser-actions.md#web-最小消费映射),
the [public identity/source/lifecycle boundary](multiuser-public-contracts.md) and
[multi-user Clients authority](../adr-multiuser-scope.md#decision-and-provenance).
The additional fixed-content presentation is required by that adopted contract,
not a new approval policy: only an explicit server-authored choice can approve.
The compatibility confirm route stays a backend compatibility entry and the
legacy fixture branch retains its characterization; ordinary Web uses the fixed
review and queues the existing native delivery after approval.


Resumed checkpoint: Joint declared43db PREP is composed, along with its M14final lineage. Actual original Imports renderer1/1 covers staged/private preview/explicit confirmation and ACK/account timing; no runtime adaptation was needed for that normal wire. Lark UTF8 full/compact metadata budgeting actualRED→a4dfGREEN and malformed pending-task identity actualRED→da02GREEN are bounded increments, not whole-provider acceptance. Current815c freshshared/ServerWebtypes/Webbuild0 precedes the later da02 task-fence change; final current gates remain separate. The explicit KEEP gaps above are unchanged unless a row states a concrete implemented journey.

Latest consumer composition includes declared Joint2528 production519 (8177 plus mandatory source-incarnation repair), QR producer final485's selected production lineage, completed Container723cc and M14finalcd46. Web QR v2 now restores the original local invitation/JSON/cancel/re-authorization panel, with original Devices navigation, exact M01 account/deployment/device-purpose/URI validation, source-only device inventory and credential-keyed retirement. Actual renderer M01/M03 grant/private403/PKCE/ACK, cancel410, original-device selection and held-A/B/malformed-success matrix2/2 passes with the existing MCP credential consumer. This closes the missing Web pairing entry; built IAB, independent review and current final gates remain separate obligations. No pending Joint processing-profile implementation or Theme code is consumed.

Agent historical inputs now use the existing per-owner M08 trace journal. CHANGE: the original detailed-trace opt-in becomes an explicit personal M04 `agentTrace.traceEnabled` setting (default false); the instance retains its existing byte/file/entry limits. This follows the multi-user private-content boundary: an administrator or instance diagnostics switch cannot opt another user into private prompt retention. KEEP: actual events, compaction/truncation, explicit recording state, retained-only history and no reconstruction from current data. Reads revalidate current original/Material/Memory proofs. No new store or trace runtime is created. Actual provider messages preserve their native typed protocol. Narrow server/renderer evidence is recorded separately from current full gates and remaining original-page work.

## Explicit selected-Memory integration through the original detail page

The original `整理所选记忆` section now uses the owner M07 integration path in Web
mode. Bearer consumers retain the original lifecycle transport. Web reads the
existing `/api/memory`, `/api/memory/recipes` (`integrations`) and `/api/models`;
it never probes the absent global Memory/model settings aliases.

`POST /api/memory-integrations` takes `{operationId,recipe:{id,version},inputs:[{id,version,fingerprint}]}`.
The owner service resolves each exact current Memory dependency to its retained
canonical Material revision, then uses the existing M07 admission, M04 lease,
M05 children, independent review and publication validators. Personal/Coding
selections keep separate batches and related-card pins, regardless of the global
profile. No new scheduler, table, model default, automatic-enable change or old
execution grant is introduced. Selection is rechecked in the admission
transaction after asynchronous provider/model preparation. Unknown recipe,
retired pin or changed same-operation body rejects; another owner's card is404.
The existing Memory-job receipt adds its persisted `phase` and `automatic` flags
when its retained input is available; physical domain erasure does not recreate
those fields from guesses.

The browser retains only explicit operation/recipe/selection identities under
origin+deployment+user. After reload it reads the exact existing M07 job; a404
permits an explicit same-body retry, never automatic readmission. Confirmed
completion with no new memories is shown honestly. Cancel/pause/resume/retry use
the original M07 job controls. Credential/Api replacement aborts and retires the
old callbacks; selecting another card never rewrites an admitted input.
This closes the selected-card/manual-recipe journey. Broad time-range/raw
selection and the remaining KEEP ledger are separate unfinished work.

## Account queue overview

The original compact queue overview in Web mode reads `GET /api/tasks/queues`.
This is a read-only aggregate of the existing M05 owner task rows joined to
same-owner execution steps: actual running, waiting, blocked and failed counts
per stored pool, plus the number of tasks with unresolved issued/unknown external
journal entries. It has scope `account`; it admits/retries no work and carries
no task input/result, credentials, another user's queue or instance capacity.
Administrator login has exactly the same personal metadata boundary. Empty own
state returns an empty pool list, not guessed instance-wide zeros.

The compact summary retains its original location/details layout, but labels
these measured personal facts explicitly. Global Agent/Harness limit fractions
belong to instance administration and are not inferred from personal task counts.
An unresolved external result does not assert physical completion. Bearer
characterization retains the original execution-settings queue API.
