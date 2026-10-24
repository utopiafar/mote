# R32 independent evaluation

**Decision: FAIL. Mean: 71.667/100.**

| Platform | New user | Function | Simplicity | Clarity | Design | Craft | Originality | /100 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| web | 3 | 2.5 | 3 | 2.75 | 3 | 2.75 | 3 | 71.25 |
| mac | 3 | 2.5 | 3 | 2.75 | 3 | 2.75 | 3 | 71.25 |
| android | 3 | 2.5 | 3 | 3 | 3 | 3 | 3 | 72.5 |

A score does not override a failed gate. Unverified required assertions remain incomplete.

## Findings

### R32-01 — Ordinary recording entries still lead to legacy forms

From Sources → Connect source → Recordings, both Feishu and DingTalk lead to old setup forms. Connection ID, separate authorization, source explanation acknowledgment and background-enable inputs are absent. The feature-directory recording entry returns to the same catalog. The expected staged workflow cannot be completed from these visible entries.

**Correction:** Connect the ordinary catalog and historical recording entries to the complete vendor workflow, then verify context acknowledgment before enabling intake and separate transcript/audio recovery from that same entry.

**Evidence:** [33-recording-catalog.json](evidence/web/changed/33-recording-catalog.json), [34-recording-entry.json](evidence/web/changed/34-recording-entry.json), [37-recording-directory-route.json](evidence/web/changed/37-recording-directory-route.json), [38-dingtalk-entry.json](evidence/web/changed/38-dingtalk-entry.json)

### R32-02 — Successful Google calendar intake retains obsolete status copy

After selecting Work, saving its range and synchronizing, the result shows one new read-only archived event. The header still says no reception range selected and the notice says the range is saved but not yet synced. Disconnect preserves the archived event as required.

**Correction:** Derive the header and current notice from saved selection and the latest completed sync result; keep authorization, scope, background intake and archive result separate.

**Evidence:** [27-google-scope-saved.json](evidence/web/changed/27-google-scope-saved.json), [28-google-synced.json](evidence/web/changed/28-google-synced.json), [29-google-result.json](evidence/web/changed/29-google-result.json), [30-google-management.json](evidence/web/changed/30-google-management.json), [32-google-retained.json](evidence/web/changed/32-google-retained.json)

### R32-03 — MCP repeat-import counts are labeled as this-attempt results

First import of one selected resource reports new 1 / duplicate 0. Repeating the same selection reports new 1 / duplicate 1 under This result, although Library contains one resulting resource material. The tools-only/no-resource state is explicit and truthful.

**Correction:** Show new 0 / duplicate 1 for the repeat attempt, or label genuinely cumulative totals separately from the current attempt.

**Evidence:** [42-mcp-no-resources.json](evidence/web/changed/42-mcp-no-resources.json), [46-mcp-one-imported.json](evidence/web/changed/46-mcp-one-imported.json), [47-mcp-one-duplicate.json](evidence/web/changed/47-mcp-one-duplicate.json), [82-library-after-grant-revoke.json](evidence/web/changed/82-library-after-grant-revoke.json)

### R32-04 — Capture stop retains a started notice

Mac capture starts after the generated permission return and uses the saved 45-second interval. After Pause capture, the main state is Stopped while the page still shows the prior Started with confirmed scope message. Sending pause remains independently preserved.

**Correction:** Replace or clear the prior start result when capture stops; retain separate capture and sending state.

**Evidence:** [07-capture-running.json](evidence/mac/native/07-capture-running.json), [14-capture-during-send-pause.json](evidence/mac/native/14-capture-during-send-pause.json), [15-capture-paused.json](evidence/mac/native/15-capture-paused.json), [16-send-still-paused.json](evidence/mac/native/16-send-still-paused.json)

### R32-05 — Import, context and native queue regressions preserve meaningful state

All three platforms retain exact multiline import interpretation through correction, confirmation and model recovery. Source context and material precedence work on all three. Android now shows pending acknowledgment offline, holds the conflicted folder, allows an unrelated saved note to receive ACK, then releases the folder only after explicit context resolution. Local-note failure/retry preserves one exact record.

**Correction:** Keep these transitions as regression evidence while extending only the still-unverified contract branches.

