# M10: user-owned external connections

Baseline: PR #132 `cdc5c34c36fc5743049007ee2c76d705fde3dd7f`, including
M00/M01/M02/M03/M04/M05/M09. This module targets the unchanged integration
branch and leaves the original checkout untouched.
The final M10 feature also stacks accepted M06 Draft #133, published head
`470516b7ed4ab7ee8b0fba344883c6b42bb7ce56`, tested runtime
`07ad9ddb17a0d2cd0004c50958670145b1457446`. This composition is confined to the
M10 feature branch; the protected integration branch stays unchanged.

## Scope and supersession

KEEP: read-only Google/Gmail transports, MIME/calendar conversion, Lark fixed
commands and document discovery, Feishu/DingTalk recording decoding, bounded
pagination, explicit historical selection, original retention, and the shared
executor. CHANGE: every connection, source, credential, CLI home, ledger, timer,
OAuth state and job is bound to the deployment, stable account and instance.
REMOVE: default-owner context, process HOME credential adoption, global private
SQL, separate connector executors, and installation triggering user collection.
EXCEPTION: trusted installed code is not a hostile-code sandbox. UNKNOWN: real
OAuth accounts, vendor permissions, long-lived token refresh and physical recorders
are outside synthetic fixture acceptance. MCP authentication and sessions remain
M11. M06 processing is now stacked for real connector intake; Memory remains M07.

The runtime must exercise the existing provider adapters through isolated fake
transport, not replace their parsing or publication with mock services. Package
installation is an administrator operation and does not create a connection,
perform discovery, mint OAuth credentials or enable historical import.

## Authorization and recovery contract

User routes use the M01 protocol/session/CSRF binding. M04 owns private settings;
M09 owns package/instance admission and stop generations; M05 owns durable job
identity, fairness, cancellation and account fences. M03 owns canonical sources,
receipts, originals and workspace admission. No ordinary request chooses userId,
CLI directories, host paths or deployment IDs.

OAuth state is opaque, one-time, time limited, persisted for restart, and bound to
its initiating stable account, connection generation and durable execution grant.
The browser's current session is not a callback identity. Exchange, refresh and
publication recheck these fixed facts around asynchronous transport. Replayed,
expired, stopped, deleted and account-revoked callbacks cannot publish credentials
or data. Provider failures expose fixed receipts without codes, tokens or prose.

CLI commands retain their fixed argv contracts. HOME, platform credential/config
paths, data/log/cache/temp directories and provider overrides are isolated per
account and connection. Installed package code is shared separately. Connection
disconnect revokes local access and stops jobs; it does not claim remote token
revocation or erase already collected history. Explicit revocation erases local
credential access and records any uncertain external outcome.

Portable lifecycle exports exclude credentials, OAuth state and active grants;
restore leaves connections disabled and requiring authorization. Domain deletion
fences publication before draining local work and removing only the target's
files and ledgers. Whole-instance recovery is M16's responsibility and must keep
SQLite and private connection state together.

## Production API and extension surface

`buildApp` registers `connectors` alongside the real M03/M04/M05/M09 hosts.
`GET /api/connectors` returns the current user's settings/status projections.
`PUT /api/connectors/:id` creates a disabled M09 instance and writes the user's
M04 domain with revision checks. `enable`, `pause`, `resume`, `stop`, `start`,
`sync`, `operations`, `disconnect`, and deletion all use this fixed instance.
Provider operations are fixed names with adapter schemas; clients never supply
argv, credential directory, context or a callback owner. M13 owns renderer wiring.
Operation payloads are validated before task admission and stored only as encrypted
vault envelopes. Durable task input carries a random reference; its envelope is
bound to the exact task, user/instance/epoch namespace, operation, generation and
M09 snapshot. Failed work can retry after restart through that same reference.
Disconnect, instance removal and configuration retirement clear payload envelopes;
domain deletion removes the remaining scoped vault. Earlier candidate task inputs
are upgraded transactionally before execution starts: task records survive while
raw payloads move into encrypted envelopes, and revoked incarnations gain no new
usable reference. Trusted connector definitions declare operation schemas too.

