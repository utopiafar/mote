# CI responsibilities

Test layers and selection rules live in [testing](testing.md). `component-checks.yml` is the automatic affected PR/main entrypoint; `checks.yml` has only `workflow_dispatch` for explicitly selected manual acceptance. The local commands below require a revision containing the balanced CI scripts in `scripts/ci/`; a documentation-only branch does not supply those scripts. The manual workflow can use its preserved runner to validate an older candidate revision.

## Automatic affected checks

The selector uses check scopes independently of release components: `web`, `server`, `agent`, `shared`, `i18n`, `desktop`, `android`, `ios`, `tooling`. PRs select affected light module checks; server cases are selected by module and distributed across four stable file shards, with bounded connection/listener contracts retained. Shared/protocol changes include their consumers. Unknown inputs and root configuration/lock changes conservatively select every light scope. Documentation-only inputs select no application jobs.

Main uses the affected light contracts for web, Agent, server and desktop, plus selected shared/i18n/tooling checks. Android changes on main check the shared contract/catalog; the selected Android JVM suite runs on PRs. Changes to the file intake producers, Kotlin upload consumer, their wire definitions or contract check wiring also select the real Central → Kotlin contract on PRs, main and local checks. Producer changes run the focused contract; Android consumer changes combine it with the JVM suite in one Gradle invocation on PRs/local checks. Unrelated Server or Android modules retain their existing checks. Main compares the current SHA against a completed successful `Component checks` push run on `main` whose SHA is an ancestor, carrying failed, cancelled and unfinished ranges forward. If workflow history or a reliable ancestor is unavailable, it selects all light scopes. This fallback never selects a heavy suite. Main runs have independent concurrency groups; newer PR runs may cancel superseded runs of the same PR.

`Required checks` runs with `always()`. It requires successful selection and every selected job to succeed; only unselected jobs may be skipped. A selector failure, failed/cancelled selected job or unexpected skip cannot become an empty green result. The job name does not imply any change to GitHub branch protection.

The runner retains bounded correctness even in files named `performance` or `migration`. Explicit behavioral inventories in `scripts/ci/partitions.mjs` select large Memory/import/query/admission correctness, mass-shutdown recovery and existing timing guards separately; shorter authorization/cancellation/recovery guards remain in the automatic partitions. The inventory validates file coverage and unique literal case names, including mixed files whose short cases stay automatic. Moving a known failure to manual selection does not repair it.

Affected Node checks also select one `architecture` task, which runs `node scripts/ci/architecture.mjs` without builds. It parses TypeScript dependency syntax and resolves source imports, workspace exports and tsconfig aliases. It prevents runtime back-imports of Agent/Server assembly, Desktop contract references to local implementation, Web consumers importing feature bootstrap, view runtime importing builtin assembly, and Server plugin modules importing the concrete `Store` as a value or type. The established shared browser exports and Web source graph must not reach Node builtins through runtime dependencies. Explicit type imports/exports and inline import types remain separate; domain SQL is outside this check. Value-form imports are conservatively treated as runtime dependencies; use explicit type syntax for erased references.

Existing debt is listed by exact rule, source, target and dependency kind in `scripts/ci/architecture-baseline.json`. Each entry requires a reason; new edges fail, and resolved entries must be removed. The three configured plugin loaders retain exact computed-expression exceptions. Other computed module targets must resolve from constant strings or receive a reviewed concrete exception. The graph covers repository source and public workspace exports, not third-party package internals or a complete browser bundle audit. Checker changes select tooling regression tests; no heavy suite or application build is added by those changes alone.

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

For an individual implemented CI task, `node scripts/ci/run.mjs --task web --dry-run` prints the task's exact commands; omit `--dry-run` only when selecting that execution. The runner validates its inventory, including TypeScript-parsed partition case names, so dependencies must be available even for its dry-run. A dry-run is not a passing runtime check.

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
| `scale` | `all`, `memory`, `query`, `intake`, `admission` | Large Memory context-grants/imports and 45-day Persona, query lineage, interrupted ZIP intake or pending-query admission correctness |
| `recovery` | `all`, `replay`, `process`, `arrivals`, `shutdown` | Generated heldout Memory replays, Central process lifecycle, material-arrival/recovery fixtures or mass model-wait shutdown/restart |
| `benchmark` | `all`, `architecture`, `directory`, `sync`, `harness`, `file-commit`, `review-retrieval`, `guards` | Generated performance measurements; `guards` runs existing literal-search and long-transcript revalidation timing regressions with their correctness assertions intact |
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

The plugin stage/release journeys (`scripts/journeys/plugin-central-stage.ts`, `scripts/journeys/plugin-central-release.ts`) and `scripts/plugin-distribution.mjs` are deliberately manual-only: `component-checks.yml`, `checks.yml` and `check:affected` do not select them. Run them explicitly on a converged candidate and record fixture, real-model, emulator, physical-device and third-party-account evidence separately. Artifact build/verify/clean-run is not a signed release or deployment; a candidate without physical-device or third-party-account evidence remains `未验证` for those journeys and is not fully release-qualified. See [testing](testing.md#manual-plugin-stage-and-release-journeys) and [plugin convergence journeys](plugin-convergence-journeys.md).
