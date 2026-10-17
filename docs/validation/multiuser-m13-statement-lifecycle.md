# PR156 finalized-statement lifecycle follow-up

This is an exact single-commit production/test selection, not a new optimization
or a platform gate rerun. Independent fix `acbfd7f1907c8457a301b69d303c9b2745526d4a` has prerequisite
b5989f75c497d7317ad35756fc5baca1b6ffbd70. M13's later70fc receipt changed only
documentation, so all application/package/script/protocol source matched that
prerequisite before selection. The no-conflict cherry-pick is `a2f299c86891997827c16c77bfe342287b35c146`.

Only two files change: `apps/server/src/scope/private-data-sql.ts` and the new
`apps/server/test/private-sql-connection-lifecycle.test.ts`. Their full Git blobs
and SHA256 match the independent fix exactly:

- production: `e4faa5765eb7f7b4dd74f1a78838bcfe90f2a18523425895645684386bd2139d`
- test: `303bbc07facf90dd3d206d0cade7de5bcdcaba4a6943c5aa6bf93cc734d41ac3`

The independently confirmed gap was a cached native StatementSync finalized by
close(), then reused after open() on the same DatabaseSync object. This does not
establish a separate existing application restart or wrong-owner disclosure.
On each cache hit the native sourceSQL getter checks statement validity without
executing SQL. Only its ERR_INVALID_STATE while db.isOpen is true evicts that
cache key and allows a fresh prepare. Actual get/all/run execution and prepare
remain outside the catch. Authorization and owner syntax checks occur first;
no SQL execution failure, closed access or revoked permission is retried or
silenced. The bounded connection/read-write metadata cache, new owner/argument
bindings and all other authority fences remain unchanged.

## M13 direct verification

Node24.21.0 runs the exact new lifecycle file:2/2,0 failures/cancellations/skips,
EXIT0,345.657ms process. It verifies warm get/all/run followed by same-object
close/open, rejected old authority and correct fresh A/B operations; SQL errors,
revocation and a still-closed database do not trigger a fresh prepare.

- `/tmp/m13-statement-lifecycle-direct.log/.exit`
- Server source noEmit: `/tmp/m13-statement-lifecycle-source-types.log/.exit`,0.
- Both new lifecycle and existing preparation tests strict noEmit:
  `/tmp/m13-statement-lifecycle-test-types.log/.exit`,0.
- Exact blob receipt: `/tmp/m13-statement-lifecycle-source-match.json`.
- git diff --check passes; no source conflict or additional implementation.

The independent owner separately reports Node24/26 native4/4 and its final
original37+new2+retained-host1=40/40, original Coding3.644s at the original15s
window, types/scope/fresh Server build0. Those are attributed independent
receipts in `/tmp/mote-pr156-statement-independent-fix.md/.json`, not M13's own
rerun or counts added to this2-case run. No dependency/ABI changes, platform
macro, real-data action, merge or deployment is performed in this follow-up.

Historical whole-gate EXIT1, original Coding timeout attribution limits and
separate KEEP158/final same-version union acceptance remain unchanged. Final C
already selecting original `acbfd7f1907c8457a301b69d303c9b2745526d4a` must not duplicate the equivalent M13
cherry-pick. The exact remote PR156 head is recorded in the publication receipt after push.
