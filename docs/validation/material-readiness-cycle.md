# Material processing readiness cycles

A retained uploaded recording can become pending, block on a lost processor response, and return to pending after an explicit product retry. Its draft can then exactly match a historical readiness manifest. Treating that match as a content rollback leaves the previous blocked Material visible and fails the current organizer generation.

The source-item publisher may opt into a processing state transition. MaterialStore verifies that the current and requested bodies are identical after excluding only coverage and artifact state/reason. A historical match receives a fresh immutable revision and sequence; normal CAS, authorization, source members, attribution, original retention, and content rollback rejection still apply. The option is a host argument, not an HTTP input or query tool.

Supersession check:

- KEEP: immutable history, fixed references, CAS fencing, original bytes, unchanged evidence anchors, and rejection of historical source content rollback.
- CHANGE: a verified readiness-only cycle can publish a new occurrence of an earlier status.
- REMOVE: applying the general historical-content rejection to an unchanged source body returning to pending.
- EXCEPTION: only the trusted source-item publisher supplies the state-transition option; append publishing and ordinary publication keep their contracts.
- UNKNOWN: fixture acceptance does not establish live processing recovery, ASR accuracy, or attribution quality.

Generated validation:

- A retained recording enters through FileStore begin/part/commit, publishes pending, becomes blocked, and resumes pending through the actual organizer and publisher. The original asset, evidence anchors, historical blocked reference, new sequence, and idle repeat behavior are checked.
- MaterialStore rejects ordinary historical republishing and stale CAS even when the host option is present. It accepts a readiness-only cycle, keeps its immutable history and idempotence, and still rejects rolling back changed source text with that option.

All fixtures are synthetic; no personal screenshots, recordings, credentials, or deployment snapshots are checked into this scenario.
