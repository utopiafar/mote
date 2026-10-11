# ADR: Plugin center and replaceable Memory modules and engines

Date: 2026-10-12. Status: **accepted; phase-one controls and pinned adapters implemented, validation tracked separately**.

The owner accepted decisions 1A–8A after reviewing the architecture and prototype,
then authorized implementation, actual isolated journeys, and PR/merge after
validation. This ADR records the accepted boundaries; it does not imply every
platform, provider or failure combination has been verified. Current supported
behavior is in [Plugin center](plugin-center.md), the original delivery
breakdown is in the [phase-one plan](design/plugin-center-phase-one-2026-10-12.md),
and executed evidence is in the [validation ledger](design/plugin-center-phase-one-validation-2026-10-12.md).

## Accepted product decisions

| Decision | Accepted scope |
| --- | --- |
| 1A | Support both independent Memory module replacement and complete engine replacement, with explicit stage ownership. |
| 2A | Phase one targets Mem0 OSS for CRUD/retrieval modules and Hindsight for engine mode; prove their actual behavior. |
| 3A | The owner may pause all automatic Memory while originals, published Memory and ordinary querying remain available. |
| 4A | Ordinary pause stops new work and drains previously authorized work; a separate immediate-stop command revokes and cancels it. |
| 5A | Install trusted GitHub releases into Central workers/services, allow necessary restart, and make no sandbox promise. |
| 6A | Explicitly migrate history and prepare indexes before a verified cutover; failed preparation keeps the old plan active. |
| 7A | Put the plugin center under Settings → Plugins, reusing established navigation and presentation patterns. |
| 8A | Present a simple overall Memory plan and expose independent module composition in an advanced view. |

Independent review remains a phase-one guarantee. Its strategy and implementation
may be replaced, but engine mode does not waive review, attribution, coverage or
exact evidence requirements. No new daily budget, semantic router, retention
rule or blanket quality compromise is introduced by this decision.

## Ownership and extension boundaries

Separate four capability contracts:

- MemoryPolicy supplies extraction, independent review and integration policies.
- MemoryRepository is the single authoritative store for versioned Memory text
  and its canonical CRUD contract.
- RetrievalProvider is a rebuildable search projection, including FTS, vectors
  or graphs; it is not a second independently editable Memory authority.
- EngineAdapter declares its extract/integrate/retrieve/store capabilities and
  observes its internal tasks, versions and receipts.

Mote owns the user operation contract, authorization, canonical identity,
provenance dependencies, version/fence checks, visibility, deletion intent and
cross-component recovery. Models and selected policies/engines interpret
meaning. Originals and formal Material remain Mote authorities; Memory text may
reside in the selected repository or engine. Mote control tables own provider locators/revisions, hashes, dependencies,
accepted visibility and operation results. Phase one also retains complete
`memories.json`, reviewed outputs and exact put-journal bodies for comparison,
transactional validation and recovery. This is an explicit implementation
exception to a metadata-only projection: selected external bindings still read
the authoritative text from the provider and never silently fall back to SQL text.

There is one active commit coordinator per Memory space, not one extraction
policy. Personal and Coding policies may independently consume the same source,
retain separate grants and products, and share generation only under the
existing exact contracts. Engine mode disables the built-in stages it takes
over, preventing duplicate extraction or integration while retaining review.

Package release, configured instance and space/stage binding are different
objects. A release pins source and artifact identity; an instance owns explicit
configuration, secret references, runtime/health and installation epoch; a
binding selects instances/capabilities, scope, revision and generation. Running
inventory verifies observed capabilities, not installation or desired state.
Install, configure, activate, history migration, delete and uninstall remain
separate operations. Installation never grants historical model work.

## Automatic pause and generations

An ordinary pause commits a new-input admission cutoff without deleting saved
composition or published data. Previously authorized queued, running and
checkpointed work keeps its pinned generation, components and inputs and may
drain or recover under that original authority. Current evidence, privacy,
deletion, installation and explicit cancellation checks still apply.

The boundary is the operation/authorization graph registered before pause.
Declared, necessary children within its frozen scope may finish; pause must not
reject their required review/publication stages or permit unlimited new scope or
self-triggered integration. All automatic Memory includes extraction,
integration and external automatic Memory writes. Existing insight and
conversation-working-memory controls/tables retain their independent meaning.

