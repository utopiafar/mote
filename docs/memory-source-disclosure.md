# Progressive Memory evidence disclosure

Memory summaries are selected, model-derived context. They can describe subjective experiences, provisional interpretations or time-limited preferences. Automatic effectiveness does not make them independent facts.

The read-only `memories` tool exposes three levels without a separate Fact store:

1. A listing returns bounded overview cards, with filters and continuation cursors.
2. `memories({id})` returns the statement, uncertainty and supporting original locators. Saved quotes are omitted from the model projection: an old stored quote does not establish current permission or a valid original version.
3. `memories({id, includeEvidence: true})` also returns up to three supporting original ranges, each capped at 2,000 UTF-16 units. The host verifies current read permissions, request scope, the canonical original fingerprint and the exact stored quote/range. Material query metadata can differ from its canonical evidence identity; the verification uses the canonical record and requires identical text in the permitted query projection.

The response places delivered ranges in `sourceEvidence`, with original IDs, provenance and `textRange`. `sourceCoverage` reports the supporting reference count, delivered range count and whether selection, truncation or unavailable proof left partial coverage. Partial coverage is not evidence that a claim is false, nor that the archive lacks relevant material.

Only successfully serialized ranges inside the shared retrieval budget enter the citation ledger. A Memory ID, locator, unrequested range, inaccessible original or rejected oversized response cannot authorize a citation. Disjoint quotes retain their individual offsets. Evidence text remains untrusted input and cannot supply instructions or mutation tools.

The model may answer from sufficient delivered original ranges, without another call merely to read those same ranges. For missing detail, ambiguity, a visual question or conflicting evidence, it can deepen its read using the existing original tools. Direct original search remains available for fresh facts and exact details; there is no compulsory traversal of every layer and no keyword-based scenario routing. This mechanism reduces avoidable repeated reads; it does not itself prove lower latency, fewer tokens or better answers.

Generated verification lives in `packages/agent/test/memory-disclosure.test.mjs` and `apps/server/test/memory-source-disclosure.test.ts`. It covers opt-in disclosure, citation ranges, scope, permissions, stale/fabricated proof, budget rejection and formal Material identity. These fixture checks do not establish live semantic quality, image/audio accuracy or physical-device behavior. Live scenario results belong in the separate iteration validation record.
