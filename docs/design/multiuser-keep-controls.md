# Instance controls, index maintenance and split Files export

This finite increment starts at M13's declared
`4ac9604a290701b731cbbb7b5d1775b8af13d782`. The PR target remains
`codex/mote-multiuser-integration`, whose remote baseline is
`6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`. It does not select subsequent
M13 or Joint WIP. The parent explicitly assigned these three remaining KEEP
entries to an independent workspace; M13 and the final union still own their
complete consumer acceptance.

## Supersession

KEEP the four execution values, persisted revisions, immediate diagnostic
preferences, explicit index repair, and distinct metadata/data exports. CHANGE
instance writes and maintenance to administrator control; split exports remain
bound to the authenticated archive owner. REMOVE the scoped Web placeholders
and disabled split-export buttons. EXCEPTION: instance administration permits
fixed index maintenance and safe operational metadata, never impersonation,
private-content browsing or global detailed traces. UNKNOWN: physical devices,
live providers, and the final composed platform gate require separate evidence.

This extends the [multi-user ADR](../adr-multiuser-scope.md),
[M04 configuration](multiuser-configuration.md),
[M05 execution](multiuser-execution.md) and
[M16 lifecycle](../validation/multiuser-m16-lifecycle.md) contracts. It supersedes
M04's statement that only the models instance domain has an online editor, for
the exact execution and diagnostic fields below. Other deployment settings keep
their startup/restart contracts. Personal trace opt-in remains in M04's existing
`agentTrace` domain.

## Administrator runtime preferences

The original `RuntimeSettings` controls are reachable from the existing account
administration area. Ordinary users receive no instance editor.

| Route | Contract |
| --- | --- |
| GET/PUT `/api/admin/execution-settings` | `interactiveConcurrency`, `agentConcurrency`, `llmConcurrency`, `memoryConcurrency`, and the current instance `revision`. Read also returns safe gate occupancy. PUT uses the original schema and the existing ConfigService update queue/CAS. |
| GET/PUT `/api/admin/diagnostics-settings` | `enabled`, `debug`, `level`, `traceEnabled:false`, and instance `revision`. A true instance trace flag is rejected. No directory, credential, account selector or private trace is exposed. |

The M05 adapter invokes the original `ConcurrencyGate` around actual model-call
handlers. Interactive Ask/compaction uses its independent gate; background
Agent/model loops and Memory model batches use their existing named limits.
This adds no durable queue or scheduling engine. M05 still owns task admission,
leases, cancellation, unknown external facts, recovery and fenced publication.
Lowering a limit leaves issued physical work occupying its slot until it settles.
Waiting gate entries observe cancellation. Gate fairness uses the stable owner
identity and does not permit a caller-supplied owner.

The M16 instance diagnostic writer supplies its existing
prepare/apply/publish/rollback handler to the same ConfigService domain. It always
forces private tracing off. Enabled/debug/level changes affect that actual sink;
retention and directory settings retain their existing restart rules. Both API
writes recheck administrator authority inside the ConfigService transaction,
including after asynchronous preparation, and survive restart in the same YAML.

## Shared lexical index maintenance

GET `/api/admin/index` returns the actual scoped index mode and the latest
maintenance task's finite ID, operation UUID, state, attempts and safe error code.
POST `/api/admin/index/rebuild` requires `{operationId:<UUID>}`. Repeating that
exact current administrator operation returns the same M05 task. POST
`/api/admin/index/:id/cancel` controls only the fixed maintenance kind.

The task uses the existing M05 journal, durable grant and shared resource lock.
It does not restore an administrator context. The host checks the admitted
administrator's enabled account and exact authorization epoch again at execution
and commit. One fenced SQLite transaction replaces only `pd_fts` from its
canonical M02 captures/materials. The fixed maintenance SQL lives beside the
existing index schema/triggers; the private SQL checker gains no general bypass.
It retains owner-qualified keys and checks live source/head, excluded/deleted
captures, attachment lineage, material visibility/dependency sources and enabled
accounts at publication. It stages no private content across an await.

The current scoped producer is M02's lexical index (`mode:text`). An old global
embedding configuration is not a scoped vector producer; this increment does
not mount the legacy Store/Indexer or advertise hybrid/vector retry as restored.
No provider call or external-result acknowledgement is part of this deterministic
maintenance operation. Cancelled or revoked work cannot publish; restart can
resume accepted current work and repeated operations cannot duplicate it.

## Owner split Files export

GET `/api/files/export` requires all three explicit query fields:

- `mode=metadata|data` selects the two original export controls.
- `type` uses the existing MIME pattern schema, including explicit `*/*`.
- `selection=current|history` selects current heads or retained authorized
  versions, with a per-entry `current` flag.

Both modes return a bounded gzip/USTAR archive with `metadata.json`. Its manifest
is `mote-files-export` version 1 and describes original hashes, byte sizes, MIME,
capture/source identities, generation, safe archive member names and declared
attachment relationships. Metadata mode opens no original or attachment byte
reader. Data mode adds the exact M03 originals and declared, linked attachment
objects, with MIME selection applied to each exported object. Missing snapshot
bytes fail explicitly; the server does not invent or silently omit them.

Selection covers the complete matching set, beyond a normal Files page. The
existing instance export byte bound applies. This is an original Files export,
not portable recovery or instance backup. Processing products are explicitly
outside its manifest coverage. In particular, it neither replaces nor modifies
PR151's separately typed image-product/current-history contract.

The existing TAR helper now accepts lazy, fixed-size chunk entries as well as
its original buffers. Each original chunk is read through M03 only after
response hooks and current-authority checks. Existing owner/source/head,
attachment relationship, file incarnation and account/session fences are checked
again before each private output block. Account/session authority is asserted
every time. A host-only SQLite token avoids reopening an unchanged full set: any
same-connection write or other-connection commit requires a fresh complete
selection/incarnation proof and a stable token before output continues. The
initial captured set and proof are also bracketed by token checks. The token
is neither stored nor returned by user services. Retirement or a changed selection aborts
the stream; it cannot leave a successful completed download. There is no new
export store, background export job, host path selector or download grant.

The original storage page mounts the two controls with explicit type/version
choices. Its controller aborts on cancellation, unmount and account replacement;
late A controls cannot issue requests through B. Index operation UUIDs remain
owner-qualified in local storage for exact lost-ACK retry after remount. Invalid
local intents fail closed. Valid pending or malformed intents can be explicitly
removed locally; removal sends no submission or cancellation. Accepted server
work remains visible through the existing safe status.