New inputs during pause continue through normal archive/Material publication and
querying, with denied automatic receipts and no new automatic Memory authority.
Resume opens a new generation for subsequently received inputs. Restart,
duplicate receipt, new configuration or resume does not authorize the paused
gap; selected historical work needs an explicit owner request. This is an
engineering refinement of the existing no-renewal rule, not a new usage limit.

Immediate stop is a separate command: persist revocation and publication fences,
request cancellation, and report unresolved external outcomes accurately.
It targets unfinished automatic work for the stopped capabilities; independently
authorized manual work is cancelled only when explicitly selected. Previously
incurred model usage is not undone. The manager must not dispose a draining
release or block an authorized commit. Uninstall requires finished/stopped work
and a migration or retained controlled reader for provider-owned historical
text. Revoked privacy, deleted originals and invalid evidence always fence
publication, even while an ordinary pause is draining.

## External operations, versions and querying

Cross-database writes use durable intent → external receipt → verified result →
published binding/accepted revision, with stable idempotency, outbox/inbox and
reconciliation under the existing ExecutionEngine. A network call inside a
SQLite transaction does not provide a distributed atomic commit. Accepted,
running, result-unknown, completed and published are separate states; unknown
results must be reconciled before unsafe replay.

An engine must isolate unaccepted writes in staging or supply immutable, pinned
reads that cannot incorporate unaccepted content. Querying its mutable current
state and hiding a row afterwards is insufficient: retrieval/reflect may already
use a cancelled, revoked or stale result. Lack of isolation/version/provenance
capabilities limits the supported mode; it must not trigger silent downgrade.

External autonomous extraction, integration, reflect, expiry and cleanup tasks
must be declared, observable and constrained by the authorized operation/scope.
They do not inherit unlimited historical or remote-model authority from install.
Stopping Mote submissions alone does not stop a supplier's schedules/workers;
uncontrollable automatic writes cannot be displayed as disabled. Cooperative
external cancellation does not guarantee an immediate end to internal writes.
Workers/services are trusted execution boundaries, not claimed sandboxes.

Ask remains read-only. Retrieve supplies scoped candidates and locators for Mote
to revalidate and expand. Reflect produces derived interpretation, not original
proof or an automatic Memory commit. Any reflect operation that writes requires
an independently authorized workflow and cannot be hidden in a query tool.
Graph paths and multi-card answers retain their complete support dependencies;
only permitted original ranges actually delivered in the current query gain
citation authority. Supplier tags cannot be assumed to implement Mote scope:
banks/namespaces, untagged data, directives and derived objects need actual
isolation verification. Trusted configuration directives and captured text remain
separate, and unknown external usage must not be recorded as zero.

Deletion distinguishes rejection from future use, external request acceptance,
pending erasure and verified erasure. It must cover text, relations, indexes,
caches and autonomous tasks and preserve deletion tombstones against recovery or
regeneration. A supplier's accepted delete receipt is not proof that all copies
have been erased. Memory deletion and original-source privacy erasure retain
their distinct meanings.

## Switching, backup and UI

Switching explicitly prepares a consistent snapshot/watermark, imports supported
history, prepares projection and verifies canonical IDs, text hashes, evidence,
corrections, deletions, relationships, CRUD and scope. The old plan serves during
preparation; the cutover barrier fences old writing, drains/reconciles its tail,
then atomically publishes a checked new binding generation. Existing queries pin
their read binding. Old late writers cannot commit after retirement.

Replacing the repository with Mem0 CRUD, or returning to the built-in repository,
requires the same text/version/correction/deletion migration. Only replacing
RetrievalProvider while keeping the text authority unchanged is index-only.

Migration transfers every Memory body retained by Mote and its canonical correction/supersession state. Native provider audit revisions and engine graphs remain in the retained old instance and runtime backup; their cross-engine portability is not promised.

Text/engine migration requires real export/import capabilities. Import must not
silently re-extract or consolidate history. Failed preparation retains the old
plan. New-input-only replacement or semantic downgrade requires a separate owner
choice, not an automatic fallback. Rollback after new writes also needs change
and deletion reconciliation; it is not merely a pointer change.

