# Central request admission without arbitrary quotas

Date: 2026-10-10

## Decision and user journey

The owner reported a local Central request being rejected as too frequent and
requested removal of request quotas and fixed backlog counts. Normal capture,
sync, browsing, import, login and query activity must not be rejected merely
because it crosses a requests-per-minute or pending-item threshold. Performance
problems should be measured and fixed in the affected path.

Remove `@fastify/rate-limit`, all Central route quotas, the foreground/transport
request classification, and the associated connector route option. Central no
longer imposes these quotas on either authenticated or unauthenticated requests.
Authorization continues to decide whether a request may access an operation.

Remove fixed admission counts for unfinished file/import uploads, pending query
and file-preparation queues, retained import jobs, pending login tickets and
requests, invitations, OAuth attempts, playback grants and original-evidence read
requests. Independent Insight requests can also coexist; their execution is
scheduled through the existing pools. Reusing a request ID retains its existing
idempotency and payload-conflict behavior.

Task concurrency and fair scheduling control actual execution, rather than
rejecting a backlog at an arbitrary count. User-configured storage capacity,
expiration cleanup, transport part sizes, checksums, authorization, cancellation,
shutdown fences and same-conversation consistency continue to apply. Provider
cooldowns reflect actual upstream failures and are separate from local HTTP
frequency controls. Clients retain HTTP 429 recovery for an upstream service or
gateway; it is not a local request-budget feature.

## Supersession check

| Disposition | Responsibility and inspected assumptions |
| --- | --- |
| KEEP | Existing execution pools, concurrency settings, cancellation, restart/checkpoint behavior, authorization, configured storage capacity, upload identities, checksums and upstream failure recovery. |
| CHANGE | Requests and distinct Insight runs are admitted independently of elapsed-time quotas or fixed pending/retained-item counts; performance regressions must be addressed in their actual path. |
| REMOVE | Global and route-specific Fastify limiter configuration/dependency, transport request classification, connector `OwnerRoute.rateLimit`, count-only rejection checks listed above, and the in-process import verifier's limiter wait. |
| EXCEPTION | Structural/protocol payload limits, bounded batches/pages and worker execution concurrency serve transport or processing contracts; they are not removed by this decision. Same-conversation and same-resource consistency checks remain. |
| UNKNOWN | The exact route and deployment revision of the owner's original failure were not captured. Large personal datasets, live model behavior and physical clients have not been validated by generated regressions. |

The initial MVP request quotas and the 0.0.73 foreground/transport quota split are
superseded. Historical release notes and dated validation records retain the
behavior and evidence that applied at the time. Current architecture, import
documentation, troubleshooting, route registration, connector contracts,
diagnostics, Web error mapping and import-verifier assumptions are updated.
Repository agent instructions impose no requirement to retain these quotas.

## Validation

See the [generated journeys and final check results](validation/central-request-admission-2026-10-10.md).
