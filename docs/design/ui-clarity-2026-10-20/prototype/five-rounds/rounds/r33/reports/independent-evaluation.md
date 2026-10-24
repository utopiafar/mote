# R33 independent evaluation

**Decision: FAIL. Mean: 72.708/100.**

| Platform | New user | Function | Simplicity | Clarity | Design | Craft | Originality | /100 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| web | 3 | 2.5 | 3 | 2.75 | 3 | 2.75 | 3 | 71.25 |
| mac | 3 | 2.5 | 3 | 3 | 3 | 3 | 3 | 72.5 |
| android | 3 | 2.5 | 3.25 | 3 | 3.25 | 3 | 3 | 74.375 |

A score does not override a failed gate. Unverified required assertions remain incomplete.

## Findings

### R33-01 — An archived recording audio backup still has no visible opening control

The ordinary Feishu catalog entry is repaired. Its transcript can be read while audio backup fails; retry succeeds and displays one archived audio backup. The audio result row and expanded saved-items/checkpoint disclosure still provide no audio detail or original opening control. Only transcript links are available in the exercised flow.

**Correction:** Give the actual archived audio item a named opening/download path with its source, original availability and processing state; verify it from the ordinary catalog flow.

**Evidence:** [15-recording-stages.json](evidence/web/changed/15-recording-stages.json), [16-recording-text.json](evidence/web/changed/16-recording-text.json), [18-recording-audio-retry.json](evidence/web/changed/18-recording-audio-retry.json), [20-recording-checkpoint.json](evidence/web/changed/20-recording-checkpoint.json), [21-recording-result-fixtures.json](evidence/web/changed/21-recording-result-fixtures.json)

### R33-02 — Calendar task notices leak into other action pages

After refreshing revoked review-device authorization, the device-refresh notice appears on a separate suggestion review. After verifying an uncertain calendar event, the same-event verification notice appears on the ordinary todo page. The underlying state transitions remain sound, but the message is detached from its owning task.

**Correction:** Scope transient action notices to their originating task and clear them when navigating to a different action workspace.

**Evidence:** [45-discovery-refreshed.json](evidence/web/changed/45-discovery-refreshed.json), [46-calendar-review.json](evidence/web/changed/46-calendar-review.json), [16-calendar-verified-original.json](evidence/web/calendar/16-calendar-verified-original.json), [18-todos.json](evidence/web/calendar/18-todos.json)

### R33-03 — Selected-file retention copy still says selected directory

Mac and Android selected-file tasks explicitly restrict authorization to named files and exclude the containing directory. Their retention explanation still says the original files in the selected directory are retained, including in the confirmation. This is a minor wording inconsistency on an otherwise working selected-file flow.

**Correction:** Use selected-file wording on this task while keeping directory wording on folder collection.

**Evidence:** [04-native-selected-files.json](evidence/mac/files/04-native-selected-files.json), [09-files-review.json](evidence/mac/files/09-files-review.json), [03-file-task.json](evidence/android/files/03-file-task.json), [10-file-review.json](evidence/android/files/10-file-review.json)

### R33-04 — The named R32 status defects have current regression evidence

Google Calendar now reports a saved range and archived results without the obsolete no-scope/pre-sync message. MCP repeats report new 0 / duplicate 1 for that attempt. Mac capture stop now displays a stopped/paused notice while preserving sending pause. The Feishu ordinary recording entry includes independent authorization and source acknowledgment. DingTalk completion was not independently credited in this focused round.

**Correction:** Preserve these observed transitions while repairing the remaining audio and task-notice defects.

**Evidence:** [28-google-scope-saved.json](evidence/web/changed/28-google-scope-saved.json), [29-google-synced.json](evidence/web/changed/29-google-synced.json), [38-mcp-selected-repeat.json](evidence/web/changed/38-mcp-selected-repeat.json), [13-recording-dirty-blocked.json](evidence/web/changed/13-recording-dirty-blocked.json), [14-recording-context-reack.json](evidence/web/changed/14-recording-context-reack.json), [15-capture-paused.json](evidence/mac/native/15-capture-paused.json), [16-send-still-paused.json](evidence/mac/native/16-send-still-paused.json)

### R33-05 — Fixed calendar review binds real choices and recovers the original event

Custom all-day dates, timezone, location, notes and target calendar survive fixed review. A changed evidence version withdraws old approval and keeps the edited draft. After new approval, a lost receipt is resolved by verifying the same synthetic event and operation IDs. Ordinary no-due todos complete and reopen separately.

**Correction:** Keep the precise fixed-review and existing-event recovery pattern; other action kinds and native shared variants remain explicitly untested.

**Evidence:** [05-invalid-all-day-range.json](evidence/web/calendar/05-invalid-all-day-range.json), [06-fixed-review.json](evidence/web/calendar/06-fixed-review.json), [08-review-stale.json](evidence/web/calendar/08-review-stale.json), [10-refixed-v2.json](evidence/web/calendar/10-refixed-v2.json), [14-calendar-uncertain.json](evidence/web/calendar/14-calendar-uncertain.json), [16-calendar-verified-original.json](evidence/web/calendar/16-calendar-verified-original.json), [23-todo-reopened.json](evidence/web/calendar/23-todo-reopened.json)

