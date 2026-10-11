# ADR: Archive admission and retired client processing cleanup

Status: Accepted by the owner, 2026-10-11.

The owner requested fixing the P1/P2 archive audit findings, removing retired local
file interpretation and lightweight indexing, updating documentation and opening
a validated PR. The implementation uses the existing architecture, with no new
compatibility layer, count quota or shared-service circuit breaker.

## Responsibilities and journeys

Sources identify provenance and observation scope. Their cumulative count does
not control admission. Completed one-time imports retain their identity without
using up a lifetime allowance. Central source registration looks up the existing
identity directly instead of deserializing the entire source catalogue.

Memory corrections continue to append immutable owner evidence and a replacement
Memory in one transaction. Published, stale and superseded history do not impose
a cumulative Memory count limit. Portable import applies the same storage and
authorization boundaries, without reinstating lifetime source or Memory quotas.
Its source, Memory and Memory-deletion metadata sections accept the product's own
current-format exports beyond the removed count thresholds, within existing byte
and schema validation boundaries.

Pairing retains serialized, atomic credential replacement and revocation history.
Revoked credentials do not impose a lifetime pairing count. The existing private
credential file byte capacity and reserved revocation space remain; no new
credential history store or upgrade reader is introduced.

ProviderAdmission shares actual upstream HTTP 429 limits and recognized transient
Retry-After signals. Without Retry-After, a timeout, network or unavailable failure
remains with that task's existing recovery policy. This does not add a new global
failure counter, probe or retry loop. ExecutionEngine still owns durable retries,
and existing fair concurrency gates still control execution.

Coding source scanning reads complete JSONL events across read chunks, then yields
between bounded output pieces. The existing checkpoint persists the event hash
and next piece with the outbox until that event is fully staged; only then does the
byte cursor advance. Restart verifies the same immutable event version. Identity
includes native identity and raw-event hash, independent of scan scheduling. A
changed partial event cannot mix versions. Partial, malformed or cancelled input
does not advance the committed cursor. Cancellation reaches the scanner through
the existing worker channel; synchronous JSON decoding remains non-interruptible.
No raw partial content or separate processing queue is persisted. The scan budget
does not reject a large event or strand later dialogue behind the cache capacity.

Native source hosts retain discovery, privacy, immutable staging and transport.
They have no local file interpretation workers, fake processing queue APIs or
lightweight-index setting. Android's snapshot metadata describes the input for
central processing; it does not decode its contents. Existing unknown-key parsing
does not acquire a new legacy adapter. Desktop rejects the retired `indexMode`
field at its existing current-format boundary before source work starts. This
preserves the old files and pending originals rather than silently resetting their
privacy fingerprint. There is no migration, dual reader or placeholder old policy
field. Current-format restart and explicit owner policy edits retain their usual
queue and authorization behavior.

Central still publishes `fileIndex.coverage: lightweight` for actual partial
extraction or a bounded text projection. That current coverage contract, its UI
label and its restrictions on claiming unseen text remain. Retiring the native
indexing preference does not make a partial central result complete evidence.

## Supersession check

| Disposition | Responsibility and inspected assumptions |
| --- | --- |
| KEEP | Current storage/ingress contracts, atomic ACKs, immutable revisions, owner corrections, revocation, privacy consent, `allowRead`, byte capacity, structural payload bounds, scheduling and task-local retries. |
| CHANGE | Archive and pairing admission no longer depend on lifetime source, Memory or credential counts; scanner scheduling and durable progress yield between event pieces; shared provider cooling requires an upstream limit signal. |
| REMOVE | Central 500-source and 100,000-Memory gates, portable cumulative gates, credential 500-count gates, client 20/40-source gates, synthetic service-wide cooldown for a single unsignalled transient failure, retired local parser workers/APIs/journal fields, lightweight-index controls and obsolete tests/smoke scripts. |
| EXCEPTION | Existing protocol pages, per-payload sizes and actual execution/cache capacity remain. HTTP 429 without Retry-After retains its bounded upstream recovery. Current Central partial-extraction coverage, OS/provider capabilities and explicitly supported page-fields modes remain. |
| UNKNOWN | Physical-device permissions, OEM background behavior, live model quality and production-scale memory/resource costs require separate validation. Complete event JSON decoding still holds one event in memory. |

This extends [Central admission](adr-central-request-admission.md) and the
[action-first client lifecycle](adr-client-action-first.md), and completes the
retired endpoint-processing cleanup in the [single MVP baseline](adr-mvp-baseline.md)
and [upload/processing contract](upload-processing-decoupling.md). Historical
release and validation records retain their original evidence. Current guides,
configuration, journals, tests and caller assumptions are updated together.

Generated journey coverage and executed checks are recorded in
[the validation report](validation/archive-admission-cleanup-2026-10-11.md).
