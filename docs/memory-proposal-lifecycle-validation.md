# Memory proposal lifecycle validation

## Durable regression journeys

| Transition | Required result | Test |
| --- | --- | --- |
| Proposal submission → erroneous yield | Corrective error; no durable wait; normal return finishes planning. | delegation-proposal-lifecycle.test.ts |
| Old impossible wait → restart | Complete plans pass product validation without model replay; incomplete plans resume with local IDs. | delegation-proposal-lifecycle.test.ts |
| Old wait + revoked authority or cancellation | No replay or product grant. | delegation-proposal-lifecycle.test.ts |
| Planning → independently scheduled inspection | Yield remains available for the worker. | delegation-proposal-lifecycle.test.ts, delegation-runtime.test.ts |
| 25 units, missing goal or invalid limit → correction | Specific host error survives loopback HTTP; valid calls succeed atomically. | delegation-proposal-lifecycle.test.ts |
| Memory old wait → review → checkpoint | Complete input coverage; repeated ticks do not rerun work. | memory-delegation.test.ts |
| Overlapping historical plans → remaining input | No double claims or partial admission; remaining originals processed. | memory-delegation.test.ts |
| Feedback regroup/stop, frozen ranges and restart | Proposal phase, independent review and exact authority retained. | memory-feedback.test.ts, memory-feedback-status.test.ts |
| 1000 generated originals | Bounded catalogs and all original checkpoints. | memory-delegation.test.ts |
| Product pause → resume behind 65 stale historical branches | Current parent rejoins and completes; stale authority stays stale; no model or checkpoint replay. | memory-delegation.test.ts |
| Product pause → resume behind 65 authority-rejected branches | Bounded reconciliation advances past rejected history and wraps its cursor; grants and original product attempt policy remain unchanged. | memory-delegation.test.ts |
| Paused/failed source queue → explicit product resume → queue restart | Planned and legacy queues relaunch the same claimed product; terminal products and disabled scheduling stay stopped. | material-memory-work.test.ts |
| A full page of paused entries → later resumed entry; revoked grant | Dormant queue cursor advances; only the explicitly resumed authorized product launches; revoked claims are cancelled. | material-memory-work.test.ts |

These tests use generated data and responses; they do not prove live-model or
device behavior.

## Opt-in local Codex acceptance

After building shared libraries:

```sh
MOTE_PLANNING_CODEX_LIVE=1 node --import tsx scripts/test-memory-planning-codex-live.ts
```

Optional MOTE_CODEX_BIN, MOTE_CODEX_HOME, MOTE_TEST_CODEX_MODEL and
MOTE_PLANNING_REPORT select the runtime/report. Defaults use gpt-6.1-sol with
high reasoning. Temporary vaults, generated data and the read-only local Codex
App Server adapter are used. The owner's archive, connectors and screenshots
are never loaded.

The production adapter plans 64 members, including eight oversized originals,
with bounded submissions and exact coverage. A replacement execution host
repairs a persisted complete legacy wait and reuses handles without another model call. A separate four-original
journey enters through authenticated loopback HTTP, runs real planning,
extraction and independent review, validates checkpoints and restarts the
application without replaying completed work. Every attempt writes a private
report outside source control, including failures.

Record actual live results separately from fixture checks; these scenarios do
not establish semantic recall, production speedups or physical-device behavior.

## Recorded live acceptance, 2026-10-07

Local Codex CLI 0.159.3 / App Server, gpt-6.1-sol, high reasoning: passed
in 195.2 seconds using four real model calls.

| Scenario | Observed result |
| --- | --- |
| 64 generated members, including eight long originals | 15 packages, three submissions of at most eight units; complete unique catalog coverage; planning returned normally (84.3 seconds). |
| Persisted legacy wait with a replacement execution host | All 15 handles reused; validated complete plan handed off with zero additional model calls. |
| Four generated authored originals through authenticated HTTP | One actual product job; extraction and independent review completed; four original checkpoints. |
| Full application restart | No extra model call, duplicated job or active operation. |

Incomplete-plan completion, erroneous yield correction, argument errors, revoked
authority, disabled admission and overlapping catalogs are fixture regressions.
The live run does not claim to exercise every failure mode or a physical device.
No owner archive or personal screenshot was used.
