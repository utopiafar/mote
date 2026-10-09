# Current-format backup and restore fixtures

`apps/server/test/combined-backup-recovery.test.ts` invokes the production backup script and `restoreProfile`, then opens the resulting SQLite and originals through current domain stores. All content is generated; no live model is called.

Both the early and later snapshots use Central epoch 4 and chunked originals. The later snapshot adds a two-part binary, owner-corrected Memory history, completed and partially committed imports, partially processed Memory, a completed insight and interrupted durable execution.

The fixture checks original bytes/SHA-256 and identities, source revisions, Memory supersession, successful checkpoints and import step attempts. Restored foreign leases lose their active fence; eligible work resumes while completed outputs remain intact. Unfinished imports require fresh analysis/preview and preserve idempotent already-committed records. Restoring the earlier snapshot uses another empty destination.

`mvp-baseline.test.ts` separately drives the real HTTP query entry point, stops the host, backs up, restores and reopens the app. The durable query resumes once; another restart retains the same completed conversation turn. It also verifies that an epoch 3 database is rejected without modifying its bytes. No migration is performed, and older backups must be handled with their matching binary.

Physical-device, live-provider and deployment-volume checks require separate reports.
