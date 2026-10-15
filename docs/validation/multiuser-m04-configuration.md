# M04 configuration, model resources and usage acceptance

Implementation: `e76f1fe6aa99d3ea733b45ea2fd1d3f49c6208f2`, including the
base implementation `a5e91664aaf03dd990ca7d9cf9b2183fe8a94c96` and review fixes
`ee3d34072e7aa7864f75191b8e1b806aea92a525`. This record is a subsequent
documentation-only commit. The implementation and production contract is
[M04 configuration](../design/multiuser-configuration.md).

## Baseline and scope

The isolated worktree is
`/Users/utopiafar/Documents/Codex/2026-10-16/task-5/mote`, on
`codex/mote-multiuser-m04-config`. It was created from M01
`443726d2a95ef55db9466d06aa44ea1061ca56e4`, including M00
`5031b754915d3fbba0dbe0c050b6d103a02966ef`. Their exact remote branch heads were
verified before implementation. The integration base remains
`6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed` on
`codex/mote-multiuser-integration`; prerequisite PRs #126 and #127 are explicitly
dependencies, not implicitly merged. M04 does not contain M02's private-data
adapter or startup-signal change. No integration or main branch was modified.

Production restores user configuration, scoped model catalog/selection and usage
read APIs through M01 authentication and the actual scoped builder. It preserves
the existing ConfigService transaction and uses per-account files. All unfinished
private data, ingestion, execution, Memory, Ask and plugin installation routes
continue to fail closed.

All generated account names, passwords, API keys, model settings and original
content belong to disposable fixtures. No real model, OAuth account, running
deployment, user dataset or physical client was used. The dirty checkout under
`Documents/Projects/mote` was not modified.

## Executed module acceptance

The final committed code passed **103/103**, zero skips:

```sh
node --import tsx --test \
  apps/server/test/scope-foundation.test.ts \
  apps/server/test/scope-architecture.test.ts \
  apps/server/test/multiuser-configuration*.test.ts \
  apps/server/test/multiuser-model*.test.ts \
  apps/server/test/multiuser-durable-model-snapshot.test.ts \
  apps/server/test/config-service.test.ts
```

| Journey / negative case | Evidence |
| --- | --- |
| A/B real Cookie page API, separate YAML files, same profile IDs | Same schema and CAS for page replacement/patch and file reload; stale file/API conflicts, invalid instance fields rejected, B unchanged. Private directories/files are 0700/0600. |
| Instance and private privilege separation | Ordinary user cannot call model-resource administration; administrator cannot select another user's private file; spoofed user headers/query IDs rejected; unrelated private routes remain closed. |
| Shared secrets and personal keys | Public shared catalog has only fixed resource metadata; endpoint/model/headers/key overrides on references rejected; personal `${ENV}` and host Codex login rejected; API responses, emitted-process output, usage and exports exclude synthetic keys. |
| In-flight model/configuration/price snapshots | A changes do not change B or already leased A settings; new admission receives A's new settings; prices are pinned; restart preserves user-qualified ledger rows; foreign/copied leases are rejected. |
| Effective configuration snapshots | Restart-required fields and failed-apply saved candidates stay out of tasks; leases contain only committed effective values. |
| Revocation and late submission | Async prepare/install/rollback, queued edits, account disable/reset, deletion and shared resource withdrawal/republication fence stale work; logout alone preserves admitted account work. Concurrent epoch handover waits for rollback before opening a new service. |
| Durable host snapshots | Real app restart restores the original effective model/endpoint/configuration/price. AES-GCM AAD binds deployment/user/ID; SQLite and WAL contain no plaintext model keys. Wrong host/user/operation, damaged ciphertext, missing/replaced/linked key and uncertain revisions fail closed. Three real processes safely share first-key creation. |
| Usage | User/model/operation come from the genuine host lease, not request IDs; duplicate delivery, including restart recovery, counts once; costs retain unknown measurement semantics; no daily fee quota. |
| Export/delete/restore | Credential-free export; wrong user/deployment/domain/version, corrupt/missing/unknown extension domains and duplicate usage IDs rejected; deletion is idempotent and B's bytes unchanged. |
| Recovery and lifecycle grants | Delete/restore serialize; revoked export leaves no watcher/runtime; revoked restore removes staging and keeps the fence; two real SIGKILL cases recover only the same operation/archive/exact owned target and publish usage once. Unknown old YAML, altered payload, target substitution and cross-user links fail closed. |
| Provider/config extensibility | Registered providers reuse the same instance/personal model schema; public extension domains restore through registered schemas; host close disposes declarations. |

The source process fixture above uses the actual production `src/index.ts`, not
the quarantined legacy composition. The emitted JavaScript was separately built
and checked:

```sh
npm run build -w @mote/server
MOTE_CONFIGURATION_PROCESS_ENTRY="$PWD/apps/server/dist/index.js" \
MOTE_AUTH_PROCESS_ENTRY="$PWD/apps/server/dist/index.js" \
node --import tsx --test \
  apps/server/test/multiuser-configuration-process.test.ts \
  apps/server/test/multiuser-auth-process.test.ts
```

