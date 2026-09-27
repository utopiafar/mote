# One native timeout split: offline recovery adapter

This change adds an explicit, once-only recovery path for the frozen wave 2 first-batch generation timeout. It does not modify production code, library builds, the original experiment manifest, the actual heldout ledger, or heldout content. All validation in this report uses generated fixtures and zero real model calls.

The existing ledger APIs still reject every historic stop unless the caller supplies the exact recovery lineage. Preparation reserves an immutable, fsynced commitment and then uses the existing `MemoryPipeline.retry()` followed immediately by `pause()` in the same JavaScript stack. The clone must remain paused with no provider admission or new usage receipt. The failed batch's eight original chunks become four plus four, retaining the parent ID/index 0 and adding index 6. Original indices 1–5 remain in place; execution proceeds 0, 1, 2, 3, 4, 5, 6. The parent's next trace attempt is exactly 2; all others are 1.

A recovery event is validated and appended under the same exclusive writer lock. It binds the stopped chain head, the sole `outer_deadline_exceeded` terminal/stop, `wave2-batch-0`, its failed incomplete receipt and closed snapshot, the prior canonical archive, old/new plans, runtime/production pins, validation result, executor pins and the new phase supervisor. Earlier bytes, failures and admissions remain untouched. Partial commitments/events and stale locks are not automatically repaired or removed. Every descendant manifest explicitly carries the lineage; ingress, integration and Ask do not discover or inherit it implicitly.

The ancestral planning cap remains 124. This recovery's effective cap is 123, including the 13 inherited admissions, leaving at most 110: 37 extraction batches × 2, five integrations × 4 and 16 Ask calls. The split halves together have a four-admission ceiling, and each stage still permits at most two admissions, 300 seconds per outer call and a 720-second supervised process. Any new failure, unknown accounting or receipt conflict stops the lineage. No second retry or split is authorized.

Only the failed target must lack its own draft/checkpoint. All inherited Memory rows, shared drafts, checkpoints, usage and original-source tables are checked before app initialization, after initialization, after native splitting and after close. There is no approximate cache classifier: the unchanged product computes its exact generation input key. A generated fixture proves a valid shared half-draft remains present and the recovered parent performs one review with zero regeneration. Spare call capacity is not filled.

## Validation

Final generated suite: `heldout-recovery-native-offline-009/ROOT_SAFE_recovery-native.json`, under the external September 27 goal directory. The suite covers native preparation/reopen, nonempty historical Memory/draft/checkpoint preservation, all seven batches, default API rejection, wrong lineage/plan/timeout/attempt, new generation/review/commit failures, unknown/interrupted accounting, exact shared-draft reuse, integration → paired Ask → next-wave ingress, and CLI zero-model preparation/mechanical-live rejection. Historical accounting fixtures comprise three actual stub receipts plus nine standalone synthetic usage meters; they are reported separately from actual stub query counts. These are structural and execution checks, not answer-quality or hardware tests.

Commands:

```sh
MOTE_HELDOUT_RECOVERY_TEST_OUTPUT=<new-external-directory> node --import tsx --test scripts/test-heldout-memory-replay-recovery.test.ts
./node_modules/.bin/tsc -p tsconfig.scripts.json --noEmit
git diff --check
```

The first preparation command is deliberately separate from ordinary freeze: `MOTE_HELDOUT_MODE=stage-recovery-freeze` with `MOTE_HELDOUT_ROOT_MANIFEST`, `MOTE_HELDOUT_MANIFEST` (failed phase), `MOTE_HELDOUT_PARENT` (failed closed snapshot), `MOTE_HELDOUT_LEDGER`, `MOTE_HELDOUT_VALIDATION`, `MOTE_HELDOUT_SUPERVISOR` and a new `MOTE_HELDOUT_OUTPUT`. It appends the one recovery event only after its zero-call clone proof passes. It emits a normal phase/extraction manifest for the existing `stage-live` route.

Subsequent freeze commands must explicitly provide `MOTE_HELDOUT_RECOVERY_LINEAGE=<ROOT_SAFE_recovery-lineage.json>` and the frozen supervisor path. Live reads the lineage from the already frozen manifest. The current contract requires the supervisor stored in the recovery plan; changing it requires a further explicit technical revision. The new external phase supervisor SHA is `070ffafc44e1d08d7d111823044d1ed383d45a273bba26b1cbe3c8113cf9bc64`; its bound process helper handles signal and orphan cleanup. Earlier wrappers and failed reports remain preserved.

The unchanged frozen production checkout still needs applicability verification before any actual recovery preparation. No real preparation, persistent-stop release or model execution is claimed here. The original Goal already authorizes generated-model iteration; the remaining gate is technical validation and the frozen execution contract, not a new user-permission request.

## Actual target applicability correction

The independent generated review passed, but the root's read-only inspection of the actual closed failed snapshot rejected C before reservation or preparation. Its batch has `errorCode=model_failed`, while the ledger correctly records `outer_deadline_exceeded`. Native retry splits only `provider_timeout`; the prior recovery options inferred that code without checking the persisted target. The actual ledger and snapshot remain untouched, with no new provider calls. Do not use this adapter for that target without an explicit, separately validated contract revision. See the external `ROOT_SAFE_recovery-C-target-precheck-001.json`.
