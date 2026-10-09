# ADR: Single MVP baseline without upgrade adapters

Status: Accepted, 2026-10-09. Owner approved the cleanup, validation, PR and merge.

Mote uses one current implementation and persisted format. There is no installed-version transition period, old reader, dual write or startup migration. Central storage is epoch **4** (`backend_epoch` and SQLite `user_version`); Desktop and Android local storage remain format **3**. Wire protocol **1**, collector Ingress **2** and portable archive **2** are independent contracts, not product versions.

A populated Central vault from another epoch is rejected before schema installation. Existing data is retained. Start with a new empty directory, or stop the service, preserve a backup and explicitly reset the selected vault. This change does not reset any user's directory. Same-epoch backup/restore and current-format portable import remain supported.

## Supersession

| Disposition | Decision |
| --- | --- |
| KEEP | Stable receipt identities, source versions, immutable originals, read-only evidence tools, privacy grants, deletion and retention |
| KEEP | Current leases, interruption recovery, cancellation, provider Retry-After, checkpoints, configuration fingerprints and usage/price accounting |
| CHANGE | Fresh startup installs the final schema, image OCR default and intake/index triggers before inputs arrive; removed configuration fields are rejected |
| REMOVE | Daily-budget retirement/revival, image-policy migration and historical image-input reconstruction, snapshot receipt repair, Activity/dependency backfills |
| REMOVE | Old automatic-Memory-off cutover, ignored source Memory boolean, pre-upgrade waits on unhanded proposal units |
| REMOVE | Closure-based QueryRuns facade/fallback, endpoint file-interpretation queues, dormant Qwen workspace, launchers, manifests and download/setup scripts |
| REMOVE | Empty Memory selection fallback, built-in personal/Coding v1 recipe/review registrations, old source-item/authored organizer version recognition, transcript@1, audio-dialogue@1 and align@1; current transcript@2 serves all media |
| REMOVE | Old blob-directory creation, statistics and GC paths; current originals use `files/objects` |
| EXCEPTION | User-requested current-format queue relocation, historical recompute and image backfill are current features |
| EXCEPTION | Central `.plain`/`.aes` mixed storage and encryption-policy changes are current supported states, not version compatibility |
| EXCEPTION | Protocol/capability validation, provider/plugin contracts and signature/install checks continue to enforce current boundaries |
| UNKNOWN | Physical-device and live-model behavior requires separate validation; fixture checks do not establish either |

This supersedes upgrade instructions in the 2026-10-04 compatibility audit, the budget retirement section in `processing-throughput.md`, and the pre-upgrade wait repair in the proposal lifecycle decision/validation documents. Those dated records retain their historical evidence. Current operation is described by [architecture](architecture.md), [source pipelines](source-pipelines.md), [deployment](deployment.md) and the [cleanup audit](audits/mvp-baseline-cleanup-2026-10-09.md).

Question requests use DelegatedQueryRuns and the durable delegation journal. No callback closure can substitute for a missing journal. Completed plans and model children resume through their existing identities; an invalid proposal wait is not synthesized or repaired. A current product-owned proposal must be handed to its product before execution can be awaited.

Automatic Memory receipt authorization remains continuous. `extraction.enabled` accepts only `true`; source configuration has no `memory` boolean. Separate processing lanes and integration/insight/working controls retain their current meanings. Privacy withdrawal and missing authorization still prevent model work.
