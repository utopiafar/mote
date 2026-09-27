# Heldout recovery D: preserve the six native batches

D replaces the unused recovery C execution path. C's committed report remains historical: its generated `provider_timeout` fixture did not match the stopped run's `model_failed` batch. D does not rewrite that error or split the batch. This change has only been exercised on generated fixtures; real preparation and live execution have not been performed.

The plan is explicitly `mote-heldout-recovery-d-plan@1`, policy `D-preserve-six-batches@1`, with a D preparation commitment and `recovery-D` validation scope. C plans and C validation reports are rejected. The existing `stage-recovery-freeze` CLI now produces `ROOT_SAFE_recovery-D-plan.json`, `ROOT_SAFE_recovery-D.json` and the explicit lineage Ref.

Before reserving the single preparation, the adapter verifies the closed canonical and failed snapshots, all 13 inherited admissions/receipts, the sole `outer_deadline_exceeded` terminal/stop, and the original wave 2 batch 0 identity. Its exact shape must be `failed / extract / model_failed / attempt 1 / 8 chunks`; the other five batches remain pending at attempt 0. Target drafts/checkpoints, split history, different errors or review failures are rejected. The target's immutable input is compared with its original canonical pin. No model interpretation is used for these checks.

Preparation clones the closed failure and calls native `retry()` then `pause()` in the same JavaScript stack. It checks zero provider attempts and zero new usage. Startup, retry, close and reopen preserve historical Memory, checkpoints, shared drafts, usage, original material and other jobs. All six batch IDs, indices, chunks, ranges, recipes and clocks remain intact. The target changes only to pending/paused while retaining attempt 1. A new WavePlan records the changed runtime pin; the original plan is retained.

Execution remains one batch per stage, index 0–5, trace attempts `[2,1,1,1,1,1]`, at most 2 outer admissions per stage, 300 seconds per outer and 720 seconds per supervised stage. D adds a target-specific limit of 2 and an effective cumulative limit of 121: 13 inherited plus at most 108 remaining. The original 124 planning limit and all failed/incomplete usage remain in the ledger. There is no second recovery, automatic retry or filling unused allowance. Default callers still reject the historical stop; descendants must explicitly verify the same lineage. Every new failure or unknown result stops admission.

The generated suite reproduces the runner's `StageSafetyError('outer_deadline_exceeded')` through the ordinary query/pipeline chain and observes `model_failed`. The runner timer itself is unchanged. A future change to typed `AgentTimeoutError` would change retry behavior and requires separate review. Native exact-key shared-draft reuse is separately tested with a generated producer; that fixture does not authorize extra producer work in the real recovery.

Validation on Node 24.15.0:

- D suite: 15/15 tests, 32 checks, 20 stub calls, 0 real calls. Includes the zero-call preparation/reopen, six-batch completion, generation/review/commit failure stops, admission 122 and target admission 3 rejection, rejection before reservation, old C rejection, shared complete-draft reuse, and explicit inheritance through integration, paired Ask and next-wave ingress.
- Existing stage/ledger suite: 12/12; sequence suite: 7/7. Together, these regressions used 13 stub calls and 0 real calls.
- `node node_modules/typescript/bin/tsc -p tsconfig.scripts.json --noEmit` and `git diff --check` passed.

Safe reports are external in `heldout-recovery-D-offline-002`, `heldout-recovery-D-stage-regression-001` and `heldout-recovery-D-sequence-regression-001`, under the 2026-09-27 goal directory. The first D run is retained separately. No heldout content, real ledger, frozen execution tree, production code or built artifacts were read or modified for this implementation. Generated success is not a claim of actual-target applicability; frozen-environment verification and metadata-only eligibility review remain required before real preparation.
