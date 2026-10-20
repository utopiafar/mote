# AD09: release the Settings monitor during connection verification

Design only, F-AD09-v1. Original owner F. Base and inspected HEAD:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
The concurrent AD05 patch changes only capture selection, outside this scope.
No AD09 implementation is authorized in round one.

## Observed journey and responsibility

Settings owns the persisted configuration and account preference selection.
RuntimeSettings.apply/replaceAccount owns producer pause, in-flight cancellation,
drain, ConnectionGuard write ownership, apply/resume and user completion.
UnifiedCentralSession owns native central session generation; ConnectionClient
owns invitation recovery, grant validation and the login ACK. These boundaries
remain intact.

The ordinary path is MainActivity settings draft -> RuntimeSettings.apply ->
pause/cancel/drain -> ConnectionGuard.reconfigure -> Settings.save -> optional
`/api/connections/self` -> identity/adoption/preference checks -> atomic preference
commit -> apply current configuration and resume according to the original mode.
Native login goes through UnifiedCentralSession.signIn -> existing verification ->
RuntimeSettings.replaceAccount -> Settings.signIn (verification) -> save (another
conditional verification) -> the same lifecycle completion. Device invitations
use ConnectionClient.complete -> verifySelf -> Settings.saveConnection -> save ->
the original handoff ACK and recovery retirement. SendPauseControl and backup
restore also call save and retain their existing lifecycle boundaries.

Settings.read, save, signIn and saveConnection use the same class-wide monitor.
save performs its conditional HTTP verification inside that monitor; signIn
performs its first verification while holding it and nests save. saveConnection
also wraps save in the monitor. HttpJson uses 15 s connect and 30 s read timeouts;
the monitor therefore spans network waits. MainActivity's startup settings load
and status snapshot are already background tasks, so the evidence establishes
blocked settings readers and delayed page/status completion, not that all current
startup reads execute on the main looper. Other UI calls such as preview
acceptance also use the monitor. Settings construction calls read itself.

## Proposed bounded change

Change only Settings.kt plus new module-specific tests. Keep method signatures,
return/error types, persisted schema, account directories, caller order, number
and order of verification requests, and all lifecycle owners. Avoid a new public
configuration API or cache/TTL for `/connections/self`.

Each save operation has three phases:

1. Under Settings' monitor, validate an explicit expected config, read the current
   complete config and selected preference/endpoint identity, and capture a
   mutation generation tied to this SharedPreferences instance. Determine the
   existing verification branch from that snapshot. Allocate an immutable intent
   containing only the request's own values and required expected binding.
2. Release the monitor. Perform the exact original verification sequence against
   the intent's origin and token with unchanged protocol headers, status handling
   and AccountBinding parsing. No settings mutation is permitted from a stale
   local snapshot. HttpJson's existing unauthorized callback may still reject the
   currently selected matching credential; that is a concurrent mutation and
   invalidates the intent. No private queue payload is involved in verification.
3. Reacquire the monitor. Require the same generation and complete snapshot, and
   recheck the supplied expected config/account before committing. A mismatch
   uses existing SettingsChangedFailure; do not automatically resend, overwrite
   a newer config or invent a fallback. Recompute preference selection, adoption
   authorization and configurationValues from the still-current state, then use
   the existing single snapshot commit and rollback path. Completion and resume
   stay with the original caller.

The no-network save branch stays one monitor transaction; do not open a needless
race for ordinary send-pause or preferences saves. An operation that needs HTTP
must not be called from an outer Settings monitor. signIn and saveConnection
therefore become orchestration methods using the same internal intent/commit
seam, rather than synchronized wrappers around a now-unsynchronized save. They
retain their original first verification and save's conditional verification.
For signIn, compute authExpiresAt at the same logical point after its initial
verification; keep authProcess/LoginProcess semantics. Preserve saveConnection's
default-argument verification before method entry and its expectedAccount check.
Do not silently consolidate repeated self requests or strengthen/change an
existing identity comparison as part of this performance change.

The immutable intent is not persisted or logged. It must not retain mutable
JSONObject references across phases. Credential encoding/cache access and
SharedPreferences mutation remain under the monitor. Existing disk commits and
adoption inventory checks may still take time: this scope removes network waits,
not every possible storage wait, and makes no universal read-latency promise.

## Mutation fencing and lock order

Generation is process local and keyed by SharedPreferences object identity, with
a bounded/weak identity lifetime so isolated test contexts do not leak. Process
restart destroys all in-flight intents, so no new persisted field or migration
is needed. Keep the exact snapshot comparison as a second guard. Before coding,
the implementation must enumerate every configuration writer in Settings.kt:

