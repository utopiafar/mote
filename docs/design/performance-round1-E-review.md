# E pre-implementation review receipt

Decision: **APPROVE**, before product or test implementation.

- Reviewer: `/root/plan_review`; independent collaboration agent, read-only.
- Model/effort: `gpt-6.1-sol`, High.
- Base and pre-implementation HEAD:
  `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
- Branch: `codex/perf-r1-e-desktop`.
- Plan: [v2](performance-round1-E-plan.md), SHA256
  `a1f29d44e024f4e526cd4637a485f473debf61de94a027d35bf297763953a733`.
- Scope: D04 transient cursor; D08 explicit adapter file-checkpoint opt-in at
  both manager calls; D15 single packed selection with first-validated-entry
  bookkeeping and disabled-diagnostics serialization guard.
- Second-round items remain design-only. No unresolved product-policy decisions
  or plan blockers. No reviewer tests/builds/install were run.

Review changed v1 before approval: omitting a checkpoint based only on source
kind would affect injected custom local-files adapters. v2 instead makes the
built-in adapter opt in, preserving full cloned checkpoints by default.

Approval obligations: preserve durable `after`, four-slot order, rollback/restart,
fault epochs and last-item completion timing. The synchronous queue observer
performs bookkeeping only; first-image storage failures remain outside attempt
handling, later-image failures retain existing first-entry bookkeeping. Verify
ACK durability, retry/held, scheduling, exact enabled counter bytes and absence of
disabled diagnostic serialization. Custom default checkpoint behavior must cover
normal and actual recovery work. Electron evidence only establishes generated
module/runtime integration, not production-main startup, foreground UI, native
permissions, physical devices or live models. Final integration is controller-owned.

Implementation delta: snapshot recovery deliberately invalidates its checkpoint
inside `requestSnapshotRecovery`. The additive HTTP fixture matches a real known
revision, proves a second scan and successful resend occur, and checks that the
default full-checkpoint accessor is still invoked there (its correct value is
undefined). The preceding normal scan proves independent full catalog cloning.
No assertion, entry point, timeout or required scale was relaxed.

Post-implementation read-only audit by the same reviewer found no additional
product correctness issue. It identified that a packed time-slice fixture drained
all input in one batch and therefore did not prove elapsed-time yielding. Before
validation, E changed only that additive fixture: one eligible record plus one
held record keeps the initial count bound above one; transport enqueues fresh
eligible input and advances the clock past 15 seconds. Source work must occur
before the fresh item uploads. This strengthens state control and preserves
assertion meaning, original production entry point and limits.

The same audit accepted the second-round handoff as bounded and design-only; it
explicitly grants no second-round implementation approval.

First targeted run: 227 tests passed and the two new recovery cases failed at
the resend assertion. Both actual recovery scans had occurred, but the additive
HTTP endpoint lacked the recovery-upload session route. E added that generated
route using the existing generated manifest and unchanged part/commit validation.
The original resend/pending assertions and real manager entry remain unchanged;
this is fixture coverage completion under the approved design, not a product fix.
