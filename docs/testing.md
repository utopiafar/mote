# Testing

**English** · [简体中文](testing.zh-CN.md)

Use the smallest effective checks for the changed behavior. Reuse existing coverage and still-valid results. Stop when evidence is sufficient; broaden only for a new change, failure or specific coverage gap.

<a id="daily-feedback"></a>
<a id="test-layers"></a>

## Daily selection

Select checks from existing coverage or a direct verification entrypoint. Check affected modules for ordinary changes. Interface changes also need the real producer output consumed by the real consumer. Cover relevant failures when authorization, deletion, recovery, persistence or lifecycle changes.

```sh
npm run check:affected -- --dry-run
```

The preview helps select light checks and is not passing runtime evidence. Select execution for the task rather than routinely duplicating all CI locally. Use the app AGENTS and CI reference for individual-file or case commands.

For example, a button-copy change needs relevant display and translation checks. A change to reads after deletion needs denied reads and rejected late results. An upload-field change needs actual serialization consumed at the intake boundary.

<a id="risk-based-review"></a>

## Regression test design

New tests should prevent a concrete user failure. Reproduce a bug before fixing it when practical. Prefer real domain objects and public entrypoints; mock external services or unavailable platform boundaries. Sufficient existing coverage does not require a new test for every edit.

Control cancellation, restart, partial upload and late-result states explicitly rather than hoping repeated runs exercise them. Do not reduce required input, weaken assertions or timeouts, or bypass entrypoints for green results. Moving a failure to a manual suite does not repair it.

<a id="early-integration-and-candidate-checks"></a>

## Integration and expensive checks

For large cross-module changes, connect the actual entrypoint, producer and consumer early, including relevant restart, cancellation and partial-failure states. Small changes do not require a complete journey suite.

## Evidence and reporting

CI carries the agreed regression scope. Select heavy cross-client journeys, scale, benchmarks and real-model checks only when the user explicitly requests them; report the relevant unverified scope otherwise. A performance or migration filename does not diminish correctness assertions within it.

<a id="logs"></a>

Distinguish generated fixtures, real models, emulators, physical devices and third-party accounts. Successful builds do not establish device behavior or model quality. Historical results are not current evidence.

Rerun only checks invalidated by later changes. Do not reuse failed, interrupted or uncertain-cleanup results. Documentation changes need content, formatting, link and presentation review.

Keep full logs in ignored files or CI, preserving exit status and useful failure locations in summaries. PRs report checks run, explicit reuse and unverified scope. Do not create per-task acceptance files.

<a id="manual-plugin-stage-and-release-journeys"></a>
<a id="reusable-synthetic-persona"></a>

Manual plugin journeys, installer fixtures and log commands: [test runbook](testing-runbook.md#manual-plugin-stage-and-release-journeys).

Current references: [CI](ci.md), [test runbook](testing-runbook.md), [generated fixtures](synthetic-persona-dataset.md). Keep this policy short, with CI and platform procedures in their respective references.
