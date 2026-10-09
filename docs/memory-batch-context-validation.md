# Memory batch context regression

The generated fixture creates 20 short originals, a bounded 12,000-character
derived interpretation and package instructions, then submits them to the actual
Memory pipeline. Extraction and independent review use the actual Codex adapter
with a synthetic app-server executable, synthetic credentials and read-only tools.
The old duplicated question is rejected before the synthetic session can handle
the work; the corrected request preserves all 20 members, original IDs and derived context through
both calls, commits exact zero-candidate range checkpoints, and completes.

`apps/server/test/memory-work-packages.test.ts` also exercises zero-candidate
independent review, supported candidates, missing/saturated coverage subdivision,
review timeout and draft recovery, unresolved context and changed-input fencing.
`apps/server/test/memory-review.test.ts` checks the complete review task, review
reuse boundaries, cancellation/deletion races and checkpoint transaction recovery.

These are generated lifecycle/transport fixtures. They do not validate a live
model's interpretation of a long original, full-corpus semantic completeness,
pixel disclosure, transcription accuracy or physical devices. Live recovery must
separately verify deployed code, actual request receipt, original ranges and exact
citations. An accepted explicit retry is not completion.
