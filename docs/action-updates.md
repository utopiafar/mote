# Evidence-backed action updates

Calendar extraction now emits `calendar.create`, `calendar.update`, `calendar.cancel`, or `calendar.complete`. Only the model chooses a semantic `sameAs` relation. The host no longer merges independent events merely because their titles and times are identical. A model-selected duplicate merges original proof while preserving a dismissed decision.

Updates are separate review proposals. The host supplies their original action version, event, device/calendar and external ID; models cannot choose native event identifiers. Each proposal contains the original and new evidence. Confirmation pins its reviewed payload and operation ID. A conflicting change, changed original, changed evidence, arbitrary receipt ID or target substitution is rejected. A successful update atomically changes the original action and keeps both sources for later comparisons. Cancelling a proposal that has not been exported only closes that proposal; completion is a Mote status, not an invented native calendar capability.

For exported events, Desktop and Android modify only the pinned original event. They check the original marker, calendar and expected content, refuse recurring/invited events, and refuse to overwrite manually changed content. Updates retain the original Mote marker and add the operation marker. A durable local ledger is written before native work; after interruption, retries reconcile the operation marker or the completed cancellation instead of blindly repeating the mutation. Native event IDs are not taken from model output.

The host grants calendar extraction a read-only `action_catalog` tool. It supports exact IDs, literal terms selected by the model and scoped cursor pagination. It discloses at most 20 comparisons and a 24 KB target per page, with at most four 500-character proof previews per item and explicit truncation. Host device/time limits apply to every original dependency. Cursor scopes cannot be broadened. Missing/deleted/local-only evidence is excluded. Catalog output grants `sameAs` comparisons, never original citation IDs or mutation tools. Normal chat and other extraction sessions cannot invoke it. Query/tool budgets still apply; limited comparison coverage must not be reported as complete history.

Web and Android show the original arrangement alongside the proposed change and keep the original native destination fixed. Cancel and complete review cannot alter event fields. The Web renderer fixture exercises create, update, cancel and complete in sequence using generated records and fake execution receipts.

## Validation for this change

- Server: 16 action tests pass, including cross-source changes, mismatched versions/targets/receipts, same-title separate participants, immediate deletion scrubbing, and 400 historical proposals paginated without gaps or duplicates. Model-selected search reaches an original older than the previous 200-item window.
- Desktop: 6 calendar execution fixtures pass, covering lost receipts, process interruption, original identity/operation markers and destination substitution.
- Agent: 36 targeted tests pass. The real Harness with generated HTTP model responses invokes the new catalog, follows its cursor, and enforces read-only tools, scope and byte/character budgets.
- Android: all 4 `CalendarActionRulesTest` methods pass; the affected production Kotlin and activity compile.
- Swift: `MoteHelper.swift` plus `WindowIdentity.swift` typecheck passes, with existing deprecation warnings.
- Real Electron renderer: `scripts/test-calendar-actions-ui.cjs` passes creation, update, cancel, complete, review destinations and receipts.
- Shared and Agent builds, Server build/typecheck, Web build/typecheck and Desktop typecheck pass. No whole-repository suite was rerun per small change.

All data is generated. These checks do not claim real Gmail authorization, live-model semantic quality, physical-device calendar provider validation or writes to a personal calendar. Native mutations are restricted to simple events previously created by Mote; arbitrary imported events, recurrence and invitations are deliberately not mutation targets.

## Shared semantic input and replay fence follow-up

ACT-03 now consumes the bounded unified `actionCues` artifact independently of Memory publication. A complete artifact is consumed once, with all supporting original spans, including cross-observation cues; at most eight cues enter a relationship pass. Empty cues checkpoint without another model query. Legacy/incomplete segments and long file chunks keep the explicit bounded-original path. See `docs/memory-updates.md` for the generated live LUNA cases and their limitations.

The release safety review found that losing a local calendar ledger could previously permit another write on an already executing/uncertain host operation. Claim responses now grant `mutationAllowed` only on the initial approved-to-executing transition. Updated desktop and Android clients require both that host grant and a never-attempted local ledger; otherwise they only reconcile an existing marker/receipt. Server repeated-claim assertions, seven desktop action tests, and the Android calendar-rule fixture cover this boundary. This intentionally leaves a lost claim response with no provable result pending manual verification rather than guessing a second write.
