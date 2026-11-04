# Task recovery and task-type execution budgets

Accepted: 2026-10-15, by the owner. The owner subsequently authorized applying
these principles to all Central task registrations and failure handling,
reproducing failures with generated fixtures, and opening a PR after verification.
Historical failures must not be rerun. Defaults are in [task execution
policies](task-execution-policies.md); verification and deployment scope are
recorded separately from this decision. The owner approved the current
single-owner bounded-retry restoration on 2026-10-23; its implementation is
recorded below.

## Decision

A durable task must not inherit a universal short processing deadline, such as
600 seconds. Each task type declares its own suitably generous default execution
or timeout policy when its workflow is designed and registered. This does not
require every task to run without a timeout. Workflows can gain stages and
complexity without acquiring an unrelated limit from the common executor.
Queueing and resource contention are normal waiting states, not failed
processing. They must not terminate the parent workflow by exhausting execution
attempts or a generic recovery window.

Task designers declare execution and recovery policy by task type and stage at
registration, rather than relying on a hidden executor fallback. The declaration
can specify a generous task-specific timeout or explicitly no overall timeout,
and separately describe call-level protection. Expected work and workflow
complexity inform this engineering choice; they are not a semantic classifier or
an automatic complexity score. A concrete model request, external protocol or
isolated worker can have an explicit, justified deadline. A workflow-wide limit
belongs to that task's declared policy. A value such as one hour is a possible
generous task or call default, not an approved universal replacement for 600
seconds. Existing explicit configuration values remain overrides at their
documented operation boundary; installation does not rewrite private profiles.

Keep these mechanisms separate:

- Task lifetime and durable progress, including queueing and dependency waits.
- A specific call's transport deadline or worker safety limit.
- Execution ownership leases, renewal and fenced publication.
- Resource admission and the next eligible dispatch time.
- Safe execution-failure retries and model-output correction rounds.

Removing a generic task deadline does not remove cancellation, authorization,
shutdown, lease expiry, worker cleanup or stale-result fences. A lease expiring
does not prove that an external call stopped. Actual elapsed time and progress
remain observable even when they are not a hard execution limit.

## Failure handling contract

Classify failures from structured transport facts and host validation contracts,
not keywords, captured evidence or provider prose. Distinguish lack of execution
capacity from an input exceeding a model's context or format capability.

| Failure or transition | Required handling |
| --- | --- |
| Confirmed resource contention or a confirmed execution-capacity rejection before processing begins | Persist resource waiting, release execution slots and resume automatically when eligible. Do not consume the processing-failure budget or end the parent because a generic attempt/recovery deadline elapsed. Shared backoff prevents repeated immediate requests. |
| Model output that fails a repairable host validation contract | Return trusted, specific validation feedback to the model and allow a finite correction sequence. Repair the failed stage, retain valid drafts/checkpoints, and validate again before publication. Do not blindly restart the whole workflow. |
| A replayable transient execution/transport failure | Use the task type's finite safe-retry policy. Establish replay safety from known non-execution, idempotency or a confirmed failed outcome; keep this budget distinct from capacity waiting and output correction. |
| Deterministic invalid input or an unsupported operation under unchanged conditions | Stop the affected execution with a precise reason. Examples include a corrupt archive or an unsupported format with no configured handler. Repeating identical work is not recovery. A changed input or configuration can support a later explicit run. |
| Missing configuration, credentials, model/runtime dependency or required owner input | Expose the actual prerequisite and wait for repair/action. Do not repeatedly invoke the model or pretend a program failure is a request for owner context. |
| An issued call with an unknown outcome | Retain known issuance and outcome facts; do not use the known-not-started capacity recovery path. Timeout, disconnect, local cancellation and lease expiry do not establish non-execution. Replay follows the task's safety, idempotency, reconciliation and confirmation contract; this ADR introduces no new universal confirmation step. Existing file issued-call guards remain required. |
| Cancellation, revoked authority or a stale input | Stop the old authorized execution and reject late publication. Neither model repair nor resource recovery renews authority or revives obsolete work. |
| An unclassified internal exception | Preserve a safe failure receipt for diagnosis. Do not infer that another attempt is safe, that the input is invalid, or that capacity is unavailable. |

A deterministic validator rejecting one model output does not prove another
generation will fail. Finite output correction is required where the host knows
how to ask for a valid correction. A task declares its repair boundary; exhausting
that sequence reports the remaining validation failure. It does not trigger
another outer loop of identical generations. Existing model-repair limits are
not increased by this decision. Evidence changes, revoked grants and unknown
execution are not repairable output errors. Feedback uses host-controlled
instructions; captured content remains untrusted evidence.

Resource recovery is durable waiting, not an unlimited stream of outbound
retries. Recheck resource eligibility and current authority before dispatch,
preserve fair scheduling and avoid holding a transaction or physical execution
slot while waiting. A prolonged wait remains visible and cancellable; this
decision adds no queue cap, expiry, retention rule or automatic terminal age.

## Single-owner bounded retry restoration

