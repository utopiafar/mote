# Unified extraction and versioned memory review

This change closes MEM-01 and MEM-03 and supplies the independent action-cue input for ACT-03. It introduces no intent keyword dispatch. Models interpret original evidence and propose semantic relationships; the host checks exact original quotes, scope, evidence versions, bounded output, and explicit owner confirmation.

## Behavior

- A complete segment of at most 12,000 original text characters produces one shared artifact with a summary, events, memory candidates and calendar action cues. The JSON response is bounded to 64 KB. Empty candidate arrays are valid. Original archive search remains available for facts not selected into the artifact.
- Memory batches reuse candidates whose full original quote ranges fit the batch, then retain independent review. Partial ranges and legacy artifacts explicitly fall back to bounded original extraction. Action processing independently consumes complete artifacts before any memory is published, at most eight cues at a time, with a durable checkpoint. A cue may cite multiple observations in the segment. Empty action output does not invoke the relationship model. Long originals/file chunks without a complete segment retain bounded original processing.
- Actions use only quote spans plus the read-only, paged prior-action catalog to decide duplication or update/cancel/complete relationships. All semantic proposals still need owner/device confirmation. They do not have calendar mutation tools.
- Memory relationships contain a target ID, fingerprint and version. Contradictions preserve both claims; supersession is applied only by a version-bound owner publication. Project scope cannot acquire another project or automatically promote a session to a project/global rule. Original and replacement records remain separately readable.
- Current memory reads respect explicit validity dates and confirmed supersession. `includeHistory` and `asOf` support historical inspection. Direct references retain access to the historical content. A correction replaces its specified claim, not unrelated facts in its original source.
- Owner corrections atomically create an original user note and a new confirmed memory, preserving the selected memory's project/session applicability. A concurrent or stale correction loses without leaving a stray note. Automatic extraction cannot overwrite that confirmation. External capture/note routes reject the host-owned correction metadata field before any batch member is written.
- The memory UI previews relationships and validity, confirms an exact version, supports correction and historical navigation, and refreshes its time boundary after adding a correction. This fixed an observed renderer failure where the newly created correction fell outside the page's old `before` timestamp.
- Large shared artifacts expose summary, original citation IDs and product counts within the ordinary 24 KB detail budget. Duplicated candidate bodies are omitted from this read projection and remain available to the dedicated consumers; the projection marks the omission.

## Focused verification

The work used small fixtures first and grouped related fixes, with no full-suite run by this subtask.

- `apps/server/test/memory-revisions.test.ts`: 6 cases, including explicit confirmation, old/current/as-of lookup, contradiction, stale version refusal, owner attribution, project scope, and concurrent correction rollback.
- `apps/server/test/semantic-products.test.ts`: 6 cases, including one shared extraction feeding memory/action consumers, zero-product handling, exact evidence and output budgets, model configuration changes, multi-original cues, and readable large-artifact projection.
- `apps/server/test/memory-owner-boundary.test.ts`: forged correction metadata cannot enter through a single capture or mixed batch; ordinary notes remain accepted.
- Existing action, coding-memory, model-configuration and bounded read-model tests passed in targeted groups. Server/Web builds and type checks passed during the implementation; final integration validation is owned by the release task.
- `scripts/test-memory-revisions-ui.cjs`: real Electron renderer and API passed version-bound confirmation, correction, current/history lists, old/new navigation and mobile overflow checks. Generated screenshots are in `.mote/memory-revisions-ui/`.
- `scripts/test-calendar-actions-ui.cjs`: shared-producer create/update/cancel/complete review, native-target pinning and receipts passed against generated APIs; no personal calendar was accessed.

## Live LUNA evidence

`scripts/test-semantic-memory-live.ts` ran the local Codex Server `gpt-5.6-luna` over generated material only. Three scenarios cover explicit project scheduling constraints and dates, third-party attribution with injected text, and later cancellation. A subsequent owner correction and current-memory query were checked separately, followed by model evaluation against the original rubric.

The accepted run used five high-level query calls, with one host-rejected date format repaired inside the first call. The provider protocol does not expose the underlying request count. All three extraction receipts contain exact thread-cumulative usage, totalling 29,566 tokens. The first script revision did not retain the answer/judge callbacks, so that measured subset is not presented as the whole run's usage; the script now captures those callbacks for subsequent runs.

The earlier failed run and final accepted run are preserved separately:

- `docs/validation/0.0.61/semantic-memory-before-grounding.json`: schema mismatch and an answer incorrectly treating one corrected claim as invalidating unrelated old-source facts.
- `docs/validation/0.0.61/semantic-memory-accepted.json`: all three scene checks and correction answer pass. Specific host feedback, a clear unified outer schema, and the partial-correction grounding rule address the observed failures. A final wording clarification requires seconds in timed ISO calendar output; the schema itself did not change.

These are different extraction boundaries, not a same-task before/after cost or quality comparison. They are a small live regression set, not a claim of universal model accuracy.

## Remaining validation boundaries

Native EventKit/Android calendar-provider writes under real user permissions, Gmail account authorization, and physical-device checks were not performed by this subtask. The native mutation logic is covered by generated host/client fixtures and compile/type checks. Calendar completion is a Mote-side resolution; it does not invent a native calendar “complete” operation. A native operation with uncertain outcome is only reconciled; it cannot receive another write grant simply because a device lost its local ledger.
