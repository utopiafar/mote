# ADR: Retain Memory when derived context caches change

> **状态：历史。** 本文记录当时的决定与验证范围，不再描述当前实现；当前设计见 [Memory 当前设计](memory-current-design.md)。

Date: 2026-10-17

## Decision and scope

An archive artifact is a replaceable interpretation cache. Removing or replacing
it withdraws dependent extraction checkpoints and marks dependent Memory
`stale` with `evidence_changed`; it does not erase the Memory statement or its
direct original-evidence lineage. Default Memory discovery already excludes stale
cards. This applies to direct replacement, source revision invalidation and
recursive parent/Material artifact invalidation.

An exact immutable artifact replay is a no-op after current original
fingerprints, parent revisions and Material inputs pass the existing checks.
Equality includes output text, metadata, revision, processor/configuration,
scope, group, members, representatives and lineage. Only `generatedAt` is
excluded. The original timestamp, descendants, Memory status, checkpoints and
artifact-ready journal remain unchanged. Equal text with a changed revision or
contract still invalidates conservatively. Equality does not use a model or a
handwritten semantic classifier.

Opening an existing vault replaces the old artifact deletion trigger. The
migration cannot recover statements already deleted by earlier versions. No
artifact rebuild automatically republishes stale Memory or creates authorized
historical model work.

Artifact removal also invokes the existing conversation invalidation lifecycle
before its lineage is removed, in the same SQLite statement. Dependent answers
remain visible as historical dialogue; their summaries and frozen model snapshots
are withdrawn. This covers replacement, eviction and recursive parent cascades.
Exact immutable replay does not invoke that lifecycle.

The lifecycle is stored as SQL, including conversation revisions, summary
withdrawal and existing operational-product cleanup. Optional schema owners
refresh the trigger after their tables are installed; replacement uses a
savepoint and preserves the caller's transaction. Offline backup/update writers
therefore inherit the same behavior without registering host JavaScript
functions. Startup replaces the earlier connection-local callback trigger.

## Supersession check

| Status | Responsibility |
| --- | --- |
| KEEP | Direct original dependencies, current evidence checks, checkpoint withdrawal on changed interpretations, default stale-card exclusion, independent extraction/review and existing job admission. |
| CHANGE | The archive artifact deletion trigger retains dependent cards as stale instead of deleting them; exact immutable replay preserves the existing graph. |
| REMOVE | Cache eviction as an implicit destructive Memory deletion operation; delete/reinsert churn for an identical artifact. |
| EXCEPTION | Original evidence deletion/retention, explicit source forgetting and owner Memory deletion retain their existing privacy and deletion behavior. |
| UNKNOWN | Historical statements already erased cannot be reconstructed safely. Semantic-equivalence decisions and finer upstream invalidation require separate work. |

This narrows the cache behavior retained by the
[system refactor](adr-system-refactor.md) and clarifies
[Memory lifecycle](memory-lifecycle.md). It preserves the
[range-evaluation](adr-memory-range-evaluation.md) admission and generation
contracts. No prompt, recipe, public API, UI, native client or scheduler policy
changes. Existing stale rendering and read filtering remain authoritative.

## Regression journeys

`apps/server/test/context-artifact-memory-retention.test.ts` creates and reviews
Memory through the real Memory pipeline with generated originals and a scripted
model. It verifies the runtime artifact dependency registration before exercising:

- Identical replay preserves a published card, its checkpoints, descendants and
  artifact journal; retrying the completed job does not invoke another model.
  Valid mixed-case original UUIDs use the same binary input ordering as SQLite.
- Invalid input fingerprints are rejected before a replay can reuse an artifact.
- Changed output, source revision and parent cascade retain the old statement as
  stale, remove checkpoints and keep it out of ordinary discovery.
- Restart preserves stale state; deleting the original still erases the card.
- Startup replaces a legacy destructive trigger in an existing database.

`apps/server/test/evidence-cache-history-integration.test.ts` adds generated
loopback HTTP/SQLite journeys for the joint conversation lifecycle: equal replay,
replacement/eviction/parent cascade, restart and referential follow-up, late model
and summary rejection, and later destructive original deletion.

These fixtures verify host lifecycle enforcement. They do not verify real-model
semantic accuracy or external provider behavior.
