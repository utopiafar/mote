# R31 independent evaluation

**Decision: FAIL. Mean: 69.375/100.**

| Platform | New user | Function | Simplicity | Clarity | Design | Craft | Originality | /100 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| web | 3 | 2.5 | 2.75 | 2.75 | 3 | 2.75 | 3 | 70.0 |
| mac | 3 | 2.5 | 2.75 | 2.5 | 3 | 2.75 | 3 | 69.062 |
| android | 3 | 2.5 | 2.75 | 2.5 | 3 | 2.75 | 3 | 69.062 |

A score does not override a failed gate. Unverified required assertions remain incomplete.

## Findings

### R31-01 — The retained import and model-recovery loop now completes on every platform

Exact multiline attribution context survives selection, edit, navigation, re-preview, confirmation, saved detail and material. Dirty confirmation is disabled. The correct import module is selected, the non-default model ID persists, and the same retained task reaches saved records after recovery. ZIP is a container with two child records and a correct four-record total.

**Correction:** Keep these verified transitions; extend mixed media and exceptional-state coverage without weakening the context checks.

**Evidence:** [10-revised-draft.json](evidence/web/import-complete/10-revised-draft.json), [15-detail-expanded.json](evidence/web/import-complete/15-detail-expanded.json), [22-model-recovered-confirmed.json](evidence/web/import-complete/22-model-recovered-confirmed.json), [22-model-recovered-confirmed.json](evidence/mac/import-complete/22-model-recovered-confirmed.json), [22-model-recovered-confirmed.json](evidence/android/import-complete/22-model-recovered-confirmed.json)

### R31-02 — Closing a live invitation removes its management entry, and QR export is absent

Generated invitation inputs and JSON persist, expiry and cancellation are explicit, and cancellation disables transfer. After Close details and browser Back, the existing invitation is no longer displayed or reopenable; only generating a new invitation is offered. There is no Save QR image control, although it is a required contract action.

**Correction:** Retain an active invitation summary with an explicit reopen/cancel path and restore the simulated QR export path alongside JSON fallback.

**Evidence:** [25-invitation-json.json](evidence/web/stateful/25-invitation-json.json), [26-invitation-closed.json](evidence/web/stateful/26-invitation-closed.json), [27-invitation-return.json](evidence/web/stateful/27-invitation-return.json), [28-invitation-cancelled.json](evidence/web/stateful/28-invitation-cancelled.json)

### R31-03 — Native source status contradicts the connection and conflict state

Mac and Android Sources report the folder as synchronizing while native sending states that Central is unconnected and content remains local. Android preserves and resolves a source-context conflict, but the source continues to say synchronizing while the conflict is unresolved. Capture can be stopped while a prior started notice remains visible.

**Correction:** Show collection, queued sending, Central receipt and context conflict as separate current states; update the shared source summary from those same states and make affected-file holding visible.

**Evidence:** [18-upload.json](evidence/mac/native/18-upload.json), [21-capture-paused.json](evidence/mac/native/21-capture-paused.json), [02-folder.json](evidence/android/native/02-folder.json), [08-context-conflict.json](evidence/android/native/08-context-conflict.json), [11-upload.json](evidence/android/native/11-upload.json)

### R31-04 — A text document is presented as a timed speaker transcript

The Markdown fixture 研究资料/记忆系统.md receives 0–6s · S1 and subsequent timed speaker segments under file processing. The manual correction and raw-text lineage work, but audio timing and speaker semantics are inappropriate for this file kind.

**Correction:** Use text extraction and text revisions for documents; expose timing, speakers and transcription controls only for suitable audio/video fixtures.

**Evidence:** [42-file-processing.json](evidence/web/stateful/42-file-processing.json), [43-transcript-editor.json](evidence/web/stateful/43-transcript-editor.json), [45-transcript-lineage.json](evidence/web/stateful/45-transcript-lineage.json), [46-corrected-body.json](evidence/web/stateful/46-corrected-body.json)

