# Combined upgrade and restore fixture

The focused fixture in `apps/server/test/combined-backup-recovery.test.ts` invokes the production backup script and `restoreProfile`, then opens the resulting SQLite/originals through the actual domain stores. It uses generated content only and does not call a live model.

The pre-migration snapshot contains encrypted legacy-format originals, two source versions with distinct capture IDs, and a published Memory without the newer version field. The upgraded vault adds chunked originals, a two-part binary file, owner-corrected Memory history, completed and partially committed imports, a partially processed Memory job, completed query/insight receipts, and interrupted durable execution steps.

The fixture verifies:

- Original SHA-256, bytes, capture IDs, source revisions and Memory correction relationships survive backup and restore.
- Completed import step IDs, attempts and statuses remain unchanged. Completed query/insight receipts are retained and are never replayed.
- Foreign host leases/fences and interactive owner leases are invalid in a restored vault. Interrupted interactive work becomes `interrupted` without submitting a model request. Background recovery retains attempts and the absolute recovery deadline.
- Restoring an unfinished import discards its old executable preview, retires its old runnable phases, and requires a new analysis/confirmation. The already imported record keeps its ID and is deduplicated; only the remaining record is newly admitted. An obsolete phase projection cannot overwrite the new generation.
- The completed first Memory batch does not run again; only offsets 256 and 512 of the generated 600-character evidence resume, including a simulated interrupted second batch.
- Restoring the pre-migration snapshot into another empty vault restores the original legacy file format, earlier Memory value and source history. It contains no execution tables and leaves the upgraded vault untouched.

Two defects discovered by this combined fixture were fixed:

1. Backup previously removed the manifest hash even from a completed import. Restore then synthesized a different completed commit step. Completed hashes are now retained as metadata; unfinished preview hashes are still removed.
2. Old runnable import phases survived workspace restoration and could block the new preview with “already processing” or later project stale state into it. Restoration now marks those phases stale, and phase projection checks the current generation.

Backup also clears only the copied execution leases/fences and copied interactive owner rows. It preserves step state, retry attempts, recovery windows, generations, dependencies, results and operation membership; there is no second authoritative recovery manifest.

Validation: `node --import tsx --test apps/server/test/combined-backup-recovery.test.ts apps/server/test/import-backup.test.ts apps/server/test/operation-runs.test.ts` passed 14/14; server typecheck passed. Log: `/tmp/mote-combined-backup-tests.log`. No full suite, actual deployment switch, Docker restore or release rollback was run in this batch. Existing deployment-switch fixtures remain part of the final integration gate.
