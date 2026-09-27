# Complete paired-answer display export

The new read-only exporter requires all eight frozen question pairs and their 16 completed answers, preserving the original fixed Response 1/2 mapping. It binds manifests, result bytes, completed receipts, continuous ledger and closed phase-v2 supervision before writing a fresh external blind-review package. Partial/failed pairs, unknown accounting, altered references, unclosed processes and continuing stops are rejected. A prior failed background stage remains recorded and must have an explicitly bound recovery event; this exporter never authorizes recovery.

The package retains full question/answer strings and all public citation content, including `contentAt`, provenance and file evidence. The initial four-field citation assumption was corrected after checking actual API enrichment and UI usage. Schemas validate nested values without trimming, adding defaults or rewriting the original JSON. Current query usage, execution trace, configuration and slot/call IDs are omitted. Naturally visible Memory references remain intact, so perfect blinding is not claimed.

The implementation imports only pure shared schemas and performs no database access, model invocation, scoring, unblinding or cost aggregation. Source files and output must be outside the repository; output must be fresh. Original source hashes are rechecked after export.

Generated validation and independent Node 24 replay both passed 23/23, with zero provider and zero stub model calls; scripts typecheck passed. An earlier malformed generated provenance fixture failed and is preserved separately. No actual heldout export or scoring has run: the real replay remains stopped before completing the required eight pairs.

External evidence: `ROOT_SAFE_heldout-review-export-delivery-v2.json` and `heldout-review-export-independent-001/ROOT_SAFE_independent-review.json` under the September 27 goal directory. The delivery includes both implementation hashes and the eight pure-schema dependency hashes. These schemas and the exporter must be pinned when an actual export is prepared.