| Writer | Required fence |
| --- | --- |
| save commit and rollback | Advance generation before every attempted write, including failed commit/rollback; never restore an old generation |
| signOut/rejectCredential | Short monitor update retires in-flight intents, including A -> signed out -> A races |
| enabled setter | Move its preference mutation into the same short monitor and fence it; service/scheduler callbacks remain outside the lock |
| read initialization/default preference write | Fence the actual mutation, after the snapshot is initialized and before a new intent can be issued |
| capturePreviewAccepted | Fence the selected personal-preference mutation; preserve capturePreviewSeen during later commits |
| deviceId creation | Keep its atomic short lock; a new device identity invalidates any in-flight identity intent |
| status, sync/capture counters | Keep outside the configuration generation so ordinary telemetry does not invalidate a save |

A failed SharedPreferences commit can still alter in-memory values: generation
advances on an attempted configuration write, not only after success. Preserve
the existing rollback and capture-stop/error behavior. Concurrent readers observe
the old committed configuration during HTTP; after commit they observe the new
complete snapshot. An external writer bypassing Settings is outside the intended
production contract, but the final value comparison must reject detectable
changes; tests must not bypass the production writer when proving ABA fencing.

Never acquire ConnectionGuard while holding Settings' monitor. Existing callers
already acquire ConnectionGuard before Settings, and keep that ownership across
verification so producers/old uploads remain fenced. Do not hold Settings while
waiting for RuntimeSettings' executor/main-thread completion or session locks.
Do not move the monitor around the entire UnifiedCentralSession operation.
Its separate synchronized network operations are a known adjacent wait and a
separate follow-up; this plan does not claim to remove those session waits.

## Supersession classification

- KEEP: all original UI/navigation, draft expected checks, local binding consent,
  exact owner/deployment validation, request order/count, credential expiration,
  account preference defaults/restoration, producer pause/drain/resume,
  sign-out cancellation, atomic commit/rollback and error presentation.
- CHANGE: Settings' network verification occurs outside its monitor; overlapping
  mutations retire the immutable verification intent via generation and CAS.
- REMOVE: network wait while holding Settings' monitor, including nested wrapper
  acquisition. No identity verification, retry or durability check is removed.
- EXCEPTION: no owner-approved product exception. Use the existing stale-settings
  failure when an overlap prevents a safe commit; ordinary serialized journeys
  retain their behavior. Generated test state is isolated from daily profiles.
- UNKNOWN: complete UI impact of the separate UnifiedCentralSession monitor;
  storage latency under commit/adoption checks; exact test-context implementation.
  Neither is a reason to change policy or claim full UI latency resolution.

No ADR currently promises a network-length Settings critical section. Review the
account-isolation ADR, profile credential policy, current Android configuration
and lifecycle docs and their tests for assumptions before implementation; update
the Android local-state/concurrency documentation through its assigned owner if
needed. The new mutation fence must not alter wire/storage versions.

## Validation contract and resources for a future batch

Use generated account/config values and a blocked loopback self endpoint. Preserve
the real Settings entry points, SharedPreferences commit semantics, HttpJson
callback and RuntimeSettings ordering. JVM tests can cover a pure intent fence
if extracted, but cannot alone prove Android Settings/WorkManager integration.

| State/transition | Required assertion |
| --- | --- |
| save/signIn/saveConnection held at each self request | A second Settings instance can construct/read the old complete snapshot before endpoint release; no partial config or token logging |
| valid success, no overlap | Same request trace, binding/device metadata/personal prefs, expiry timing and endpoint as baseline |
| save(expected) stale before/after network | Existing failure; no overwrite, no automatic verification retry |
| concurrent save, signOut, credential rejection, enabled stop, preview acceptance | Late verification cannot overwrite any newer configuration state |
| A -> B -> A and failed commit/rollback | Generation rejects old intent even when config equality returns to A; original failure/capture-stop behavior |
| counters/status update during HTTP | Save remains valid and counters are not rolled back |
| same origin, new deployment; wrong expected account; protocol/401/timeout | Original identity/network behavior; no TTL or origin-only shortcut |
| local adoption with pending notes/sources/stages | Same confirmation and producer fence; no account remapping or private payload on self endpoint |
| RuntimeSettings normal/apply failure/stop race | Original drain/cancel/resume and settings UI completion; no resumed capture after explicit stop |
| invitation grant persisted, self success, login ACK lost, restart | Existing pending recovery is retained/retired in the original order |

Before implementation, independently approve the final writer inventory and test
seam against the exact future base/head. Use the campaign heavy gate, isolated
Gradle home/project output and generated fixtures. Future Android entry-point
instrumentation needs a resource-request and an independently allocated headless
AVD/serial; do not use existing shared emulators or physical devices. Preserve
all current assertions/timeouts/required scale. Final controller integration is
separate from these module checks. Round one executes none of this AD09 code.
