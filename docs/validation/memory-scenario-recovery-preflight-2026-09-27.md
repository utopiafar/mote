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
- Final recovery source report hash: `c7a1872ee9a18c14656c24dbfd0bd6a63c5d5046d5032af76f2f6e252b88ca3a`; source database hash: `f1b7989e0b7f0e5a48a7711fa672ed15c0ef4aeee02ecc406de5d11c872b6744`. Both stayed unchanged, as did the original failed live source hashes.
- Tested script SHA-256: `40e6eb395a309ef0489ad6b24364d46309647b31e3b54bcbac738f14ec449b51`. Code snapshots include `packages/agent/dist/codex-session.js`, where terminal-usage handling changed.

Preflight reports, generated vaults and logs remain outside the repository. An early recovery precheck stopped before any call because the stored job keeps an empty `memoryIds` array while `get()` projects IDs from persisted batches; validation now compares that projection to those batches explicitly. Earlier reports remain retained. No live recovery, private data, browser or physical-device validation was performed in this adapter task.

```sh
MOTE_SCENARIO_MODE=preflight \
MOTE_SCENARIO_RECOVERY_PLAN=/absolute/external/path/preflight-plan.json \
MOTE_SCENARIO_FIXTURE=/absolute/external/path/wave-1.v1.json \
MOTE_SCENARIO_OUTPUT=/absolute/external/path/new-recovery-run \
node --import tsx scripts/test-memory-scenario-live.ts
```
