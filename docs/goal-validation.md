# Real-context MVP validation

Active goal, 2026-09-26. Decision order: **functional correctness and completeness, then performance, then cost**. Keep bounded execution and recovery throughout; performance targets must not be used to skip unresolved functionality.

All live LLM calls for this goal use the local Codex App Server, `gpt-6-sol`, reasoning `max`. Do not substitute a model or reduce effort to improve results. Generated fixtures belong in Git; private inputs, traces, credentials and vaults do not.

## Acceptance ledger

| Area | Required evidence | Current state |
| --- | --- | --- |
| Input and decisions | Real distribution, representative reading, current code and historical user decisions, primary-source research | Inventory/history/research recorded privately. One real call processed locally; speech accuracy and speaker labels remain unverified |
| Functional journeys | Ingress → material → reviewed memory → evidence-backed answer and insight | Fifteen generated patterns have passing runs, including repaired failures; three private note cases passed. Two private insight reports pass fidelity/usefulness as recaps. Revised insight policy and cross-date synthesis are being evaluated. These are multiple code snapshots, not one frozen-suite result |
| Memory quality | Owner attribution, subjective experiences, repetitions across dates, scoped decisions, corrections, abstention, third-party/task boundaries | Attribution and diary-carried coding decisions repaired. Incremental correction passes extraction, review, consolidation, version-bound replacement, current/history query and preservation of unrelated memories. Default granularity for transient personal plans is being calibrated |
| Extensibility | Two different source chains and an actual extension without editing business core | A fixed Memex Markdown Source Pack consumes generic input names, limits and settings. Twenty-day generated ZIP and full private diary ZIP pass; OCR/audio and alternative Memory-policy composition remain separate work |
| Reliability | Duplicate/offline ingestion, restart, partial availability, failures, deletion and bounded retry | Generated regressions cover archive corruption and staged-import recovery. Full private diary import passes completed-job restart and duplicate-upload replay; not an in-flight full-corpus restart test |
| Progressive scale | 12–20 patterns → 100–200 mixed records → multiweek replay → one resumable full private-input acceptance | 631 real diary entries and 14 linked images imported and checked against exact originals. Only six original note entries have live Memory evaluation; mixed replay and full audio/Memory acceptance remain pending |
| Product experience | Usable UI under background processing; working progress, citations and partial-data queries | Generated Electron Memory correction/history and 20→631 Material UI tests pass, including 430px width and 12 actions during source ingestion. No physical-device or sustained audio/LLM concurrency claim |
| Performance | Query convergence, responsiveness, backlog drain, elapsed time and resource measurements | Three private-note queries took 58.277, 30.887 and 36.744 seconds; full case durations include separate extraction/review/judgment and are much longer. Small samples do not establish an SLO |
| Cost | Whole-operation usage including retries, cached context and missing counts | Ledger available; opaque Codex internal requests cannot support a claimed strict token ceiling |

The full goal and research basis are outside source control in the user's `Documents/Codex/mote-goal-2026-09-26` directory. They include the balanced, replaceable Memory policy and private data inventory. This ledger does not replace their full requirements.

## Running the first live journey

Build libraries with `npm run build:libs`, then run:

```sh
MOTE_JOURNEY_CASES=milestone node --import tsx scripts/test-context-journey-live.ts
```

The opt-in runner creates a new isolated vault and a report under the OS temporary directory. Set `MOTE_JOURNEY_OUTPUT` to a **new directory outside the repository** to retain a named run. It sends generated text through authenticated production ingress, explicitly starts a Memory job, then uses the normal query endpoint. It preserves outputs and failures, checks exact evidence and runs a separate semantic judgment with the same fixed model. It does not claim browser, physical device, real private data, OCR or ASR coverage.

Increase `MOTE_JOURNEY_CASES` with comma-separated fixture IDs only after inspecting the preceding results. No automatic re-run of a failed model call. The 300-second per-agent deadline is a temporary functional-baseline safety limit, not an accepted interactive latency target.

