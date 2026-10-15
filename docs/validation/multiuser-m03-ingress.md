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

Implementation/boundary SHA: `14858e862f8e36c9115af7a46d6739bb2a94eb4f`.
The command below ran against those final code contents, including
compiled `apps/server/dist/index.js` for the new ingress process journey:

```sh
MOTE_INGRESS_PROCESS_ENTRY="$PWD/apps/server/dist/index.js" \
  node --import tsx --test --test-concurrency=4 --test-timeout=120000 \
  apps/server/test/scope-*.test.ts apps/server/test/multiuser-*.test.ts \
  apps/server/test/private-data*.test.ts
```

Result: **185/185 passed**, zero failures/skips. This includes **19 M03 tests**
through actual account authentication and production services/routes. Evidence:
`/tmp/mote-m03-final2-composition.log`. Server build/typecheck, the complete scope
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
| Filesystem negatives | Traversal, symbolic file and parent links, workspace escape, failed/revoked callback and setup-admission cleanup, quiescent crash staging GC, and FIFO read/import in a separately time-bounded production host. |
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
The peer confirmed review of exact `14858e86` and independently reran all 18
source/service M03 tests and the compiled listener/restart/download journey:
**19/19 passed**, zero failures/skips, with no unresolved P0/P1/P2 found.
Evidence: `/tmp/m03-independent-review-from-m09.md`,
`/tmp/m03-independent-from-m09-14858.log` and
`/tmp/m03-independent-emitted-from-m09.log`.

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
passes all 185 tests. Intermediate compiler failures were repaired before builds.

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
deletion receipt. The parent forwarded this evidence, and M09 independently
reproduced it and fixed it in `aa9691365812835809f1a7e3cf1b3611563c6c00`.
M03 independently reviewed that clean frozen tree and ran 20/20 production
service journeys, 1/1 emitted two-process journey and 1/1 adapted original attack;
no failures/skips. The latter returns `complete`, check 503 and `late=false`, with
the user directory absent after a further 600 ms. No remaining P0/P1/P2 was found
in that review. M09 subsequently found a package-path relocation P2 and fixed it
in `7f00c8b6cb2800109202af840d03e3498dc50935`. M03 independently reviewed that
two-file delta and passed the isolated offline copy/remove-old-root/A-B history
and fixed-task regression 1/1, zero skips. No remaining P0/P1/P2 was found in the
combined final review; final broad checks still belong to M09. Evidence:
`/tmp/mote-m09-independent-7f00c8b6-relocation.log` and the final verdict in
`/tmp/mote-m09-review-from-m03.md`.
Evidence: `/tmp/mote-m09-independent-aa969136{,-emitted,-probe}.log` and
`/tmp/mote-m09-final-independent-review.md`.
Additional runtime-generation/probe-directory observations are
in `/tmp/mote-m09-review-from-m03.md`. Direct cross-thread app message attempts
returned unavailable/unconfirmed, so those attempts alone do not prove delivery.

After freeze `fffe1d12`, an added admission-fence fault injection reproduced a
P2: a temporary preparation directory could remain if pin admission was revoked
before entering the cleanup `try`. The same ordering existed for workspace
metadata admission. Both admissions are now inside their cleanup boundary;
cleanup validates the owner path without requiring the revoked user grant.
A regression first failed and then passed. Owner GC additionally removes orphan
crash staging only when there is no unresolved I/O journal. Logs:
`/tmp/mote-m03-stage-regression-before.log` and `...-after.log`.
The `fffe1d12` full affected candidate was explicitly stopped before completion
because these runtime changes made it obsolete; it is **not** counted as passed.
The final `14858e86` freeze supersedes the earlier candidate.

