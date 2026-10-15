# M02 private data validation

Date: 2026-10-15 (UTC). Prerequisite: M00
`5031b754915d3fbba0dbe0c050b6d103a02966ef`.
Data implementation: `1323c7e1498fb2a2dc0827eb36a81cc095b04c04`.
Final implementation under test (including the startup-race fix):
`d8aaef97104f636c541bd9ea0747da76620d16c2`.
Module branch: `codex/mote-multiuser-m02-data`.
PR target: `codex/mote-multiuser-integration`.

This record validates M02. It does not claim that the 17-module program,
M16 portable-3 format or final joint acceptance is complete. All accounts,
credentials, content, configurations and vaults used below were generated in
isolated temporary directories. No real personal data, running deployment,
existing vault, main branch or integration branch was modified.

## Dedicated acceptance

```sh
node --import tsx --test \
  apps/server/test/private-data.test.ts \
  apps/server/test/private-data-lifecycle.test.ts \
  apps/server/test/scope-foundation.test.ts \
  apps/server/test/scope-architecture.test.ts \
  apps/server/test/startup.test.ts
```

**Passed: 38 tests, zero failures, zero skips** on the implementation commit.
The first sandbox-only socket attempt returned `EPERM`; the actual HTTP/process
checks were rerun with the supported local-listener permission, without skipping
or weakening an assertion.

| Journey/boundary | Executed evidence |
| --- | --- |
| Production registration | Actual `buildApp`/`buildScopedApp` registers data services and routes, using the host two-user verifier; no legacy builder or production test-mode switch. |
| A/B collisions | Same source/device/external/revision/capture/Material identities coexist; same Material revision can exist independently. A deletion/correction leaves B content and exact export unchanged. |
| Foreign reads and changes | Details, source descriptions/history/items, capture and Material versions/read/members, filtered counts, updates and deletion return generic denial/absence without B content; administrator A has the same private boundary. |
| Identity | Missing/old tokens, header/body/query selectors, copied or foreign-host contexts and revoked accounts fail. A revocation at the SQL commit fence rolls back the new row. |
| Parent constraints and failure | Composite foreign keys reject A→B source/capture parents. A failing later batch item leaves no earlier capture/head/Material/link/FTS. Illegal dependency publication rolls back heads, visibility floors and canonical export. |
| Pagination | Signed account/deployment/collection/filter cursor rejects another account, another query and tampering. Paging has no repeated/omitted synthetic rows; the durable cursor works after restart. |
| FTS/model boundary | A's candidate slice excludes 100 B matches and B-only Material before limit/order. Short CJK and literal query syntax are covered. The complete downstream candidate fixture contains no B text; no real model was called. |
| Source metadata and versions | Optimistic description history, lost-response retry, calendar interval overlap with timezone/cross-midnight values, block correction, content/correction retention and exact source pins are covered. |
| Dependency transitions | Current-input changes hide stale output, preserve canonical history/correction for rebuild and exclude hidden output from reads/counts/search. Historical links cannot hide an independent current head. |
| Shared database/restart | Two simultaneous connections write the same upstream identities for different accounts. Stop/restart retains identity, rows, FTS and cursor authority. |
| Real HTTP/process | Temporary loopback listener serves data through the production composition; shutdown/reopen retains the data boundary. Actual `src/index.ts` startup still rejects the old owner token and old vaults. |
| Domain lifecycle | Consistent canonical export; idempotent delete/restore; current, hidden, historical, cross-source and transitive dependencies; bad schema/hash/target/version/reference rejection; injected mid-transaction failure rolls back rows/FTS and preserves B. |
| Disabled account cleanup | Production `ScopedServices.forLifecycle` uses purpose/domain-limited host grants after normal account access is revoked; cleanup never re-enables private reads. Revoked/wrong-domain grants fail. |
| Old directory protection | Generated epoch-4/WAL/unknown/malformed/inconsistent vaults preserve file bytes, names and modes on rejection, including actual startup before token/PID/config writes. |
| Architecture | Every new route/table/registration is declared. Scope/import checks and negative private-SQL tests reject undeclared surfaces, raw connection bypass and missing owner binding. |

## Builds and M01 seam smoke

`npm run build -w @mote/server -w @mote/web` passed. Web emitted the existing
large-chunk advisory. A fresh compiled `apps/server/dist/index.js` process served
health 200 with `privateCapabilities: ['private-data']`, rejected the old owner
token with 401, installed the new scoped tables, created no legacy private table
or owner token and stopped cleanly. All listener/config/vault files were temporary.

An additional temporary source-composition fixture used **exact M01
`1b37cdce813d1de48c9e06b0c5a2dcc5850cbcc9` plus this exact M02 implementation**.
It kept M01's production builder/resolver/Accounts and added only the documented
domain registrar, `PrivateDataError` mapping and delivered health flag. It passed
the complete server TypeScript check and these default-Accounts journeys:

- Password client login, administrator invitation and A/B same-ID private data.
- Web Cookie access with session binding, mutation CSRF rejection/success and
  rejection of a stale A tab carrying B's replacement Cookie.
- MCP credential rejection on ordinary data routes; disabled-account read and
  retained-service commit fences; restart persistence of identity and revocation.

This fixture was copied under `/tmp`, then removed. It did **not** merge either PR
or change the integration branch. It demonstrates the documented resolver seam;
it does not replace rerunning acceptance on the parent's eventual combined commit.
The integration must pass the full M01 `runtime`, including `accounts`, into
`registerPrivateData(runtime, storage.db)`.

