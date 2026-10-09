# ADR: Memory package context and batch coverage

Date: 2026-10-09. Status: accepted for the internal Memory request correction.

Memory extraction carried the same package goal, instructions and complete member
contract in both `question` and `taskContext.memoryWork`. A valid wide batch could
therefore exceed the Agent question limit before its model session started. This
appeared as a provider failure, although the request never reached the provider.

The complete package and member contract now travel in the existing task context.
The existing bounded interpretation text also travels there, without changing its
12,000-character serialization. The question retains the extraction policy and
validation feedback, with references to the contract and untrusted interpretations. Neither the Agent question limit nor
the total context budget changes. Independent review receives the same originals,
member identities, ranges, package information and complete draft.

Package completion belongs to the host's aggregate job. Extraction and review
account for each listed target range in full. Other ranges scheduled separately
do not by themselves make a fully inspected range need context. Actual missing
interpretive context still requires `needs_context`; a partial range cannot prove
that the entire original or package is complete. This clarifies the existing
range-based contract rather than converting a model's semantic decision in code.

| Classification | Disposition |
| --- | --- |
| KEEP | Full original delivery, model interpretation, exact coverage keys, independent review, candidate capacity, grants, fences, privacy, existing limits and explicit retry policy. |
| CHANGE | Internal request packaging and explicit batch-local extraction/review instructions. |
| REMOVE | Duplicate package/member serialization in the question and the implication that a single range must complete the overall package. |
| EXCEPTION | Genuine missing context remains blocked; validation and budget rejection remain authoritative. |
| UNKNOWN | Live-model adherence, semantic recall and original-media accuracy require separate observation. |

Affected surfaces: Memory pipeline requests, work coverage instructions,
independent review, context assembly and budget checks, persisted draft request
hashes, package tests and current behavior documentation. Existing successful
checkpoints and published outputs remain intact. No navigation, model selection,
evidence scope, permission, retention, retry count or automatic retry changes.
Failed or blocked batches require their existing explicit recovery path; this
correction does not silently replay them.

See [validation](memory-batch-context-validation.md).
