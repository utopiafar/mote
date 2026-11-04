# Central task execution policies

Each task registration selects an explicit policy from
`apps/server/src/execution-policy.ts`, with an operation-specific override where
needed. The executor has no implicit two-minute or 600-second deadline. `null`
means no workflow total, rather than a very large timer. The
[decision](adr-task-recovery-and-execution-budgets.md) separates task lifetime,
call protection, resource waiting, safe failure retries and model correction.

## Registered defaults and their reasons

| Task family | Execution budget | Actual failure attempts | Reason and narrower protection |
| --- | --- | --- | --- |
| Ask/Insight coordinators and delegated work | No workflow total; an explicit internal caller deadline can cap an admitted fragment | Query/Insight observation 1; replayable delegation up to 3 | Can yield to children or wait for model capacity. Each admitted Agent owns its configured model/tool/correction budget. Non-replayable observations are not resubmitted on restart. |
| File pipeline and summary coordinator | No workflow total | Child steps own finite retries | Extraction, diarization, alignment and model stages cannot inherit time already spent by earlier stages. Successful artifacts and summary pages are checkpoints. |
| Local ASR, diarization and OCR calls | One hour by default; existing explicit file `timeoutMs` is a per-call override | Up to 3 typed safe failures | Managed audio workers already have a one-hour subprocess limit. Call time starts after admission; unknown file outcomes retain their issued-call guard. |
| Model sessions | One hour of admitted work by default; explicit profile values or `null` preserved | Outer task policy; finite output correction remains separate | Counts actual model/tool/repair work, excluding host gate waits. HTTP requests retain their five-minute default and ten-minute maximum; Codex owns internal model requests. |
| Actions extraction | No outer total | Up to 3 typed safe failures | Agent sessions own their admitted-work budget; an outer timer must not charge model-queue waiting. |
| Memory batches, lifecycle windows and provider preparation | No multi-stage workflow total | Extraction and independent review each up to 3; lifecycle default 3 with an explicit extension bound; provider preparation 1 | Individual model calls retain protection. Prerequisite and child waits are not execution failures; failed children are not reopened by an outer loop. |
| Material organization, deterministic DAG and derived-image work | 15 minutes per admitted operation | 1 for deterministic work | Bounded current-input processing. Larger workflows keep separate checkpoints; semantic/model work has no outer model-queue timer. |
| Material FTS, consumer planning, image exclusion and Memory input binding | 5 minutes per admitted operation | 1 | Bounded local/metadata projection without external model waits; input/version fences remain. |
| Background embeddings | 5-minute operation protection; each HTTP call 45 seconds | Up to 3 typed temporary failures | Single-vector transport and bounded responses. Query vectors retain their explicit single-attempt deadline after pool admission and existing lexical recovery. |
| Recording discovery, metadata, transcript and media acquisition | No combined phase deadline | Up to 3 typed temporary failures | Phases contain multiple CLI/HTTP/archive operations with concrete transport limits; readiness and invalid export structure remain separate. |
| Import prepare/commit and source archive | No workflow total | 1; concrete children/calls own recovery | Can decode containers, organize inputs and invoke an Agent. Unknown exceptions need diagnosis, not another identical full import. |
| Plugin installation/check and bookkeeping/reconciliation | One hour per operation, or no total for an explicit orchestrator | 1 actual failure | Generous control-work protection; pending reconciliation is a declared wait. |
| Format decoding and asset hashing/encryption/staging | 15 minutes after a local worker slot is acquired | Caller owns recovery | Supports large originals and retains subprocess cleanup; queueing consumes no processing budget. |
| Memory deletion comparison | No default total over all candidate/rule comparisons | Existing per-call correction/recovery | Comparison count varies; each model call has its own policy. Explicit internal caller/test limits remain supported. |

The current replayable defaults are three attempts: the initial execution and
at most two automatic retries of eligible failures. This applies to
`orchestration`, `localProcessing`, `modelCall` and `networkAcquisition`.
`deterministic` and `control` remain single-attempt policies. Explicit
single-attempt registrations, including non-replayable Ask/Insight runs, query
embeddings, import prepare/commit and provider preparation, remain exceptions.
The cap does not make permanent or unknown-outcome failures replayable, and it
does not increase the existing model-output correction rounds.

The policy families provide a one-hour baseline for an actual isolated operation.
Registrations deliberately select narrower local work or no workflow total by
responsibility; this does not make every task a one-hour task. A source-AST
regression checks that every production registration declares its policy.

The fixed Python Source Pack sandbox retains its separate 30-second default and
120-second maximum for one hash-pinned script invocation. Its timer starts after
subprocess creation, alongside existing memory, filesystem and network limits.
Health probes, OAuth expiration and preview lifetimes are separate protocols.

## Waiting and recovery

Known capacity waits persist their reason and next eligible time without using a
processing-failure attempt. They release execution leases and preserve the parent
workflow and completed children. Normal shutdown and expired ownership leases
represent interruption, not a confirmed processing failure. Unknown issued file
calls still prevent automatic duplicate requests under the existing guard.

