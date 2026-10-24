# Independent evaluation rubric — R30–R34

**Frozen before R30:** 2026-10-22 14:20:31 UTC. **ID:** `mote-r30-r34-independent-v1`.

**Evaluator:** `/root/r30_34_independent_review`. **Product base:** `81a73c0ec81af876d6eeef71451b75cd51684b34`.

The authoritative criterion definitions and all 0–4 anchors are in [rubric-independent.json](rubric-independent.json). The inventory agent's `user-features.json`, `journeys.json`, and `source-semantics.md` determine product completeness. Generator route lists and earlier scorecards do not replace that contract.

| Criterion | Weight | Minimum on each platform | A score of 3 means |
|---|---:|---:|---|
| New-user understanding | 25% | 3 | A first-time user understands the next action, prerequisites, scope, and result throughout critical journeys. |
| Functional and semantic completeness | 20% | 3 | All required inputs, options, visible results, and transitions are verified; choices survive the required journey. |
| Simplicity and focus | 20% | 3 | Each screen has a clear purpose; details appear on demand without hiding or removing required capability. |
| Information and state clarity | 15% | 3 | Labels, values, outcomes, provenance, privacy boundaries, and pause scopes are accurate when needed. |
| Design quality | 10% | — | A coherent visual system produces clear hierarchy and appropriate platform adaptation. |
| Execution and interaction craft | 5% | — | Evaluated pages and disclosures render cleanly; controls, focus, scroll, and typography behave consistently. |
| Purposeful product character | 5% | — | Mote-specific design decisions improve context, provenance, collection, and review while retaining familiar patterns. |

The scale is 0–4 with quarter-point increments only when evidence explains the adjacent anchors. Platform scores equal the weighted sum of `score / 4`; the round score is the mean of all three platforms. There is no assumption that later rounds score higher.

## Hard gates

1. Web, Mac, and Android must each reach 3 in new-user understanding, functionality, simplicity, and clarity.
2. There must be zero omitted applicable required semantic features. An option, output, or transition is part of a feature, not an optional detail. A partial or untested required assertion blocks a completeness claim.
3. No surface may offer central-local folder collection, central watched roots, central scanning, or central enable-sync controls. One-time browser upload stays. Device-owned Mac and Android collectors stay.
4. All applicable critical journeys must complete through ordinary visible interactions. Merely finding a route or button does not satisfy a journey.
5. Browser prototype evidence must remain separate from backend, native permission, physical-device, live-model, and production claims.

## Evidence and review discipline

Each round uses a fresh frozen candidate and records its hashes. The evaluator inspects rendered DOM and screenshots and operates the UI as a user. Candidate source, hidden application state, storage, author-provided pass claims, and historical reviews cannot establish a score.

Every major page and disclosure is inspected on all platforms. Critical journeys verify stateful inputs and results, including import Agent metadata through correction, review, completion, and detail; central versus device-owned collection; privacy and pause scopes; and context/provenance flows specified by the independent inventory. Missing, partial, untested, verified, and explicitly not-applicable evidence are reported separately.

Use generated fixtures in isolated headless browsers. Material defects receive reproduction steps, visible evidence, and a concrete next correction. Scores cannot compensate for a failed hard gate. If a candidate fails, the report says so even if it looks better or is the final round.

## Method basis

The [Anthropic harness article](https://www.anthropic.com/research/harness-design-long-running-apps) supports separating generation from evaluation, making subjective criteria concrete, and checking granular contracts through live interaction. It also describes how attractive applications can retain missing core interactions and how evaluators can rationalize defects. This review therefore freezes criteria, treats semantic omissions as failures, and records evidence before scoring. The article informs the method; the user's product requirements determine scope and weights.