Result: **2/2 passed**, zero skips. This covers actual startup, authentication,
A/B settings/catalog, file CAS, restart persistence, disable and shutdown. Keys
and passwords do not appear in process output. No fixture model network request
or live provider request is sent by these smoke tests.

## Independent review

Two domain reviews and a fresh final reviewer examined the implementation.
The final review reported **zero unresolved P0/P1/P2** after these corrections:

- Transaction guards cover queue execution, atomic rename and synchronous
  publication; revocation restores saved bytes with CAS and rolls back installs.
- Shared resources use monotonic generations; identical republication cannot
  revive an old lease or accept its late result/usage.
- Restore cannot adopt old credential-bearing YAML; complete validation,
  per-user serialization, staging, directory fsync and a credential-free durable
  provenance journal protect partial publication and crash retry.
- Export authorization cannot leave an ordinary plugin runtime/watcher behind;
  public extension schemas and complete domain coverage are checked on restore.
- New epoch initialization retries its own context, and concurrent handover
  waits for the old service to drain before reading its file.
- Task snapshots read effective configuration rather than saved candidates.
- Durable encrypted snapshots and monotonic shared/credential recovery
  generations preserve original values across restart without reviving revoked
  authority or copying credentials into task payloads.

The final reviewer's independent snapshot/recovery/epoch regression run passed
**16/16** durable recovery cases, zero skips, after the previous
**10/10** effective-snapshot/epoch/crash review. Credential component withdrawal,
whitespace clearing and replacement back to the original value cannot revive a
revoked snapshot. The encrypted-store suite passed **7/7**, including three real
concurrent processes. Failed development-time table-inventory assertions were
updated to the actual eight M04-owned tables; no test or production domain was
disabled to achieve acceptance.

## Affected checks

Final command on the frozen implementation:

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/Users/utopiafar/Library/Android/sdk \
npm run check:affected -- --base origin/codex/mote-multiuser-integration
```

Completed on 2026-10-15 with **exit code 0**. The selector included Central,
Desktop, Android and tooling; it ran `check:local` and Android JVM checks without
narrowing the plan.

| Check | Final result |
| --- | --- |
| Bilingual catalogs and call sites | 8,321 messages checked; passed. |
| Shared/agent/diagnostics builds and workspace/script typechecks | Passed. |
| Desktop | 456/456 passed. |
| Server | 2,018 passed, 0 failed, 1 existing conditional skip; 2,019 total. |
| Web | 469/469 passed. |
| Agent | 316 passed, 0 failed, 1 existing conditional skip; 317 total. |
| Diagnostics | 5/5 passed. |
| Shared | 190/190 passed. |
| Root release/security/tooling regressions | 81/81 passed. |
| Client script regressions | 4/4 passed. |
| Central runner journey | Passed. |
| Android `:app:testDebugUnitTest` | BUILD SUCCESSFUL; tasks up to date with the separate 329-test run below. |

The two existing conditional skips are the macOS sandbox permission fixture and
the installed-Codex opt-in fixture. No M04 case was skipped. The final source
module and emitted-process acceptance above ran on the same committed code;
`git diff --check` and local Markdown link checks also passed. The only later
repository change is this validation record.

An earlier invocation could not locate Java at the Android step; the bundled
Android Studio JDK 25 was also incompatible with this Gradle/Kotlin version.
Selecting the already installed JDK 21/SDK for the test process fixed the
toolchain. A separate Android invocation passed **329 tests in 70 suites**, zero
failures/errors/skips. No machine-wide Java, SDK, repository settings or test
skip conditions were changed.

## Delivery and downstream limits

The remote module head is verified before the Draft PR is opened, and the PR
targets only `codex/mote-multiuser-integration`. The final PR head and CI readback
are reported with delivery. `Checks` and `Component checks` were read back as
`disabled_manually`; M04 does not enable or alter them. No CI run means CI is
**not run**, never passed.

M05/M06/M07 use `UserConfigurationService.lease`, host
`Configurations.withModel` and `recordUsage`; model inputs and attribution are
bound to a genuine user context and lease. `lease` persists an encrypted immutable
model snapshot and returns `snapshotId`. M05 stores only that ID and public
metadata. After recovering durable authorization it calls
`restoreLease(context, snapshotId, expectedOperationId)`; success returns a new
host object containing the original effective configuration, model transport,
selection, price and durable generations. Explicit unavailable reasons prevent
fallback when authorization, credentials, resources or encrypted storage cannot
be recovered. No model credential is persisted in a task payload. The same ID
keeps usage idempotent across restart. Cross-module execution-grant composition
remains a joint M05/M04 acceptance step, not claimed by the M04-only fixture.

M13 owns real browser settings/login integration with the new Cookie/API
contract. Page API tests above do not establish renderer acceptance. M09 owns
trusted provider/package loading and safe uninstall order; M16 owns the full
instance backup/restore coordinator and lifecycle grant persistence. Browser UI,
physical clients, live model/provider service, real OAuth, deployment and final
cross-module joint acceptance are **not tested** here. No PR was merged and no
deployment or real data was changed.
