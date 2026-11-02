# Agent Runtime and Host output contract (A01)

This is the P0 contract for A03–A17, following [H01](native-plugin-architecture.md). Its common service, identity and lifecycle vocabulary is frozen H02 commit `020a50996e917fa52852034943a1e486893169d5`. This document and the two new contract modules do not switch the current runtime, create a Host implementation or establish a real runtime/consumer journey. H02 integration and dependency wiring remain coordinated by root.

## Responsibility and trust

A RuntimeProvider drives an engine. It receives a Host-resolved runtime profile, a separately leased model adapter and a restricted local HostRunPort. `prepare(profile, model, host)` returns a handle with `run`, `repair`, `cancel` and `close`. A handle returns candidate **text** and a typed terminal. The candidate is never an AgentAnswer/QueryResult, citation, receipt, grant or persistence instruction.

The Host owns the accepted input, run identity, scope, tool snapshot, original delivery ledger, source/evidence dependencies, context assembly, active execution budget, optional outer deadline, repair count, output service and final eligibility check. Only the trusted Host output service constructs AgentAnswer from those values. C27 and other product writers still check current authority in their actual transaction; output acceptance is not permission to persist or perform an external effect.

The output service is a required, restart-replaceable foundation (`mote.agent.host-output`, exact API `1`). It is leased before runtime preparation or any evidence disclosure. Missing, revoked or incompatible output service rejects the run. This is an explicit change from today's optional `QueryInput.validateOutput` callback: a domain validator remains a pure, trusted part of the Host evaluation pipeline; it does not replace base parsing/citation/delivery validation. The service receives only responseMode/skill/taskContext/validateOutput policy, candidate and Host evidence/metrics, not the full QueryInput, Host control channel or tool/grant callbacks.

Official and independent providers use the same runtime service (`mote.agent.runtime`, exact API `1`) and explicit ServiceBinding. The binding selects a particular contribution/scope/activation and implementation revision. There is no installation-order fallback. A02/A09 resolve runtime/model profiles and pair capabilities; A01 does not reinterpret model protocol as runtime selection.

These are local trusted interfaces. ModelLease adapter values and resolved configuration may contain secrets or trusted launch handles and must never enter public receipts or prompts. Arbitrary same-process code can violate TypeScript contracts; the parser and tool ports are not a code sandbox. Work-unit isolation belongs to the common Host. Query remains read-only; Import workspace and Host delegation require their separately authorized task capabilities.

## KEEP / CHANGE from the current producer and consumer paths

The behavioral baseline is main `e96a74c94f72d72d427487485039ae56b72318f5`, incorporated unchanged into H02. In particular it includes PR #395 image steering. Source references below describe the current implementation, not a claim that the new path already executes.

| Current responsibility / real seam | KEEP | CHANGE / owner |
| --- | --- | --- |
| `index.ts` and `codex-agent.ts`: `pinContextTools` before `startBridge` | Immutable names/version/schema fingerprints, exact selected ranges, saved-query capability comparison; fresh checks on each read | A04 creates one Host session; A08 unifies built-in/extension registration without privileged built-in bypasses |
| `systemInstructions` and `assembleContext`, bridge seed evidence | Host-selected responseMode, skill, language, zone, untrusted labels, selected evidence/direct images, Memory coverage keys and assembly metrics | A04 owns assembly; A13 registers task/skill/context packs; provider receives assembled prompt only |
| `context-tool-session.ts` / `evidence-ledger.ts` | Navigation and metadata do not grant citations; exact actually delivered original ranges, image identity and source/lineage dependencies | A08 retains one Host ledger and grants; packs consume read ports and cannot manufacture original receipts |
| Both paths: `parseAnswer(bridge.records)` → `restoreMemoryCoverageKeys` → `validateHostOutput` | This order, exact excerpts/inline citations, trusted domain feedback, no hand-authored semantic answer | A04 implements one Host output service; A05/A12 remove duplicate parsing/result authority |
| Both repair loops and `ActiveExecutionBudget` | At most three model-authored corrections in the same evidence/model session; total active budget is not reset | Host controls attempts/repair guidance. Provider `repair` only drives the same engine session |
| DSH `turn/end`, Codex `turn/completed` / fail-closed native calls | Typed error/limit/cancel facts; no free-form provider-message classification | A05/A12 map into RuntimeOutcome; A11 normalizes lifecycle/usage |
| DSH `output_limit` behavior | Reject truncated candidate but allow bounded shorter model-authored repair; still fail after exhaustion | Shared Host handles this explicitly, rather than accepting syntactically valid truncated text or making it unconditionally nonrepairable |
| Current runtime result assembly | Host-original image/range receipts, source/evidence pins, context usage and run ID | A04 alone assembles them; provider authority fields fail candidate parsing |
| `app.ts` authorization wrappers, result checks and C27 commit | Admission, original/source/deletion revalidation and persistent execution/transaction fence | A06/C04/C27 retain these real checks. Service lease validity does not replace data authority |
| Runtime/bridge/observer/process cleanup | Await shutdown and pending setup; preserve primary failure and report secondary cleanup failure | A04/A11 unify cleanup; do not carry Codex finally's potential primary-error masking into the common skeleton |

