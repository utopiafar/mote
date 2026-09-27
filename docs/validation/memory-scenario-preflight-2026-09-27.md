# Generated Memory scenario preflight — 2026-09-27

Baseline: `f33930e`. The new `scripts/test-memory-scenario-live.ts` is an evaluation adapter, not a production behavior change. Its default is offline preflight. It supports one frozen three-record, two-question generated development wave, not arbitrary private vaults or a held-out benchmark.

Source ingress, Material organization, manual extraction, independent review, integration and Ask use the normal application APIs in a new external vault. Source and document timestamps remain distinct from actual receipt time. The frozen fixture hash is `6f02fa2ca1a129c3f8dcb427eecaf6fc7ad84893613d63ff1afa2925678a04e1`. Original questions and evaluator-only rubrics are not added to extraction prompts.

Every question/arm starts with a separate closed snapshot clone and a new conversation. The source-only arm removes Memory and its execution/derived caches without creating user deletion intent. Both arms retain the same production tools and instructions; the source-only Memory tools return no cards. A table-difference allowlist protects originals, Materials, indexes and permissions. Unknown other derived surfaces fail the adapter's preconditions. Queries may write only the listed conversation, execution and usage state.

This wave extracts each record under its bounded evidence IDs. That production path cannot read previous Memory during extraction. It tests separate extraction followed by integration, not incremental extraction with access to older cards. Empty extraction or integration is allowed in live mode. A positive synthesis must be assessed against its parents and originals; a nonempty result alone is not evidence of value.

Final preflights passed with no real model calls: external `memory-scenario-preflight-010-final-empty` made 11 stub calls; `memory-scenario-preflight-011-final-nonempty` made 12, including a deliberately mechanical two-parent integration and its review. Parent review inspected the adapter, ablation diffs and anonymous output fields. A separate supervisor smoke passed with 11 stub calls. A shortened supervisor stop check terminated the local runner as expected; provider-side cancellation was not tested.

The adapter limits outer calls to 12 and forbids repeated outer stage/phase attempts. Per-call protection is 300 seconds, with a 75-minute model-admission deadline. Production internal model rounds and validation repair remain separately observable; provider-internal requests and prices may be unknown. A separate external supervisor bounds the whole local process group, including setup and shutdown. Cloned historical usage is marked and must not be added repeatedly to totals.

After all four answers complete, the adapter writes an anonymous answer package and a separate mapping. Quality judgments should be saved before revealing groups, traces and usage. Answer content may reveal the group, so anonymity is not guaranteed. Preflight answers are explicit stubs and cannot be used as semantic-quality or net-benefit evidence.

The scripts TypeScript check passed. Earlier preflight assertion failures and one interrupted backup experiment remain in external reports; they were not relabeled as successful live runs. At this checkpoint no real-model scenario run, private media validation or physical-device check has been performed, and the full Goal remains incomplete.