The administrator installs bundled definitions through
`POST /api/admin/connectors/:provider/install` and M09's catalog revision/idempotency
contract. The server distribution supplies these adapter implementations. Native
CLI dependencies must be installed by the deployment administrator at the pinned
versions (Lark 1.0.85 / DWS 1.0.62); the private runner verifies the actual version
before account commands. User routes never run package installation. Lark's app
setup/configure and device login, and both recording providers' device logins,
remain real task-backed production operations. Device links are projected only
into the admitting user's M05 progress; device codes and raw CLI output are not.

Trusted deployment code may supply `connectorDefinitions` before startup. Its
factory receives the same bounded adapter ports and a host-fixed instance scope;
M09 installs/checks/enables it through the same flow. The generated connector
acceptance exercises this path without a new business dispatch branch. Legacy
`ConnectorManifest` v1 and its Store-bearing context remain quarantined; the
scoped definition is the breaking replacement, not a Store-shaped mock.

A connection's private key, ciphertext, CLI home and cache namespace include the
stable deployment/user/instance, connection storage generation and account epoch.
Replacing a browser/client credential within the same epoch preserves identity;
disable/reset and a new account epoch cannot adopt old provider credentials.
Disconnect joins its adapter, removes its current private directory/ciphertext,
and advances the storage generation. Removing and recreating an instance cannot
read the previous storage generation. Archived history stays in M02/M03.

On macOS, the pinned Lark backend stores encrypted credentials beneath HOME and
prefers `master.key.file`; the host seeds an independent local key there before
launch. DWS receives `DWS_KEYCHAIN_DIR` and `DWS_DISABLE_KEYCHAIN=1`, using its
isolated file backend. HOME/config/data/cache/log/temp paths and identity overrides
are fixed by the host. The pinned Windows native CLIs use shared HKCU credential
slots which these file roots do not isolate; their scoped runner fails before
spawning on Windows. A supported isolated Windows credential backend remains a
platform gap, rather than a claim that HOME alone isolates HKCU.

M03's host-only `receiveSourceItemsWithOriginals` selects provider bytes before
its one immutable original descriptor is published. It is absent from worker RPC.
Default archive-source retries retain the original descriptor for an existing
semantic revision even when the new observation time differs. Supplying different
original bytes for the same revision still conflicts. Normalized adapter heads
are encrypted, fixed to the same scope and checked against the canonical capture
ID; they are not indexed as evidence. Canonical source records and full originals
are the actual M03 production data, available to M06/M07's domain consumers.
The composed M06 host receives the same transactional intake receipt with a
trusted format for each original. Ordinary uploaded JSON stays a file. Gmail MIME
JSON and both recording export formats select fixed local processors registered
in the existing FileProcessorRegistry; these call the real `gmailItems`,
`feishuTranscript` and `dingtalkTranscript` algorithms on bounded retained bytes.
Their exact original-bound source identity participates in cache fingerprints;
they never select a newer source head. No format selector enters source worker RPC.
Normalized connector snapshots, including calendars, retain serialized SourceItem
originals for real automatic processing; reference sources retain no bytes.
SourceItem extraction preserves bounded text chunks and available speaker/time
metadata. Material titles use the canonical parent title when nonempty; valid empty
source titles (such as Gmail without Subject) retain their canonical evidence and
use the existing `Processed original` display fallback. DingTalk export MIME is
JSON, and a changed MIME creates a new revision while retaining old evidence.
Gmail envelope-only changes such as `historyId` retain the canonical original of
an unchanged semantic revision. New semantic revisions supply new provider bytes;
the generic M03 conflicting-original check remains strict.

One M05 task records the durable next polling instant; repeated manual sync does
not multiply polling chains. Pause closes future timer admission while admitted
work drains. Resume schedules one future poll; stop/removal/account/lease fences
reject old callbacks. Recording ledgers preserve exact bounded scan windows,
pagination tokens and separate transcript/media checkpoints. Audio failure does
not discard collected transcripts. Repeated discovery rereads transcript revisions
and retains an already confirmed audio backup. Failed transcript/media work keeps
its finite five-attempt transient budget and backoff across polls and restarts;
blocked or exhausted work requires the owner's explicit `retry` operation.
Reference-retention sources reject supplied original bytes before any write.

