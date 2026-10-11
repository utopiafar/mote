# ADR: Central file evidence expansion

Status: Accepted within the owner's retired local-processing cleanup, 2026-10-11.

PR #95 retired client file interpretation. Its second review found an unused
Desktop read helper and a Central device request queue without a current client
consumer. The current upload/processing contract already assigns file decoding
and retained text to Central. This completes that responsibility boundary.

File evidence expansion reads the expected immutable version from text already
retained by Central. It creates the existing bounded excerpt and dependency link,
subject to current source, scope, retention, revision and `allowRead` checks. If
text is unavailable, the read returns immediately with its known location and
reason. It does not create work for an offline device. Reference-only sources
remain metadata-only.

| Disposition | Responsibility and inspected assumptions |
| --- | --- |
| KEEP | Central retained text, excerpt identity and dependency links, source ownership, scope, current revision, retention, `allowRead`, deletion propagation, immutable uploads and recovery. |
| CHANGE | Missing Central text returns directly; Agent instructions accurately identify Central as the text host. Login restart fixtures use the managed upload path used by the Desktop app. |
| REMOVE | Device read-request routes, pending/completion queue, timeout polling, shared request/result schemas, Desktop local read helper/interface/location map and obsolete device-response fixtures. |
| EXCEPTION | Existing excerpt bounds remain. Historical database files may contain an unused request table; no new migration or compatibility reader is introduced. `file_evidence_links` remains in use for current dependency tracking. |
| UNKNOWN | Physical device lifecycle and live model behavior are not established by generated fixtures. |

This supersedes device read-request assumptions in the current implementation backlog and
evidence reader guide. It completes the [archive cleanup](adr-archive-admission-cleanup.md)
and follows the [upload/processing contract](upload-processing-decoupling.md).
Historical validation reports retain their original results. Executed validation
is recorded in [the cleanup report](validation/file-evidence-cleanup-2026-10-11.md).