Reopening an existing execution preserves its attempt count by default. Only an
existing explicit owner recovery command resets the applicable failed work.
Automatic continuation, prerequisite rechecks, model-facing delegation retry and
observing a terminal child cannot renew its budget. A new admission checks the
retained count before executing, including after restart or repeated reopening.
Explicit reopen retains its existing immediate wake timing; lifecycle windows
still enforce their own persisted retry time before resuming an invocation.
Each actual failed lifecycle invocation is counted once from its durable receipt,
so observing the same failure after restart does not consume another attempt.
Paused, unconfigured and context prerequisites are checked before charging a
Memory status-bookkeeping execution.

Successful child outputs and artifacts remain reusable during failed-phase
recovery. Existing explicit recompute and reindex commands keep their declared
behavior; an ordinary failed-phase retry does not discard successful siblings.
A locally expired lease cannot re-admit the same task while this host's physical
task is still settling. Late cleanup may remove only its own active entry;
separate hosts retain the existing lease and publication fences.

Memory extraction and independent review own separate durable phase tasks, each
with three attempts for eligible failures. The coordinator yields without
charging an attempt while a child waits; observing a terminal child does not
reopen it. An explicit owner retry resets only failed or blocked children with
the current frozen input generation. Successful extraction and review remain
committed, so failed review recovery does not repeat extraction and publication
recovery does not repeat review. Automatic continuation and model-facing retry
preserve exhausted child budgets.

A phase stores its complete result, native draft pins and explicit review/read
receipts in the private `memory_phase_outputs` table, atomically with execution
success. This owned checkpoint is not an evictable extraction/review cache and
has no 512 KiB truncation or discard threshold. Missing or corrupt output for a
successful phase fails closed rather than issuing a replacement model call.
Cancellation, retired dependencies and deletion remove its private checkpoint;
a current authority check rejects late commits. Content-storage bulk decryption
includes these envelopes before retiring the encryption key.

A response is complete for recovery only after that transaction commits. Process
loss before local commit may require another authorized execution; this does
not establish exactly-once external model execution. Existing output correction
rounds, current-input checks, provider publication journals and native cleanup
remain separate from phase attempt accounting.

That guard is conservative across process loss: a file stage may have entered
its call-protection region while still waiting in an in-memory model gate. A
crash loses that queue state, so the saved guard can become `unknown` even if no
model request was sent. Without durable proof of non-execution it follows the
existing explicit unknown-outcome recovery path. Live gate waiting and a saved
explicit not-started busy response retain automatic resource recovery; this does
not promise transparent restart recovery for every in-memory queue position.

Resource waiting does not expire under a generic six-hour window. Actual typed
failures have the registered finite attempt bound; explicitly task-specific
recovery windows remain supported. Unclassified exceptions are not assumed
transient. Model validation receives trusted feedback and finite correction;
revoked authority and deterministic invalid inputs do not enter that loop.

Managed ASR extraction/diarization and managed OCR use opaque physical-listener
resource keys shared across stages and database connections. Worker busy feedback
sets a persistent shared cooldown. Five seconds is a busy availability recheck
interval, not an estimated finish time. Custom OCR services retain configured
concurrency while sharing their explicit busy cooldown. Independent central
databases do not gain distributed fairness or exactly-once worker execution.

The persisted next-eligible time drives API and structured waiting diagnostics.
Model gates recheck cooldown after admission. Web requests do not translate a
model execution budget into a second wall-clock deadline that includes waiting;
explicit cancellation remains available.

## Existing work and validation

Managed loopback OCR, ASR and diarization requests carry one UUID per actual
POST and an instance/step/generation-bound scope. The authenticated worker
retains only fixed execution metadata. Status GETs do not acquire a model or
physical processing slot, create model usage or consume another attempt.
Accepted/running facts retain waiting. A terminal failed fact may settle the
original failed attempt and resume the same current phase with its remaining
budget; shutdown-refunded attempts are restored once by identity, never reset.
Three actual eligible failures remain terminal across polling and restart.
Unsupported input remains permanent. The normal owner retry remains explicit.

A successful worker fact cannot replace a lost result body. Missing facts,
changed credentials/configuration and an old worker interrupted by process
restart remain unknown. Existing unknown-outcome confirmation still applies;
no status read manufactures an artifact or authorizes another POST. Successful
artifact commit releases its exact issued wait in the same transaction.
Cancellation, deletion and changed input authority permit only exact terminal
receipt cleanup. Active/unknown worker records cannot be erased; terminal
erasure retains consumed identity so an old POST cannot execute again.

No historical terminal task is reopened and no historical attempt counter is
reset on deployment. New file defaults do not revive old failed work. Manual
retry retains current-input, permission and unknown-outcome checks. Original
uploads, completed artifacts and retention rules remain intact.

Registration and parent replay do not retry a terminal failed child. Explicit
manual recovery may retry its failed children without discarding successful
checkpoints. Unpublished intermediate Agent rounds remain in-memory session
state; they are not an exactly-once or cross-restart checkpoint guarantee.

An automatic Insight window can replace its precisely linked failed observation
only during that window's scheduled, finite typed-transient recovery. The old
observation remains failed. Restart alone, an unclassified outcome, a permanent
failure or cancellation does not authorize a replacement observation.

A confirmed import retains its canonical commit identity across lease
interruption and resumes after its saved record position. Only that internal
execution grant can continue an `importing` job; the owner confirmation API still
requires its reviewed preview, and completed imports are not rerun.