**Evidence:** [22-model-recovered-confirmed.json](evidence/web/import-complete/22-model-recovered-confirmed.json), [22-model-recovered-confirmed.json](evidence/mac/import-complete/22-model-recovered-confirmed.json), [22-model-recovered-confirmed.json](evidence/android/import-complete/22-model-recovered-confirmed.json), [17-note-repeat-save.json](evidence/android/local/17-note-repeat-save.json), [18-note-original.json](evidence/android/local/18-note-original.json), [20-context-resolve-offline.json](evidence/android/local/20-context-resolve-offline.json), [24-queue-partial-send.json](evidence/android/local/24-queue-partial-send.json), [26-folder-ack-after-context.json](evidence/android/local/26-folder-ack-after-context.json)

### R32-06 — Invitation management, document correction and targeted Central controls improve

An issued invitation can be reopened after closing; the synthetic QR image and JSON fallback are explicit. Markdown processing now uses untimed paragraphs and retained original text. Exact MIME rules outrank wildcard rules, dirty settings disable preview confirmation, and a current preview produces a named queue receipt. Read-all MCP grants and explicitly scoped write grants are distinct; hiding and selective revocation preserve unrelated grants and archive rows.

**Correction:** Preserve these specific improvements without treating unoperated options or routes as verified features.

**Evidence:** [08-invitation-reopen.json](evidence/web/changed/08-invitation-reopen.json), [11-invitation-qr-save.json](evidence/web/changed/11-invitation-qr-save.json), [52-document-correction.json](evidence/web/changed/52-document-correction.json), [54-document-lineage.json](evidence/web/changed/54-document-lineage.json), [64-exact-rule-match.json](evidence/web/changed/64-exact-rule-match.json), [67-dirty-policy-invalidates-preview.json](evidence/web/changed/67-dirty-policy-invalidates-preview.json), [69-reprocess-confirmed.json](evidence/web/changed/69-reprocess-confirmed.json), [76-write-grant-no-source.json](evidence/web/changed/76-write-grant-no-source.json), [77-write-grant-scoped.json](evidence/web/changed/77-write-grant-scoped.json), [81-grants-refreshed.json](evidence/web/changed/81-grants-refreshed.json)

### R32-07 — Library hierarchy is simpler, but contract completeness still fails

The long desktop category rail and repeated populated-home orientation are removed. Fresh three-platform screenshots show search and records as the main content, with types and filters in named disclosures. Mobile still repeats Library and leaves substantial vertical space above the first row. This focused round does not retest all unchanged families; every such assertion remains explicitly untested.

**Correction:** Keep the simpler hierarchy and finish remaining semantic workflows before any completeness claim. Do not infer a feature pass from the 78-entry directory or from these visual improvements.

**Evidence:** [library.png](evidence/web/major/library.png), [library.png](evidence/mac/major/library.png), [library.png](evidence/android/major/library.png), [sources.png](evidence/android/major/sources.png)

## Evidence scope

- Frozen R32 HTML only. All candidate hashes and unchanged contract/journey/rubric hashes were independently verified. No candidate source, hidden application state or storage was inspected for scoring.
- The independent 188-feature contract and fixed weights remain authoritative. All 188 features and all representative journeys receive explicit statuses; every unmentioned applicable assertion is untested.
- This is a bounded changed-family review, as requested: it does not repeat R31's whole directory survey. Earlier evidence is not silently carried forward as a current-round semantic pass.
- Meaningful current-round state transitions support the assertions. Finding a route, a label, a directory item or a generic success message alone is not a feature pass.
- Headless Chrome and generated HTML fixtures validate UI behavior only. No live account, backend, physical native collection, real OAuth/pairing, model execution or real system permission was validated.
- Three-platform import and shared source-context/attribution regressions are current evidence. Changed connector, file-rule and grant journeys were exercised primarily on Web; their native variants remain untested.
- There are no browser page errors or document-width overflows in captured current-round DOM. Full keyboard, screen-reader, localization and dark-mode coverage was not repeated.
- The QR and model/MCP credentials are explicitly synthetic. Export buttons were operated, but downloaded byte contents and clipboard contents were not inspected.
- No evaluated source surface offers Central-local folder scanning/sync controls; the Web source view reports device-owned sources. This gate statement is scoped to the evaluated surfaces, not an assertion that every untouched route was exhaustively explored.

## Coverage and identity

- [Feature assertions](feature-coverage.json)
- [Journey coverage](journey-coverage.json)
- [Complete scores, gates, and artifact identities](independent-evaluation.json)

