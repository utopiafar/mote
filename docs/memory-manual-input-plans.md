# Manual Memory input plans

A manual request with explicit recipes freezes its selected materials and recipe bindings. Each material/recipe pair has a private `memory_input_plans` row and a required `memory.input` step in the existing execution engine. The HTTP client cannot supply source pins. New material arriving after the request is outside that request.

The source pin identifies the original source input separately from derived output readiness. Normal OCR or transcription completion may change a Material revision while preserving that source pin. A changed source head or archive checkpoint makes the waiting plan stale. Older/custom material without a stable original identity uses the exact Material revision. Named outputs bind their evidence and fingerprint once, when first ready. Exact evidence-ID requests never acquire a future sibling output outside their allowlist.

For an explicit evidence-ID selection, a recipe without its own `requires` pins
the ready named outputs containing the selected current anchors. This includes
selected OCR/transcript originals even when the automatic source's default only
uses its body and visual interpretation. The allowlist still limits model reads
and commits to those selected anchors; unrelated pending outputs do not block
mapped selections. Unmapped legacy blocks retain whole-Material readiness and
revision checks. Explicit recipe requirements and range-based selection keep
their existing dependency policies. See the [selection correction ADR](adr-manual-memory-selected-outputs.md).

Ready plans keep the existing same-recipe batching budget. Each generated batch owns only its applicable input pins and Material references; validation, model reads, review, commit and timeout subdivision use that scope. A failed transcript does not invalidate an independent body batch. Timeout subdivision preserves its child scopes and updates the plans' batch associations. Existing jobs retain their saved evidence and strategy bindings; ambiguous old scope metadata keeps conservative validation instead of inventing a new authorization.

Package metadata and the full coverage contract are supplied through the task
context once, keeping internal extraction and review questions within the existing
Agent limit. Coverage describes each listed target range, not completion of the
whole original. Separately scheduled ranges alone do not require more context;
genuine missing interpretive evidence remains explicit. The host aggregates job
completion and preserves all original range grants. See the
[batch context ADR](adr-memory-batch-context.md) and
[generated regression](memory-batch-context-validation.md).

`memory.input` is a metadata-only execution pool. Pending output uses admission waiting with a bounded retry delay, before any attempt or model slot is claimed. The existing memory feature's tick rechecks original plans; a host wake hook can shorten that delay. Failed/unavailable inputs remain blocked until explicit retry; retrying Memory does not initiate media processing. A pending input's readiness timer does not block an explicit retry of another failed input; actual provider cooldowns still apply. Binding a newly ready input, creating its batches, saving plan associations and registering execution steps occur in the same fenced transaction. Quota failure rolls the entire operation back.

The job and operation remain waiting while required input steps are unfinished, even after body batches complete. `run()` returns the current durable stopping point rather than waiting hours for OCR. Manual execution permission comes from the durable uncancelled, unpaused job; the in-process promise map only tracks callers awaiting the current pass. Automatic Material and lifecycle jobs retain their existing grant and activation rules. Pausing blocks new work, cancellation revokes all unfinished input and model steps, and completed batches are not replayed on recovery.

List/detail responses expose bounded input and recipe progress, without source-pin internals. Plan JSON is included in the storage ledger. The Material foreign key removes private plan metadata when a source's Material is forgotten; an unfinished execution step whose plan is gone becomes stale with safe identifiers and an error code.

Generated fixtures cover pending-only requests, ready-material batching, restart and late readiness, independent output failure, exact evidence scope, pause/resume/cancel, authorization changes, source replacement, metadata cleanup and transactional quota refusal. These checks verify host scheduling and privacy boundaries, not live-model semantic quality or physical devices.

`apps/server/test/memory-selected-output.test.ts` exercises the authenticated
manual-job route with generated composed inputs. It verifies selected OCR alone,
body alone and all selected outputs while an unrelated transcript is pending,
delivery to the model harness, unchanged automatic receipts/defaults, explicit
recipe policy, authentication and rejection of replaced anchors. It does not use
personal screenshots or establish live extraction quality.
