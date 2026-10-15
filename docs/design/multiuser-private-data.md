# M02 private data and index contract

M02 depends on M00 `5031b754915d3fbba0dbe0c050b6d103a02966ef`. It restores
account-scoped source metadata, source descriptions, capture and source-item
reads, immutable Material versions, exact input dependencies, statistics and
lexical search in the production `buildScopedApp` composition. It does not
initialize accounts or introduce another identity system.

## Host and authentication integration

`registerPrivateData(runtime, storage.db)` installs the domain on the admitted
epoch-5 shared SQLite connection and registers `private-data` with
`ScopedServices`. The registrar uses `registerUserRoute`; identity always comes
from the host's `UserContextAuthority`, never an owner selected by an HTTP body,
header, query parameter, saved cursor or upstream document.

M01 owns account tables, password verification, Cookie/CSRF and the HTTP resolver.
The registrar derives its runtime type from `registerUserRoute`, retaining the
M00/M01-compatible signature. When combining the independently developed M01
and M02 branches, pass M01's **complete `runtime`**, including its `accounts`
field, into the registrar so Cookie and CSRF checks run on data routes. Retain
M01's authentication registration and error mappings; additionally map
`PrivateDataError` to its generic error code/status. Health must advertise the
delivered `private-data` domain while leaving other private capabilities closed.
Neither module changes the integration branch or merges its prerequisite PR.

Repositories are obtained through:

```ts
const data = services.forUser(context).get<PrivateData>('private-data');
```

`PrivateData` never exposes a connection, prepared statement or user selector.
The SQL gateway supplies the captured owner binding and revalidates authority
before every statement, transaction and commit. Synchronous transactions contain
no model calls or asynchronous work. Nested host transactions use savepoints.
M05 must reconstruct a host-authorized account context from its durable grant;
persisting a Web session context would incorrectly bind tasks to logout.

## Persisted ownership and exact dependencies

`pd_sources`, `pd_source_contexts`, `pd_captures`, `pd_source_heads`,
`pd_materials`, `pd_material_versions`, `pd_material_captures`,
`pd_material_inputs`, `pd_material_contexts` and `pd_material_sources` are private.
Their primary/unique keys and parent references include `user_id`. A/B may share
source IDs, device IDs, capture UUIDs, external IDs, source revisions, Material
IDs, Material revisions and identical bytes without sharing a private row.
There is no parallel account directory or foreign key to an unfinished M01 table.

Sources reuse the shared source schema. Revision intake is immutable: replay of
the same semantic content returns the same receipt; changed content under the
same source/external/revision conflicts. A batch and its current pointers/index
updates commit together. Capture deletion removes dependent Material content and
its descendants in that same user's archive. Source deletion additionally removes
source descriptions and all transitive Material dependencies.

Material values reuse the existing schema extracted into
`scope/material-model.ts`; the quarantined legacy implementation imports the same
contract. Publication validates local capture members and exact current Material
references before committing. Source-description pins and host attribution are
normalized before calculating the immutable revision. Semantic prose is never
used as an authorization decision.

Source description and owner-relation edits reissue existing visible Material
content in dependency order, preserving processed text and the user's correction.
They advance `min_visible_sequence`, so old attribution versions cannot be read
as current evidence. A Material correction updates block-level attribution too.
Ordinary upstream changes hide stale dependents while retaining their canonical
drafts, history and corrections for an authorized rebuild; hidden versions are
excluded from details, lists, counts and search. Physical privacy deletion removes
that content rather than merely hiding it. Rebuilds retain the stable Material
identity, sequence and saved correction, and require current input references.

`pd_meta` is instance metadata containing domain version 1 and a random cursor
signing key. Installing the schema does not authorize opening an old vault:
M00's admission gate still rejects unsupported/inconsistent directories before
any schema, permission, sidecar or configuration writes. No owner assignment,
automatic compatibility migration or directory reset is performed.