One existing concrete producer → consumer is `apps/server/src/insights.ts:validateInsightOutput`: it validates an Insight candidate using `insightResult`, returning trusted `insight_shape` repair feedback on shape failure. `app.ts:queryAgentAuthorized` injects it; both runtimes call it through `types.ts:validateHostOutput` after parsing and coverage restoration. The new local output lease must compose this domain check with base Host validation. Its feedback is not a public PluginFailure message and is not serialized into PluginSnapshot. A04/A06 will verify this actual consumption after implementation; the A01 type fixture is not T3.

## Run selection, events and lifetime

`ResolvedRuntimeProfile` and `ModelLease.selection` carry separate runtime/model profile IDs and revisions. The runtime binding revision describes its implementation; profile revisions describe configuration. Model selection includes the model ID/revision and transport. `assemblyFingerprint` pins resolved native assembly. Host emits this nonsecret RuntimeRunIdentity on observations. No executable, home path, secret, package source or credential is a receipt field. A02 validates pairing structurally before prepare; Codex App Server login cannot be silently paired as a DSH HTTP model.

Each run/repair has a Host-issued attempt ID/index. `HostRunPort.runModel` and `emit` carry that attempt; Host rejects unknown, late or settled attempts. `tools.ready` may use a null attempt during prepare only. Host compares the actual loaded tool composition with its pinned definitions, including name/version/fingerprint. A notification by itself is not authority. HostRunEvent distinguishes an engine's `attempt.terminal` from the one final Host `run.terminal`: runtime completion may still be rejected by output/fence/cleanup. Providers cannot emit either terminal observation directly. Host completion is not a durable-write receipt. Usage preserves existing TokenUsage cumulative/incremental semantics, unknown buckets, interrupted partial usage and queue/LLM/harness units; A11 owns normalization, not the provider's claim of successful output. Observer exceptions cannot alter execution, grants or cleanup.

Normal configuration replacement quiesces new acquisition but keeps accepted leases and resources alive until drain. A fixed old lease remains valid even if a newer generation is published. Revoke, stop, uninstall, expired installation identity or data authorization loss fences affected work immediately. An AbortSignal alone does not prove an uncooperative task cannot commit. Lease release is idempotent, invalidates that lease, does not close siblings, and is not remote rollback. Runtime/model/output/tool leases and domain grants must all still be valid at final eligibility checking.

Runtime capability declarations include supported transports, task kinds, tools/images, Import workspace, Host delegation, recovery and replacement policy. A declaration is not execution evidence. Durable provider recovery may only be advertised when its versioned checkpoint adapter has been implemented and verified by A09/A15; a journal containing old prose is not engine recovery or a citation grant. Host durable consumers pin the required profile/assembly versions and either recover accurately or report blocked/stale, never substitute a new engine silently.

## Candidate and terminal boundary

`parseRuntimeOutcome` is the production parser for this new boundary. Only these plain-data shapes are accepted:

```ts
{ terminal: { kind: 'completed' }, candidate: { text: string } }
{ terminal: { kind: 'output_limit' }, candidate?: { text: string } }
{ terminal: { kind: 'failed', reason, providerFailure? } }
{ terminal: { kind: 'cancelled', cause } }
{ terminal: { kind: 'yielded' } }
```

Failed/cancelled/yielded outcomes cannot carry a candidate. Extra fields are rejected at outcome/candidate/terminal/providerFailure boundaries, including QueryResult, citations, receipts, ledger, grant and run identity. Objects with accessors, symbol fields or class prototypes are rejected without reading getters. The parser copies supported data; it does not retain mutable provider objects. Empty, invalid JSON or oversized text remains candidate text until Host parsing, preserving existing output error reasons instead of confusing response validation with transport schema errors.

`providerFailure` carries existing structured category/code/retry/admission facts, without raw exception text. The adapter derives these from typed SDK/App Server/HTTP facts; a syntactically valid code still needs trusted adapter normalization before public diagnostics. Host treats `failed`, `cancelled` and `yielded` as non-success. Unverified tools and exhausted tool recovery cannot be repaired into a successful product result. `output_limit` is a typed rejected attempt eligible for the bounded repair policy. Terminal success plus candidate text still needs all Host parsing, evidence, domain and final authority checks.

## Actual delivery and images

The Host tool port owns lookup, schema/scope/plugin/fresh-grant checks and exact delivery accounting. A provider supplies only a tool call and adapter sender. The Host obtains authorized payload, checks authority again and awaits the sender's actual boundary before updating eligible delivery state. A rejected sender, stale attempt or cancelled/revoked scope must not add a receipt. A successful transport call does not imply that the remote model attended to the content. Tool payload, including base64, stays out of public events/receipts.

