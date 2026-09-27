# Integration timeout and interrupted usage

A frozen generated three-record scenario on 2026-09-27 completed six per-record extraction/review calls and one integration-generation call. Its integration review timed out after 300,024 ms. All four review tool calls completed, with no output-repair turn or final answer. Continued model events do not establish why the provider took this long. No Ask comparison ran, so this failure supplies no Memory net-benefit conclusion.

The run exposed two separate correctness problems:

- The Codex adapter retained `complete: true` on the last cumulative usage sample when a local deadline, cancellation or child exit interrupted a turn. The last sample can precede unreported work. Interrupted turns now preserve observed counts with `complete: false`; late samples cannot restore completeness after interruption. Normal successful cleanup preserves complete usage.
- The built-in integration policy still said an owner confirms a reviewed relationship, contradicting automatic publication and the other instructions in the same request. It now describes independent review, host validation and automatic atomic application. The built-in integration strategy and recipe are version 2. Existing pinned selections/windows are not silently rebound; an explicit new selection/request is required to use the revised definition.

The policy inconsistency is not a demonstrated cause of the timeout. The model, reasoning effort and 300-second call protection were not changed. The old run's receipts, report and vault remain unchanged; its 196,355 reported Token total includes a failed-call sample of 50,927 that may omit later unreported work. Provider-internal request counts and prices are unknown.

The product preserves the completed per-record extractions. Its integration checkpoint currently preserves selected input hashes and completed domains, but not an unreviewed integration draft. Native retry therefore repeats generation for the unfinished domain. An external report draft is not a production checkpoint and must not be injected to claim review-only recovery. A separately bounded follow-up is being prepared to clone the failed vault, explicitly cancel its old integration window, create one version-2 integration task, and then run the unchanged four Ask arms. This follow-up has not passed at this checkpoint.

## Verification

Generated Codex subprocess fixtures cover local deadline, host deadline, owner cancellation, close during a turn, child exit, a late usage sample, and normal successful cleanup. The targeted Codex/protocol/usage group passed 22 tests with one explicitly gated installed-Codex check skipped; it made no live-model calls.

`npm run check:local` completed with exit 0 (`check-local-005`, external log):

| Suite | Passed | Skipped |
| --- | ---: | ---: |
| Desktop | 345 | 0 |
| Server | 906 | 1 |
| Web | 125 | 0 |
| Agent | 153 | 1 |
| Shared | 70 | 0 |
| Diagnostics / local inference | 5 / 13 | 0 |
| Script groups | 4 / 4 | 0 |

All 5,575 bilingual messages/call sites, library builds, workspace/script types and the central-runner checks passed. No new live-model run, private-media processing or physical-device check was performed for this correction. The full Goal remains incomplete.

## Startup recovery follow-up

A generated close-and-reopen probe found a separate interruption path: when the server exited before closing a usage receipt, startup changed `running` to `failed` but retained `complete: true` on its last cumulative token sample. The summary then reported no unknown usage and the detail view presented that partial sample as complete.

Startup now marks only unclosed `thread_cumulative` samples incomplete, preserving every reported quantity and retaining an unknown cost. Missing usage remains missing. Already closed failed/completed receipts are unchanged, and repeated startup is idempotent. This does not infer missing tokens or retrospectively rewrite already closed historical failures.

The regression failed before the fix and passed afterward. The affected server usage/query-run suites passed 14/14, Web usage tests passed 2/2, and server typechecking passed on Node 24. No real model, private input or frozen experiment was used or changed. This follow-up used targeted verification; the earlier full-suite results above remain historical.