`MOTE_JOURNEY_MANIFEST` can select a strictly validated private case manifest outside Git. The report distinguishes private/generated data. `incremental-correction` uses generated notes only and publishes its initial candidates before admitting the correcting note; publication is limited to the isolated fixture vault.

## Source extension and archive validation

See [Memex Markdown Source Pack](../plugins/source-packs/memex-markdown/README.md). Registration adds one pinned parser plus trusted configuration; no new upload, scheduler, storage or authorization subsystem. The drill uncovered three host defects/limits: grouped base64 validation overflowed on an 11 MB input, the streaming ZIP decoder retained a reused read buffer, and the executor's fixed 16-file/1 MiB-output limits did not accommodate an actual multi-month export. Defaults remain bounded; packs explicitly select higher limits within hard caps. The parser measured about 1.11 MB of JSON for this corpus and uses a 2 MiB allowance without truncating entries.

`scripts/test-import-journey.ts` uses authenticated import APIs and the real OS sandbox. It checks every original's SHA-256, all parsed source slices, attachment associations, completed-job restart and idempotent replay. `--resume` reuses a completed isolated import with the same original and pinned parser, preserves the preceding failed report, and resumes verification. It does not rerun Memory or OCR. The verifier respects HTTP read rate limits and reads evidence in the host's bounded batches; early verifier failures are preserved in private reports.

Generated integration and real macOS sandbox tests pass. `npm run check:local` passed after the production archive/parser fixes; subsequent harness-only edits passed script TypeScript checking. Logs and exact run results remain in the private goal directory. Full private inputs, traces and model outputs are never checked into Git.

## Incremental Memory correction

The generated correction journey first publishes an initial plan and an unrelated personal experience, then admits a separate correction. Extraction remains bounded to its input batch; the existing consolidation extension supplies the earlier Memory and original evidence. The live test exposed an independent reviewer rejecting a valid replacement relationship merely because the newer card already stated the corrected fact. The shared consolidation policy now makes the missing relationship explicit value, without treating similar wording or recency as replacement evidence.

A second failure occurred before the reviewer reached the provider: its question repeated the entire shared admission policy and exceeded the host input limit. Review now includes that exact leading policy once while retaining the complete task, context and draft. A regression checks the previously overflowing request. The resumed generated run passes, including the unrelated experience and both current and historical answers; its query took 39.062 seconds. Earlier failed reports and the one explicit test-only replay of a completed generated consolidation cursor remain recorded. The fourth full local check passes after these production changes.

## Insight and UI evaluation

`scripts/test-insight-journey-live.ts` copies a completed isolated context journey and evaluates the normal persisted insight endpoint. It does not republish private candidate memories. Source-run usage is excluded from the new run's receipts. Its separate semantic review distinguishes a useful recap, a supported new connection, abstention and filler; same-model review is still not independent factual ground truth. The first two private reports were useful recaps, not evidence of discovering a long-term pattern. Personal-insight policy 1.0.5 removes a finding-count quota, requires explaining the additional understanding, and retains meaningful single experiences. Report provenance now records the actual personal-insight version instead of the unrelated default skill version. Three insight structure/provenance tests and the fifth `npm run check:local` pass.

Run `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-material-load-ui.cjs` after building the app. This generated fixture starts with 20 independent Coding materials, adds records through the source API until 631 are published, and exercises bounded pages, reading and scrolling during ingestion. The passing run has 12 overlapping actions, no HTTP errors or crashes, 220 frame samples with an 18.7 ms maximum gap, and 391,446,528 bytes peak server RSS. This brief local Electron run does not establish a stable SLO. Its first failure was a harness error: repeatedly configuring the same pipeline requeued all work. Configuration now occurs once, and each run has a separate output directory; failed temporary vaults are retained.

The first 26.76-minute private M4A run produced a complete 532-segment transcript but failed in speaker separation. Its original and transcript remain available for diagnosis. Neither the full audio path nor acoustic transcription/speaker accuracy has passed acceptance.
