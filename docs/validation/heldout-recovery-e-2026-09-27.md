# One-batch preserved-context recovery E

The heldout second-wave first batch and its D retry both reached the historical 300-second deadline without an extraction result. The closed product batch remains `failed / extract / model_failed`, attempt 2, with its original eight chunks. Four transport disconnection events during D do not establish four billable requests or explain the remote failure. The 14 prior outer calls, both failures and incomplete or absent usage remain unchanged.

E is a separate explicit recovery protocol. It preserves the original six-batch plan, input, recipes, semantic time, model and reasoning settings. Only the selected model timeout changes from 300,000 to 600,000 ms. The native retry updates the corresponding configuration fingerprint; all other job and batch pins must still match. Preparation retries and pauses the target in the same JavaScript stack on a new clone, with zero provider attempts or added usage.

The request binds the original experiment, D plan and event, stopped ledger head and failed snapshot. Before reservation, the adapter verifies D's prepared tree, all six batch pins, the second failed extraction key and all 14 usage receipts. E permits only this batch, attempt 3, with at most two additional outer calls and a cumulative cap of 16. Exact-key shared drafts remain reusable; two is a ceiling, not a required call count. There are no automatic outer retries. Default and D entry points cannot bypass the existing stop.

The 600,000 ms bound reaches the selected memory profile, server signal, Agent/CodexSession and runner timer. A separate supervisor allows 1,320 seconds including termination and cleanup. Parent snapshot, source, configuration and closed receipt checks precede a successful stage closure. Success then writes a persistent `recovery_e_complete` stop; failure retains its first stop. Neither outcome permits the next batch, integration or Ask.

Main-tree generated validation passed on Node 24:

- E: 13/13 tests, 13 stub calls and two generated executable processes; zero real provider calls.
- Shared runner regression: 16/16; historical D regression: 15/15. Script typechecking and diff checks passed.
- Independent narrow review: 2/2 cases with four stub calls. Success closed at 16 admissions/receipts and rejected all reentry and next-batch paths. A mutated parent snapshot could not receive a successful closure.
- External supervisor: five groups, 27 generated cases, plus one generated CLI rejection. No real model calls.

The deadline transport check uses the real server, Agent and CodexSession classes with a generated executable. It observes actual 600,000 ms arguments, scales the old/new bounds to 3/6 seconds, succeeds with a 3.5-second response and fails at the new bound. This is not a ten-minute wall-clock run, an installed Codex binary check or evidence that remote provider deadlines will change. Earlier unsuccessful fixture attempts are retained.

Evidence is stored outside Git in the 2026-09-27 goal directory: `ROOT_SAFE_recovery-E-main-delivery.json`, `heldout-recovery-E-offline-005/ROOT_SAFE_recovery-E.json`, `heldout-recovery-E-independent-001/ROOT_SAFE_independent-review.json` and `ROOT_SAFE_phase-e-supervisor-delivery.json`. They include source and report hashes.

This commit contains runner preparation and generated validation only. Applicability to the original 418 frozen production/build pins, actual E preparation and any bounded model execution remain separate steps. No production source, real ledger, original snapshot or historical report was changed by this adapter; no heldout semantic content was inspected. The experiment still has no completed heldout question pairs or net-value result.
