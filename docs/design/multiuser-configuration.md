# M04: Configuration, model resources and usage isolation

M04 is based on M01 `443726d2a95ef55db9466d06aa44ea1061ca56e4`, including
M00 `5031b754915d3fbba0dbe0c050b6d103a02966ef`. Its Draft PR targets only
`codex/mote-multiuser-integration`. The integration branch remains at
`6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed` while prerequisite PRs await
integration. M02 owns private-data SQL and the startup signal registration fix;
this module neither imports that domain nor modifies its startup path.

## Ownership and transaction

This extends [the unified configuration ADR](../adr-unified-configuration.md)
under [the multi-user decision](../adr-multiuser-scope.md). It keeps the existing
ConfigService schemas, revisions, file observation, atomic persistence,
prepare/apply/publish/rollback and redacted projections. It does not introduce a
second configuration framework.

| Surface | Authority and implementation |
| --- | --- |
| Instance `MOTE_CONFIG_FILE` YAML | Deployment operator; built-in ConfigService registrations. The resource administrator API edits only its `models` domain. Other instance settings retain their startup/restart contracts; unfinished runtimes stay unavailable. |
| `DATA/configuration/users/<host-user-id>/mote.yaml` | One ConfigService per authenticated account. Path components come from a host context, never a body, header, model tool, or filename supplied by the client. Direct file editing is an operator action on that account's file. |
| Personal `models` domain | `profiles` contain only that user's connections; `selections` maps existing model features to strict `{kind,id}` references. Empty selection is unconfigured and fails explicitly. |
| Instance shared models | Configured `models.deployment` and `models.profiles` publish fixed resource references. The public catalog contains only ID, name, provider, model and `readOnly`. No copying of shared credentials, endpoint override, or shared-to-personal credential inheritance is exposed. |
| Personal `modelPrices` | Prices use the established price schema. Accounting preserves unknown prices/cache quantities and introduces no daily fee quota. |
| SQLite M04 state, generation, usage, encrypted snapshot and restore-journal tables | User-qualified state/receipts/ciphertext, durable resource and credential generations, and credential-free restore provenance hashes. No legacy global Store or owner model runtime is mounted. |

HTTP uses M01's real `requestContext` and `registerUserRoute`, including protocol
2, session binding and CSRF. Management privilege never selects someone else's
personal configuration. The administrator receives only the same credential
status projection for shared model settings. API views identify the personal
file as `user-config:mote.yaml` and do not reveal another user's filesystem path.

Page API mutations and file reloads use the same schema and revision queue.
Invalid input leaves the previous effective configuration active. Stale file and
HTTP revisions conflict. Private resolvers never expand `${ENV}`; the personal
model schema rejects environment references and the host Codex login protocol.
Instance secret references keep their existing operator-only meaning.

ConfigService adds optional synchronous access/transaction guards. They run at
queue execution, before atomic rename and after asynchronous resource install
before synchronous publication. An authorization failure rolls back installed
resources and restores the previous saved document using CAS. Concurrent file
replacement makes uncertain cleanup fail closed. Provider exception text and
guard exception payloads do not reach public errors.

## Production API and downstream use

| Endpoint | Behavior |
| --- | --- |
| `GET /api/configuration` | Authenticated user's redacted saved/effective domain view and revision. |
| `PATCH /api/configuration` | `{revision,patches:{domain:patch}}`, one ConfigService transaction. Instance domains are unregistered here and rejected. |
| `PUT /api/configuration/:domain` | `{revision,value}`, a complete domain replacement. |
| `POST /api/configuration/reload` | Reload the authenticated user's fixed YAML path through the same validation/CAS. |
| `GET /api/models` | Shared immutable references plus that user's redacted personal profiles and selections. |
| `GET /api/models/selection/:feature` | Credential-free selected-model lease receipt; no implicit fallback. |
| `GET /api/usage` | Only the authenticated user's receipts and the existing usage totals calculation. No client usage-write endpoint. |
| `GET/PUT /api/admin/configuration/models` | Administrator-only redacted instance model view / complete model domain replacement with revision. |

The production `scope/app.ts` opens and closes these real services; tests do not
substitute a fixture composition. Other private domains remain closed. The old
single-owner `/api/model-settings*` routes are deliberately not mounted: their
copy/update behavior could inherit shared secrets. M13 must consume this scoped
contract and M01 cookies before its settings renderer is restored. This module's
page checks exercise those real cookie HTTP endpoints; they are not browser
renderer acceptance.