Two image edges must remain distinct in A05/A08F/A12:

- DSH attachment preparation and its current Host-local delivery acknowledgement preserve the original `prepared` meaning. Discovery, metadata or an attachment path alone do not prove remote attention.
- Codex #395 uses `turn/steer` with the same active `expectedTurnId`, checks the ACK turn ID before acknowledging the dynamic tool, and fails on mismatch, stale completion, steering error or cancellation. Do not regress to dynamic-tool `inputImage`, start a new turn, enable native tools or log echoed base64. The current Codex bridge acknowledgement occurs before the steer operation; A08F/A12 must move confirmation behind the successful sender boundary when integrating the new port, preserving the current fail-closed final outcome.

Actual originals and image grants remain Host-owned. Third-party metadata cannot cite itself into the ledger. Dialogue-attached image grants and archive image permissions remain separate, with existing hash/crop/quota/dedupe checks; stopping one pack does not grant another more pixels or evidence.

## Budget, output and cleanup

HostRunBudget separates `activeTimeoutMs: number | null` from optional absolute `deadline` in Unix milliseconds. A11 retains ActiveExecutionBudget behavior: wait for model admission, then charge actual admitted work; repairs share the remaining active budget. Do not convert activeTimeoutMs into `Date.now() + timeout`, charge queue waits or restart the budget for repair. Null disables only the active deadline; an independently supplied outer deadline/signal still applies. Model request timeout remains a separate A10 transport setting.

The Host checks typed terminal/tool readiness, parses the candidate against its own ledger, restores coverage keys, runs the selected output/domain validators and either requests a bounded correction or produces a result. Before returning an accepted result it rechecks signal/scope/grant, lease generations, tool availability and source/evidence dependencies after awaited work. C27/Memory/Import check their transaction fence at the persistent write. The Host session has no commit method or implicit write grant.

Cancel/close cover prepare, queue wait, tool read/delivery, model stream, repair and drain. Stop new work, revoke eligibility, cancel, await all pending setup/tool/model work, close runtime/bridge/transport and release leases in dependency order. Keep dependencies alive during permitted drain. Do not report success if required cleanup failed; when there is already a primary failure, keep it and expose secondary cleanup failures separately. Cleanup cannot silently delete durable submitted-effect reconciliation records.

## DSH extension boundary and follow-up

Use only rc.2 public root exports. Go/mote-35's integrity-matched public-tarball inspection supplies static evidence for setFactory, setup/commit and the four Hook dispatch points, not execution proof. Default AgentLoop occupies the single factory slot and does not expose its registration disposer. A03/A07 must use DSH child-runtime restart for factory replacement, or separately prove plugin unload/reload that drains all handles. Do not promise direct same-process hot replacement. `setup` may await; `commit(): void` is synchronous. AgentHandle has `dispose`, not invented Agent.close/Session.close methods. Native packages are trusted code, not sandboxed by the tool guard.

| Follow-up owner | Real behavior and counterexamples still to verify |
| --- | --- |
| A03 / J09 G1 | Real locked loader/profile, non-Mote native pack, Hook alters loop, actual replacement factory executes after restart; setup/commit/unload/cancel rollback and drain. No SDK spike runs as part of A01 |
| A04 | Real bridge-delivered originals feed shared output; same legal DSH/Codex candidates produce equivalent results; invalid/unread citation, injected write instruction, exhausted repair, late validator after revoke and cleanup failure reject appropriately |
| A05/A08/A12 | Actual runtime schema/tool readiness and sender boundaries; stop/revoke during original/image delivery rejects late receipts; Codex #395 success, reject, mismatch/stale and cancellation cases |
| A06/C27 | Actual buildApp/authenticated query → Host output → QueryRuns/Conversations; missing required output, denied auth, invalid pairing or stale transaction fence produces no successful product commit |
| A09–A11 | Config prepare/activate/persist rollback, fixed runtime/model/tool pin, accurate recovery or blocked state, fresh observable attempt authorization and active/queue/partial usage |
| A16 / J08/J09/J10/J16 | Independent runtime/tool packages and selected converged journeys; actual Codex and live models only by explicit manual selection, separate from fixtures |

A01 light checks are the new runtime-outcome parser T1 cases and compile-only real-declaration consumers. `runtime-contract-types.test.mjs` compiles the actual declarations/negative samples with the repository TypeScript dependency, so they remain in the ordinary Agent test glob rather than an unexecuted example. They do not load DSH/Codex, instantiate a Host, execute tool delivery or establish T3. After H02 merges, publish an independent A01 diff based on main; A05/A13/A17 own public Agent exports and default wiring. This card does not edit `types.ts`, `index.ts`, `query-agent.ts` or existing runtime implementations. Package/dependency/lock and build ordering are owned by the designated package writer.
