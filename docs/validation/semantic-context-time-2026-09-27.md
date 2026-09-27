# Trusted semantic context time

The host may supply `buildApp(config, {semanticContextTime: () => isoInstant})` for an explicitly orchestrated historical replay. It defaults to the real current time and accepts only a valid ISO instant with a timezone. It is dependency injection, not an HTTP field, model tool, source metadata value, or global fake clock.

An Ask samples this clock once when `runQuery` starts, before opening Memory reads, conversation compaction, and model admission. Those stages share the same `contextTime`. Concurrent requests use their own asynchronous context. Existing Ask restart behavior remains interruption followed by a new question; this change does not add replay of interrupted Ask work. A request waiting for its execution slot has not started `runQuery` yet.

Each newly created lifecycle window samples and persists one `contextTime`. Memory integration generation and independent review use that value through queueing, retries, and reopening the vault. A legacy window with no `contextTime` retains its original `startedAt` as the integration fallback. Explicit extraction jobs continue to use their existing `MemoryPipeline.create({contextTime, ...})` contract; recipe checkpoint identity already includes that time.

Opening Memory overview/detail reads, agent `memories`, and the Memory portion of `catalog` use the task time for default validity checks. Explicit `asOf` takes precedence, and `includeHistory` retains its existing meaning. Reviewed automatic supersession uses `validFrom`, then the saved review receipt's `contextTime`, then real current time. Owner correction behavior is unchanged.

`receivedAt`, lifecycle `startedAt`, `createdAt`, `updatedAt`, review `checkedAt`, execution leases, authorization TTL, retry scheduling, provider deadlines, retention, and usage accounting retain their real clocks. Automatic input authorization/grant replay is outside this adapter: existing grants are not rebound to a replay clock. No real provider, OCR, ASR, device, or private-media checks were performed for this change.

## Fixture validation

`apps/server/test/semantic-context-time.test.ts` uses independently generated notes, dates in 2001, and local model stubs. It does not use evaluation corpus content, questions, rubrics, or evaluation model output. Its end-to-end case makes exactly five stub calls: extraction generation/review, integration generation/review, and a fresh Ask. It verifies generation inputs, saved review receipts, expiry visibility, semantic supersession, same-time checkpoint reuse and different-time checkpoint separation. It reads terminal usage from a read-only SQLite connection after closing the app.

All 10 new tests passed. They also cover concurrent Ask isolation, model queueing, derived working summaries, default real time, invalid clocks, HTTP injection rejection, manual/automatic lifecycle retry and recovery, a fully closed/reopened vault, legacy windows, explicit validity precedence, and real-time owner corrections.

Commands completed:

```sh
./node_modules/.bin/tsx --test apps/server/test/semantic-context-time.test.ts
npm run typecheck -w @mote/server
./node_modules/.bin/tsx --test apps/server/test/memory-lifecycle.test.ts apps/server/test/lifecycle-execution.test.ts apps/server/test/memory-integration.test.ts apps/server/test/memory-revisions.test.ts apps/server/test/memory-review.test.ts apps/server/test/evidence-reader.test.ts apps/server/test/query-runs.test.ts apps/server/test/conversations.test.ts
```

The existing targeted regression suite passed 79 tests. The integrating task's `npm run check:local` also passed (`check-local-007.log`): Desktop 345, Server 922 plus one skipped, Web 125, Agent 163 plus one skipped, Shared 70, diagnostics 5, local inference 13, both script groups of 4, and the central runner. Skipped checks remain unperformed.