M05/M06/M07 obtain
`services.forUser(hostContext).get<UserConfigurationService>('configuration')`.
`lease(feature, operationId)` pins the user's effective document, personal
credentials, selected fixed transport, price and configuration revisions. The
host's `configuration.withModel(lease, callback)` provides the pinned settings to
trusted runtime adapters. Each lease includes an opaque `snapshotId`; its model,
effective document, selection, price and authorization metadata are durably
AES-256-GCM encrypted in a user-qualified record. AAD binds deployment, user and
snapshot ID. Each account has a private 32-byte host key in its configuration
directory; keys and encrypted snapshots are excluded from portable user export.
JSON receipts contain no credentials; copied or deserialized lease objects cannot
obtain host access. A changes neither B's document nor B's active lease. Normal
configuration changes affect new admission; account reset/disable, deletion and
shared resource withdrawal fence publication and usage. Shared generations are
monotonic and durable, including identical republication. Web logout alone does
not revoke already admitted account work.

`recordUsage(lease, result)` derives user, model and operation from the genuine
lease, uses a user-qualified receipt key and reuses existing cost/totals functions.
M05 owns durable task authorization and recovers a current host UserContext. It
stores only the snapshot ID and public receipt, never plaintext model credentials.
On restart it calls `configuration.restoreLease(context, snapshotId,
expectedOperationId)` (or the same bound user service method). The result is
`{status:'restored',lease}` with a new genuine host object for the original values,
or `{status:'unavailable',reason}`. It never leases current settings as a
substitute. User/deployment, account epoch, configuration deletion generation,
operation and durable resource/credential generations must match. Key/ciphertext
damage returns explicit unavailable; account reset, credential withdrawal or
resource withdrawal cannot be undone by republishing identical settings. The
recovered ID is also the usage receipt ID, so restart does not double count an
already delivered result.

Personal nonempty credential replacement preserves admitted live work, as in the
original next-request contract; it prevents rehydrating an old credential
generation, including after changing back. Clearing any credential component
(including whitespace) or removing a profile revokes live and durable access.
Persisted catalog/configuration revisions detect uncertain host restarts; unknown
generation history fails closed. M06/M07 own processing/evidence publication
fences. No unfinished executor or real model calls are enabled by M04.

Trusted plugins can register user configuration domains before first admission
with `registerDomain(id, factory)`, using the same ConfigDomainRegistration
schema/metadata/prepare contract. A private domain must provide an explicit
resolver; it cannot inherit implicit instance environment expansion. Provider
declarations extend the established model schema and transport validation through
`registerProvider`. M09 owns trusted package loading and registration before
configuration admission; ordinary users cannot install providers or supply
executable code. This module does not add another transport protocol.
Before unloading a provider declaration, M09 must withdraw or migrate its saved
references and drain its runtime. Removing a schema declaration while documents
still use it fails closed; reinstalling the declaration permits repair. No
ordinary-user provider unload API is exposed.

## Lifecycle and compatibility

The registered `configuration` lifecycle domain covers personal model settings,
feature selections, price settings, registered portable configuration and scoped
usage. Export is a consistent synchronous document/receipt observation after
configuration admission. It excludes API keys, custom headers, extra bodies and
all instance secrets. Sensitive extension domains are explicitly omitted, and
their missing coverage prevents a purported complete restore. Public extension
domains round-trip through their registered schemas; unknown, missing, corrupt
or wrong-user/deployment/domain/version input is rejected before publication.

Delete marks the account's configuration generation unavailable before draining
work, closing watchers and removing its directory and usage. Retries are
idempotent; B's files and receipts are untouched. The M00 purpose-limited
LifecycleContext allows cleanup/export after account disable without issuing a
normal user context. Lifecycle export creates no ordinary plugin runtime or
watcher and closes its temporary service when complete.

Restore requires a validated host-bound archive and target. It preserves the
account fence while preparing a credential-free staging YAML, fsyncs its final
rename, and publishes usage and restored state in a synchronous SQLite
transaction. Same-user lifecycle actions serialize. An old YAML left by an
interrupted delete cannot be adopted as the archive. Credentials must be
re-entered after portable restore; this does not promise per-user historical
recovery. M16 still owns whole-instance backup/restore orchestration and durable
lifecycle grant issuance.

A durable restore journal stores only operation IDs, generations and payload /
staged-file hashes. If a process dies after rename and directory fsync but before
SQLite activation, the same operation can verify its own exact target and finish
once after restart. A different operation, altered archive, substituted file or
unknown credential-bearing YAML conflicts. Delete clears pending restore
provenance; a revoked grant leaves the target fenced and removes temporary files.

KEEP: ConfigService, provider transport validation, privacy/error projection,
request snapshots and accounting semantics. CHANGE: instance and private domain
ownership, explicit reference selection, host leases and per-user usage keys.
REMOVE: ordinary owner-token access, shared credential inheritance, private
environment expansion and silent deployment-model fallback. EXCEPTION: trusted
operators and installed provider code can access host plaintext. UNKNOWN: M13
renderer, joint M05 grant/snapshot recovery, physical clients, real providers and actual
deployment behavior remain downstream validation; no live keys or data are used.

Executed results and independent review are recorded in the
[M04 acceptance record](../validation/multiuser-m04-configuration.md).