Replayable orchestration, local processing, model calls and recording network
acquisition default to three attempts: the initial execution plus at most two
automatic retries of an eligible failure. Deterministic and control policies
remain at one attempt. Explicit single-attempt registrations, including
non-replayable interactive observations, query embeddings, import prepare/commit
and provider preparation, remain unchanged. This supersedes the former four-call
model/local/delegation defaults, five-call recording default and two-call Actions
extraction default. Permanent errors and unknown external outcomes do not become
automatically retryable, and model-output correction rounds do not increase.

The executor preserves attempt counts when reopening a task unless an existing
explicit owner command resets the applicable failed execution. Automatic
continuation, prerequisite healing, model-facing delegation retry and repeated
observation of a terminal child are not owner reset authority. The executor
checks exhaustion again before dispatch, so reopening or restarting cannot
produce a fourth execution in the same bounded round. Current-input, privacy,
configuration, cancellation and unknown-outcome checks still apply to an owner
retry. Successful siblings are preserved; existing explicit recompute commands
retain their separately declared scope.

Resource and child waits do not consume a failed-execution attempt. Lifecycle
windows persist both their retry time and the exact failure receipt already
counted; a repeated observation after restart cannot increment the failure count
or shorten the domain's backoff. An explicit reopen keeps its existing immediate
wake behavior, so confirmed readiness is not delayed by a new generic wake
policy. Prerequisites such as paused or unconfigured Memory status are checked
before claiming a bookkeeping execution.

After local lease expiry, the same host must wait for its old physical task to
settle before admitting that task again. Its final cleanup may remove only its
own active entry. Other hosts continue to use durable leases and commit fences;
no lease transition proves that an external effect did not execute.

Memory extraction and independent review now use separate durable phase tasks.
Their identities pin the batch, input generation and strategy, independent of a
renewed parent lease. Each phase owns three eligible execution attempts. Child
waiting refunds the coordinator's attempt, and a terminal failed child stops
that path instead of acquiring another budget from the parent. An explicit
owner retry may reset current-generation failed or blocked children; it preserves
successful extraction and review. Automatic continuation and model-facing retry
cannot reset them.

A dedicated `memory_phase_outputs` table stores the full semantic result,
explicit independent-review receipt, evidence/image read dependencies and native
draft/provider pins in the existing private envelope. The row and phase success
commit in one transaction. These are owned checkpoints, not evictable cache
entries: outputs above 512 KiB remain complete. Every successful-phase recovery
requires a readable, valid checkpoint; missing or corrupt output fails closed
without repeating the model call. Publication continues through its existing
journal, with completed review reused after publication failure. Correction
rounds and review acceptance contracts remain unchanged.

Cancellation, input invalidation, dependency retirement and deletion remove the
private outputs, with authority checks fencing late writes. An admitted batch
may finish while its job is pausing, preserving the existing pause-drain
contract. Bulk decryption traverses these envelopes before key retirement.
Generated fixtures cover restart with encrypted and decrypted storage, actual
process exit on both sides of local commit, failed-phase owner reset and
successful-phase reuse. A response lost before local commit is not a completed
checkpoint; recovery does not promise exactly-once model execution across that
boundary.

The restoration was checked with generated fixtures through the recording
connector's authenticated HTTP entrypoint, Material publication and transient
Memory extraction/review recovery. Tests retain the 1,000-original delegation
corpus, local and two-host lease recovery, capacity waiting, failed-phase reuse,
unknown-call protection, cancellation/deletion and source progress while Memory
is held. This is fixture evidence, not physical-device or live-model evidence.

## File and worker admission

Reuse the central durable executor for resource admission. Transcription and
diarization on the same physical worker share capacity; central alignment and
language-model stages do not hold that ASR resource. A worker's explicit
pre-execution busy response, with Retry-After, provides a fallback for occupancy
that the central scheduler cannot observe. Central state, API and diagnostic logs
must use the same next-eligible time and waiting reason.

Both parent pipeline and child stages need consistent waiting, attempt and
deadline semantics. Changing only the error category after claim is insufficient:
the current claim already increments attempts. Central lease release must not be
mistaken for physical worker release, and an unknown call must not be treated as
either proven idle or permanent occupancy of the whole service.

The central executor remains the workflow authority. A worker-side persistent
job queue, distributed coordinator, new queue limit or short-job priority policy
is outside this implementation. Independent central databases cannot coordinate merely by
sharing the current SQLite lease mechanism.

## Supersession check

