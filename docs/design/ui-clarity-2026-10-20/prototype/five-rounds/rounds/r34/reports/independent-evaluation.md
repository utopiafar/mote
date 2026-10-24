# R34 independent evaluation

**Decision: FAIL. Mean: 74.063/100.**

| Platform | New user | Function | Simplicity | Clarity | Design | Craft | Originality | /100 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| web | 3.25 | 2.5 | 3.25 | 2.75 | 3 | 3 | 3 | 74.375 |
| mac | 3.25 | 2.5 | 3.25 | 2.75 | 3 | 3 | 3 | 74.375 |
| android | 3 | 2.5 | 3.25 | 2.75 | 3.25 | 3 | 3 | 73.438 |

A score does not override a failed gate. Unverified required assertions remain incomplete.

## Findings

### R34-01 — Missing browser bytes leave a stale Uploading heading on all three platforms

After an uploading item is interrupted by a normal browser reload, exact context, bytes and submission ID remain. The UI correctly requires the same files again and disables advancing the upload, but the row still says Uploading. Wrong files are rejected and the correct sample re-selection recovers; no false Central receipt or loss of explanation was observed.

**Correction:** Give missing local bytes an explicit primary state such as Files required; show prior progress separately until the same files are reselected.

**Evidence:** [20-session-file-missing.json](evidence/web/upload/20-session-file-missing.json), [22-wrong-files-rejected.json](evidence/web/upload/22-wrong-files-rejected.json), [23-original-reselected.json](evidence/web/upload/23-original-reselected.json), [08-after-browser-reload.json](evidence/mac/upload/08-after-browser-reload.json), [08-after-browser-reload.json](evidence/android/upload/08-after-browser-reload.json)

### R34-02 — The narrow first screen delays collection scope and its connection action

A fresh-context independent AI observer, shown screenshots before DOM and without the contract or earlier reviews, correctly identified purpose and the first import action on all platforms. At Android 390 by 844, however, the local-to-Central collection explanation is at the bottom edge and the connection action is below the first viewport. Web Central wording and the memory/insight relationship also require some inference. The 412 by 915 Library itself remains clear and free of horizontal overflow.

**Correction:** Keep the concrete first import action; shorten the example-card region or move a concise collector-scope line and named source action earlier on narrow screens. Use Central library consistently when explaining its role.

**Evidence:** [first-look.json](evidence/first-look/first-look.json), [android-first-use.png](evidence/first-look/android-first-use.png), [web-first-use.png](evidence/first-look/web-first-use.png), [library.png](evidence/android/major/library.png)

### R34-03 — Recording archives now have a real synthetic audio path and stable identity

Ordinary Feishu entry on Web/Mac and DingTalk on Android lead through independent authorization and context acknowledgment. Transcript remains readable while backup fails; retry creates a distinct audio detail. The downloaded WAV is 16044 bytes, mono PCM16 at 8000 Hz for one second, explicitly labeled as generated test audio. Native-layout play controls advance media time. Corresponding transcript and audio identities remain stable after disconnection.

**Correction:** Preserve the honest sample labeling and separate text/audio results; cancellation, unknown submission, all vendors and vendor-deletion variants remain unverified.

**Evidence:** [07-transcript-audio-split.json](evidence/web/recording/07-transcript-audio-split.json), [08-audio-backup-retried.json](evidence/web/recording/08-audio-backup-retried.json), [09-audio-original-detail.json](evidence/web/recording/09-audio-original-detail.json), [13-audio-provenance.json](evidence/web/recording/13-audio-provenance.json), [18-audio-after-disconnect.json](evidence/web/recording/18-audio-after-disconnect.json), [audio-example.inspection.json](evidence/web/recording/audio-example.inspection.json), [07-playback.json](evidence/mac/recording/07-playback.json), [10-audio-after-disconnect.json](evidence/mac/recording/10-audio-after-disconnect.json), [01-ordinary-catalog-entry.json](evidence/android/recording/01-ordinary-catalog-entry.json), [07-playback.json](evidence/android/recording/07-playback.json), [10-audio-after-disconnect.json](evidence/android/recording/10-audio-after-disconnect.json)

### R34-04 — Import context, same-task recovery and independent uploads retain user choices

