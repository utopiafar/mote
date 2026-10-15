# Unified YAML configuration and in-process ConfigService

Date: 2026-10-14

Multi-user production supersession: [M04](design/multiuser-configuration.md)
splits instance and private ownership while retaining this ConfigService
transaction contract. The one-owner file and model-copy assumptions below do not
authorize shared credential inheritance or mounting retired global routes.

## Decision and user journey

The owner asked to keep file-based startup and the settings pages, unify ordinary
configuration, and apply most changes without restarting. The final recommendation
in the [shared discussion](https://chatgpt.com/share/6acf21ed-7dfc-83ea-a324-37594e130115)
was verified using Chrome on the owner's computer. This decision implements the
improved C option: one private `mote.yaml`, an in-process `ConfigService`, YAML,
Zod, Chokidar, and the existing Cordis lifecycle. It does not adopt Nacos, Apollo,
or c12. The owner explicitly allowed breaking internal configuration formats at
this MVP stage.

A named CLI profile starts from its YAML file. The settings pages update that
same file; an owner may also edit fields that have no dedicated page. Both paths
validate the same registered domain schemas and use the same transaction queue.
The owner view exposes the saved value, effective value, global revision,
sensitivity, and application policy. Restart or migration fields retain their
current effective values and show the pending change explicitly. Saving a data
directory or a port never moves data or restarts a process.

`MOTE_CONFIG_FILE` selects the file; otherwise the process uses `mote.yaml` in its
working directory. Ordinary configuration is not overridden by ambient env.
Only explicit `${NAME}` references in registered secret fields resolve env
credentials. Unchanged references stay references when the Web saves unrelated
settings. Raw credentials, parser values, and provider error text are excluded
from public configuration errors and configuration projections.

## Responsibilities and transaction

Each module registers its schema, defaults, sensitive fields, and effect policy.
The service owns reading, stable file observation, structural validation,
content comparison, revision/CAS, atomic persistence, safe status, and shutdown.
The domain owns plugin-aware validation, resource preparation, activation,
rollback, and the semantics of existing tasks. Irreversible task cancellation, requeueing, permission-epoch changes and prior-resource retirement run only after the complete transaction commits, so a later domain failure cannot revoke work authorized by the previous configuration. Plugins can register schemas and
handlers through the Cordis `moteConfig` service rather than extend a giant
application schema.

After stable reading and validation, a real diff prepares every affected runtime
candidate before writing. The writer creates a private temporary file, syncs it,
checks the observed file identity again, atomically renames, and syncs the parent
directory. Awaitable resource installation runs first and cannot expose candidate
permissions or admission policy. Every runtime snapshot and derived intake SQL
projection then publishes in one synchronous continuation with the effective
configuration map. Plugins use the same `publish` barrier; published snapshots
must also roll back synchronously. This prevents background work from observing
permissions belonging to a transaction that later fails. A failed preparation keeps the old
saved and effective values. A failed application rolls effective domains back;
the saved candidate remains visible with failed status so the owner can repair
it. An uncertain commit is reported separately and does not silently overwrite
an unknown file state.

Web commands include the last global revision. A file edit must preserve the
revision it read: the service advances it after accepting a real change. A stale
Web command or file revision conflicts. Equivalent content is deduplicated,
including object key order; the writer's own watcher event does not trigger
another save. The watcher observes the parent directory, handles atomic file
replacement, waits for stable writes, and drains with the application lifecycle.
An invalid file during operation leaves the last effective values in use and
reports a fixed error; invalid startup configuration stops startup.

## Implemented application boundaries

| Domain | Application policy |
| --- | --- |
| `models.deployment`, `profiles`, feature defaults and model overrides | Prepare a registry; new requests use the new generation. Existing requests retain their old runtime and snapshot. |
| Execution concurrency | Next admission; lowering a limit never kills work already admitted. |
| Diagnostics enabled/debug/trace/level | Immediately reconfigure the existing writer. Log directory and size/count bounds require restart. |
| Connector sync interval | Reconfigure scheduling. Connector modules, credentials, MCP access and OAuth transport require restart. |
| `processing.settings` and `processing.policy` | Plugin-aware validation, relevant task fingerprints, revocation and fences; existing completed results require explicit reprocessing. |
| `perception` | Apply image permissions and behavior through the domain; concurrency affects later admission. OCR endpoint and profile are derived from `processing.policy`. Coupled image-page changes commit both domains atomically. |
| `workflows` ordinary DAG lanes | File authority for concurrency/enabled; later admission uses new capacity, disabled lanes fence older in-flight publication. |
| `actions.enabled/timeZone` | Runtime application; review-device authorization remains in the database and cannot be granted by YAML. |
| `memory` runtime schedule/budget | New admission windows use the new settings; active windows retain their pinned settings. |
| Media workers, server listener, update transport, module loading, Codex executable/login path, embedding transport | Restart required. |
| Storage write-encryption toggle | Immediately changes subsequent writes; existing representations remain readable. |
| Storage root and encryption key | Migration required; the configuration service does not move or decrypt data. Other storage boot options require restart in this implementation. |

Managed media settings are an effective startup snapshot. Changing the managed
OCR/ASR endpoint cannot silently reinterpret saved processing services or send a
worker token to another destination. The media directory, Python executable,
ports, endpoints and token are therefore restart fields. Separately configured
processing services continue to use their existing runtime policy behavior.

## Supersession check

| Disposition | Responsibility and inspected assumptions |
| --- | --- |
| KEEP | Named profile isolation; file startup; settings navigation and draft editing; private credentials and owner authorization; model preset routing and credential reuse rules; prepared model swaps; in-flight snapshots; concurrency fairness; task fingerprints; SQL intake ordering; immutable Memory bindings, strategy versions, receipt grants and history; original data and jobs. |
| CHANGE | CLI, Docker, direct startup and Web commands use one YAML document. Configuration metadata and defaults come from registration. File edits and Web commands share validation, preparation, revision and apply policy. Current file/image processing and Memory runtime settings are YAML domains. |
| REMOVE | Ordinary env/file overlay, `mote.env` startup authority, `model-settings.json` and `file-processing.json` authority, SQLite runtime/diagnostic/perception/lifecycle/workflow and ordinary Action settings authority, deployment env-fragment downloads, and direct media env reads in server domains. Old files and rows are not deleted or migrated automatically. |
| EXCEPTION | SQLite effective projections used by intake triggers are derived from YAML and are rebuilt at startup/apply. They are not configuration sources. Business data, jobs, receipt policy snapshots, plugin/source instances, installed package state, authorization, immutable strategy bindings and device-local privacy/capture settings remain domain storage. `profile.json` retains CLI deployment lifecycle selection; tunnel credentials retain their private secret file. |
| UNKNOWN | Actual production migration, physical-device journeys, real provider requests, and Docker daemon/container runtime checks are separate acceptance work. Generated tests do not establish those outcomes. General zero-downtime rebinding of listeners, storage, worker processes, embedding or module installation is not implemented. |

This supersedes current multi-source configuration descriptions in the
[server reference](server-configuration.md),
[configuration ownership](configuration-ownership.md), model-provider setup, and
deployment/development guides. Existing storage epochs and the
[MVP baseline](adr-mvp-baseline.md) are not bumped by this change. Historical
release notes and dated validation records describe their original versions and
remain historical evidence.

### Integration with DEV retention and Ask evidence decisions

The 2026-10-15 integration preserves the [DEV retention decision](adr-dev-log-retention.md):
omitted `diagnostics.maxBytes` selects 100 MiB for DEV and 2 MiB elsewhere;
explicit numeric values remain explicit, with a 100 MiB DEV ceiling and an
8 MiB ceiling elsewhere. File and event counts keep their existing limits.
The deliberate CLI default-adoption command now edits YAML with revision/CAS
and still requires a normal restart. The legacy env-based adoption path is
superseded by the single-file authority above. Server startup, CLI preflight and
the native supervisor share the same profile-aware capacity resolver.
The saved document preserves omission through watcher reloads and unrelated
settings saves; the diagnostics domain resolves its effective capacity against
the same document's profile. Incremental saves merge into raw domain values so
derived defaults and credential references do not become explicit settings.
Explicit values equal to the default remain explicit. Whole-domain replacement
continues to honor every value supplied by the editor.

The [Ask evidence decision](adr-ask-evidence-quality-and-simple-context.md)
continues to remove estimated evidence-reading quotas and automatic capacity
halving. YAML runtime settings do not reintroduce those heuristics. Complete
lineage, read grants, metadata revalidation, in-flight snapshots, operation usage
and typed Memory recovery remain enforced through the combined lifecycle.
The R5 UI retains the existing settings navigation and presents the global
configuration revision and saved/effective metadata in those pages.

## Compatibility and validation

The old configuration formats are intentionally unsupported as active sources.
Before an upgrade, preserve private configuration and credential backups and
prepare `mote.yaml` offline. Re-enter or copy the desired values explicitly;
there is no automatic database reset, data deletion, profile migration, restart,
or deployment. Existing task authorization is not expanded by a configuration
change. Downgrading requires a compatible separate configuration backup.

Generated regressions cover file authority, stale revisions, file replacement,
invalid input, no-op/self-write deduplication, prepare/apply faults, model request
snapshots, concurrency, domain revocation, old source exclusion, secret
redaction, and lifecycle cleanup. Domain-specific evidence includes
`config-service.test.ts`, `runtime-config.test.ts`,
`processing-config-service.test.ts`, `media-configuration.test.ts`,
`file-config-snapshot.test.ts`, `memory-configuration.test.ts`, and the existing
model/processing/permission journeys. Final executed commands and remaining
limitations are reported with the PR; this ADR does not label unexecuted live or
container checks as passed.
