# Independent bounded-plan review — R30–R34

**Reviewer:** `/root/r30_34_independent_review`  
**Review started:** 2026-10-22 14:20:31 UTC  
**Exact base/head at review:** `81a73c0ec81af876d6eeef71451b75cd51684b34`  
**Decision:** **APPROVE** the bounded plan in [iteration-plan.md](iteration-plan.md), reviewed before prototype implementation. This approval is limited to the exact base, prototype scope, feature-contract freeze, ownership, simulation exception, and validation boundaries recorded below. Any change to those decision boundaries needs a bounded delta review.

**Approved plan SHA-256:** `6dd535fd07b37567b7495e055fb73b89a94944e2d9266e5f3a6355b23d7e250b`  
**Frozen rubric JSON SHA-256:** `58826132bd1d4c70690567482902b7ef7dac89e32f7fc727a643ce3d213abb7c`

## Accepted review boundary

The task is five new, immutable rounds of three HTML prototypes. The generator owns prototype HTML/CSS/JavaScript and manifests. The independent inventory agent owns the source-audited feature and journey contract. This evaluator owns the frozen rubric, evaluation reports, and evidence. There are no production source, native runtime, backend, storage-schema, model, permission, or policy changes in this scope.

| Classification | Review expectation |
|---|---|
| KEEP | Real product capabilities, complete input-to-result journeys, user-configured privacy, distinct pause scopes, provenance and context attribution, one-time browser upload, and native device-owned file collectors. |
| CHANGE | Screen focus and information hierarchy on all three prototypes; restore every audited import metadata field and carry the selected values through edit, review, completion, and detail. |
| REMOVE | Central-local folder collection controls and their central-local scanner or sync implications everywhere in these prototypes. |
| EXCEPTION | Native and API effects are simulated with generated fixtures; prototype validation cannot prove native/backend/live-model operation. |
| UNKNOWN | The independent source audit, rather than historical route counts, resolves the remaining feature inventory and platform applicability before the first new candidate is evaluated. |

## Required plan refinements

The received plan explicitly incorporates the following requirements. They are execution conditions within the approved scope, not unresolved product decisions.

- Freeze the independent feature contract before R30 implementation. The plan must include any source-audit findings rather than relying on the old prototype's navigation list.
- Give each round an immutable candidate identity and preserve its report. Any repair after freezing becomes the next round, unless the frozen identity is explicitly withdrawn before evaluation and no scored evidence is silently replaced.
- Verify meaningful state transitions, including choosing non-default metadata, correcting it, reviewing it, completing the import, and finding the same values in detail. A metadata label alone is insufficient.
- Audit all major pages and disclosures for prohibited central collection controls. Preserve Mac/Android ownership labels and the separate browser one-time-upload path.
- Treat missing and partial required behavior as hard failures; do not improve simplicity scores by deleting features or pushing every routine action into menus.
- Use isolated headless browser sessions and generated fixtures. Record actual evidence and distinguish untested native/backend boundaries.

## Validation and resources

Use one generator, one independent source-inventory owner, and one independent evaluator. No additional implementation or review agents are needed. Root supplies an isolated static server and headless browser helper; the evaluator drives ordinary DOM interactions and screenshots without reading candidate application internals. The frozen rubric requires per-platform minimums and complete semantic coverage. Routine artifact parsing and link/hash checks are sufficient for these documentation/prototype outputs; no full application suite is implied.

## Risks

Progressive disclosure can conceal required options; UI fixtures can claim state changes that do not survive navigation; inherited labels can imply central collection; and high visual scores can conceal functional omissions. All four are explicit evaluator checks. If source audit contradicts the proposed scope or a new product policy is needed, return for a bounded delta review instead of silently changing the contract.

## Receipt note

The repository requests a Sol Medium/High reviewer receipt. This evaluator was assigned by the parent thread with its inherited model settings and cannot attest to a different model identity. The receipt records actual agent identity and does not fabricate a model selection.

## Ownership delta — 2026-10-22

**APPROVE** the generator's bounded delegation of native-specific prototype options, privacy, and upload UI to `/root/r30_34_native_ui`, with sole write ownership of `src/native-semantics.js` and `src/native-semantics.css`. Root remains integration owner and owns all other prototype source. The independent inventory and evaluator remain separate; the native helper cannot change contracts, rubric, scores, or evidence. This changes implementation ownership only, keeps the approved behavior and hard gates, and starts after the inventory freeze. It does not authorize real native collection or new product policy.

## Evidence-helper correction — 2026-10-22

Baseline full-page screenshots were followed by collapsed disclosures, while independent timed DOM-only observations kept those same disclosures open. Treat the collapse as an evidence-harness interaction, not a confirmed product defect. Evaluator captures now observe DOM before taking a viewport screenshot, avoiding full-page resize effects. Existing baseline observations remain preserved with this limitation; no assertion, acceptance standard, journey, or entry point is relaxed. This is a focused fixture/evidence correction within the approved plan.

## Contract freeze and applicability clarification

Final `user-features.json` SHA-256: `316d7ac7ea6577c4a6d28c526f6e27ad56d33c7a9afd60db4b74466e88791572`. Final `journeys.json` SHA-256: `a30546c750bc7281177985b9e993c9f1f1a163c93dad9ebc077cac9ec1badf1b`.

The independent audit contains 188 named semantic features and 188 representative adversarial journeys. Its final clarification states that `central-web` identifies implementation evidence: when Mac/Android prototypes expose the shared Central task, its UF semantics still apply. Native NAT applicability remains exact. The baseline already used this interpretation; its evidence and scores are unchanged. One original-deletion source anchor was also corrected without changing a required behavior. Neither clarification weakens a gate or waives a feature.

## Ownership delta 2 — R31 onward

**APPROVE** the generator's bounded delegation to `/root/r30_34_central_ui`, exclusively owning `src/central-semantics.js` and `src/central-semantics.css`. That helper covers audited shared Central semantic omissions outside root-owned import/context/connectors/calendar and outside native-helper local surfaces. Root remains integration owner; the inventory and evaluator retain exclusive contract/scoring ownership. R30 remains frozen and excludes both helper additions. This changes implementation ownership only; the same product scope, simulation boundary, requirements, and hard gates apply.
