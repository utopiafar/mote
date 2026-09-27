# Host deadline classification

A host-created timeout could reach the Memory pipeline as a native `TimeoutError` and be persisted as `model_failed`, even when the Agent trace classified the same deadline as `AgentTimeoutError`. A generated `buildApp` extraction-success/review-timeout case reproduced the mismatch before this change.

The host now owns a small deadline wrapper that aborts with `AgentTimeoutError`. It forwards an earlier caller cancellation by exact reason identity and disposes its timer and listener after settlement. Both the query wrapper and preparation deadline use it. Existing late-result checks and the outer HTTP execution deadline remain in place; this change adds neither retries nor a forced termination mechanism for a provider that ignores cancellation.

The generated case now persists `provider_timeout` without a Memory or checkpoint commit. Six focused tests also cover late results, the HTTP 504 boundary, one failed receipt, cancellation identity, and cleanup. Eighty-one related existing tests passed. Independent review found no blocker and added one generated early-rejection/late-cancellation check. No real model or private input was used.

Root ran `npm run check:local` with Node 24.15.0: exit 0. Desktop 345, Server 940 with one skip, Web 125, Agent 189 with one skip, Shared 70, and the remaining workspace and runner checks passed. The two skips were not executed. This does not constitute a physical-device or live-model check.

External evidence is stored in `host-agent-deadline-offline-001` and `host-agent-deadline-independent-001` under the September 27 goal directory. The root verification report SHA256 is `597b98e4f0cace532b39c01022ebc7a5e1b15d0a28b36bde91b5f026ca58d788`. Historical failure records and the separate frozen heldout production tree remain unchanged.
