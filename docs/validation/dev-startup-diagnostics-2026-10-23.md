# Development bootstrap diagnostics

Date: 2026-10-23. Stage: **integration-verified** for the generated development
launcher journey and the separately identified local configuration repair.
Full affected-candidate checks remain pending; this is not merge-ready evidence.

## Problem and bounded change

The foreground launcher's development-account bootstrap discarded its exception
and printed only a generic initialization failure. A local development YAML had
an obsolete entry under `models.defaults`; the current local source rejected it
before opening account storage, but the terminal did not identify that field.

The bootstrap now follows the server entry point's existing configuration-error
contract: a fixed event/category and `ConfigError.field`, without raw exceptions
or configuration values. Known profile, live-process, unsupported-vault,
permission, filesystem and SQLite failures have bounded categories; allowlisted
system codes and numeric SQLite codes help distinguish those failures. Unknown
exceptions retain the generic initialization category. Field paths retain the
existing server disclosure contract; this change does not redesign that contract.

- KEEP: configuration and storage validation, profile restrictions, bootstrap
  order, account/password preservation, failure exit, no-start behavior, current
  fixture entry points, assertions, required lifecycles and timeouts.
- CHANGE: actionable bootstrap diagnostics; the user-authorized local removal
  of only `models.defaults.embedding`, after a private backup.
- REMOVE: suppression of all bootstrap failure details and that one local
  obsolete assignment.
- EXCEPTION: the owner explicitly authorized validation against the existing
  local Dev profile. Its configuration and archive remain outside source control.
- UNKNOWN: full affected-candidate checks, CI availability, physical devices and
  live-model behavior are not established by these focused results.

The local checkout's schema no longer accepts the embedding default assignment;
the clean PR base still does. The regression therefore uses a deliberately
unknown generated default key, rather than changing model features or assuming
that `embedding` is invalid in every checkout. `models.embedding` is preserved.

## Independent pre-implementation approval

Plan `dev-startup-diagnostics-v1`, SHA-256
`7270ed8a9783c17a77fd13def1bd5839a1fb23ce49c65cd04765cf41abcd983e`,
was reviewed before product-code edits by the independent
`startup_plan_review` agent using **gpt-6.1-sol / medium**.
Result: **APPROVE**, bound to base/pre-implementation HEAD
`05353e7ced91f68f32c54f5b8972394d5bc15964` and branch
`codex/dev-startup-diagnostics`.

Approval covers this bootstrap catch, additive assertions in the existing
launcher fixture, documentation, the authorized private configuration correction
and actual startup verification. One owner implemented and integrated the change.
No responsibilities, privacy policy, model feature, storage contract, lifecycle
ordering or validation success criteria change. Raw exception/SQL/path/value
output and reductions in existing fixture coverage are outside the approval.

## Focused evidence

Environment: macOS arm64, Node 26.11.1, npm 11.20.0. Dedicated worktree
dependencies were installed; the pinned native SQLite runtime was rebuilt and
the Server/Web environment preflight passed.

| Check | Executed evidence |
| --- | --- |
| `npm run build -w @mote/shared -w @mote/agent` | Passed. |
| `node --test scripts/release/dev-server.test.mjs` | Passed, one complete launcher lifecycle case; approximately 14.0 seconds including compiling the actual Server. |
| `npm run check:affected -- --test-file apps/server/test/startup.test.ts --test-file apps/server/test/config.test.ts` | Passed: environment, shared/agent builds and all 26 selected tests. Functional test task approximately 17.7 seconds; no file/case budget overruns. Driver receipt run ID `aa4e35e2-779a-416d-9c98-4c2223be2224`. No reused tasks. |
| Full `npm run check:affected -- --dry-run` | Inspected only. The generic release-test path conservatively selects all workspaces and Android; this complete candidate plan was not executed for this focused handoff. |

The additive generated regression uses the actual launcher and its compiled
bootstrap: invalid defaults -> nonzero exit with `configuration` and
`models.defaults` -> no generated secret canary in output -> unchanged YAML,
no database or process marker -> remove only the generated entry -> first
startup, real HTTP login, password change, restart/preservation and shutdown.
Existing occupied-port, build-failure, existing-account, held-PID,
unsupported-vault and forbidden-profile journeys remain. Additional assertions
verify bounded guard/storage diagnostics. The existing fixture's already-built
npm commands remain substituted; installation is not claimed from that fixture.
All fixture materials are generated; no real personal screenshots or model calls.

## Separate local operational verification

The original private Dev YAML was backed up with mode 0600 before removing only
`models.defaults.embedding`. A semantic comparison verified all other settings
were unchanged, and the repaired configuration passed the local source schema.

In the user's existing, previously modified local source checkout, the actual
`node scripts/dev-server.mjs` reused unchanged dependencies, rebuilt libraries,
Server and Web, preserved existing accounts and reached
`Mote 0.0.90 (dev) ready` on loopback port 47842. Both `/api/health` and the Web
root returned HTTP 200; media runtime preparation reported ready.
`node scripts/mote.mjs stop --profile dev` stopped it successfully; the launcher
exited zero, the PID file and listener were gone, and this run's stale stopped
process marker was removed under the profile lock after verifying its PID dead.

This operational result proves the local configuration repair with the existing
source composition. The new bootstrap diagnostic implementation is separately
proven by the clean candidate's generated launcher fixture. Local startup is not
evidence of model accuracy, physical-device behavior or the complete affected
candidate plan. No user archive reset, automatic migration or source edit in
the user's original checkout was performed.

## Follow-up: deployed connector page and source selection

The owner subsequently reported `config_invalid` on the Lark connection page;
the browser's `GET /api/connectors` returned HTTP 400. The original health-only
local check above did not cover lazy loading of this account's configuration.

Read-only investigation established that the running process record pointed to
the original working directory, while the Dev profile selected the separate
installed `central-main-c2d5129c-20261023` release. The working directory has a
different source composition: its processing implementation does not register
the `perception` account domain. The account YAML still contains that domain,
which includes explicit image privacy settings. The installed release includes
the domain's implementation. This was an incompatible source/runtime selection,
not evidence that the account domain should be deleted.

The selected installed release also requires the explicit
`models.defaults.embedding` assignment when `models.defaults` is supplied.
After stopping the source process, its first startup attempt identified that
missing field. The original assignment was restored from the earlier private
backup, after another private backup and semantic verification that no other
instance setting changed. The account YAML, its `perception` domain and its
disabled external-image/query-image permissions were preserved. The earlier
removal described above applies only to the original working directory's schema;
it is not the final deployed configuration.

The installed release's actual `mote.mjs start` entry was then invoked with the
existing explicit profile home. The managed process record now matches the
profile-selected release, health returns HTTP 200, and the media runtime reports
ready. Reloading the owner's existing authenticated Lark browser tab completed
without `config_invalid` and enabled the New connection button, which requires
the connector inventory to load successfully. Only accessibility text was read;
no personal screenshots, connection creation, provider authorization, or sync
were performed. The existing Dev server remains running in the background.

No product-code or lifecycle change was needed for this operational correction.
Future validation of this incident must include the actual authenticated
connector/configuration consumer, as well as runtime-release provenance and
health. Use `mote.mjs start` for the selected installation and `dev-server.mjs`
only when intentionally building the current checkout's source.
