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

## SQL ownership boundaries

`node scripts/ci/architecture.mjs` also runs the [SQL ownership check](../scripts/ci/sql-ownership.mjs). Run that module directly for a focused check, `--inventory` for concrete covered/uncovered files, relations and statement fingerprints, or `--map` to print the generated ownership map. The check never changes the database or updates a baseline.

The [policy](../scripts/ci/sql-ownership-policy.mjs) names production `SchemaInstallation` declarations and exact consumer modules. Owner names and tables/views are extracted from each declared install function into the checked-in [generated map](../scripts/ci/sql-ownership-map.json); changing a declaration makes a stale map fail. The schema-installation scope contains the core vault installers and Material/Material Catalog. Activity additionally has an explicit projection scope sourced from its formal feature activation and actual `ActivityMemoryIndex` constructor; its nine tables and thirteen subscription triggers are extracted from that construction point. This does not claim Activity has completed schema installation ownership. Only its constructor and subscription retirement are covered; its other consumer methods remain pending. Execution, feature Memory and other installers must join after their production owner declarations land. The CLI explicitly reports partial coverage; passing with existing debt does not mean every domain is covered.

The TypeScript AST follows immutable lexical constants, concatenations, finite conditional branches, templates, and local `prepare`/`exec` aliases, and also inspects complete SQL literals outside those calls. Zero-argument lifecycle methods contain no SQL argument and are excluded; a same-named method with SQL remains checked. In the explicit Activity construction/retirement scopes only, it additionally proves local expression-bodied string helpers, the finite CASE map over literal numeric states, literal iteration members and the retirement parameter’s literal choices. Lifecycle calls across production sources must pass proved literal schema arguments; taking the retirement function as a value or passing a computed schema fails, so a type assertion cannot silently widen the operation. It executes no helper code. Mutated or escaped constants and unsupported expressions remain unproved. A small SQL lexer checks visible read/write relations, quoted identifiers, nested queries, CTE scopes, trigger bodies and FTS table functions. Unknown fragments remain unproved SQL; this is a static literal boundary, not whole-program value-flow analysis or a general SQL validator. Foreign-key declarations express schema dependencies rather than data reads. SQLite metadata and built-in JSON/pragma table functions are outside domain data ownership.

A cross-owner access fails unless its exact statement is registered. Shared read models require a reviewed purpose and exact file, statement fingerprint, table and read access; they never grant writes. Shared reads cover Material Catalog's bounded source facets and Activity's exact constructor statements that rebuild disposable metadata from Memory jobs/batches. Exact `observe` grants additionally permit Activity's TEMP subscriptions on those two source tables; trigger attachment is distinct from DML in a trigger body. Activity writes its own nine projection tables and receives no source-product write permission. The subscription retirement target list is checked against trigger objects derived from the same constructor, including the finite main/temp schema choice. Other existing accesses remain debt, including potentially legitimate reads that still need domain review.

The separate [SQL baseline](../scripts/ci/sql-ownership-baseline.json) freezes existing cross-owner accesses, unresolved SQL, unknown tables and uncovered consumers. A `symbols` array groups exact fingerprints for the same access; it is not a file or table exemption. Fingerprints include resolved constant contents and occurrence count; unresolved SQL also fingerprints its enclosing lexical body. Fully proved projection statements fingerprint the actual helper-expanded SQL, so unrelated constructor admission work does not change their authority while an actual helper SQL dependency change fails. New statements, copied calls, changed constants and changed dynamic helpers fail. Remove stale entries as consumers gain an owner or access moves behind its owner; existing debt may only shrink. Do not regenerate the baseline to approve a change. When adding an owner, review the generated map and remove resolved coverage entries instead of exempting the entire module.

Formally registered Execution, Operation Projection, TaskRecords, TaskEvidence and RunExecution installers additionally use the same bounded AST proof for literal-array map/join, single-return pure string helpers and correlated literal iteration. Direct same-file one-db-argument construction helpers are traced from the install declaration. Reassignment, aliasing, callback paths, exported db helpers or another runtime caller or a duplicated db-helper invocation cannot inherit installation authority. Unexecuted string-helper fragments remain outside the installer permission scope.

The exact `schemaMaintenance` declarations describe the existing joint storage invariants: operation progress and hierarchy maintain execution membership; evidence deletion invalidates task revision and erases private task input/result bodies in the same transaction. Each grant includes installer identity, direct call path, complete proved SQL SHA-256, exact statement fingerprint/occurrence, actual observed source relations, target relation, exact operation (`read`, `observe`, `index`, `insert`, `update`, `delete`) and purpose. It applies only at that installation statement/path. It is separate from shared-read grants and derives no general authority from prerequisites. Runtime consumers remain pending.

When a registered table owner refines an existing unresolved-table access into a cross-owner diagnosis, the old baseline entry may remain only with an explicit `retainedClassificationScopes` witness: the same file, complete SQL fingerprint/occurrence, relation, access kind, concrete parsed operation, named scope and full original scope fingerprint. A retained DML write additionally requires complete static SQL and a proved insert/update/delete operation; an unknown operation or schema/DDL effect cannot use this refinement. Such retained classification debt is still debt, not a valid shared model or schema-maintenance authorization. Missing scope proof, a changed SQL/table/operation, another occurrence or a moved scope fails. The baseline identity is preserved instead of falsely reporting resolution and inserting another debt record.

Focused generated-fixture checks:

```sh
node --test scripts/ci/sql-ownership.test.mjs scripts/ci/architecture.test.mjs
```

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
