# R29 independent baseline evaluation

**Decision: FAIL.** The baseline is a focused diagnostic, not an exhaustive acceptance run. It confirms missing import metadata and the prohibited central-directory responsibility on all three prototypes.

| Platform | New user | Function | Simplicity | Clarity | Design | Craft | Originality | Weighted /100 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| web | 2.5 | 1.5 | 2.5 | 2 | 3 | 2.5 | 2.5 | 56.875 |
| mac | 2.5 | 1.5 | 2 | 2 | 3 | 2.5 | 2.5 | 54.375 |
| android | 2.5 | 1.5 | 1.75 | 2 | 2.5 | 2.5 | 2 | 51.25 |

Mean: **54.167/100**. Each platform fails the required thresholds, semantic-completeness gate, and central-collection gate. The fixed weights are 25/20/20/15/10/5/5; the complete anchored rubric is recorded separately.

## Confirmed findings

### B01 — Agent-understanding explanation is absent from input, completion, and detail

Only name, parser, save mode, and image plan are represented. There is no optional freeform explanation or saved explanation/revision path.

**Next correction:** Restore the existing optional 12,000-character prose field with concise examples. Preserve the exact multiline text and quote roles through input, review, edit, saved detail, and regeneration of the same task.

**Evidence:** [02-import.json](../evidence/web/02-import.json), [05-import-detail.json](../evidence/web/05-import-detail.json), [01-import.json](../evidence/mac/focused/01-import.json), [03-import-detail.json](../evidence/mac/focused/03-import-detail.json), [01-import.json](../evidence/android/focused/01-import.json), [03-import-detail.json](../evidence/android/focused/03-import-detail.json)

### B02 — Central-server directory intake remains visible

All three import forms offer 中央目录. Web empty home describes connecting a 工作台服务器 folder.

**Next correction:** Remove all central-local directory collection and sync controls, guide entries, fixtures, and cross-links. Retain one-time browser file/folder upload and device-owned Mac/Android collectors.

**Evidence:** [01-home.json](../evidence/web/01-home.json), [02-import.json](../evidence/web/02-import.json), [01-import.json](../evidence/mac/focused/01-import.json), [01-import.json](../evidence/android/focused/01-import.json)

### B03 — Repeated instruction and secondary panels compete with the immediate task

Import repeats one-time/sync distinctions in the description and a prominent callout; on Android these consume most of the first screen before file selection. Native source dashboards show large local-collector cards above a repeated connected-source list.

**Next correction:** Keep a concise task explanation, primary selection action, and on-demand options. Use one source list with clear device ownership and contextual controls.

**Evidence:** [01-import.png](../evidence/mac/focused/01-import.png), [03-sources.png](../evidence/mac/survey/03-sources.png), [01-import.png](../evidence/android/focused/01-import.png), [06-sources.png](../evidence/android/focused/06-sources.png)

### B04 — The import detail is too shallow to establish the source contract

The detail shows selected file, name, save mode, simplified parser, device, and image scheme. It does not establish installed Source Pack/version, file-by-file dispositions, or separate original/interpretation/publication/memory stages.

**Next correction:** Expose the audited interpretation and recovery detail at the decision point. Show source-specific selected values and outcomes; a generic settings modal or success toast cannot substitute.

**Evidence:** [05-import-detail.json](../evidence/web/05-import-detail.json), [03-import-detail.json](../evidence/mac/focused/03-import-detail.json), [03-import-detail.json](../evidence/android/focused/03-import-detail.json)

## Scope and evidence limits

- Only rendered DOM, screenshots, and ordinary fixture UI interactions were used. Candidate JavaScript and hidden state were not inspected.
- This baseline establishes the known regressions and visual starting point. It does not claim complete inspection of 188 features or all adversarial journeys.
- Native permissions, real backend execution, physical devices, live models, and production were not run.
- An apparent disclosure-collapse defect was excluded: DOM-only timing checks stayed open; full-page screenshot capture altered the UI. Subsequent captures use viewport screenshots and observe DOM before capture.

## Identity

- Product source: `81a73c0ec81af876d6eeef71451b75cd51684b34`.
- Contract: `316d7ac7ea6577c4a6d28c526f6e27ad56d33c7a9afd60db4b74466e88791572`.
- Rubric: `58826132bd1d4c70690567482902b7ef7dac89e32f7fc727a643ce3d213abb7c`.
- Candidate hashes and viewport sizes are in [independent-evaluation.json](independent-evaluation.json).
- Every named contract feature receives an honest status in [feature-coverage.json](feature-coverage.json); untested assertions are not treated as working features.

The initial numerical draft was calibrated after completing comparable Mac and Android observations; these saved scores are the baseline of record.

Final contract provenance includes the explicit shared-workspace applicability clarification and one source-anchor correction. The baseline already used that applicability, so its scores and findings did not change.