## Restored HTTP and host capabilities

| Surface | Delivered behavior |
| --- | --- |
| `/api/sources`, `/api/sources/:id` | Own source registration, list/detail, metadata update and deletion. |
| `/api/sources/:id/context` | Exact description history and optimistic version update. |
| `/api/source-items`, `/api/sources/:id/items`, `/item`, `/history` | Own current items/history; planned calendar interval overlap and document content-time filtering. |
| `/api/captures`, `/api/captures/:id` | Own paged captures, detail and privacy deletion. |
| `/api/materials`, `/api/materials/:id`, `/read`, `/members`, `/revisions/:revision`, `/context` | Own visible versions, text ranges/spans, members, optimistic attribution correction and deletion. |
| `/api/layers`, `/api/data/statistics` | Own source/capture/visible-Material counts. No counts from unfinished Memory domains. |
| `/api/data/search` | Own current capture/Material lexical candidates. |

Foreign and absent private IDs have the same generic `404` result. Signed cursors
bind deployment, user, collection and filters; another account's or another
query's cursor is invalid. The signing key is durable across process restart.
FTS applies owner and current-head visibility inside a materialized candidate CTE
before sorting/limiting. It does not use global BM25 corpus statistics. Short CJK
queries use a substring predicate inside that same boundary. M07 may rerank or
send to a model only the returned scoped candidates.

`receiveCaptures`, `receiveSourceItems` and `publishMaterial` are actual host
service methods for later M03/M05/M06 adapters. They have no intake/publication
HTTP endpoint in M02. Images/assets, archive-retention intake, unsupported member
kinds, import/owner question declarations and aggregate Material declaration
resolvers fail closed pending their owner modules. Ordinary source snapshots and
text Material storage work now. Original files, Coding archive processing,
workers, Memory, Ask, connectors, MCP, downloads and plugin runtime remain closed;
M02 does not mount the old single-owner composition to make them appear usable.

## Domain lifecycle and architecture checks

The `private-data` `DomainLifecycle` implements version-1 canonical export,
transactional deletion and exact restore. Payload coverage names all ten private
tables and explicitly excludes assets, credentials and other domains. FTS is
rebuilt by the canonical-row triggers. This domain envelope is not a claim that
the M16 portable-3 archive or a single-user point-in-time restore is available.

Export reads one consistent transaction. Restore checks the strict envelope,
canonical JSON/schema, source fingerprints, Material hashes, visibility floors,
complete reference sets and exact dependency graph before writing. It accepts an
empty domain or an identical complete retry; a conflicting nonempty domain fails.
History retains exact old references, while current visible versions must pass
current input and source-context checks. Failure rolls back rows and FTS together.
Deletion is idempotent and touches only its subject's canonical rows and index
entries. Its complete receipt covers those registered records; it does not claim
forensic erasure of shared SQLite pages or storage media. M16 owns instance-level
backup/media maintenance and the final deletion report.

`ScopedServices.assertSubject` lets the gateway revalidate a user or a
purpose/domain-limited `LifecycleContext` at commit. The production builder accepts
the existing optional `lifecycleAuthority`; M16 supplies durable grants and may
clean up a disabled account without restoring its ordinary private access.

The inventory declares every new table and concrete route. The private SQL check
also scans production files using the new tables/gateway, rejecting direct
connection bypasses and statements missing the host owner predicate/binding.
Only the exact schema installer and SQL gateway are exceptions. This static check
is a change detector; composite constraints and executable A/B journeys establish
the actual data boundary.

Supersession: KEEP immutable originals, source revisions, exact dependencies,
Material value schemas and control-plane corrections. CHANGE global private SQL
to host-bound repositories and composite ownership. REMOVE implicit/default
owners and old-format backfills. EXCEPTION schema installation owns instance
metadata and FTS triggers. UNKNOWN real model/provider, native UI and final
combined-module behavior until their own acceptance runs.
