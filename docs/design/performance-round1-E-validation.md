# E module targeted validation

Frozen base: `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
Candidate branch: `codex/perf-r1-e-desktop`.
Plan/review: [v2 plan](performance-round1-E-plan.md),
[independent APPROVE receipt](performance-round1-E-review.md).
**Module targeted validation only; unified integration validation is pending the
controller. The PR remains draft.** No complete check:affected/check:local was run.

All execution used the campaign resource gate, owner E, heavy. Worktree-local
node_modules, dist and native outputs were independent. TMPDIR was the campaign
E/tmp directory; Electron userData/session and generated material were independent.
No personal material, existing service/profile, physical device, emulator or live
model was used. The generated HTTP fixtures bound random loopback ports.

## Newly executed evidence

Environment: macOS arm64, Node v26.11.1, npm 11.20.0, Vitest 4.1.11,
Electron 41.10.7. Commands ran from the worktree root. Each command below was
wrapped with:

```sh
python3 /Users/utopiafar/.codex/orchestration/mote-performance-20261020-l33r5sf0/run-resource.py --owner E --kind heavy -- COMMAND
```

| Command | Observed result |
| --- | --- |
| `npm ci` | PASS; independent installation. |
| `npm run build -w @mote/shared -w @mote/diagnostics` | PASS. Earlier occupied-resource requests were UNRUN, not tests. |
| `npm run build -w @mote/desktop` | PASS, including TypeScript, browser bundle and macOS native build. Native capture/permissions were not exercised. |
| Targeted Vitest command below | 12 files, 229 tests PASS; 31.83 seconds wall time. |
| `node apps/desktop/scripts/performance-round1-E-directory.cjs` | PASS; frozen-original comparison and generated-directory measurements below. |
| `env -u ELECTRON_RUN_AS_NODE node node_modules/electron/cli.js apps/desktop/scripts/performance-round1-E-smoke.cjs` | PASS; actual Collector packed upload/ACK/reopen plus manager addFiles/sync, generated images, one selection, zero windows and no real capture. |
| `npm run build -w @mote/agent` | PASS; prerequisite for the targeted account consumer fixture. |
| Account Vitest command below | 2 selected tests PASS, 36 deliberately unselected; 3.73 seconds. Actual scoped Server fixture, not a live deployment. |
| `npm run check:affected -- --base af11ab7c3e9fb5f38deaea4e4bae11462a7306b4 --dry-run` | Desktop-only affected workspace; plan includes shared consumers/preflights. Scope inspection only, not a passed combined gate. |

```sh
npm exec -w @mote/desktop -- vitest run \
  test/performance-round1-E-directory.test.ts \
  test/performance-round1-E-queue.test.ts \
  test/source-files.test.ts test/source-manager.test.ts \
  test/source-sync.test.ts test/source-sync-batch.test.ts \
  test/queue.test.ts test/capture-stage-durable.test.ts \
  test/collector.test.ts test/transport.test.ts \
  test/coding-agents.test.ts test/coding-transport-compatibility.test.ts \
  --maxWorkers=2 --testTimeout=15000

npm exec -w @mote/desktop -- vitest run test/multiuser-desktop.test.ts \
  -t 'preserves packed production uploads and exact item ACKs|retains state-series observations appended during a real ACK' \
  --maxWorkers=2 --testTimeout=15000
```

Functional coverage includes durable name recovery after disappearance, restore,
rollback, Unicode order, exclusions/symlinks/nesting, failed-stat epochs, four-slot
ordering, the existing 2,005-file shard, new reconciliation, incremental draft
ownership, normal and actual snapshot recovery scans, custom/coding full clones,
shared image read/hash counts, packed/nonpacked exact payload and diagnostic
bytes, disabled-diagnostic base64 elimination, transport byte history, corruption
of the first/later packed image, partial/missing ACK, held/retry behavior, unchanged
25-item/4 MiB admission, oversized-first progress, real 15-second yielding with
eligible work remaining, 16 MiB live/history fairness and source interleaving.

## Directory algorithm measurement

The script loads the exact original DirectoryCatalog from the frozen Git commit,
transpiles it in memory, and compares it with built output. It creates real
generated directories but supplies identical constant stat metadata to isolate
enumeration cost. All pages/candidates/flags and final checkpoints match; only
the wall-clock scan-start timestamp is normalized. Stat count is exactly N for
both implementations, and the last completion page remains N+1. This is one
local run with warmed runtime/file cache effects, not a latency promise or a
real-disk/end-to-end upload benchmark.

| Entries | Original next(1) sweep | Position cursor | Ratio |
| --- | --- | --- | --- |
| 1,000 | 16.59 ms | 5.57 ms | 2.98× |
| 6,000 | 315.96 ms | 21.45 ms | 14.73× |
| 12,000 | 1,023.58 ms | 37.77 ms | 27.10× |

D08 is verified by accessor call counts and checkpoint independence rather than
an invented timing estimate. D15 verifies three shared image events require
three reads/hashes in packed and nonpacked mode; payload base64 runs three times
with diagnostics disabled and six with diagnostics enabled. Enabled counter
values and actual streamed bytes match their existing exact formulas. The queue
admission estimate is unchanged and is not substituted for either exact counter.

## Failures, cleanup and limits

Initial targeted run: 227 passed, two new recovery cases failed. The generated
endpoint lacked a recovery-upload session route; both second scans already ran.
The fixture route was completed and the entire 12-file selection reran, passing
229. No product fix, assertion relaxation, scale/timeout reduction or changed
entry point was used. The first run never reached benchmark/Electron steps.

REUSED: none. All reported passing tests/measurements above were newly executed;
no driver-level reusable receipt or combined-gate pass is claimed. Earlier builds
are recorded at their actual execution stage; later changes were test/docs only.

Resource tokens: install `2d091fdf-9fcd-4c6d-928d-c7170274ebf2`, prerequisite build
`7368481a-cc03-49fe-8fba-921a563ae389`, build/initial tests
`cb1b2e7b-e2bf-4550-93b6-0bcc3c8a442e`, final targeted/benchmark/Electron/account
selection `872b24e1-f21f-4e71-b42b-01dab13b1a39`. Each wrapper confirmed complete
process-group cleanup and released its lease. Test directories/profiles and
fixture HTTP servers were removed/closed by finally/afterEach. External campaign
E/artifacts retains logs, benchmark JSON, candidate hashes and this module's
status; independent dependency/build outputs remain for controller inspection.

Not verified: full Desktop suite, combined check:affected/check:local, production
main/profile startup, foreground UI/focus/menu or system permission behavior,
real capture, physical devices, live models or released deployment. No merge,
release, second-round implementation or delivery-to-main claim is made.
