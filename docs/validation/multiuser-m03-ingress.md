# M03 ingress acceptance

## Scope and prerequisite identity

Implementation worktree: `/Users/utopiafar/Documents/Codex/2026-10-16/task-7/mote`.
Module branch: `codex/mote-multiuser-m03-ingress`.
Prerequisite PR #130 and its remote branch were both verified at
`7f72e9040872dbbb351f3c9a22afa6f069aa59c8` before worktree creation. The local and
remote module branch did not exist. PRs #126–#130 are dependencies. Integration
remained `6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`; no PR was merged, no main or
integration branch was modified, and the user's dirty primary checkout was not
used. Only synthetic data and isolated temporary instances were operated on.

Design and downstream contracts:
[originals and ingress](../design/multiuser-ingress.md). Production restores the
version-3 ingress registrar, scoped original storage/downloads, device/source
synchronization, file upload/receipt recovery, raw Coding archive intake and
M16 lifecycle. M06 algorithms, M09 worker binding, M10 connectors, M11 MCP and
physical client consumers remain their owner modules' responsibilities.

## Actual validation

The implementation/boundary SHA and final affected result are appended after the
code is frozen. The command below ran against the final code contents, including
compiled `apps/server/dist/index.js` for the new ingress process journey:

```sh
MOTE_INGRESS_PROCESS_ENTRY="$PWD/apps/server/dist/index.js" \
  node --import tsx --test --test-concurrency=4 --test-timeout=120000 \
  apps/server/test/scope-*.test.ts apps/server/test/multiuser-*.test.ts \
  apps/server/test/private-data*.test.ts
```

Result: **183/183 passed**, zero failures/skips. This includes **17 M03 tests**
through actual account authentication and production services/routes. Evidence:
`/tmp/mote-m03-final-composition.log`. Server build/typecheck, the complete scope
inventory/import/private-SQL checker, and `git diff --check` also passed.

| Journey | Executed evidence |
| --- | --- |
| Equal A/B identities | Same device, capture UUID, source/external/revision, batch key and bytes; distinct owner-bound receipt/upload/original references, no overwrite or private-result reuse. |
| Ownership/credential negatives | Top-level and nested request owner spoofing, wrong ingress version, administrator access to B, limited device private routes/minting/host import, and MCP escalation all rejected. |
| File intake | Real immutable part checksum/size validation, full-object child preparation, conflict, restart after partial upload, lost ACK replay, repeat commit and late receipt presented to B. |
| Downloads/playback | Own authenticated full/ranged/suffix reads; foreign account, administrator, swapped original, missing credential, tampered/expired ticket rejected. |
| Source/Coding | Raw Coding tool bodies recover through scoped originals and never enter raw lexical candidates; limited source facade rejects direct and transitive foreign-source dependencies. |
| M02 transactions/publication | Failed batch no partial capture/reference; Material publication delegates to M02; source-context rebuild preserves raw-capture source dependencies. |
| M05 fences | Actual durable task attempt context, cancellation and retained capability rejection; asynchronous file commit after credential revocation publishes neither capture nor receipt. |
| Original lifecycle | Pin prevents GC until release; A capture/source deletion plus GC leaves B bytes unchanged; failed preparation can be followed by valid same-byte intake. |
| Filesystem negatives | Traversal, symbolic file and parent links, workspace escape, failed/revoked callback cleanup, and FIFO read/import in a separately time-bounded production host. |
| M16 | Own export with explicit coverage, exact/idempotent restore, corrupt checksum and stitched same-user source mapping rejection before writes; live/crashed I/O returns unknown, lifecycle reconciliation cannot settle a known live activity. |
| Production process | Actual listener start, two account logins, same input, stop/restart, lost ACK replay and authenticated original download. Compiled JS entry used in final composition. |

The M01 handoff regression was updated for the adopted finite device boundary:
device-to-global-Web ticket creation now asserts 403; the complete account-session
one-use ticket, reverse approval, parent revocation and device logout assertions
are retained. No assertions or test classes were broadly disabled.

## Independent review and resolved findings

Peer review came from the existing M09 execution conversation
[`01a14182-6199-7164-9b09-792ba8fe4023`](codex://threads/01a14182-6199-7164-9b09-792ba8fe4023),
without creating another execution conversation or editing this worktree.

- P2: portable restore checked parent existence without proving canonical
  source association. Fixed by matching capture provenance/host ingress source,
  scope projection, exact content-qualified original ID and image descriptor.
  Same-user stitched-source regression passes.
- P2: a not-ready object occupied the same metadata state as a zero-byte ready
  object after failed worker preparation. Fixed with explicit `bytes=-1`
  preparation state; valid same-byte capture after failed full-object verification
  passes without requiring a manual reset.
- P2: opening a FIFO before `fstat` could block. Both original reads and admin
  import now use `O_NONBLOCK` with `O_NOFOLLOW`, then require a regular single-link
  file. A separate production host regression has a five-second outer timeout.

Self-review additionally fixed canonical raw-capture source tracking through
transitive Material dependencies and rebuilds, prevented admin device credentials
from using host import, and added a durable I/O activity journal so physical
cleanup cannot be claimed while a child/workspace is unresolved. Original
references include the content digest, MIME and retention identity, preserving
immutable byte interpretation across restoration.

The peer's independent `/tmp/m03-review-restore.ts` initially could not load ESM
exports when executed as a CommonJS-classified temporary script. The same script
copied unchanged to `.mts` ran and reported `RESTORE_REJECTED / invalid_data`;
that loader failure is not counted as a behavior pass. The durable regression
suite independently exercises canonical linkage with a fully recomputed ID.

## Failed/intermediate and unrun evidence

The first M03 run passed 9/11: a large base64 regex could exceed the JS regexp
stack, and the Coding fixture used a nonexistent shared `kind`. The parser now
uses bounded canonical base64 validation; the fixture uses shared `message` kind.
A source-process run inside the restricted sandbox failed to bind loopback;
the unchanged isolated production listener passed in the authorized environment.
The first combined run passed 180/181 because the old M01 fixture still expected
a finite-device credential to obtain a full Web session. The explicit boundary
regression described above supersedes that expectation. Later final composition
passes all 183 tests. Intermediate compiler failures were repaired before builds.

Physical devices, native capture permissions, live OCR/ASR/model providers,
external accounts, actual deployment and complete M16 whole-instance restoration
were **not run**. No real model or external account was called. No system safety
or GitHub Actions setting was changed. Existing disabled workflows and final
remote CI/head checks are recorded below; zero check records never mean passed.

## Parallel-module review handoff

M03 also independently reviewed M09 frozen
`2f0e02a0fe39b6aa0f2e79e86f413e5f34c9703d`. A generated local plugin reproduction
confirmed that an untracked `check()` probe can recreate files after plugin-domain
delete returned `complete`. Evidence:
`/tmp/mote-m09-review-probe.mts`, `/tmp/mote-m09-review-probe.log`;
result `lateFilesAfterSuccessfulDelete:true`, `checkStatus:401` after a complete
deletion receipt. This is an M09 P1 pending that module's fix/review, not an M03
pass or a reason to merge anything. Additional runtime-generation/probe-directory
observations are in `/tmp/mote-m09-review-from-m03.md`. Several cross-thread app
message attempts returned unavailable/unconfirmed; delivery is not claimed.
The parent must ensure M09 receives this evidence before combining the modules.
