# Test layers and validation triggers

This is the single source for test layers and when to run them. App `AGENTS.md` files give focused commands and platform limits, [CI](ci.md) describes workflow entrypoints, and the [test runbook](testing-runbook.md) covers the Android intake contract, hidden UI fixtures and emulators. Choose checks by the behavior and boundaries changed, not by a test filename.

## Test layers

| Layer | What it establishes | When to run |
| --- | --- | --- |
| Local unit | A function or module rule, using real domain values and controlled dependencies | Focused feedback for the affected behavior |
| Module integration with real SQLite / HTTP | Storage, transactions, authenticated routes and module lifecycle against generated data | When those module behaviors change; keep focused cases in ordinary checks |
| Light cross-module contract | A producer's real serialized output is accepted and used by its actual consumer, including relevant errors | When an interface or its producer/consumer behavior changes; include affected contracts in ordinary checks |
| Heavy cross-client E2E | An assembled journey across processes, clients, UI, native runtime or containers, including relevant recovery | Only when the user asks, typically for stage or release acceptance; never automatically on each push |
| Scale correctness | Completeness, ordering, isolation, cancellation, deletion or recovery at a required input size | Keep the required scale and assertions; run expensive cases only when the user asks |
| Pure performance benchmark | Latency, throughput, resource use or a comparison against a measured baseline | Only when the user asks, for a performance investigation, a major performance-sensitive change or a measured severe regression |
| Real external model | Actual provider behavior and semantic quality with fixed generated inputs and declared model settings | Only when the user asks for live-provider or quality evidence |

A module test using real SQLite or HTTP is not automatically heavy E2E. A large fixture that checks every record or cancellation is correctness coverage, even if its file contains `performance` or `migration`. Retain that coverage when splitting suites; keeping it does not require running it on every PR. A test that measures time and asserts correctness may need separate entrypoints, with its meaningful assertions, input size, lifecycle states and timeouts preserved. Do not delete or weaken valid tests to hide an existing failure.

## Reusable synthetic persona

For a small fictional owner spanning desktop, Android, Central, imports, files and recording connectors, use the [Lin Zhao dataset and isolated replay guide](synthetic-persona-dataset.md). Offline transport checks, opt-in local-model runs, manual semantic review and physical/cloud boundaries are recorded separately.

## Daily feedback

