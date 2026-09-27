# Heldout replay preparation and deterministic retransmission

No live model, private material, or screenshot was used. The coordinator and adapter author did not inspect heldout source, question, or rubric semantics. Local programs read the frozen generated inputs; public metadata contains only counts, hashes, stage/status, and fixed error codes. Vaults and identity manifests remain outside Git under `DO_NOT_OPEN`.

`scripts/test-heldout-memory-replay.ts` currently supports only `prepare`, `clock-probe`, and `duplicate-probe`. It rejects live mode. The active Goal already authorizes generated-sample model iteration; the remaining gate is an independently reviewed staged execution budget and runner, not another user consent request.

## Frozen inputs and structural result

- Corpus v2 freeze: `367c19ff948908151d4ae1fcd55e8f194bf314de4a02f3824d7c246ff6697e8c`.
- Current evaluation v2.1 freeze: `c8fa7c2439da14d540a0877804da8c6fe6e1e5ae7cebe8ff65b3f8f95fc06f24`.
- Preparation 005: 120 normal SourceItem API deliveries, 114 unique records, 80 note deliveries / 40 coding deliveries, 6 exact retransmissions, 4 late first arrivals, 3 projects, 8 sessions, 6 waves, and 8 question checkpoints.
- Final storage: 76 note captures, 38 immutable Coding archive events, 84 Materials. Coding publication ran after each event: 30 real continuation revisions; exact duplicates preserved identity and revision. No Coding session spans waves in this corpus, so that particular case is not claimed.
- Two recipes apply to every new/revised Material: `mote.personal-memory@2` and `mote.coding-memory@2`, with 12,000-character normal batching. Unchanged Materials are not rescheduled at a different semantic date.
- Six wave batch counts: `6 / 6 / 10 / 6 / 8 / 6`, total 42. The planning cap is 84 extraction/review + 24 integration/review + 16 Ask = **124 outer agent calls**, not a live authorization to launch the whole run. Empty outputs can reduce this count; internal provider/repair turns require separate accounting. Each outer deadline remains 300 seconds.
- Closed SQLite backup and Memory-only ablation preserved 155 protected tables. All 76 ordinary exact source segments were reconstructed through the production aggregator and compared. Coding originals remain in SourceArchive and Material indexes in both arms.
- Record `receivedAt` was checked against actual API wall time. Coding original JSON was preserved, with a separate real API receipt interval; no historical receipt field was invented. Transport wave, availability, and event-group metadata never entered source payloads.

Preparation 003 used wave-end publication and the earlier evaluation v2; 004 added per-event Coding publication and stopped on a real exact-retransmission revision drift. Neither is overwritten by 005. Preparation 005 predates the additional tombstone regression test below; it is not evidence for that separate boundary. Its then-pending clock gate is supplemented by the independent clock probe, not rewritten.

## Product correction and targeted checks

Exact archive retransmissions now retain an existing work item when its archive checkpoint and source/recipe/configuration pins are still valid. This preserves completed publication, running workers, and failure backoff; explicit retry and genuine changed inputs remain available. Empty Coding append preserves artifact revisions, and Material no-op comparison checks normalized manifest content **and actual ordered members**. Member or dependency revision changes still publish.

Repeated processed tombstones no longer re-redact an unchanged Material while skipping its worker. New deletions still immediately hide changed groups. A mixed batch regression covers an old tombstone replay in one session and a new deletion in another.

Validation: **34/34** tests across `source-pipeline-execution`, `coding-append`, `material-inputs`, and `materials` (6 new generated tests). Checks include running-worker preservation, failure backoff plus explicit retry, configured reprocessing, new continuation, member/dependency changes, and the tombstone boundary.

The integrating task's full `npm run check:local` passed (`check-local-007.log`), including 922 Server tests and the other workspace/script checks recorded in the semantic-clock validation. Two optional tests across Server and Agent remain skipped; no live or physical-device check is implied.

Independent `duplicate-probe-002`: 3 deliveries / 2 unique generated events, 0 stub / 0 real calls; retransmission keeps Material revision and input fingerprint. Independent `clock-probe-002`: 5 stub / 0 real calls; extraction, review receipt, integration, Ask opening/catalog/default Memory reads, and fallback supersession use their pinned semantic times. Explicit historical reads remain available. The clock probe also checks completed checkpoint reuse, nonempty Memory ablation, and terminal usage after `app.close()`.

These stubs validate structure, not semantic quality or Memory benefit. Semantic clock implementation has its own [validation record](semantic-context-time-2026-09-27.md).

## Reproduction and artifact hashes

```sh
MOTE_HELDOUT_OUTPUT=/new/external/directory node --import tsx scripts/test-heldout-memory-replay.ts
MOTE_HELDOUT_MODE=clock-probe MOTE_HELDOUT_OUTPUT=/new/external/clock node --import tsx scripts/test-heldout-memory-replay.ts
MOTE_HELDOUT_MODE=duplicate-probe MOTE_HELDOUT_OUTPUT=/new/external/duplicate node --import tsx scripts/test-heldout-memory-replay.ts
node --import tsx --test apps/server/test/source-pipeline-execution.test.ts apps/server/test/coding-append.test.ts apps/server/test/material-inputs.test.ts apps/server/test/materials.test.ts
```

External metadata lives under `/Users/utopiafar/Documents/Codex/mote-goal-2026-09-27/`; source data and logs are not copied here.

| Artifact | SHA-256 |
|---|---|
| Current preparation script | `ca49567519e7b49abf306e9346af7d2c0807b3cff689b0c22b98f8376d5b3862` |
| `heldout-replay-preparation-005/metadata.json` | `6e46da245f7db42e36bbfcc7aef514f6b9ecdd375ab8e9af604cf70edf67ef68` |
| `heldout-clock-probe-002/metadata.json` | `e970e277ae410be6c9713cec8ed62e75ffe0338aa1f3c8fe5c9fa442d8d145d4` |
| `heldout-duplicate-probe-002/metadata.json` | `ff29f1e36c6d245a5d3ff5bc44c5ac46653ab454eec096adc55c920bbc49a642` |

Future live replay must use fresh per-question/per-arm closed clones, unchanged ordinary prompt/tools, a sealed answer/arm mapping, independent stage supervision, no automatic whole-run retries, and deduplicated background/Ask receipt ledgers read after shutdown. No answers or semantic arm mapping are exposed before all eight questions are complete. A >50-input integration window is a stop-and-replan condition, not silent card selection.
