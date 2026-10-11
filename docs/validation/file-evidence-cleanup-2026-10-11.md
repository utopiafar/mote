# PR #95 follow-up: file evidence cleanup

All fixture input was generated. No personal screen content, physical-device
capture or live model calls were used.

## Independent review

PR #95 was already squash-merged by the owner account when the requested review
started. Its merged tree is identical to its reviewed head. Independent Android,
Central and Desktop reviews found no blocking deletion of production behavior.
Focused checks passed: Android 46 JVM tests, Central 31 tests, Desktop 86 tests.

The review found two P3 remnants: an unused Desktop local read helper/location
map, and Central device read-request routes/journal/polling without a client
consumer. A generated HTTP multipart upload through the actual archive reader
reproduced a 1026 ms wait and `device_pending` before Central processing; reading
the same retained text after processing took 3 ms. The follow-up removes these
retired paths while retaining Central excerpt reads and authorization fences.

## Login restart regression

A newly dispatched Linux CI run on the #95 merge commit failed the Desktop
login-session fixture before restart or reauthorization. The fixture used
unmanaged uploads although the app uses managed uploads. An explicit sync tried
source registration before staging, so the generated offline fetch left no
queued revision. Watcher timing could mask this fixture error.

Generated controlled comparisons reproduced pending=0 for unmanaged uploads
without a watcher wakeup, pending=1 after an injected watcher wakeup, and
pending=1 with no network registration under the app's managed upload path.
The corrected fixture follows the app path and checks the exact queued revision
through restart and same-node reauthorization. No platform skip or weakened
assertion was added.

## Validation boundary

Central text expansion, stale versions, deletion, source authorization and
`allowRead` changes are covered with generated fixtures. Retired routes no longer
accept device responses; new stores do not create the retired request journal.
Documentation and Agent tool wording identify Central as the text host.

Follow-up focused checks passed: 98 Desktop tests, 46 Central tests, shared/Agent
builds and Desktop/Central type checks. An independent review found no blocking
deletion and verified all scanner parameter consumers. A generated 1100-file
directory check passed initial collection, unchanged reconciliation and one-file
change; root script type checking passed.

`npm run test:profiles` passed after rebuilding Central. It exercised the actual
CLI import consumer against two generated Central processes, independent tokens
and vaults, unchanged-input retries, encrypted asset roundtrip, backup/restore,
upgrade/rollback and log rotation. The first attempt had failed before startup
because local server output still referenced a retired shared export after a
partial build; a complete server build resolved that artifact mismatch without
source changes.

`npm run check:affected` passed on the final code. Shared/protocol and script
changes selected all consumers: the full TypeScript integration check plus
Android JVM tests. Desktop passed 433 tests, Central 1397, Web 268, Agent 243,
shared 177 and diagnostics 5. Android passed 287 JVM tests. Release/security/CLI
regressions and the generated Central runner passed. The two existing optional
TypeScript skips cover a macOS Python sandbox environment and installed Codex
with synthetic Responses; neither is reported as executed.

The heldout Ask script's pinned table inventory was updated only for the removed
request table. A fresh generated Central confirmed that table is absent and the
excerpt link schema remains. The broader pinned inventory already differs from
the current schema; its full contract and live heldout run were not verified in
this change. No unrelated inventory was rewritten.

Physical devices, permission changes and live-model behavior remain unverified
by this follow-up. Historical validation records are unchanged.
