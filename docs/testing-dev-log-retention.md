# Diagnostic retention regression journeys

All verification inputs are generated in private temporary directories. Real profile logs are not fixtures. Ordinary focused checks cover the changed logging boundaries; live models, containers, deployed profiles and physical clients are separate evidence.

| User failure prevented | Regression |
| --- | --- |
| Yesterday's error disappears during a trace burst | Separate channel quotas, UTC rollover, restart and a low-priority incoming trace that cannot evict an existing error |
| Capacity reduction silently empties a useful file | Reopen under a smaller budget/segment size, whole-segment expiry and exact survivor byte comparison |
| Central and its supervisor each exceed an independent quota | Concurrent writers share one cleanup/append lock and total budget; the real supervisor records generated stdout/stderr and exit facts |
| An interrupted lock publication blocks startup or a reclaimer steals a live lock | IPC-paused metadata publication, independent module copies, an aged live owner, SIGKILL recovery and 144 complete concurrent Central/supervisor records; unknown legacy locks and linked/corrupt mutexes remain untouched |
| A legacy empty lock is silently removed or actual startup still fails after recovery | Real supervisor and Central entrypoint reject an unknown empty lock without listening, preserve its inode offline, then authenticate, stop and restart on the same generated profile |
| A failure loses the original cause | Original HTTP status / official Codex discriminator / process exit facts survive their provider boundary; failed review metadata survives restart with trace disabled |
| Cleanup deletes data added after preview | Owner HTTP preview, collector rejection, changed-selection 409 and explicit confirmation with exactly the reviewed files |
| Detailed personal content remains in cache after deletion | Memory priority and removal follow segment deletion and expiry; trace recording automatically stops after its persisted deadline |
| Large/malformed files break reads or become silently truncated | Existing 300 MiB sparse boundary, large traces, dense 10,000-event pages, UTF-8 chunk boundaries, malformed tails and untrusted-field filtering remain covered |
| SDK output discloses content or blocks shutdown | Real supervisor fixture keeps 60,000 generated stdout lines and 2,300,000 stderr bytes per restart, private-content suppression, bounded queues, split tail, exit/signal and disk-failure checks |
| A deployment chooses a writer that cannot implement the current policy | CLI/config preflight, capability markers, exact explicit settings, revision/secret preservation and generated upgrade/rollback checks |

Focused entrypoints include `apps/server/test/diagnostics.test.ts`, `diagnostic-log-store.test.ts`, `diagnostic-retention-lock.test.ts`, `diagnostic-retention-startup.test.ts`, `insight-runs.test.ts`, `config.test.ts`, `configuration.test.ts`, the affected Agent provider/protocol files, Web diagnostics tests, `scripts/release/dev-log-retention.test.mjs`, and `node scripts/test-central-runner.mjs`. Inspect `npm run check:affected -- --dry-run` before selecting further checks. Deployment/process journeys and full platform suites retain their normal repository triggers; do not replace missing evidence with a generated fixture result.
