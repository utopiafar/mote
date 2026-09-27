# Manual Memory plans and readable citations — 2026-09-27

This stage builds on `5da3449` on `codex/automatic-memory`. It fixes independent readiness in an explicitly selected manual multi-recipe request and citation readability observed in the preceding generated live run. The full Mote Goal remains incomplete.

## Behavior

The manual UI selects recipes for this request without changing automatic settings. Each selected Material/recipe pair keeps its original source identity and recipe version. Ready inputs run immediately; pending OCR or transcription waits without consuming model attempts. Late readiness binds only the saved selection. A failed dependency, cancellation or explicit retry does not replay an already completed independent result or add newly arrived material. See [the execution contract](../memory-manual-input-plans.md).

The UI shows each recipe's progress, dependency reason and source-processing entry point. Completed Memory is immediately readable while other inputs wait. Job and operation states retain waiting, failure, cancellation and partial results rather than reporting premature completion.

New citation excerpts display the body of a host-verified source wrapper and merge overlapping delivered ranges. Unread gaps remain marked; undecoded or undisclosed content is not filled in. Raw evidence, fingerprints, offsets and citation authority are unchanged. The decoder is restricted to known source/speech JSON from the current built-in `mote.source-item@8` organizer and Material schema version 1. Custom or unknown formats stay literal. Previously persisted answers are not rewritten.

## Completed targeted checks

- Eight generated input-plan cases and 53 existing pipeline/draft/composition/strategy checks passed at the execution-layer checkpoint. They cover independent dependencies, fixed recipe batching, restart, exact evidence selection, source changes, pause/resume/cancel, permission changes and quota rollback.
- Four selection/source-identity cases passed, including a changed archive-group checkpoint before material reconstruction. The real POST route and composition tests passed with a pending-only request, partial completion, failed transcription, restart and explicit recovery without range expansion.
- Actual Electron application renderer: 25 checks passed in ignored `.mote/manual-memory-ui/run-Ty5Pvb/report.json`. This used generated Material products and simulated extraction/review. It checked reading, source navigation, English/Chinese and 430 px layout, pause through a dependency failure, explicit retry, cancellation with late readiness, and matching operation states. The parent agent also inspected narrow-screen waiting and desktop failure screenshots.
- Final citation targets: 22 Agent and 11 Server checks passed after the last decoder changes. They include quoted/escaped text, Unicode boundaries, overlapping and disjoint reads, hidden-tail sentinels, undeclared/custom JSON, withdrawal of a host format declaration and wrappers with no text.
- Actual AnswerView and InsightReport components in an isolated Electron renderer: seven checks passed in external `run-003-citation-preview-ui/report.json`, including exact readable excerpts, retained evidence IDs, gap sentinels and desktop/narrow-screen layout. This is component rendering with application CSS, not a full navigation test.
- Shared and Agent builds, Server typecheck, Web build and targeted UI checks passed. The English catalog and Android copy contain 5,575 synchronized entries.

## Independent review

Review reproduced two recovery boundaries and verified their fixes. First, a pending input's 30-second metadata timer was incorrectly treated as a provider cooldown, delaying an explicit retry of a different, repaired input. The retry now consults model batches' actual cooldowns. Second, a ready archive-backed plan could run after a new original event arrived but before its Material was rebuilt. All batch admission and commit paths now recheck the original source pin, including missing plan records. Queued and in-flight fixtures verify no new invocation or late checkpoint respectively. Ordinary SourceStore replacement already invalidated the dependent evidence before reconstruction; that behavior was verified without adding duplicate logic. The final review set passed 12 checks and Server typecheck.

The first integrated run, external `check-local-003.log`, failed on one old test that expected an independent body recipe to be blocked when a default recipe lost its whole-Material dependency. The replacement assertion preserves that default recipe's invalidation and verifies that only the still-ready body recipe can invoke the model. Eight related selection/dependency checks then passed. The failure report is retained.

## Integrated result and limits

Final `npm run check:local` passed, exit 0, in external `check-local-004.log`. It includes the review fixes and changed dependency assertion: Desktop 345 passed; Server 907 total, 906 passed and one skipped; Web 125 passed; Agent 152 total, 151 passed and one skipped; Diagnostics 5, Local Inference 13 and Shared 70 passed. Both four-case script suites and the central runner passed. Translation validation checked 5,575 entries. The two skips are not claimed as executed validation.

These generated checks do not establish live-model semantic quality, private media accuracy, large-archive usability, physical-device behavior or scenario-specific net benefit. No real model, OCR/ASR service or private media was used in this stage. No merge, release or daily-service replacement was performed.
