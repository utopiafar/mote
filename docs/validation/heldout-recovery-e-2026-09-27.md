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

## Frozen applicability and actual batch result

The runner-only commits were subsequently migrated to frozen HEAD `d88d623e`, retaining all 418 original production/build pins. The E suite passed 13/13 there and script typechecking passed, using the fixed Node 24 runtime and that checkout's own packages. A metadata-only review verified the actual D history, batch state and snapshot identities before preparation. Actual preparation took 1.53 seconds, made zero provider attempts and added no usage. It preserved the original ledger prefix and appended only the explicit E authorization.

The single authorized E stage then completed extraction, independent model review, submission and closed-snapshot checks. The supervisor exited normally after 801.574 seconds with its process group closed, no remaining child process, unchanged control hashes and an unchanged historical ledger prefix. The stage status is `completed-stopped`: one of six second-wave batches is complete and the other five have not been started by E.

Its two new calls completed, reporting 89,792 tokens (59,458 input and 30,334 output; 19,584 cached input is included in input). Extraction took approximately 327 seconds and review 473 seconds. Both exceeded the previous 300-second bound. This run proves completion under the new bound; it does not establish a general latency target, an isolated performance improvement or semantic quality. Remote HTTP request counts and prices remain unknown.

The cumulative experiment now contains 16 admissions and 16 terminal receipts: 14 completed and two historical failures, with no unreconciled admission or receipt conflict. The 743,550 reported tokens remain a lower bound because one old failure has partial usage and the other has none. All 17 observed model starts include the one historical repair; E added two starts and no repair. The successful batch closure is followed by the persistent `recovery_e_complete` stop. Later batches, integration and heldout question pairs were not automatically authorized or executed.

Actual evidence is in `heldout-wave2-recovery-E-freeze-001` and `heldout-wave2-recovery-E-batch0-live-001` in the external goal directory. The successful closed snapshot hash is `4bad18a2d6eed3ae9d31e15caca514d33c4cd406abad9c408e23257f5530883f`; the final ledger hash is `5b255dc83ba4d1ec528ebd34fcaaff331fb9e99456729d2bd30e016aa39bd3d0`. All heldout source, Memory and question semantics remain sealed from the implementation agents.