Run the narrow command that exercises changed behavior after a coherent batch of edits. Ordinary changes need affected unit/module checks; interface changes also need a light contract against the real consumer, such as the [Android intake contract](testing-runbook.md#android-intake-contract). A small fix involving permissions, deletion or restoration still needs the corresponding risk regression, without expanding to unrelated repository suites.

Use the affected app's focused command: [server](../apps/server/AGENTS.md), [web](../apps/web/AGENTS.md), [desktop](../apps/desktop/AGENTS.md), [Android](../apps/android/AGENTS.md). For Agent tests, build changed or missing shared/Agent inputs with `npm run build:libs`, then select an existing file, for example `node --test packages/agent/test/task-context.test.mjs` from the root. A package's `npm test` always runs its full glob, so appending a filename does not narrow it. Use Node `--test-name-pattern` before the filename for a single diagnostic case and report that selection.

Never build shared inputs concurrently with another agent or session. `better-sqlite3` must match the active Node ABI.

## Early integration and candidate checks

For a large requirement, connect one shortest real journey early: actual entrypoint/startup, authenticated action, producer output and consumer result. A light contract can catch an interface mismatch quickly; it does not replace the assembled journey. Add relevant restart, cancellation or partial-failure states as the modules converge. A manually composed internal object does not prove actual startup.

When the user asks for stage or release acceptance, one integrator runs the relevant acceptance scope for the converged candidate, including the heavy E2E, expensive scale correctness and live-model checks it needs. That acceptance is not a reason to run heavy suites on every push, every small PR or every handoff. Performance benchmarks follow their own triggers in the table above; historical performance targets do not automatically become current gates.

Inspect the affected light plan before selecting execution:

```sh
npm run check:affected -- --dry-run
# Explicit committed comparison. Use the remote your PR merges into
# (in a fork checkout that is usually upstream/main):
npm run check:affected -- --base origin/main --head HEAD --dry-run
# Run the selected light plan when relevant:
npm run check:affected -- --base origin/main --head HEAD
```

The dry-run describes the commands in the checked-out revision; it is not runtime evidence. `check:affected` selects light checks only; `--all` expands to all light scopes, never heavy suites. Without `--head`, it also includes working changes. Broad component commands and `check:local` remain manual integration tools. Exact task commands, manual `suite/scope/revision` inputs and the distinction between workflow and local specialist entrypoints are in [CI](ci.md). A local light plan is not stage or release acceptance.

After a fix rerun checks invalidated by source, dependency, fixture, configuration or environment changes. Reuse unchanged successful results without another run. Never reuse failed, interrupted or uncertain-cleanup results. Diagnose repeated failures rather than endlessly replaying the same test. A known failure remains a failure until repaired and verified; moving it to a manual suite does not resolve it.

Document-only changes receive formatting, grammar, link and rendering review. Historical results are not current evidence.

## Manual plugin stage and release journeys

The plugin convergence candidate has manual stage, release and artifact checks outside the ordinary test glob and the automatic affected plan. Run them explicitly on the converged candidate; do not add them to every push, PR or handoff.

```sh
# Real source entrypoint, owner Note round-trip, restart and a repository-external plugin.
node --import tsx scripts/journeys/plugin-central-stage.ts

# Packaged default distribution, same-profile restart, provider/plugin lifecycle,
# unknown writes, revoked sources and CLI backup restore.
node --import tsx scripts/journeys/plugin-central-release.ts

# Default distribution artifacts. Build/verify/clean-run cover Central, Web, Mac
# and Android when the platform tools are available; Android needs JDK 17–24 and
# SDK platform 36, Mac packaging needs macOS.
node scripts/plugin-distribution.mjs build
node scripts/plugin-distribution.mjs verify
node scripts/plugin-distribution.mjs clean-run
```

The stage journey starts the real server entrypoint with a private generated profile and loads the repository-external `examples/external-plugin` through the private plugin-dev package host. The release journey builds the default distribution, inventories its features, restarts the packaged candidate, exercises provider and plugin lifecycle, and restores a stopped CLI profile. `plugin-distribution.mjs` builds and verifies the default compositions and deliberately rejects a mismatched plugin contract version; its clean-run starts the Central artifact from a fresh temporary home and installs a generated SDK sample. These scripts write generated artifacts under ignored paths and never publish or sign anything. Their per-journey evidence is recorded in [plugin convergence journeys](plugin-convergence-journeys.md).

Report evidence by kind: **fixture** (generated profiles, loopback services, generated model transports, generated artifacts), **real model** (an actual provider with a declared model), **emulator**, **physical device**, or **third-party account**. A fixture journey cannot stand in for provider semantic quality, native permissions/OS effects, physical-device behavior or a third-party account. A successful artifact build or clean-run is stage/build evidence, not a signed release, deployment or full release qualification. If physical-device or third-party-account journeys are missing, record them as `未验证` and do not claim complete release eligibility.

## Logs

Keep verbose logs in ignored files; print a short result and inspect failure excerpts. Preserve exit status, for example:

```sh
mkdir -p .mote/checks
npm run typecheck -w @mote/server > .mote/checks/server-types.log 2>&1
check_status=$?
if [ "$check_status" -ne 0 ]; then tail -60 .mote/checks/server-types.log; fi
exit "$check_status"
```

## Risk-based review

Stop before implementing a changed product boundary or architectural decision: for example who may access data, what deletion/restoration promises, a persistence or cross-client contract, or lifecycle responsibilities across modules. Give the user a short decision note: the old/new decision, affected consumers, risks and how the real boundary will be validated. The user decides and arranges any independent review, which binds to that scope and its assumptions; review again only when the decision boundary changes. New product policies are likewise the user's call.

Module features and bug fixes within an established boundary need focused validation, not new design approval. A permission, deletion or recovery fix that restores the existing contract needs the corresponding regression. It does not automatically require an independent approval or full-repository run.

Product decisions can supersede obsolete assertions. Explain the changed behavior and remove obsolete tests in the same change; a change that alters a product or architectural boundary goes through the decision note above. KEEP/CHANGE/REMOVE/EXCEPTION/UNKNOWN is useful for superseded architectural responsibilities, not a mandatory form for every edit.

[Coordination](agent-development-workflow.md) applies when work is split across several agents or sessions.
