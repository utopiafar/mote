# Diagnostic severity and retention

Date: 2026-11-11. Status: accepted by the owner. This decision replaces the shared three-file retention policy formerly documented here.

Detailed Agent traffic previously shared the same rotating files as errors. A full file or UTC date boundary advanced the three-file ring, so a short trace burst could remove the only explanation of a failed task. Increasing file size did not establish a useful retention period.

Central now writes one current NDJSON segment format, separated into `error`, `warn`, `info`, `debug` and `trace`. The native supervisor uses the same storage module and directory budget. A file reaching its size limit or crossing a UTC date closes that segment; neither event independently deletes history. File counts do not determine retention.

| Channel | Target age | Disk budget |
| --- | --- | --- |
| error | 30 days | 128 MiB |
| warn | 14 days | 64 MiB |
| info | 7 days | 256 MiB |
| debug | 48 hours | 128 MiB |
| trace | 24 hours | 1 GiB |

All profiles default to 16 MiB segments, a 2 GiB total log budget, 2000 in-memory events, and disabled debug/trace capture. Explicit per-segment capacities remain explicit, up to 100 MiB. These are age targets under finite quotas, not guaranteed minimum durations. Diagnostics shows each channel's actual oldest/newest timestamps, bytes, limits and the latest cleanup cause.

Cleanup removes expired segments, then the oldest segments exceeding their own channel budget. Total pressure removes trace, debug, info, warn and error, in that order. A lower-priority incoming event cannot evict a higher-priority retained event; it is dropped and counted when it cannot fit. Central and the supervisor coordinate append/cleanup with one short filesystem lock. Append handles close before another writer can delete their files. Smaller configuration never truncates surviving files. Unknown files are not read or deleted as an old format; existing log/temporary file bytes still count against the total budget. Preserve needed historical files before explicitly removing them offline.

Free disk below 1 GiB stops additional trace/debug capture and clears those low-priority segments. Directory metadata has a small reserved margin in the total budget. Closed segments are immutable between coordinated appends; reads use a bounded descriptor snapshot and do not hold the write lock while scanning. In-memory history gives errors priority and withdraws records whose segment was deleted or whose age expired. File ownership and 0600/0700 protection remain in force.

Manual cleanup previews exact filenames, sizes and time ranges. Confirmation rechecks the complete selection under the writer lock; changed selected files produce 409 before any deletion. Trace-only cleanup preserves ordinary logs. Disabling capture does not manually delete historical content. Cleanup remains owner-only and cannot delete unrelated originals or follow symlinks.

Detailed recording requires explicit activation, receives a persisted 24-hour expiry, and stops after that deadline even across restart. Initial context may contain personal content; repeated large prompt strings on model/query-start events become lengths and hashes rather than duplicate bodies. Safe support exports continue to exclude trace bodies. Keys, URLs, provider messages, stderr and arbitrary exception stacks never become ordinary diagnostic fields.

Failure classification and recovery behavior are unchanged. Normal errors and existing task receipts retain additional allowlisted facts at the original transport boundary: HTTP status, official Codex discriminant, process exit/signal, known transport error, model identifier and execution stage when supplied. Missing underlying causes remain explicitly unknown. Task summaries follow the task's existing lifecycle and do not depend on the trace toggle or log-file rotation. No execution, delegation, authorization or model-output contract is added.
