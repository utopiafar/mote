# R30 independent evaluation

**Decision: FAIL. Mean: 61.562/100.**

| Platform | New user | Function | Simplicity | Clarity | Design | Craft | Originality | /100 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| web | 3 | 1.75 | 2.75 | 2.5 | 3 | 2.25 | 2.5 | 64.062 |
| mac | 2.75 | 1.75 | 2.5 | 2.5 | 3 | 2.25 | 2.5 | 61.25 |
| android | 2.75 | 1.75 | 2.25 | 2.5 | 2.75 | 2.25 | 2.5 | 59.375 |

A score does not override a failed gate. Unverified required assertions remain incomplete.

## Findings

### R30-01 — Confirmation silently discards the edited import explanation

Reproduced independently on all three platforms. After changing the review textarea, Confirm remains enabled and saves the earlier explanation. The revised vendor-ownership correction disappears from the saved detail.

**Correction:** Block confirmation while explanation is dirty, or require an explicit re-preview that uses the revised prose and retains the same task.

**Evidence:** [11-confirm-with-dirty-draft.json](evidence/web/dirty-context/11-confirm-with-dirty-draft.json), [11-confirm-with-dirty-draft.json](evidence/mac/journeys/11-confirm-with-dirty-draft.json), [11-confirm-with-dirty-draft.json](evidence/android/dirty-context/11-confirm-with-dirty-draft.json)

### R30-02 — Model-required recovery returns to an unresolved task

All three platforms preserve task identity and context, but the recovery screen edits the question model, reverts Local Processing on Save, and returns to Waiting for model configuration.

**Correction:** Identify the missing import module, persist the saved model assignment, and enable same-task continuation after the simulated readiness change.

**Evidence:** [26-model-saved.json](evidence/web/journeys/26-model-saved.json), [27-return-same-task.json](evidence/web/journeys/27-return-same-task.json), [19-model-saved.json](evidence/mac/normal-import/19-model-saved.json), [20-return-same-import.json](evidence/android/journeys/20-return-same-import.json)

### R30-03 — Per-file dispositions collapse into parsed records

The selected ZIP and both text inputs are all labeled parsed with one record each. No container, attachment, excluded, unsupported or separate-media outcome is demonstrated.

**Correction:** Use a meaningful mixed fixture with retained original paths, outcome reasons and counts; show failed audio/image stages independently from record publication.

**Evidence:** [17-files-detail.json](evidence/web/journeys/17-files-detail.json), [15-detail-expanded.json](evidence/mac/normal-import/15-detail-expanded.json), [15-detail-expanded.json](evidence/android/journeys/15-detail-expanded.json)

### R30-04 — Device invitation inputs and lifecycle are missing

The source screen offers two example connection buttons. Clicking Android immediately creates a connected device. No reachable Central address, connection name, existing-device identity, one-use invitation, expiry or cancellation is presented.

**Correction:** Restore the contract invitation preparation and transfer lifecycle with an explicit device-collection versus account-login distinction.

**Evidence:** [29-pairing.json](evidence/web/journeys/29-pairing.json), [30-pairing-request.json](evidence/web/journeys/30-pairing-request.json)

### R30-05 — Current source semantics are absent behind several reachable entries

The source editor lacks ACK/version/conflict recovery; Android lacks native description ACK/conflict; A30 still describes obsolete draft-only deployment; account settings omit password/switch/expiry and the one-day session option. Directory reachability therefore overstates feature coverage.

**Correction:** Implement the current-source inputs, transitions and state-specific results without presenting generic save feedback as completeness.

**Evidence:** [33-source-context-expanded.json](evidence/web/journeys/33-source-context-expanded.json), [74-A30.json](evidence/web/survey/74-A30.json), [survey.json](evidence/web/survey/survey.json), [survey.json](evidence/android/survey/survey.json)

### R30-06 — Import is simpler, but broader pages remain dense

The two-zone import is a clear improvement. The populated library still has a second long category rail, and native Sources repeats a large collection panel, explanatory copy, and connected-source list. Android places the source list below the first viewport.

**Correction:** Consolidate source status and actions into one list and keep uncommon library categories behind a named disclosure while preserving their task inputs.

**Evidence:** [01-library.png](evidence/web/survey/01-library.png), [03-sources.png](evidence/mac/survey/03-sources.png), [sources.png](evidence/android/major-populated/sources.png)

### R30-07 — The ordinary context journey and collection boundary are improved

All three platforms retain exact multiline import prose through re-preview, saved detail and material. Fixed parser and archive-only image choice remain visible. Web folder management explicitly sends collection setup to Mac or Android; browser-selected folders remain a one-time upload.

**Correction:** Keep these improvements while fixing dirty confirmation and recovery. Include a role-specific synthetic preview so vendor/AI quotations can be checked as output rather than only explained in copy.

**Evidence:** [22-material-context.json](evidence/web/journeys/22-material-context.json), [16-material-context.json](evidence/mac/normal-import/16-material-context.json), [16-material-context.json](evidence/android/journeys/16-material-context.json), [31-web-native-folder-handoff.json](evidence/web/journeys/31-web-native-folder-handoff.json)

## Evidence scope

- Frozen HTML only, source base 81a73c0ec81af876d6eeef71451b75cd51684b34. Candidate code/internal state was not read for scoring.
- Headless Chromium, viewport screenshots and visible DOM; no native runtime, backend, real file upload, live-model or provider validation.
- All 188 semantic features have explicit coverage rows. Unexercised assertions and journeys remain untested; 78 reachable directory entries are not treated as complete features.
- DOM was recorded before viewport screenshots; earlier full-page screenshot disclosure artifact is excluded.
- Critical import scenarios exercised separately on all three platforms. The remaining contract journeys were not all completed; this is an explicit failed completeness gate.

## Coverage and identity

- [Feature assertions](feature-coverage.json)
- [Journey coverage](journey-coverage.json)
- [Complete scores, gates, and artifact identities](independent-evaluation.json)

