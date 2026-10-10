# SQLite write receipts after FTS cleanup

The reported central-node crash was `ERR_OUT_OF_RANGE` in `ExecutionEngine.fail()` while updating an Import step. The offending integer was larger than JavaScript's safe integer range. `node:sqlite` reads the connection's `last_insert_rowid()` for every `StatementSync.run()`, including UPDATE and DELETE, even when the caller only needs `changes` or ignores the receipt entirely.

A generated reproduction on Node v26.11.1 populated a contentless-delete trigram FTS5 index with 3,000 rows. Deleting the second row left an internal rowid of `9007886449508352`; both the deletion receipt and a subsequent ordinary UPDATE threw `ERR_OUT_OF_RANGE`. The UPDATE had already executed before conversion of its receipt failed. No personal archive was inspected or modified to obtain this reproduction.

The shared Store connection now decodes write receipts as BigInts, converting only safe integers back to numbers. Query reads keep their existing number behavior; explicit `setReadBigInts(true)` is preserved across successful and failed writes. Genuine query integer overflow still raises an error unless BigInt reads are requested. This covers all Store writers, including Import, Material FTS cleanup/indexing, execution leases, cancellation, retries, Memory, sources and deletion. The separate vector worker is read-only and does not use write receipts.

Import phase scheduling also observes errors from persisting a scheduler failure. A second failure rejects its caller and removes the phase waiter instead of producing a detached unhandled rejection. Existing phase completion, admission, retry, cancellation, indexing responsibility and retained-original rules are unchanged; no schema migration or index rebuild is required.

| Journey / transition | Generated regression |
| --- | --- |
| FTS deletion followed by reused UPDATE; affected and missing rows | `sqlite-database.test.ts` checks exact receipts and number-valued get/all/iterate results. |
| Integer boundaries, named parameters, RETURNING, explicit BigInt mode, SQL failure | `sqlite-database.test.ts` checks lossless rowids, parameter forwarding and restoration of read configuration. |
| Failure → retry → success; running → cancellation after FTS cleanup | `execution-engine.test.ts` checks durable states, publication and transaction cleanup. |
| Scheduler rejects and failure persistence also throws | `imports.test.ts` checks caller rejection and waiter cleanup; Node's test runner also detects unhandled rejections. |
| HTTP create → parser failure after Material FTS cleanup → retry → preview → confirm → completed → app close/restart | `sqlite-import-http.test.ts` uses real routes and lifecycle ordering, retained generated originals and a fixture parser, with zero model calls. |

These fixtures do not validate the owner's existing archive, a physical device or live model behavior. Merge validation is recorded in the PR.