OAuth exchanges and CLI authorization have M05 external issuance journals. A lost
outcome is not replayed automatically. Connector deletion returns `result_unknown`
while a linked authorization issuance is unresolved; M16 must reconcile it through
M05 before local erasure can be acknowledged. Active local work returns `pending`.
Every adapter operation also has a durable owner-bound activity record. Successful
retirement removes it only after adapter and physical provider work have joined.
An interrupted host leaves `result_unknown`; only a genuine delete-purpose
lifecycle subject can inspect it and record an observed `stopped` outcome, and
cannot settle work still alive in this host. Controlled shutdown interrupts M05
before closing connectors so admitted polling can resume through M05 after restart.
M16 must invoke `configuration`, `plugins`, `execution`, `ingress`, and
`private-data` hooks as well: this domain does not claim their settings YAML,
task history, source evidence or originals were erased by deleting connector state.
Portable restore stages only credential-free settings and applies them through
M04 once; no token, OAuth state, CLI home or polling authorization is restored.

Pinned backend review: [DWS v1.0.62 source](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tree/v1.0.62/internal/keychain)
and [Lark v1.0.85 source](https://github.com/larksuite/cli/tree/v1.0.85/internal/keychain).
The read-only scopes come from the pinned Lark recording commands. Native account
authorization, live refresh, physical devices and real provider data remain unrun.

The timer slot and command receipt are committed inside M05 admission through a
trusted synchronous `onAdmitted` callback. Competing hosts cannot commit orphan
polling chains, and repeated immutable operation IDs return the original task.
A changed command payload or account epoch conflicts. The callback is not a wire
field or worker capability. M09 snapshot validity is also part of M10 task
validation through final result publication. Native CLI cancellation waits for
physical child close; a revoked output callback cannot escape the event handler.
Gmail retains the complete provider Message response and decoded body parts;
binary attachments remain uncollected as declared by its existing
`attachmentsCollected:false` metadata. This does not claim a full RFC822 mailbox
or attachment backup.

### Scoped recording disconnect versus data withdrawal

Recording disconnect retires the connection generation, future sync intent,
provider credentials and saved selection. It preserves accepted archive data and
its existing personal source read authority. General source disable/delete,
privacy/account retirement and explicit data deletion remain their own fences.
The scoped adapter therefore does not translate disconnect into source.enabled
false. A disconnected recording sync rejects before querying provider identity;
explicit connect/login is still required to acquire a new provider association.
No credentials or collection grant are recovered from the retained archive.

### Lark Web presentation increment (M13 checkpoint, not final acceptance)

Lark's document source ID in owned status and successful task results is the exact
public M03 source resolved through `(user_id, instance_id, local_id)` in
`connector_sources`. Consumers must not use adapter-local `lark-docs-*` IDs as
public source identities. No source is created by this projection.

The Lark task-result budget uses actual UTF-8 bytes, including a check on the
compact metadata. For an oversized Lark status-shaped result, M10 retains the
actual CLI probe/job fields and returns `statusInConnection:true`
in place of `selection` and `documentSync`. The same credential-bound
`GET /api/connectors/:id` provides those complete durable fields. Its newly opened
adapter has not probed CLI environment: consumers preserve the task's actual
probe fields when combining the result, and recheck their captured Api after each
await. Failed tasks retain their M05 failure; a status read supplies the current
persisted document errors for explicit per-document retry. There is no implicit
new model/provider job or permission.

This increment does not add ordinary CLI installation, new vendor aliases,
oversized-calendar result storage or a second connector runtime. Broader
recording/Lark capabilities and current final validation remain open.

### Lark calendar inventory beyond task metadata

An explicit Lark `calendars` operation whose full UTF-8 result exceeds the
existing task metadata budget retains the complete inventory in the existing
connector encrypted vault, under its deployment/user/connection/storage and
authorization epoch. The stored proof also pins the connection generation and
actual admitted task ID. Its small successful task result is
`{calendarInventory:taskId,count}`. The existing owned `GET /api/connectors/:id`
exposes `calendarInventory:{taskId,items}` only for that same current generation.
The original Lark consumer requires the exact task ID, count, unique IDs and
calendar field types before replacing its choices; an intervening discovery or
configuration change rejects rather than adopting a different result. No title
or list is truncated. Small inventory results keep their original shape. This
adds no route, table, scheduler, provider call or new execution authority.
Disconnect uses the existing vault retirement; lifecycle export/deletion and
instance backup already cover the same encrypted state. The inventory is a
read-only discovery receipt and never grants calendar write or source admission.
