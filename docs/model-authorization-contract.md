# Background model authorization integration contract

Status: integrated core/media/UI candidate awaiting implementation review and CI. No release or merge is claimed. Baseline: `7a62fef74289bd09dc8a57712a379c8639ef1cf5` plus the existing model-authorization working changes. Product scope is [P1-K](ui-user-journeys.md#6-单一实施清单). This document describes that code so the independently owned media consumer can integrate against precise interfaces. It does not grant approval or replace the independent review required by [testing](testing.md#risk-based-review).

## Owned interfaces

`apps/server/src/background-model-authorization.ts` exports:

```ts
type ModelConnection = {id: string; fingerprint: string};
type ModelDataKind = 'text' | 'image' | 'audio' | 'conversation';
type ModelDataScope = {sourceIds: string[] | null; dataKinds: ModelDataKind[]};
type ModelDisclosure = {sourceId: string; dataKind: ModelDataKind};
type AutomaticModelPurpose =
  'memory' | 'working' | 'insight' | 'activity' | 'actions' |
  'image' | 'file' | 'embedding' | 'semantic' | 'integration';
```

`modelConnection(id, settings)` hashes the complete resolved settings, including credential/header identity, without persisting credential plaintext. `agentModelConnection(identity, settings)` uses `${identity.kind}:${identity.id}:${settings.model}` as its connection ID. `ModelAgentIdentity` lives in `model-agent.ts` and has `{kind: 'profile' | 'file-service' | 'probe', id: string}`. The factory requires this host identity in its fourth argument; arbitrary prompt fields, job prefixes, lane names and HTTP booleans are not authority.

`ModelAuthorizationHost` in `model-authorization-host.ts` owns intake identity conversion and entrypoints:

- `automatic(id, purpose, candidates, task, signal?)` selects unconsumed accepted roots, or restores the same durable work after restart. `task` receives its cancellation signal. A dependent call inherits the current host authority.
- `manual(id, connections, task, signal?, kind = 'manual', identities = [])` is only for an existing explicit owner action. It must not be called to repair missing background authority.
- `captureModelIdentity(id)` is `capture:<id>`; `sourceModelIdentity(sourceId, inputKey)` is `source:` plus the JSON pair; `conversationModelIdentity(turnId)` is `conversation-turn:<id>`.
- `capture`, `source` and `conversation` record original intake in the producer's transaction. `derive` inherits known roots in the publication transaction; it does not grant permission to historical inputs.

Consumers use `control.assertCurrent(connection)` at the real model send and again before publishing results. `control.assertDisclosure(disclosures)` checks the approved source and representation. Historical references are allowed only inside that scope and still pass existing privacy, deletion, version and source visibility checks. Native relays use `control.capture(connection)`, a host closure; do not serialize an authority token into plugin arguments. `ExecutionEngine.bindModelAuthority` captures the task on enqueue, restores only that exact task for execution, and checks the authority at commit. No receipt means no automatic trigger, not deletion of the original.

## Owner control plane and current semantics

`GET /api/model-authorization` returns `{authorization, connections, processing: 'new-intake-only', historicalContext: 'within-approved-scope'}`. `authorization` includes revision, epoch, state, connections, scope and acceptedThrough. Connections currently have IDs and fingerprints only; a UI must show a comprehensible resolved model/provider identity without exposing credentials.

`POST /api/model-authorization/commands` takes `{revision, operationId, action}`. `action: 'authorize'` also requires the exact selected `{id, fingerprint}` pairs and `scope`; pause/stop reject these extra fields. Operation IDs are UUIDs. Revision conflicts and stale connection fingerprints return 409. Both routes require the owner, not a paired device or Agent credential.

- First approval is prospective. Original receipts denied before approval or during a pause stay denied across duplicate delivery, derived publication and restart.
- Pause blocks new admissions; already admitted work drains under its captured scope.
- Stop increments the epoch, aborts active automatic work and fences old work after restart. Explicit owner operations are separate.
- A changed connection fingerprint never silently inherits background approval. Fixed model choice is enforced by identity. Dynamic routing, cost scheduling and fallback algorithms remain Hold.
- Current `authorize` snapshots a new scope for future work but does not increment the epoch or narrow already admitted work. The independent review must confirm that UI disclosure matches this behavior; do not silently reinterpret it as immediate revocation. Stop is the current immediate revocation operation.
- Third-party scripts that independently access the network remain the explicitly accepted known limitation. Host fences do not establish a script sandbox.

## Integrated consumers and UI

The design received coordinator APPROVE bound to the earlier document SHA256 `a9befe431642f0693a00ab448a68087445c67bb863bb739efdff955136f03d8f`. This updated implementation report does not replace final implementation review.

Media commits `5d97ebc2` and `2b640c65` are integrated. `app.ts` alone resolves and registers the actual file-service/default-profile connection, retains `{settings,identity}` atomically, and injects `ModelProcessingAuthority`. Missing identity on a saved snapshot returns 409. Explicit retry and confirmed historical IDs get durable per-item owner intent; background/restart never synthesize it. The historical item ledger matches reservation bytes plus 128 and rolls back under quota failure without consuming the preview.

Owner query snapshots retain a single-turn model override without approving it for background work. Imports use a saved manual admission. Embedding checks the exact embedding connection before sending and after receiving. Native Memory relays capture the actual model identity. Source projections inherit their original capture receipt. Memory integration uses its own `integration` purpose for original roots; explicit selected-card integration saves `owner-integration:<windowId>`. Integration receives no additional raw-reading grants and checks authority again at publication.

The Web settings component shows connection identities, source/representation scope, data/cost consent, and distinct pause/stop commands. Drafts survive transient errors, uncertain retries reuse the exact command UUID, and server changes reset drafts. Scope edits explicitly affect future admissions. English strings are synchronized to Android; this is not a native UI implementation.

## Validation and limits

All data/model outputs are generated fixtures. Previously passed checks were reused: authorization/executor 19; model profiles 4; query workspace 2; no-model note persistence 1; settings/query/evidence 24 with the remaining media accounting case subsequently fixed and passed. Query admission/failure/cancellation 3 passed after its fix. Indexer execution, import cancellation and semantic product 19 passed after consumer wiring.

New assembled HTTP tests cover owner-only access, stale/forged connection rejection, prospective intake and historical scope, restart, stop/late result, real loopback ASR/OCR bytes, explicit old-item retry, frozen historical membership and embedding publication fencing. They are not live-provider tests. Web component tests cover explicit consent, pause/stop, draft cancellation, offline retry and uncertain command replay (3 passed). A hidden browser exercised the real server's approval/pause/stop UI; the rebuilt page displays readable media identities and was checked at a 390px viewport without horizontal overflow.

Memory image regressions passed 23 cases after generated fixtures gained explicit consent. Memory integration initially exposed missing authority at the actual consumer; after fixing it, the 7 failed recording/native cases passed, with the 5 unaffected successes reused. A new real Store quota fixture verifies 507 rollback, exact batch-member accounting and persistence across restart. Server typecheck, Web production build and translation check (8659 messages) passed. Final candidate CI and independent review remain required.

The affected selector expands to native platforms because the English catalog is shared. The user's focused-validation instruction applies: Central affected behavior, Web build/UI and catalog synchronization; no duplicate full-platform run. No physical-device, emulator or live-model quality evidence is claimed. Third-party independent networking remains the recorded limitation. Automatic topic classification is a separate reviewed module whose production dependent-task wiring is not yet part of this candidate.

## Incremental review fixes

Independent review of `3b07f4bf` requested two corrections. Both were reproduced by assembled HTTP fixtures before fixing: a new image with only image/text and its source approved never reached VLM, and a 507 historical-confirmation failure left one manual admission. Image evidence now uses `taskContext.imageEvidence` with no fabricated conversation turn. Historical confirmation uses `manualCommand`, a synchronous transaction covering admission, item intents and frozen members; asynchronous callbacks are rejected. The two regressions and the existing restart/frozen-membership HTTP journey pass after the fix. Quota is set before the HTTP command; repeated failure and database reopen preserve exact logical bytes and work count. Agent build and server typecheck passed.


### Calendar/main integration validation

After #257 merged, the only manual conflict was the `featureServices` declaration in `app.ts`. The resolved app file remains byte-identical to approved candidate `4b2b78c8`: both `pluginCenter` and every model authorization/owner-intent service are retained. Main's action grant storage-ledger expression is merged alongside existing model/media/topic accounting.

The combined managed-calendar HTTP fixture now separately authorizes model reading of its generated text source through `/api/model-authorization/commands`; calendar write grants remain independent. The multi-source case explicitly authorizes model reading of the second generated source while preserving the narrower calendar write grant. No production gate was weakened. Initial loopback testing hit sandbox `listen EPERM`; the same generated HTTP test received normal execution approval. Then 8/9 managed-calendar cases passed; the sole multi-source fixture was updated and rerun successfully. The two focused image-understanding and historical-quota authorization cases passed, as did shared library build, Server/Web types and i18n. This is split focused evidence, not a new full-suite run or live calendar/model validation.
