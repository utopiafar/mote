# Archive admission and client cleanup validation

Date: 2026-10-11. Decision: [archive admission cleanup](../adr-archive-admission-cleanup.md).

All fixtures use generated content, temporary private directories and loopback
services. No personal files/screenshots or live models are used.

## Journey coverage

| Journey | State transitions and regression |
| --- | --- |
| Central file import | 500 retained inactive sources → real HTTP automatic import → original archived and generated text available; existing identities and conflicts remain authoritative. |
| Memory correction | 100,000 current-shape records, including 99,999 stale → real HTTP owner correction → immutable owner note and replacement card; stale-version correction still fails. New extraction and portable merging remain available. |
| Portable recovery | Export beyond former source and Memory thresholds → import into a fresh current vault, retaining correction history, owner note, paused sources and deletion proof. Deletion-ledger metadata count guards are also removed; the large-card fixture contains one deletion intent. |
| Pairing | 500 revoked records and one active record → owner-bound invitation → replacement credential → full Central restart; old credential remains denied and the new credential works. Existing byte-capacity and atomic-write failure regressions remain. |
| Provider isolation | Timeout/network/unavailable without Retry-After → real HTTP next question succeeds; 429 or explicit Retry-After → shared wait persists across reconstruction, queued admission and independent credentials. |
| Coding source | 36 MB event / 4,500 pieces through the actual worker adapter, durable outbox and HTTP ACK, including lost ACK/restart → following human dialogue delivered. UTF-8 boundaries, partial append, mutation and budget-independent identities; actual worker cancellation with 70 MB generated input retains cursor and pending bytes, then reuses the worker. |
| Desktop source lifecycle | 41 completed one-time imports through manager and HTTP ACK → current-format restart without replay; retired full/lightweight configuration rejects before any stored queue/original changes. |
| Android source lifecycle | 21 completed one-time imports → new offline pending file → rename and reconstruct config/queue → identical manifest and bytes → valid ACK drains transport. Reference no-read, current-policy changes and recovery retain their regressions. |

## Executed checks

- `npm run test:ui -w @mote/desktop`: passed. Builds the application and macOS
  native helpers, then runs the real Electron main/preload/renderer UI and sync
  history fixtures. Native file selection, offline source saving, source editing,
  receipt/content pagination, denied reads and minimum-window layout passed.
  Capture remained stopped. The generated source-screen rendering was inspected.
- Android `:app:assembleDebug :app:lintDebug`: passed using JDK 17 and the local
  Android SDK. Lint reports 0 errors and 204 warnings.
- Cross-client snapshot recovery: all 6 generated Desktop/Central tests passed,
  including narrowed original-read permission, lost ACK, restart, cancellation,
  source revocation and metadata-only rename. The retired `indexMode` fixture was
  removed; current permission transitions remain covered.
- Final `npm run check:affected`: passed after updating the retired cross-client
  fixture. Shared translations select all three consumers, so this runs
  `check:local` and Android `:app:testDebugUnitTest` (287 tests, 0 failures/errors).
  Typechecks and 6,643-key translation/catalog checks passed. Desktop has 434
  passing tests; Central has 1,393 passing tests and one environment skip; Web
  has 268 passing tests; Agent has 243 passing tests and one environment skip.
  Shared, diagnostics, release/security/CLI fixtures and the actual Central runner
  checks also passed. The skipped checks are the optional macOS Python sandbox
  and installed-Codex synthetic Responses journey; neither is claimed as verified.
- Documentation formatting and relative links were checked; the new ADR and
  validation tables render with ReactMarkdown and remark-gfm.

## Limits

Physical-device permissions/capture, OEM background behavior, live model quality
and production-scale resource use are not validated by these fixtures. Retired
Desktop `indexMode` profiles and Android local parser WorkManager jobs receive no
upgrade adapter; see the existing MVP boundary in the decision.
Complete JSON event decoding still holds one event in worker memory and cannot
be cancelled inside synchronous `JSON.parse`.