The first full `14858e86` attempt was also stopped without a pass receipt. The
offline dependency installation had skipped native build scripts, leaving this
worktree without `better-sqlite3`'s binary. Existing Mem0/native-history tests
reported provider-unavailable failures, and termination cancelled remaining
server files (partial report: 1,928 passed, 21 failed, 36 cancelled, 1 existing
skip). That attempt exited 143 and is not a completed source acceptance result.
The locally available binary from the identical dependency version was copied
into this worktree only. Its Node ABI 147 and actual in-memory SQL were verified,
then the seven native Mem0/retained-reader/shutdown tests passed unchanged
(`/tmp/mote-m03-native-dependency.log`). No source, assertions, or dependency
versions changed. A fresh full affected run uses the same frozen source and
`/tmp/mote-m03-14858e86-final-affected.log`; incomplete earlier attempts are not
passes.

That fresh full attempt completed with exit 1: Server **2,117 passed, 1 failed,
1 existing skip**, Desktop 456 passed, Web 469 passed, Agent 316 passed with
1 existing opt-in skip, Shared 5 passed and Diagnostics 190 passed. The sole
failure was the existing thousand-original background-import fixture: all 1,000
inputs imported successfully, but its unchanged 60-second final phase saw only
999 Material/Memory checkpoints. Execution reported success with no failure
receipts; maximum event-loop delay was 35.1 seconds. Root script checks and
Android were not reached after the workspace failure.

The unchanged fixture then passed alone: **1/1**, prefix 133,355 ms, final tail
4,792 ms, total 140 seconds (`/tmp/mote-m03-background-import-rerun.log`). No
assertion, phase timeout or source changed. M03 and M09 coordinated sequential
heavy phases for the next complete run, recorded with UTC start/phase/end times
in `/tmp/mote-m09-review-from-m03.md`. The new full log is
`/tmp/mote-m03-14858e86-final2-affected.log`; its final exit receipt is the broad
acceptance gate, rather than the isolated retry alone.

## Final complete check

At unchanged implementation `14858e862f8e36c9115af7a46d6739bb2a94eb4f`, the exact
required command completed with **exit 0**:

```sh
npm run check:affected -- --base origin/codex/mote-multiuser-integration
```

Evidence: `/tmp/mote-m03-14858e86-final2-affected.log` and its `.exit` receipt.
The full command includes i18n, library builds, all workspace typechecks/tests,
root release/media/security/reset/proxy scripts, CLI, central-runner checks and
Android `:app:testDebugUnitTest`.

| Component | Final executed result |
| --- | --- |
| Server | 2,118 passed, zero failures/cancellations, 1 existing skip |
| Desktop | 456/456 |
| Web | 469/469 |
| Agent | 316 passed, zero failures, 1 existing opt-in Codex skip |
| Shared | 5/5 |
| Diagnostics | 190/190 |
| Root scripts / CLI | 81/81 and 4/4; central-runner JSON status `passed` |
| Android | 329/329, zero failures/errors/skips across 70 JUnit suites; 25 tasks executed, `BUILD SUCCESSFUL` |

The thousand-original fixture passed in this full run: prefix 116,233 ms,
tail 5,366 ms, total 123,510 ms. No runtime source or test assertion changed
between the failed full attempt, isolated retry and this complete pass. Only
acceptance documentation changes follow the implementation freeze; they were
checked for whitespace, grammar and local links.

## Remote publication verification

Before publication, the M03 remote branch and open PR were both absent and
integration still resolved to `6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`.
Checks and Component checks were read-only verified as `disabled_manually`;
neither workflow nor any repository setting was changed.

Draft PR [#131](https://github.com/utopiafar/mote/pull/131) is **OPEN / Draft**, base
`codex/mote-multiuser-integration`, head `codex/mote-multiuser-m03-ingress`.
The initial published documentation head `c8f1aa675062ef795c2487f199828c16afe4a38d`
matched both the PR API and `git ls-remote`; base remained the SHA above.
`merged:false`, `statusCheckRollup:[]`: **zero CI records, not CI passed**.
The PR was attached to this task. This final publication-record commit changes
only this validation document; runtime/tests remain exact `14858e86`.
The remote head is verified again after that documentation-only push and recorded
in the final handoff. No merge is authorized or performed.