All three normal import journeys preserve the optional 12000-character field, custom multiline explanation, selected parser/image plan and exact revised text through preview, save and material reading. Dirty explanation blocks confirmation. Model configuration selects the import module and returns to the same task. Web pauses one upload while another completes; all three recover the original submission after missing-file re-selection and retain the Central import after local queue removal.

**Correction:** Keep these explicit confirmations and identities. Do not infer support for untouched drag/folder/image, cancellation or every failure variant from these completed examples.

**Evidence:** [10-revised-draft.json](evidence/web/import/10-revised-draft.json), [13-file-options.json](evidence/web/import/13-file-options.json), [16-material-context.json](evidence/web/import/16-material-context.json), [22-model-recovered-confirmed.json](evidence/web/import/22-model-recovered-confirmed.json), [14-saved.json](evidence/mac/import/14-saved.json), [22-model-recovered-confirmed.json](evidence/mac/import/22-model-recovered-confirmed.json), [14-saved.json](evidence/android/import/14-saved.json), [22-model-recovered-confirmed.json](evidence/android/import/22-model-recovered-confirmed.json), [13-first-still-paused.json](evidence/web/upload/13-first-still-paused.json), [31-original-context-preserved.json](evidence/web/upload/31-original-context-preserved.json), [38-original-still-openable.json](evidence/web/upload/38-original-still-openable.json), [17-original-retained.json](evidence/mac/upload/17-original-retained.json), [17-original-retained.json](evidence/android/upload/17-original-retained.json)

### R34-05 — Calendar protection and ordinary cross-page notices are repaired; fixture limitations remain

Fixed all-day content and target bind to the evidence version. A changed source requires a new review, and final approval rejects an actually selected-and-then-revoked Mac target while preserving the title. Uncertain write recovery verifies the same original event. Its success notice no longer appears on ordinary todos, and discovery refresh no longer leaks to the suggestion list. A no-selected-device revoke fixture gave a generic authorization-change notice without revoking the target; a newly generated example review also displayed an earlier stale-evidence notice. These latter observations are confined to demo-fixture paths.

**Correction:** Keep actual revocation enforcement. Make fixture feedback conditional on a selected device, and clear or scope the stale-evidence notice when generating a different example suggestion.

**Evidence:** [02-fixed-review.json](evidence/web/calendar/02-fixed-review.json), [04-stale-evidence.json](evidence/web/calendar/04-stale-evidence.json), [09-target-revoked.json](evidence/web/calendar/09-target-revoked.json), [11-final-approval-rejected.json](evidence/web/calendar/11-final-approval-rejected.json), [13-uncertain.json](evidence/web/calendar/13-uncertain.json), [14-original-event-verified.json](evidence/web/calendar/14-original-event-verified.json), [15-todos-no-calendar-notice.json](evidence/web/calendar/15-todos-no-calendar-notice.json), [17-suggestion-no-discovery-notice.json](evidence/web/calendar/17-suggestion-no-discovery-notice.json), [19-new-target-test.json](evidence/web/calendar/19-new-target-test.json), [21-actual-review-device-selected.json](evidence/web/calendar/21-actual-review-device-selected.json), [22-selected-device-revoked.json](evidence/web/calendar/22-selected-device-revoked.json), [23-real-revocation-approval-blocked.json](evidence/web/calendar/23-real-revocation-approval-blocked.json)

### R34-06 — Native saved-file summaries are calmer and keep the collector boundary

Mac and Android now show one compact saved-file summary and named editing disclosure. Confirmation restricts scope to the named research excerpt and an unconnected local destination; copy says the selected files remain at their original location. A one-time save no longer promises another scan. Android retains its exact description draft and visibly waits for Central acknowledgment. The Web folder entry directs users to Mac/Android without a server path or watched-root control.

**Correction:** Retain the simplified summary and device-owned scope. Continuous folder permissions, offline restarts, receipt variants and sending policies were outside this final changed-family sample.

**Evidence:** [04-file-confirmation.json](evidence/mac/files-corrected/04-file-confirmation.json), [05-one-time-file-saved.json](evidence/mac/files-corrected/05-one-time-file-saved.json), [07-local-record-detail.json](evidence/mac/files-corrected/07-local-record-detail.json), [03-draft-preserved.json](evidence/android/files-corrected/03-draft-preserved.json), [04-file-confirmation.json](evidence/android/files-corrected/04-file-confirmation.json), [05-one-time-file-saved.json](evidence/android/files-corrected/05-one-time-file-saved.json), [07-local-record-detail.json](evidence/android/files-corrected/07-local-record-detail.json), [01-folder-collector-handoff.json](evidence/web/boundary/01-folder-collector-handoff.json)