| Disposition | Boundary |
| --- | --- |
| KEEP | One central execution authority; archived originals and upload acknowledgements; successful checkpoints; fair scheduling; source/privacy/configuration checks; cancellation, leases and fences; unknown-call guards; finite safe-failure retries and finite model correction; existing model bindings and retention. |
| CHANGE | Each task type explicitly registers its own generous default timeout policy and recovery policy when the workflow is developed. Confirmed resource waiting is separate from failed execution and must propagate through parents without ending the workflow. Call limits are independent from task lifetime and waiting. |
| REMOVE | A short common deadline as the default task lifetime; queue wait consuming processing time; every busy response consuming a failed-processing attempt; resource waiting ending merely because the common four-attempt or six-hour rule elapsed; unclassified exceptions assumed transient; log-only retry delays differing from scheduling. |
| EXCEPTION | Specific model/transport/worker limits remain possible with an explicit rationale. Model context overflow is not worker contention. Actual transient failures can retain finite recovery. Issued unknown calls, stale authority and deterministic failures keep their restrictions. User-configured limits require an explicit transition decision. |
| UNKNOWN | Performance and quality of real long inputs under the declared defaults; multi-worker or independent-central coordination; identity and physical release history of the worker involved in the incident. |

This supersedes conflicting policy in [execution-engine](execution-engine.md),
[provider-failures](provider-failures.md), [file-processing](file-processing.md)
and the task-wide deadline interpretation recorded in the dated
[audio timeout validation](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/validation/audio-processing-timeout.md). Current behavior is described by [task execution policies](task-execution-policies.md);
the dated validation retains the old implementation and results. The bounded
recovery wording in [recording outcomes](adr-recording-outcomes-runtime.md),
[range evaluation](adr-memory-range-evaluation.md) and
[system refactor](adr-system-refactor.md) continues to apply to actual failures,
not confirmed resource waiting. The retained total-deadline wording in the
[Ask simplification decision](adr-ask-evidence-quality-and-simple-context.md)
does not establish a universal task deadline under this decision. The
[request admission decision](adr-central-request-admission.md) and
[honest Memory failure states](adr-memory-evidence-delivery-and-failure-state.md)
retain their authority. No new semantic fallback or smaller substitute input is
approved. Dated validation results remain historical evidence.

Inspected assumptions include the executor's default timeout/attempt/window,
parent/substep replay, file and format workers, query/delegation/import/lifecycle
deadlines, provider cooldowns, model correction contracts, runtime configuration,
failure projections, tests and repository instructions. Existing tests that
expect busy exhaustion or a log-only delay describe behavior to supersede; they
do not decide the intended policy. Runtime migration must inspect the affected
prompts, UI, configuration, jobs and consumers before claiming completion.

The implementation replaces the executor's implicit two-minute limit and
large-number no-deadline stand-ins with explicit registered policies. It separates
file pipeline/call deadlines, starts format/asset timers after slot admission,
and removes model-budget wall-clock wrappers around query queues. HTTP providers
can omit an Agent total while retaining their request timeout. Memory/source/DAG
coordinators no longer inherit a short total across their child calls. Nested
model correction remains finite; outer lifecycle recovery cannot blindly reopen
a terminal child. The shared execution protocol projects resource waiting;
provider adapters retain transport facts and task types own recovery decisions.

## MVP scope and validation

The single-owner recovery restores the independent media execution-fact
contract from the owner-approved 2026-10-18 reliability decision (historical
`2c78ca8d`, `docs/adr-scoped-processing-reliability.md`). Its account machinery is
superseded by [the single-owner ADR](adr-single-owner-mvp.md). One managed
worker request has a unique ID, exact stage and private instance/step scope;
authenticated terminal metadata can establish a failed physical execution
after response loss. Worker service incarnation does not identify model
weights. Reloading a model never rewrites an existing request, and restarting a
service maps its old accepted/running records to unknown rather than failure.

The host reconciles outside model execution and restores only the original
issued attempt count under matching current input, generation, configuration
and wait identity in one settlement transaction. It does not reopen a terminal
step, reset a budget or replay completed work. A successful physical execution
with a missing body remains unavailable. Custom/remote services without this
contract retain the existing unknown guard. Credentials and recognition bodies
are absent from the fact journal; its private files contain fixed identities,
timestamps, states and allowlisted failure codes. There is no result cache,
historical loader, migration, new polling promise or new retention limit.

R10 received independent pre-implementation **APPROVE** from Sol High against
`38e1eb5a56302c7491415a4f86c95de2b2d48cda`, including the narrow engine attempt
recovery method, authenticated status/erasure, consumed-ID tombstones and
generated real-process validation. Actual test results remain separate from
this decision.

Historical terminal failures can be rerun manually in MVP. Do not build a
historical recovery migration, reset attempts on deployment or automatically
reopen old work. This decision does not execute a manual retry or remove the
existing confirmation for unknown outcomes. The separate Android Memory
continuity issue is outside this ASR repair.

Implementation validation must use generated content and real product entry
points: long multi-stage work, bulk resource waiting and eventual progress,
model validation feedback and finite correction, deterministic failures, unknown
outcomes, cancellation/authority changes, restart, checkpoint reuse and agreement
between API/logs/actual dispatch. Cover contention across stages and independent
resources, and any multiple-worker/central topology that is explicitly supported.
The initial documentation-only discussion ran no fixtures. Implementation
fixtures and final affected checks are recorded in the [verification
record](validation/task-execution-policies-2026-10-15.md). Private historical
scenarios are not automatically counted as passed tests; physical-device and
live-model validation remain separate.