Backup/restore covers matching configuration and provider/adapter release,
consistent content snapshot, canonical mappings, dependencies, corrections,
tombstones, binding generation and operation recovery. A projection may be
rebuilt only when that path has been verified. Secrets remain separately secured;
remote version/restore limitations must be reported.

Settings → Plugins exposes discovery/GitHub release details, installed packages,
configuration instances, overall Memory plan, advanced modules and accurate
operation progress. Package-provided dynamic UI is declarative configuration,
status and supported actions, not arbitrary remote executable HTML/React.
Trusted compiled Web contributions keep their existing contracts. Web,
Electron and Android need real consumers and fallbacks; schema-only additions
do not complete the UI. Native capture still requires a native build.

## Supersession audit

| Disposition | Decision and affected assumptions |
| --- | --- |
| KEEP | AI-native semantic interpretation; untrusted captured content; read-only queries; originals/Material, exact citations, scopes, independent review, one ExecutionEngine, cancellation, deletion, retention and measured usage. |
| KEEP | Same-source parallel policies, exact version/fingerprint and draft reuse; installation does not authorize history; readable originals do not wait for Memory. |
| CHANGE | Owner-controlled pause replaces the mandatory continuous-new-input rule and extraction.enabled:true-only behavior in attribution/MVP baseline, lifecycle/settings/intake APIs, UI and tests. |
| CHANGE | Admission state/generation is explicit and separate from saved nonempty composition; ordinary pause drains old authorized queued/running/checkpointed work and necessary authorized children, immediate revocation fences it, resume does not backfill. |
| CHANGE | Trusted local path/env loading evolves into pinned GitHub release, instance and binding lifecycle; current inventory stays an observed capability projection. |
| CHANGE | Memory text repository and retrieval become replaceable; public control metadata retains authority, including external intent/receipt and version visibility. |
| REMOVE | Direct Memory SQL in consumers; install=enabled, disable=delete, empty recipes=pause, external accepted=completed, and inventory=package-manager assumptions; built-in stages duplicated by a selected complete engine. |
| EXCEPTION | Privacy/source revocation, source deletion, immediate stop and invalid evidence block late publication; ordinary drain gives no override. Missing old components remain blocked rather than switching versions. |
| EXCEPTION | Restart may be required; trusted services are not sandboxes; native capabilities require native builds; retained history needs a usable reader after contribution removal; insight/working controls and explicitly authorized manual work remain independent. |
| CHANGE | Pinned Mem0 immutable literal/journal and Hindsight isolated operation/read-bank contracts are implemented and independently tested. Migration covers Mote-retained canonical bodies/states; native audit revisions and engine graphs remain in old instances/runtime backups. |
| UNKNOWN | Arbitrary provider compatibility, private GitHub credentials, verified physical erasure, native audit/graph portability, full semantic/performance matrix and physical-device behavior require separate evidence. |

The new admission control need not reinstate retired source Memory booleans,
empty recipes or legacy epoch adapters. Tests may still reject invalid retired
configuration fields, but must independently prove the new pause journey.

This accepts a target supersession of the continuous-processing portions of
[Material attribution](adr-material-attribution.md) and the true-only extraction
contract in the [MVP baseline](adr-mvp-baseline.md). Their attribution and epoch
decisions remain. [System refactor](adr-system-refactor.md) review, rolling work
packages, read-only capability discovery and single execution authority remain.
[Daily events](adr-daily-event-memory.md) defaults/scopes do not expand implicitly.
[Library plugin contracts](library-plugin-contracts.md) retain consumer dependency
and fallback guarantees. Historical ADRs remain historical; current behavior
documents must only be updated when the corresponding implementation is verified.

## Delivery evidence

Phase one must demonstrate actual Mem0 OSS CRUD/retrieval and Hindsight engine
behavior through real product entry points; mocks alone cannot prove replacement.
Generated fixtures cover deterministic contracts and lifecycle; independent
semantic review covers quality. Real models, external accounts/services, actual
renderers and physical devices are reported separately. No such implementation
or validation is claimed by this plan/prototype change.

The owner permits future live-chain checks to reference the locally running
Central node and specifies local Codex Server with GPT 6.1 Medium when a model is
needed. Implementation, tests, data and reports stay local and must not be
submitted to GitHub. This does not authorize writes to the existing node or
transmission of personal screenshots. The current prototype uses synthetic data.
