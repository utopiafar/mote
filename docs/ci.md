# CI responsibilities

Test layers and selection rules live in [testing](testing.md). `component-checks.yml` is the automatic affected PR/main entrypoint; `checks.yml` has only `workflow_dispatch` for explicitly selected manual acceptance. The commands below require a revision containing the balanced CI scripts in `scripts/ci/`; a documentation-only branch does not supply those scripts.

## Automatic affected checks

The selector uses check scopes independently of release components: `web`, `server`, `agent`, `shared`, `i18n`, `desktop`, `android`, `tooling`. PRs select affected light module checks; server cases are selected by module and distributed across four stable file shards, with bounded connection/listener contracts retained. Shared/protocol changes include their consumers. Unknown inputs and root configuration/lock changes conservatively select every light scope. Documentation-only inputs select no application jobs.

Main uses the affected light contracts for web, Agent, server and desktop, plus selected shared/i18n/tooling checks. Android changes on main check the shared contract/catalog; the selected Android JVM suite runs on PRs. Main compares the current SHA against a completed successful `Component checks` push run on `main` whose SHA is an ancestor, carrying failed, cancelled and unfinished ranges forward. If workflow history or a reliable ancestor is unavailable, it selects all light scopes. This fallback never selects a heavy suite. Main runs have independent concurrency groups; newer PR runs may cancel superseded runs of the same PR.

`Required checks` runs with `always()`. It requires successful selection and every selected job to succeed; only unselected jobs may be skipped. A selector failure, failed/cancelled selected job or unexpected skip cannot become an empty green result. The job name does not imply any change to GitHub branch protection.

The runner retains bounded correctness even in files named `performance` or `migration`. It selects the one large Memory context-grant case and the large query-lineage file separately under manual `scale`; shorter Memory authorization/cancellation guards remain in the automatic partitions. The inventory checks file/case partition coverage. Moving a known failure to manual selection does not repair it.

## Local light commands

Use app `AGENTS.md` for focused commands. From the repository root, inspect the affected light plan before selecting execution:

```sh
npm run check:affected -- --dry-run
npm run check:affected -- --base origin/main --head HEAD --dry-run
# Explicitly execute that committed comparison's light plan:
npm run check:affected -- --base origin/main --head HEAD
# Inspect all light scopes, without selecting scale/recovery/benchmark:
npm run check:affected -- --all --dry-run
```

Without `--head`, selection includes staged, unstaged and untracked working changes as well as committed changes since the merge base. With `--head`, it checks the committed comparison only. Invalid revisions/diff errors fail rather than returning an empty plan. `check:affected` uses the local/PR light plan; it does not query the successful-main baseline or reproduce main's contract-only selection. `check:local`, `check:central`, `check:desktop` and the root/full-glob `npm test` remain broad commands, outside the automatic entrypoint; they are not substitutes for the light selector.

For an individual implemented CI task, `node scripts/ci/run.mjs --task web --dry-run` prints the task's exact commands; omit `--dry-run` only when selecting that execution. The runner validates its inventory, including TypeScript-parsed Memory case names, so dependencies must be available even for its dry-run. A dry-run is not a passing runtime check.

## Explicit manual workflow

In GitHub Actions choose **Checks → Run workflow** on a workflow ref containing these scripts, then supply:

| Input | Accepted value |
| --- | --- |
| `revision` | Full 40-character commit SHA; blank uses the selected workflow ref's resolved SHA. A branch name in this field or a checked-out SHA mismatch is rejected. |
| `suite` | `integration` (default), `docker`, `scale`, `recovery`, `benchmark`, or `all` |
| `scope` | `all` (default), or one specialist scope from the table below. `integration`, `docker` and `all` accept only `scope=all`. |

| Suite | Available scopes | Selected coverage |
| --- | --- | --- |
| `integration` | `all` | Generated app/protocol units and integration fixtures, E2E/media, profiles/tunnel and related checks; specialist suites remain separate |
| `docker` | `all` | Temporary container, profile/backup/rollback and tunnel-container integration |
| `scale` | `all`, `memory`, `query` | Original large Memory context-grant case or large query-lineage correctness coverage |
| `recovery` | `all`, `replay`, `process`, `arrivals` | Generated heldout Memory replays, Central process lifecycle, or material-arrival/recovery fixtures |
| `benchmark` | `all`, `architecture`, `directory`, `sync`, `harness`, `file-commit`, `review-retrieval` | The selected generated performance measurement |
| `all` | `all` | All five suites above, including benchmarks; select this scope deliberately |

The workflow preserves the runner from its selected workflow SHA before checking out the candidate. Selection validates suite/scope and the exact candidate SHA before the heavy jobs run; summaries record the candidate and runner revisions. These generated suites do not establish physical-device behavior or live-provider quality. Their triggers remain those in [testing](testing.md#test-layers).

The local specialist runner accepts only `scale`, `recovery` and `benchmark` with the same specialist scopes. Prepare dependencies, matching SQLite ABI and shared/Agent builds for the selected command; the workflow performs these setup steps for specialist jobs. From the root:

```sh
node scripts/ci/run.mjs --suite scale --scope memory --dry-run
# Explicitly selected scale-correctness execution:
node scripts/ci/run.mjs --suite scale --scope memory
# Inspect a benchmark; measuring it requires a separate explicit selection:
node scripts/ci/run.mjs --suite benchmark --scope directory --dry-run
```

Do not pass `integration`, `docker` or `all` to local `run.mjs --suite`; those are workflow selections. `--task integration-units` is one workflow step, not the complete `integration` workflow. Heavy commands are never selected transitively by the automatic light plan.

## Results and release qualification

CI checks the selected revision. Avoid duplicating unchanged successful work locally, and never call a local-only result a CI pass. Workflow source, enabled/disabled state and a successful revision-specific run are separate facts. Inspect actual runs before reporting CI success.

The PR owner reads failure logs and repairs ordinary failures with the module owner. Store full logs in CI artifacts or ignored local files and preserve nonzero exit status when showing excerpts. PRs record behavior changes, checks actually run and untested risks; no separate ledger is required.

Public API, shared protocol, persistence and authorization changes need the affected actual consumers. Release qualification follows [testing](testing.md#early-integration-and-candidate-checks) and [releasing](releasing.md); it does not make benchmarks mandatory for every release. New releases use new versions and immutable tags; rollback never authorizes overwriting a release.
