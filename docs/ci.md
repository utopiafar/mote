# CI reference

[Testing](testing.md) defines check selection. Automatic jobs run through [component-checks.yml](../.github/workflows/component-checks.yml); [checks.yml](../.github/workflows/checks.yml) is an explicitly selected manual workflow.

## Automatic affected checks

The selector separates check scopes from release components. Shared/protocol changes include actual consumers; root configuration, lockfiles and unknown inputs select all light scopes. Documentation-only changes, including root Markdown, select no application jobs; runtime prompts inside workspaces retain their consumers. Main uses its last successful ancestor run as the baseline, carrying failed or unfinished ranges forward; without a reliable baseline it selects all light scopes.

PRs use affected module checks. Android intake changes select the real Central → Kotlin contract; Android consumer changes combine it with JVM units in one Gradle invocation. Main uses the selected Android shared contract/catalog, with the JVM suite on PRs. `Required checks` requires successful selection and every selected job to succeed; only unselected jobs may be skipped.

The [partition inventory](../scripts/ci/partitions.mjs) separates expensive scale/recovery/timing cases while retaining ordinary correctness checks. The [architecture check](../scripts/ci/architecture.mjs) validates dependency boundaries and browser-safe exports; exact existing exceptions are in its [baseline](../scripts/ci/architecture-baseline.json). Test coverage, assertions and input sizes are unchanged by suite selection.

## Local light commands

```sh
npm run check:affected -- --dry-run
npm run check:affected -- --base origin/main --head HEAD --dry-run
npm run check:affected -- --base origin/main --head HEAD
node scripts/ci/run.mjs --task web --dry-run
```

Use the PR's actual target remote in comparisons. Without `--head`, selection includes working changes; with it, only the committed comparison is selected. Invalid revisions fail. `--all` expands light scopes only. Local/PR selection differs from main's successful-run baseline. Broad `npm test`, `check:local` and component commands remain available, but are not required for every edit. A dry-run prints a plan, not a passing result.

## Explicit manual workflow

In **Checks → Run workflow**, choose a workflow ref containing the runner and supply:

| Input | Values |
| --- | --- |
| `revision` | Full 40-character commit SHA; blank uses the workflow ref's resolved SHA. Branch names and candidate SHA mismatches are rejected. |
| `suite` | `integration`, `docker`, `scale`, `recovery`, `benchmark`, `all` |
| `scope` | `all`, or a specialist scope below. `integration`, `docker`, `all` require `all`. |

| Specialist suite | Scopes |
| --- | --- |
| `scale` | `all`, `memory`, `query`, `intake`, `admission` |
| `recovery` | `all`, `replay`, `process`, `arrivals`, `shutdown` |
| `benchmark` | `all`, `architecture`, `directory`, `sync`, `harness`, `file-commit`, `review-retrieval`, `guards` |

The workflow preserves its runner before checking out the candidate and reports both revisions. Local `run.mjs --suite` accepts only `scale`, `recovery` or `benchmark`, for example:

```sh
node scripts/ci/run.mjs --suite scale --scope memory --dry-run
node scripts/ci/run.mjs --suite scale --scope memory
```

These specialist checks are selected only for explicitly requested acceptance or investigation. Automatic light checks never select them transitively. Dependency/setup requirements and exact commands are defined in the runner. `--task integration-units` is one step, not the whole integration workflow.

## Results and artifacts

Report the revision actually checked, valid reused results and remaining gaps. Workflow availability and a successful run are separate facts. Keep full logs in CI artifacts or ignored files and preserve failure exit status.

Plugin stage/release and distribution checks are [manual runbook entries](testing-runbook.md#manual-plugin-stage-and-release-journeys), outside both affected plans and the manual workflow. Generated fixtures, real models, emulators, physical devices and third-party accounts establish different things. Artifact build/clean-run is not a signed release or deployment. Release operations are described in [releasing](releasing.md).
