# Memory validation diagnostics

Memory model completion and host admission are separate outcomes. An `agent.completed`
event means the query returned, not that its proposed memories passed admission.

The pipeline emits `agent.memory_validation_failed` at warning level for each host
validation rejection, including the first attempt when regeneration later succeeds.
It does not require Agent trace opt-in (ordinary diagnostics must be enabled and the
log level must include warnings). Logs obey existing rotation and retention limits.

Each batch also retains its last 20 `validationFailures` in the database and the
`GET /api/memory-jobs/:id` response. Existing historical entries remain readable;
new optional fields do not require a database migration. The job/batch terminal
error stays `invalid_model_output` for compatibility; inspect the failure history
for the precise validation code.

## Quote codes

| Code | Meaning |
| --- | --- |
| `quote_evidence_undeclared` | An evidence span names an ID absent from this candidate's declared evidence IDs. |
| `quote_length_mismatch` | Explicit length differs from the quote's UTF-16 length. |
| `quote_not_found` | The exact quote does not occur anywhere in the original text. |
| `quote_offset_mismatch` | The quote exists, but does not match at the declared absolute offset. |
| `quote_ambiguous` | An omitted offset cannot be resolved because multiple authorized exact positions match. |
| `quote_range` | A matching quote is outside the supplied segment, including an omitted offset with matches only outside the segment. |
| `missing_quote` | A declared evidence ID has no quote. |
| `quote` | Legacy aggregate code retained for historical compatibility. New validation uses specific codes. |

Validation still rejects non-exact quotes and never widens the authorized range.
The first failing condition is reported; a candidate may have more than one issue.
The host accepts a unique exact match without a model-supplied offset. Prompts and
repair feedback now consistently recommend omitting offset and length by default.

## Correlation and privacy

Ordinary events carry job ID, batch ID/index, attempt, query result run ID,
validation phase (`extract` or `review`) and validation code. Where applicable,
details include candidate/span index, evidence ID, declared offset/length, quote
length, source length and authorized match count (capped at 2, meaning multiple).
All indices and offsets are zero-based; text lengths and offsets use UTF-16 units.

Database history nests these measurements under `details`; log events flatten them
and use `validationCode`/`validationPhase` to avoid confusion with transport errors.
No source text, quote text, candidate prose or arbitrary exception messages are
added to ordinary diagnostics. IDs and measurements pass the diagnostics allowlist.
Detailed Agent traces remain opt-in and use the same NDJSON envelope and rotating files as ordinary logs. Numeric candidate/span
locations can be included in repair instructions without replaying untrusted text.

## September 21 investigation

A read-only inspection of the local running node found 13 terminal failed batches
with 27 recorded quote rejections (24 extraction, 3 review). Those rejections fell
between September 19 03:28 UTC and September 20 11:12 UTC. The earliest retained
detailed Agent trace was September 20 17:58 UTC. Retained older ordinary logs had
no detailed Agent trace, and stored failure entries had only time, phase and the
aggregate `quote` code. Consequently, these historical failures cannot reliably be
attributed to offset, text, length or ambiguity errors. No private evidence was
replayed to a model or checked into the repository to make that attribution.

## Concurrency boundary

Before this change, Mote's `queryAgent` rejected a third active query and its memory pipeline ran whole jobs sequentially. Mote's Codex adapter launches a separate App Server
process per query. These are application constraints, not evidence of a Codex App
Server-wide maximum of two.

The [official App Server reference](https://learn.chatgpt.com/docs/app-server)
describes thread/turn routing and WebSocket ingress backpressure (`-32001`), but
does not establish a universal maximum number of simultaneous model runs.
The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes `agents.max_concurrent_threads_per_session` (legacy `agents.max_threads`)
as a limit on spawned-agent threads excluding the primary thread. It must not be
interpreted as an account-wide or App Server-wide root-query concurrency limit.
No live-model concurrency/load test was performed during this investigation.


## Same-conversation repair

Host output validation now runs before the provider session closes. The host supplies
only a fixed error code, trusted repair instructions and numeric candidate/span
positions. HTTP Harness reuses the same session ID and Codex App Server starts a new
turn on the same thread. Previously retrieved evidence, tool-call budget, scope and
run deadline remain in force. Exactly one correction is allowed across output JSON,
citations and host validation combined. A rejected correction terminates the run;
production adapters do not restart the whole extraction. The pipeline retains its
legacy two-generation fallback for third-party query adapters without the hook.

This applies to extraction/review, consolidation, calendar schema/quotes/references,
working-summary length and insight schema/presentation citations. Final host checks
still run before persistence. Source changes and other non-output failures are not
sent back as model-repair requests. No fuzzy quote matching or host-authored factual
correction is introduced.

Industry precedents: [Pydantic AI output validators](https://pydantic.dev/docs/ai/core-concepts/output/)
raise `ModelRetry` with feedback and consume a bounded output retry budget;
[LangChain structured output](https://docs.langchain.com/oss/python/langchain/structured-output)
returns schema failures as tool feedback and lets the model correct its output.

## Scheduling and operations

Defaults: `MOTE_AGENT_CONCURRENCY=8`, `MOTE_LLM_CONCURRENCY=4`, and
`MOTE_MEMORY_CONCURRENCY=3`. Settings > model execution and the owner-only
`GET/PUT /api/execution-settings` API persist overrides and apply them immediately.
Agent capacity covers complete runs. LLM capacity conservatively covers one provider
turn including its internal tool loop; it does not claim to measure each Codex HTTP
request. Capacity reduction lets admitted work finish. Queues are FIFO with aborted
waiters removed; background query admission is bounded to 1000 queued/running runs.

Memory scheduling rotates across jobs and admits independent batches. Evidence IDs
are conflict keys: batches touching the same original serialize, preventing competing
checkpoints while independent originals can progress. Final exact validation and
transactional commits still guard deletion/revision races. Parallelism reduces blocking
behind slow batches but increases provider load, process count and simultaneous token
spend; lower limits when upstream throttling appears. A task-type-only parallel flag
would be insufficient because two tasks of the same type may share evidence.

The memory page shows execution/queue counts, batch phase and last activity, completed
batches, last save, empty successful results and detailed rejection history. Pause and
cancel apply at batch boundaries; in-flight work finishes and saved results remain.
Diagnostic preferences have their own `GET/PUT /api/diagnostics-settings` API; changes
apply to the existing logger immediately and survive restart. Full traces include
prompts, tools, model deltas and Codex lifecycle events; ordinary heartbeat events
report elapsed/idle time without capturing content. Closing trace does not delete
previously retained logs.
