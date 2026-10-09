# ADR: Unified query, bounded automatic Memory and isolated execution

Date: 2026-10-10. Status: accepted by the owner; implementation validation is recorded separately.

The normal query path directly retrieves and verifies evidence. The same durable
query coordinator may delegate independent research when the model chooses it.
There is one user entry point and no semantic keyword router or fast/deep mode.
The default tool declaration contains a small typed read-only core and native
image tools. Other trusted registered capabilities are discovered on demand and
executed with host-validated JSON arguments. A trusted test-only all-native arm
uses the same prompt, evidence policy and model to compare total round trips.

Material reads may return bounded, permitted original sourceEvidence alongside
the material page. Only successfully delivered original ranges enter the current
fragment's citation ledger. Private lineage, summaries, saved workspace locators
and child results cannot grant citations. A bounded encrypted research workspace
uses the existing delegation journal and atomic yield; resumed fragments must
revalidate and receive cited originals again.

Ordinary ready automatic Memory inputs enter bounded structural work packages
without a mandatory model planner. Packing uses exact recipe and input contracts,
existing member/text budgets and source fairness. It does not decide semantic
relatedness or wait to fill a package. Each member keeps its receipt contextTime,
attribution and evidence range. Full coverage and capacity are validated for every
target. Saturated uncommitted batches are subdivided without dropping checked
targets. Existing accepted proposals and genuine needs_context feedback retain
their scoped planning path.

Independent review remains mandatory, including packages with no candidates.
Coding understanding candidates may replace extraction only under the exact full,
unsaturated generation contract. A valid extraction draft survives reviewer
validation failure; retries repair the failed stage while rechecking current
evidence, recipe, model and deletion policy. Existing cache retention and evidence
resource locks remain unchanged.

The single ExecutionEngine admits delegated work in separate trusted background
and interactive lanes. Children inherit their parent's registered profile lane.
Background effective capacity is min(agentConcurrency, 32); interactive capacity
is interactiveConcurrency. There is no preemption or capacity borrowing. Existing
Agent and Harness gates also retain separate lanes. Provider cooldowns are shared
by endpoint identity; no new global provider concurrency gate is introduced.

| Classification | Disposition |
| --- | --- |
| KEEP | Read-only queries, untrusted content, scopes, versions, exact quotations, grants, independent review, atomic batch commit, fences, cancellation, deletion, retention, bounded retries and one engine. |
| CHANGE | Direct-first query prompt, smaller declarations, delivered source ranges, durable bounded workspace, rolling direct Memory packages, exact Coding reuse, reviewer-stage recovery and complete lane isolation. |
| REMOVE | Mandatory automatic planner, routine delegation instruction, workPackage-wide reuse exclusion and unconditional draft deletion on reviewer validation errors. |
| EXCEPTION | Scoped accepted plans/needs_context, incomplete or saturated products, unavailable media, explicit historical work and mismatched generation identities use their existing guarded paths. |
| UNKNOWN | Broad production semantic recall and latency distributions, provider-internal API counts and physical device behavior require separate observation. |

This narrows the planning responsibility in [proposal lifecycle](adr-memory-proposal-lifecycle.md)
and extends [batch context](adr-memory-batch-context.md). It preserves [attribution](adr-material-attribution.md),
[private lineage](adr-material-disclosure-lineage.md), [manual selected outputs](adr-manual-memory-selected-outputs.md)
and the [epoch 4 baseline](adr-mvp-baseline.md). Optional workspace/semantic metadata
does not renew old grants; productsVersion 2 is reused only by its exact reader
contract. No historical vault is migrated or reset by this change.

The [module proposal](design/system-refactor-2026-10-10.md) and
[journey matrix](design/system-refactor-validation-2026-10-10.md) define the scope.
Release notes and the dated validation record report what was actually executed.
