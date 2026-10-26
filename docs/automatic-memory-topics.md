# Automatic Memory topic index

This slice implements model-produced topic references and the Central Web consumer. It does **not** enable background model calls by itself. The model authorization owner must connect the original admitted Memory task, its durable recovery and the exact model transport before this is a complete automatic journey. Android and desktop do not yet consume this index. No live-model quality or physical-device evidence is claimed.

The bounded persistence/authorization design received independent APPROVE from the integration coordinator on 2026-10-26, bound to baseline `7f3f17b1` and design SHA256 `1c064082cd32de2abc1d87f19c3b2a90b0a7e43051e6e2af6e0bbc6eb0b45092`. Product authority remains [the user journeys](ui-user-journeys.md), particularly B/E and P3-D. This is a browse index, not Memory correction, fact extraction, lifecycle redesign or a new grant.

## Host integration

`features/context.ts` initializes `featureServices.contextTrees.automatic` against the existing Store and EvidenceReader. A trusted classifier registers `{id, version, classify({memories, signal})}` and receives a disposer. The module exports `TOPIC_CLASSIFICATION_INSTRUCTION` and `topicClassificationSchema` for the model adapter. The host invokes:

```ts
await contextTrees.automatic.classify(
  {operationId, classifierId, memoryIds},
  {admissionId, signal, assertCurrent},
);
```

`admissionId` is the original host admission, not a user field. `assertCurrent` must fence its epoch and exact resolved model connection, including after restart. The classifier callback must use the host's model send gate and source/representation disclosure checks. A stored ID alone cannot reconstruct authority. Run as dependent work under the original Memory admission: creating a second `memory` purpose task from already consumed roots is not permission to re-admit them. Missing authority, configuration or receipt must block; never substitute a manual operation, scan historical inputs, or trigger a model from a GET request.

The classifier returns only `{trees:[{id,label,nodes:[{id,label,parentId?,memoryIds}]}]}`. Strict host validation rejects unknown/duplicate references, duplicate identities and cyclic/missing parents. Memory bodies are untouched. Model text remains untrusted, and topic labels are presented as model-organized navigation rather than new owner facts. The host adapter should send only the fields needed to classify, preserving uncertainty and attribution.

## Persistence and visibility

`context_topic_batches` contains one immutable completed result per operation ID: original admission ID, classifier identity/version, the complete input set (`id/version/fingerprint/body digest`), and derived labels/references. It contains no second copy of Memory statements or evidence. Completion inserts an operation receipt and atomically advances `context_topic_heads` for the exact classifier/version/full-input snapshot after synchronous authority and input checks; a successful empty classification is also recorded. Repeated delivery of the exact operation returns completion without another model call and never restores a superseded head. A newly authorized operation for the same exact input replaces its visible result, including an empty result. Concurrent work for that snapshot conflicts rather than publishing out of order. Changed admission, classifier or input identity conflicts. Failure/cancellation does not publish a batch. Both tables participate in the existing StorageLedger byte accounting; reservation includes the new receipt and net head growth. A quota failure leaves the previous head and labels intact. In-flight task recovery belongs to the host's durable admitted task, not this table.

All inputs, including ones the model did not assign to a node, are label dependencies. Every directory/node read checks current EvidenceReader visibility and exact versions. One unavailable, superseded or changed dependency hides the whole batch. Remaining readable members do not keep an invalid label alive. Asynchronous reads are rechecked before returning; node pagination also rechecks after reading members. Unavailable provider errors fail the read rather than using a saved body. Classifier removal/version change hides its contributions.

Tree IDs are a stable namespace of the exact classifier/input snapshot and model tree ID; node IDs are the validated model IDs. Independent batches are not merged by guessed label similarity. One original Memory may appear in several nodes and trees without copying it. Existing static dimensions and trusted explicit-ID tree contributions remain available, with the `auto.` namespace reserved for this service.

## Consumer and evidence

The existing `/api/context-trees` directory and node routes remain the read surface. The directory adds classification availability/running/failure state. Web checks the visible directory every five seconds, marks missing selections, hides stale members/details and offers return to all memories. Transport failure is visible and retryable; ordinary Memory browsing remains available. English strings are synchronized to the Android catalog; that does not establish a native topic UI.

Focused generated-fixture coverage includes multi-tree identity, unchanged Memory row count/body, exact operation replay after database reopen, an unassigned deleted dependency, late output after stop/deletion/plugin disposal, malformed output, empty completion, offline retry, concurrent duplicate work, denied admission, scoped pagination, correction invalidation and unauthenticated HTTP, asynchronous classifier withdrawal and configured-quota failure after restart. Web component coverage includes loading, errors, retry, revoked catalog, literal untrusted labels and missing-selection return. The hidden Electron fixture exercises actual HTTP, renderer, evidence details, two trees, offline recovery, invalidation, 320/390 widths and English state. All fixtures use synthetic originals/model outputs; they do not establish live-model quality or production authorization wiring.

The affected selector expands to all platforms because translations are shared. This slice uses the owner's explicit focused-validation instruction: server/Web checks, Central build, translation synchronization and the actual Web fixture. Unchanged unrelated platform suites are not re-run. Production host wiring, its automatic restart/stop journey and independent implementation review remain merge prerequisites.
