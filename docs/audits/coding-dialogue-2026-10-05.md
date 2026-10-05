# Coding dialogue boundary acceptance — 2026-10-05

## Confirmed boundary

The owner requires raw Coding transcripts to remain outside every model context. Central cleans them using provider protocol rules before indexing, retrieval, conversation understanding or Memory. The admitted input is human utterances and protocol-confirmed final replies. Reasoning, commentary, diagnostic process text, tools, host context, delegated sessions and unknown-finality replies remain outside the model-facing projection. Semantic importance is still chosen by models over this admitted dialogue.

The earlier tool-only exclusion left assistant process text visible. A subsequent full-conversation overview pass also expanded model reads before bounded batch work. Both paths are closed in this release. Schema 6 is required by model read and understanding boundaries; the overview implementation is removed. Missing multipart events have no readable message body, and complete messages over 12,000 UTF-16 units are withheld with fidelity limitations. Explicit host wrappers are removed before applying that budget. Legitimate quoted code remains authored evidence, not independently verified execution.

Native Claude UUIDs stabilize event identity across file rewrites; compaction sidechains and Codex subagents cannot replace parent dialogue. Kimi final text is reconstructed only at TurnEnd from the last tool-free step, using a bounded persisted scanner buffer.

Queued understanding children now depend on durable parent input authorization rather than the parent’s temporary worker lease. Parent yielding cannot make an unchanged child stale; cancellation, paused admission, revoked grants and changed inputs still prevent commits. Pending work reports the understanding stage and polls with a bounded delay.

## Isolation and validation scope

`scripts/test-coding-dialogue-real.ts --local-sample --live` is explicitly opt-in. It copies authorized native Claude, Codex and Kimi text into a private temporary directory and builds a fresh isolated Central vault. The production database and native journals are not modified. Raw or derived personal text, native session identifiers, source paths and credentials are not committed or included in the report. Temporary contents are removed at completion. `MOTE_ACCEPTANCE_CLAUDE_FILE` can privately select the compaction scenario without storing a personal path in source code.

Live calls use only local Codex App Server with `gpt-6.1-sol`. Instrumentation checks the admitted model evidence ranges and actual Codex RPC messages for excluded process snippets. The evidence limit is 12,000 UTF-16 units per call; complete RPC size also includes host prompts and transport metadata. The live test runs personal and Coding recipes over the real cleaned Claude conversation, checks completion, and verifies that completed jobs do not replay model calls. Native Codex and Kimi samples independently exercise parsing and publication; no live-model coverage of those samples is claimed.

Generated fixture tests separately cover protocol phases, compaction IDs, Kimi checkpoint reconstruction, multipart publication, unknown speakers, oversized messages, old-schema denial, no full-conversation prepass, queue saturation, cancellation, input mutation and manual upgrade without historical backfill. No physical-device, screenshot or Android validation is claimed by this change.

## Latest real-data rule run

The final rule run on the updated source completed on 2026-10-05. Counts include uploaded textual events; dialogue counts include the published evidence headers. Native Claude input includes the compaction sidechain file, whose process copies are excluded by protocol.

| Native source | Files | Uploaded text characters | Admitted dialogue characters | Materials |
| --- | ---: | ---: | ---: | ---: |
| Claude | 2 | 2,036,393 | 41,035 | 1 |
| Codex | 1 | 1,679,603 | 8,602 | 1 |
| Kimi | 1 | 9,452 | 1,026 | 1 |

This run made no model calls. The same native Claude fault scenario is used for the separate live chain below. No previously persisted production material was repaired or backfilled.

## Real local-model chain

The native Claude dialogue above completed with local Codex App Server `gpt-6.1-sol`, using low reasoning effort and 12,000-character evidence batches. This was an isolated acceptance run, not a replay or repair of production jobs.

| Recipe | Batches | Completed | Terminal failures | Published memories |
| --- | ---: | ---: | ---: | ---: |
| Personal Memory | 4 | 4 | 0 | 1 |
| Coding Memory | 4 | 4 | 0 | 8 |

There were 17 model queries, including independent reviews and slow-call retries, and 23 observed Codex RPC deliveries. Excluded process snippets were absent from inspected evidence and RPC. Evidence was at most 12,000 characters per model query; the largest entire RPC was 32,986 characters including host guidance, JSON escaping and metadata. All eight understanding children succeeded without stale processing inputs. Running both completed jobs again made zero additional model queries.

The run took 17.1 minutes. It demonstrates completion and the input boundary, not uniformly fast provider responses: several calls required timeout/retry. Different extraction-policy identities intentionally have separate understanding work; cross-policy one-call reuse is not claimed. The rules-only rerun above used the final wrapper-cleaning code; the live run began before the later wait-poll delay adjustment, which is covered by the final fixture suite.

## Final local checks

After synchronizing with main, `npm run check:local` completed successfully, including translation synchronization, library builds, workspace/script type checks and the full fixture suite. `npm run build:central`, `npm run build -w @mote/desktop`, both component release-version checks and `git diff --check` passed. No generated fixtures, real personal logs or temporary vaults are part of the release source. Central and Desktop are version 0.0.83; Android remains on its independently published version.