## Independent review

A separate reviewer inspected schema, SQL, FTS, cursor signing, routing,
transaction boundaries, source attribution, version dependencies and lifecycle
restore. Confirmed issues were fixed and independently reproduced again:

1. Source metadata edits discarded processed body/user correction: replaced with
   dependency-ordered version refresh and durable visibility floors.
2. Correction left block attribution stale: host correction now updates both
   the Material and each block projection.
3. Source-item filters lost calendar overlap: restored planned start/end overlap.
4. A new dependency could be hidden by its own publication propagation: inputs
   are rechecked after withdrawal; the entire attempted publication rolls back.
5. Historical links could hide an unrelated current head: propagation seeds now
   join the current revision.
6. Complete-run startup regression exposed a readiness/shutdown race: health was
   reachable during asynchronous runtime-locator publication before signal
   handlers existed. Shutdown handlers now register before `listen()`. A real
   subprocess regression holds only the generated locator write, confirms health
   and immediately stops; it requires exit 0, the stopped event and PID cleanup.

Source-description pins now participate in the Material revision hash, and
normalized drafts are parsed again before hashing/storing to preserve schema
field order during export validation. Cross-source declarations remain real
scoped dependencies. Reviewer reruns passed the dedicated transition regressions,
all lifecycle tests, scope checker and whitespace check. The startup reviewer
also ran all three startup tests and used the same held-publication fixture
against old `1323c7e1` and fixed `d8aaef97` entry sources: old failed, fixed passed. **No unresolved confirmed
P0/P1/P2 findings remain** in the reviewed implementation.

## Affected checks

**Passed with exit code 0 on `d8aaef97104f636c541bd9ea0747da76620d16c2`.**
The complete log and explicit exit receipt were inspected before opening the
Draft PR:

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/Users/utopiafar/Library/Android/sdk \
npm run check:affected -- --base origin/codex/mote-multiuser-integration
```

The remote integration baseline was read as
`6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`. The selector includes M00's prerequisite
consumer changes, so it selects full TypeScript integration and Android JVM tests.
The earlier exploratory run passed, but it is not used as final-code evidence
because the review fixes followed that run's initial test discovery. The next
complete run on `1323c7e1` caught the startup race (server 1959 passed, one failed,
one existing conditional skip). That failed run is retained as a failure; the
production ordering was fixed and the final complete run below passed. No
startup assertion was relaxed and no test was skipped to hide the failure. A
subsequent background run lost its execution handle and stopped without a final
result; it is recorded as incomplete, not passed. The final run wrote an explicit
exit-status receipt in addition to the complete log.

The final command selected full TypeScript integration and Android JVM checks:

| Check | Final result |
| --- | --- |
| i18n, library builds, all workspace and script type checks | Passed |
| Desktop | 456 passed |
| Server | 1961 passed, one existing conditional skip, zero failures |
| Web | 469 passed |
| Agent | 316 passed, one existing conditional skip, zero failures |
| Diagnostics / shared | 5 / 190 passed |
| Root release/media/security/reset/proxy regressions / client | 81 / 4 passed |
| Central runner fixture | Passed |
| Android JVM | Passed; 329 tests in 70 suites, zero failures/skips, unchanged inputs up to date in the final run |
| Scope inventory, private-SQL boundary and whitespace | Passed |
| Server/Web production builds and compiled startup smoke | Passed |

The existing conditional skips require explicit macOS sandbox and installed-Codex
opt-ins. No new skip was added. Android was built and tested in this isolated
worktree during the first full run; the final required command confirmed the same
Android inputs/results as up to date. No native UI, emulator or physical device was
run. The successful final run does not turn either the earlier failure or the
interrupted run into a pass.

## Remote delivery and limits

[Draft PR #128](https://github.com/utopiafar/mote/pull/128) is open with base
`codex/mote-multiuser-integration` at
`6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed`. Its source is
`codex/mote-multiuser-m02-data`. Creation-time verification matched the remote
module branch and PR head at `5e4ef80e9f4db9ce1723194a410ec1c1dc653fbe` (the tested
implementation plus the acceptance document). This final evidence update changes
only documentation; the final delivery SHA is reported in task completion and
can be read from the PR. The application implementation remains exactly `d8aaef97`.

The checked head had an empty `statusCheckRollup`; CI did not run. On read-only
inspection, repository workflows **Checks** and **Component checks** were both
`disabled_manually`. No workflow setting was changed and no CI success is inferred
from that state. [M00 PR #126](https://github.com/utopiafar/mote/pull/126) remains
an open prerequisite at the checked baseline, so the PR includes its changes and
explicitly declares that dependency. No PR, main or integration branch was merged
or advanced by M02.

Not run: physical devices, Android emulator/renderer UI, native client journeys,
real models/providers, external indexes, production deployment or real-vault
backup/restore. Legacy algorithm regressions are separate from the explicit
M02 multi-user acceptance above. Ordinary capture/source-item upload, archive
retention intake, originals/assets, Memory, Ask, MCP execution and the other
unfinished domains remain fail closed until their owner modules are delivered.

M03/M05/M06 can consume the actual scoped `PrivateData` host methods documented
in [the domain contract](../design/multiuser-private-data.md). M16 consumes its
registered `DomainLifecycle` through M00's host lifecycle authority. Neither
private SQL nor a caller-selected user ID is an allowed downstream interface.