### R33-06 — Scoped maintenance has meaningful file, operation and retained-evidence behavior

A downloaded portable3 fixture is rejected after changing its account; the correct file resumes the same partially completed operation after browser reload and re-selection. Index publication stops on failed authorization recheck. A seven-day diagnostic export truthfully contains only October 22 retained events with partial coverage. Turning off detailed trace capture preserves old traces; an unknown run shows no trace.

**Correction:** Preserve the scoped results and original-operation recovery. Cancellation/paging variants and untouched encryption, decryption, retention, statistics and export families remain untested.

**Evidence:** [03-same-account-selected.json](evidence/web/maintenance/03-same-account-selected.json), [04-reload-no-reset.json](evidence/web/maintenance-reload/04-reload-no-reset.json), [05-retry-without-file-blocked.json](evidence/web/maintenance-reload/05-retry-without-file-blocked.json), [06-retry-same-operation.json](evidence/web/maintenance-reload/06-retry-same-operation.json), [15-index-publication-blocked.json](evidence/web/maintenance-reload/15-index-publication-blocked.json), [25-diagnostic-week-export.json](evidence/web/maintenance-reload/25-diagnostic-week-export.json), [28-trace-off.json](evidence/web/maintenance-reload/28-trace-off.json), [30-old-trace-retained.json](evidence/web/maintenance-reload/30-old-trace-retained.json), [31-unknown-trace-absent.json](evidence/web/maintenance-reload/31-unknown-trace-absent.json)

### R33-07 — Native selected files, receipts and mobile hierarchy improve without proving completeness

Mac selects two independent files, confirms a local-only task and blocks unconnected sending. Android selects one file and holds it pending context acknowledgment. Dirty drafts remain on Continue editing. Mac receipt date filters obey both endpoints, and actual-content navigation returns to the same receipt. Fresh three-platform primary pages render without horizontal overflow; mobile Library removes its repeated title. Full 188-feature completeness remains unverified.

**Correction:** Retain these focused transitions and the simpler mobile title; do not convert route availability or untested variants into feature passes.

**Evidence:** [09-files-review.json](evidence/mac/files/09-files-review.json), [13-two-files-queued.json](evidence/mac/files/13-two-files-queued.json), [14-unconnected-send-blocked.json](evidence/mac/files/14-unconnected-send-blocked.json), [22-receipt-after-end-excluded.json](evidence/mac/files/22-receipt-after-end-excluded.json), [23-receipt-before-start-excluded.json](evidence/mac/files/23-receipt-before-start-excluded.json), [24-receipt-boundary-included.json](evidence/mac/files/24-receipt-boundary-included.json), [29-return-exact-receipt.json](evidence/mac/files/29-return-exact-receipt.json), [30-return-filtered-list.json](evidence/mac/files/30-return-filtered-list.json), [09-draft-preserved.json](evidence/android/files/09-draft-preserved.json), [11-file-committed.json](evidence/android/files/11-file-committed.json), [14-file-original.json](evidence/android/files/14-file-original.json), [library.png](evidence/android/major/library.png)

## Evidence scope

- Only frozen R33 HTML is evaluated. Candidate bytes are read solely for hashing; candidate implementation, hidden app state and storage are not scoring evidence.
- The unchanged independently audited 188-feature contract, 188 representative journeys and frozen weights are authoritative. Every applicable unmentioned assertion remains untested.
- This is the requested bounded changed-family review. R31/R32 observations are not silently copied as current-round passes; full import, model, attribution, invitation and other unchanged journeys were not repeated.
- Current Web Central checks do not establish the equivalent shared native workflows. Current native selected-file checks do not establish physical-device permissions or real filesystem access.
- No backend, live model, live OAuth, real calendar write, real native permission or real archive service was used. All content and exported files are explicitly synthetic fixtures.
- A portable3 fixture and a diagnostic bundle were actually downloaded and inspected as user-visible outputs; an account-mismatched synthetic copy was supplied via the ordinary file input. No hidden application data was read or changed.
- No page exception or document-width overflow was observed in the exercised current evidence. Full keyboard, screen-reader, localization, dark-mode and every disclosure coverage were not repeated.
- The no-Central-local-collection result is supported by evaluated home/source/catalog/storage surfaces and collector-owned file confirmations; it does not claim an exhaustive unchanged-route survey.
- Zero complete feature passes in a focused round, if produced by the assertion table, reflects untested or partial required branches and is not a claim that all untested functionality is absent.

## Coverage and identity

- [Feature assertions](feature-coverage.json)
- [Journey coverage](journey-coverage.json)
- [Complete scores, gates, and artifact identities](independent-evaluation.json)