### R31-05 — Sources is clearer, while Library still spends attention on repeated structure

Native Sources now shows one source list with useful local settings links, and both native source rows are visible on a 390-pixel Android screen. Populated desktop Library still has a long second category rail. Mobile Library repeats product orientation, a title and a category heading before the first result; advanced settings expand into long task mixtures.

**Correction:** Consolidate uncommon desktop categories behind a named disclosure and shorten repeated orientation on populated screens while retaining the actual semantic controls.

**Evidence:** [01-library.png](evidence/web/survey/01-library.png), [03-sources.png](evidence/mac/survey/03-sources.png), [01-library.png](evidence/android/survey/01-library.png), [03-sources.png](evidence/android/survey/03-sources.png)

### R31-06 — Context, privacy and account semantics improve, but the full contract is not verified

Web source ACK/conflict and material-precedence transitions work; switching to a second account shows an empty library; Ask reconnects and returns from citations; invalid model JSON and changed-host credential reuse are blocked. Mac permission/return, privacy-rule save and held-record release are exercised. Android send conditions block charging, metered network and low-battery cases. Many contract variations and other families remain untested, and Android resend has no eligible queue data.

**Correction:** Keep explicit partial/untested coverage, add meaningful nonempty generated queues and exercise remaining semantic journeys before any completeness claim.

**Evidence:** [13-source-conflict-return.json](evidence/web/stateful/13-source-conflict-return.json), [18-material-override.json](evidence/web/stateful/18-material-override.json), [21-material-follow-source.json](evidence/web/stateful/21-material-follow-source.json), [33-switched-library.json](evidence/web/stateful/33-switched-library.json), [39-ask-return.json](evidence/web/stateful/39-ask-return.json), [41-ask-back-from-citation.json](evidence/web/stateful/41-ask-back-from-citation.json), [54-invalid-json.json](evidence/web/stateful/54-invalid-json.json), [56-destination-change.json](evidence/web/stateful/56-destination-change.json), [09-capture-running.json](evidence/mac/native/09-capture-running.json), [15-held-after-policy.json](evidence/mac/native/15-held-after-policy.json), [17-held-released.json](evidence/mac/native/17-held-released.json), [19-waiting-charge.json](evidence/android/native/19-waiting-charge.json), [21-resend-blocked.json](evidence/android/native/21-resend-blocked.json), [22-waiting-wifi.json](evidence/android/native/22-waiting-wifi.json), [23-waiting-battery.json](evidence/android/native/23-waiting-battery.json), [25-queue-result.json](evidence/android/native/25-queue-result.json)

## Evidence scope

- Frozen R31 HTML only. All three hashes were independently checked against manifest.json. Candidate source/internal application state was never read for scoring.
- The independent 188-feature contract and unchanged weighted rubric are authoritative. Generator changes.json was used only to select regression risks; its verification claims were not evidence.
- All 188 features and 188 representative journeys receive explicit statuses. Partial and untested assertions fail completeness; no directory destination, route count or generic toast is counted as a full feature pass.
- Headless Chrome 134.0.6998.165, generated fixtures and DOM-before-viewport screenshots. No live backend, native collection, physical permissions, OAuth, actual pairing or live model validation.
- The exact retained import and model-recovery journey completed independently on all three platforms. Context/Central workflows were exercised primarily on Web; Mac capture/privacy and Android source/connection/send conditions were exercised separately. Unexercised platform variations remain untested.
- Model credential examples are synthetic. The Android queue contained no eligible records, so condition messages and blocked confirmation are evidence, not proof of payload retention/delivery.
- English/dark model settings were checked on Web; full language, keyboard, screen-reader and accessibility coverage was not completed.

## Coverage and identity

- [Feature assertions](feature-coverage.json)
- [Journey coverage](journey-coverage.json)
- [Complete scores, gates, and artifact identities](independent-evaluation.json)