### R34-07 — Usage, historical prices and retained Agent reads have substantive independent evidence

The separate Central subreview operated failed runs with known and unknown costs, separate USD/CNY totals, date/status filtering and pagination. Editing four current prices and currency survives reload without changing an earlier run’s USD price snapshot or estimate. Agent browsing, new-conversation preview and retained historical reads remain distinct; partial reads show captured ranges/failure/truncation, and an unknown run clears the previous trace. Mobile usage has a long heading/filter region before totals. The remaining family options stay explicitly partial or untested.

**Correction:** Preserve immutable historical receipts and clear unknown states; prioritize untested filters, directory/evidence variants and the source-ACK transition in a later verification cycle.

**Evidence:** [observations.json](central-independent/observations.json), [02-failed-unknown-run.json](central-independent/evidence/web/02-failed-unknown-run.json), [06-pricing-reloaded.json](central-independent/evidence/web/06-pricing-reloaded.json), [25-historical-price-expanded.json](central-independent/evidence/web/25-historical-price-expanded.json), [15-retained-read.json](central-independent/evidence/web/15-retained-read.json), [17-missing-trace.json](central-independent/evidence/web/17-missing-trace.json), [24-initial-context-preview.json](central-independent/evidence/web/24-initial-context-preview.json), [01-usage-entry.png](central-independent/evidence/android/01-usage-entry.png)

## Evidence scope

- Only frozen R34 candidate hashes are scored, against the unchanged independent 188-feature and 188-journey contract with fixed 25/20/20/15/10/5/5 weights. The inventory is a named semantic audit contract, not a claim to enumerate every source-code path.
- Every unmentioned applicable assertion stays untested. Partial or untested is not evidence that the feature is missing. No previous-round pass, generator self-check, route count or catalog presence is substituted for current semantic evidence.
- This final round is the requested bounded changed-family review. Whole-feature completeness and all critical journeys remain unverified, so the hard gates fail even where the exercised scenarios improve.
- All interactions use synthetic isolated HTML. No live account, backend, native permission, real filesystem collector, real calendar, vendor recording, model execution or production validation is claimed. User-visible WAV downloads and wrong-file synthetic uploads were actually exercised.
- The fresh-context first-look reviewer read three screenshots and froze observations before DOM, with no contract or prior review. It is an AI proxy, not human usability research, and platform order may influence later impressions. The separate Central reviewer had inherited context and its first-look is not described as blinded.
- Central usage/Agent findings are independently authored by /root/review_r31_r34/review_r34_central; only its current operated assertions are merged. Shared Web findings do not establish Mac/Android variants.
- The initial native-file harness wrongly expected an Android-only description field on Mac and the import sample filename on native tasks. Those initial timeouts/false booleans are retained under files; corrected visible-UI runs under files-corrected are authoritative. They are not product defects.
- Several Web REPL label guesses timed out and produced no snapshot. Captured states, not intended filenames, determine judgments: upload/24 is uploading and /25 is submitting; calendar/11-final-approval-rejected actually shows accepted because no reviewing device had been selected for its prior fixture. The actual selected-target rejection is calendar/23.
- Normal browser reload removes the evaluator-injected CJK font style. Subsequent DOM remains valid but affected PNGs are not evidence of product font quality. Fresh first-use/major/task and Central web-visual captures supply legible visual evidence. No full-page resize artifact is used for findings.
- No page exception or horizontal document overflow was observed in the exercised DOM evidence. Full accessibility, keyboard traversal, all resolutions, themes, translations and every disclosure were not verified.
- Web folder handoff, one-time browser imports, source catalog and native file confirmations support the evaluated no-Central-local-collection gate. This is not an exhaustive unchanged-route inspection.
- The functionality score remains below 3 because complete semantic coverage is required by the frozen rubric. The Android score may decrease due to a newly observed contradictory upload state; score progression is not assumed.

## Coverage and identity

- [Feature assertions](feature-coverage.json)
- [Journey coverage](journey-coverage.json)
- [Complete scores, gates, and artifact identities](independent-evaluation.json)

