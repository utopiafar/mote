# Background model authorization integration contract

Current interface checked against the implementation on 2026-11-14. The original integration landed in [#253](https://github.com/utopiafar/mote/pull/253); its older connection/data-kind/epoch control surface is no longer the current API. The dated implementation and validation notes below are historical evidence, not tests rerun for this update. Validation guidance is in [testing](testing.md#risk-based-review).

## Current owner control plane

`GET /api/model-authorization` returns only `{authorization: control.view()}`. Both this route and `POST /api/model-authorization/commands` require owner access; paired collectors and Agent credentials cannot change the switch.

```ts
type ModelConnection = {id: string; fingerprint: string};
type ModelDisclosure = {sourceId: string};
type ModelAuthorityView = {
  revision: number;
  state: 'off' | 'on';
  excludedSourceIds: string[];
};
```

Commands take `{revision, operationId, action}`, where `operationId` is a UUID and `action` is `on`, `off`, `stop` or `exclude`. Only `exclude` accepts and requires `excludedSourceIds`, the complete replacement list. The implementation rejects unknown fields and stale revisions. Replaying the same last operation with a different body conflicts.

- `on` opens automatic admission over eligible original receipts. Work received while the switch was off can run after it opens. A receipt marked ineligible stays ineligible; an old reference without an original receipt cannot become a new automatic trigger.
- `off` stops new automatic admissions and lets already admitted work drain. A fresh attempt of saved automatic work waits while the switch is off.
- `stop` also turns the switch off, aborts active automatic work and invokes the existing batch-stop control. It does not introduce a public epoch or remove archived originals. Late results still pass the original/job/publication checks.
- `exclude` withholds the listed sources and aborts their affected automatic calls. Re-including a source can resume its withheld eligible work; a completed purpose is not claimed twice. Unlisted and new sources participate by default.
- Automatic work uses the model configuration current at the actual call. Changing a connection fingerprint does not require a new background approval. Explicit manual/probe work still captures exact connection IDs and fingerprints, and cannot silently send through another connection.

This is the existing owner switch and source exclusion contract. It has no `ModelDataKind`, `ModelDataScope`, representation tier, selected-connection approval list, `authorize` command or public epoch field. Do not reconstruct those retired controls from earlier reports.

## Host and consumer boundaries

`modelConnection(id, settings)` hashes resolved settings, including credential/header identity, without persisting credential plaintext. `agentModelConnection(identity, settings)` uses `${identity.kind}:${identity.id}:${settings.model}` as its connection ID. `ModelAgentIdentity` lives in `model-agent.ts` and has `{kind: 'profile' | 'file-service' | 'probe', id: string}`. The factory receives this trusted identity in its fourth argument; prompt fields and HTTP booleans do not issue authority.

`ModelAuthorizationHost` in `model-authorization-host.ts` owns intake conversion and model entrypoints:

- `automatic(id, purpose, candidates, task, signal?)` claims eligible unconsumed original roots for that purpose, or resumes that exact saved work. A dependent fragment inherits its parent's current authority.
- `manual(id, connections, task, signal?, kind = 'manual', identities = [])` is for an existing explicit owner action. It cannot repair missing background authority. Synchronous owner commands use the existing `manualCommand` transaction.
- `captureModelIdentity(id)` is `capture:<id>`; `sourceModelIdentity(sourceId, inputKey)` is `source:` plus the JSON pair; `conversationModelIdentity(turnId)` is `conversation-turn:<id>`.
- `capture`, `source` and `conversation` record original intake in the producer's transaction. `derive` inherits known original roots in the publication transaction without issuing a new trigger or retroactively authorizing old references.

Consumers call `control.assertCurrent(connection)` at the actual send and before publication. Automatic disclosure rejects currently excluded sources; manual connection assertions remain separate. Both still obey source visibility, privacy filters, original retention, deletion, version and raw-reading checks. Native relays capture the authority in a host closure rather than serializing it to plugin arguments. `ExecutionEngine.bindModelAuthority` restores the exact durable step's authority and checks it at commit.

Model installation, dependency preparation and plugin selection never grant background authority or create content-analysis tasks. Local image intake and local ASR follow the same existing authorization as other processing. Image intake may use its selected local model while Memory extraction, independent review and Ask retain their own selected models, including cloud models. `allowQueryImages` still controls on-demand original-image reading; the remote OCR setting retains its existing OCR meaning. There is no new global image outbound switch, derived-text tier or local-only restriction on later workflows.

Owner queries and explicit file retries remain manual operations. Imports keep their saved manual admission; embeddings check their actual connection; source and Material projections inherit lineage. Query agents have read-only context tools, and external effects require Actions product authorization. Third-party scripts that independently access the network remain the known host boundary; these checks are not a script sandbox.

## Historical integration and validation reports

The following records describe earlier candidates, including retired scope/epoch behavior and old test counts. They are retained for history and must not be used as the current API, current authorization semantics or evidence that this update reran those checks.

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
