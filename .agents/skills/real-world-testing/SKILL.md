---
name: real-world-testing
description: Design Mote regression tests from concrete user failures and review coverage when fixing bugs, adding tests or changing lifecycle behavior.
---

# Mote regression coverage

Name the user failure the test prevents. Prefer real domain objects or public entrypoints; use generated evidence and mock only external services or unavailable platform boundaries.

Reproduce a regression before its fix when practical. Preserve meaningful outcomes, required data scale, timeouts and cleanup assertions. Avoid existence checks, mock echoes, implementation mirrors and duplicated adapter scenarios.

Exercise timing where it matters: cancellation during work, late results, restart, partial upload acknowledgement, withdrawal or deletion. Control that state explicitly rather than hoping repeated runs exercise it.

Product decisions can supersede old assertions. Explain the old/new behavior and remove obsolete tests in the same change. Do not weaken valid assertions, timeouts, scale or tested entrypoints merely to turn failure green. Tests named `performance` or `migration` may protect correctness; classify by what they establish and retain their required coverage when splitting suites. Moving a failing test to a manual suite does not resolve its failure.

Use module `AGENTS.md` for commands and [testing guidance](../../../docs/testing.md) as the single source for layers and triggers. Distinguish local units, real module SQLite/HTTP, light producer/consumer contracts, heavy cross-client E2E, scale correctness, pure benchmarks and real external models. Batch coherent edits, use focused feedback and add light contracts when interfaces change. Connect one shortest real journey early for a large requirement; complete relevant acceptance at stage completion and before release, with heavy suites explicitly selected manually. Reuse unchanged successful results.

Follow the review boundary in [testing guidance](../../../docs/testing.md#risk-based-review): changed product or architectural decisions need independent review; module fixes within an established contract need corresponding risk regressions. PRs record behavior changes, actual checks and untested risks; do not create extra ledgers.

Report fixture, physical-device and live-model results separately. Keep verbose output in ignored logs, preserving command exit status.
