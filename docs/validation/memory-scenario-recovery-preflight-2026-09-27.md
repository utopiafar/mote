# Generated scenario recovery preflight

`scripts/test-memory-scenario-live.ts` now accepts an explicit `MOTE_SCENARIO_RECOVERY_PLAN`. It clones a closed failed vault, preserves the three completed extraction jobs, cancels the exact old integration window, and requests a new integration with `defaultMemoryIntegrationRecipe` (v2). It then reuses the existing four isolated Ask arms and anonymous answer package. This is an affected-stage rerun under a corrected policy, not a same-window retry or review-only resume. The normal fresh-generation path also imports the current default recipe.

The adapter checks the frozen report/database/fixture hashes, source mode, original text and formal evidence hashes, completed jobs and persisted batch projections, parent hashes, strategy/model pins and old window before admitting a model call. Old call inputs/results are discarded while parsing the source report; the old integration draft is never injected. The original v1 default selection remains unchanged. Only the explicit new manual task selects v2.

Recovery has a separate six-call budget (two integration, four Ask), 300-second per-call limit, 2,100-second admission window and zero automatic outer retries. The original fixture retains its twelve-call budget. Reports distinguish the prior eight calls, this run's calls and cumulative maximum fourteen. A supervisor must still bound filesystem/open/close wall time.

The final offline preflight passed on 2026-09-27 using a deliberately failed integration review seed, process shutdown, a new process and a new vault clone. The seed used eight local stub calls; recovery used six local stub calls and zero real-model calls. Three completed extraction jobs and their tables were unchanged. The old window was explicitly cancelled, the v2 task completed independent review, four Ask arms completed in frozen order, and the anonymous package retained the original schema and question text. Both archive-only arms exposed zero Memory; the Memory arms exposed the retained cards plus the mechanical integration fixture. These stub results establish plumbing, not semantic quality or net benefit.

Usage is read from a read-only SQLite connection **after `app.close()`**, so Agent shutdown and terminal receipts finish first. Inherited receipt IDs are excluded from current-run accounting. The final preflight contains six distinct new receipts and fourteen distinct cumulative receipts; all five vault reads occurred after shutdown. Historical live receipts remain unchanged: the old failed receipt's `complete: true` was unreliable, its 50,927 tokens were the last reported sample, and the old reported total of 196,355 may undercount. Cumulative reported usage must not be presented as exact.

Validation completed:

- `tsc -p tsconfig.scripts.json --noEmit` and `git diff --check` passed.
- The budget precheck blocked the seventh call, repeated outer key, expired run deadline and timed-out call.
- Cross-mode live/preflight input, wrong report hash, wrong database hash and wrong window ID all stopped with zero agent calls.
- A separate normal nonempty preflight used the v2 default and completed twelve stub calls.
- Final recovery source report hash: `2fa416d00b8e93414b3bce18f573e62a2b256d1d7640b68c7096dbe7e242b281`; source database hash: `abedaf1da414cbd0e064d1d0c3b5209f2506176bcfc5d666e876a647b0fc20af`. Both stayed unchanged, as did the original failed live source hashes.
- Tested script SHA-256 after the original-index correction below: `acad171466d5b2069eda4048336c876037d7005fef407da06cbf6f7b28fb5dd3`. Code snapshots include `packages/agent/dist/codex-session.js`, where terminal-usage handling changed.

Preflight reports, generated vaults and logs remain outside the repository. An early recovery precheck stopped before any call because the stored job keeps an empty `memoryIds` array while `get()` projects IDs from persisted batches; validation now compares that projection to those batches explicitly. Earlier reports remain retained. No live recovery, private data, browser or physical-device validation was performed in this adapter task.

The first supervised live recovery attempt also stopped at **zero calls**: its source contained three deterministic original-text segments that the fast stub source had not produced. The capture feature runs `EvidenceArchive.aggregate(1, Date.now()-15000)` every five seconds even with `backgroundWorker: false`. In the longer original run, this created one `mote.exact-segment@1` artifact for each frozen note after settlement. Each artifact's full text equals its raw original (97/111/78 UTF-16 code units); each has one matching original fingerprint and no artifact, Material or Memory parent dependency. They are ordinary shared original-text retrieval indexes, not Memory-derived semantic products.

The corrected adapter retains those indexes in both arms and verifies their exact processor/version/config, canonical metadata, current source identity, complete text, content hash, member fingerprint, revision, original dependency and FTS text. Unknown or semantic artifacts remain rejected. Offline seed construction now explicitly calls the same production aggregator, producing all three segments before snapshotting; it does not disable normal retrieval or its timer. The final six-stub recovery passed with all four arms preserving the eleven context/index/FTS table hashes across ablation and queries. A generated semantic-artifact mutation was rejected before any agent call.

`MOTE_SCENARIO_RECOVERY_VALIDATE_ONLY=1` additionally verified the actual failed live source and a new clone: exact inputs and pins, cancellation of the old task, and creation of a new v2 task through the production request function. It does not tick the new task, skips model catalog access, and independently blocks network access, Agent admission and provider factory calls. This check completed with **zero outer, stub and real-model calls** and unchanged source hashes. It is structural validation, not a completed live A/B run. The earlier zero-call failure report remains unchanged.

```sh
MOTE_SCENARIO_MODE=preflight \
MOTE_SCENARIO_RECOVERY_PLAN=/absolute/external/path/preflight-plan.json \
MOTE_SCENARIO_FIXTURE=/absolute/external/path/wave-1.v1.json \
MOTE_SCENARIO_OUTPUT=/absolute/external/path/new-recovery-run \
node --import tsx scripts/test-memory-scenario-live.ts
```
