# Upload and synchronization review — 2026-09-23

All data used in these checks is generated. The 100,000-entry catalog is a separate structural performance diagnostic, not the persona corpus and not model input. No physical-device capture or personal screenshot was collected.

## Changes

- File manifests settle successful ACKs and permanently rejected versions in one local transaction. A forgotten file (410), conflict or invalid item is isolated with its title and status while later files and notes continue. Temporary failures retain only their own pending versions; malformed or mismatched response identities never acknowledge guessed items.
- Source batch negotiation falls back to individual uploads only on 404/405. Malformed ACKs, authorization failures and rate limits retain the queue. Capture batch network and malformed JSON failures use the same safe transport errors as individual uploads.
- Source `known` and `delivered` maps receive only committed changes. The durable outbox stores each immutable version in its own SQLite row, with transactional migration from former whole-array storage. Directory scans use a copy-on-write draft and commit changed catalog rows with the scan cursor; a failed local transaction does not mutate the previous catalog.
- Import creation accepts an optional request UUID. Repeating an identical create request after a lost response or restart returns the existing job; conflicting reuse returns 409, and a deleted job returns 410. This prevents duplicated import operations while preserving explicit new imports.

## Reproducible checks

`node --import tsx scripts/verify-source-settlement.ts` starts an actual temporary loopback server and drives production desktop `SourceSync` against the central routes. The test interrupts local ACK persistence after 99 server commits plus one forgotten file, reconstructs the client, replays idempotently, then sends another 100 files and a note. It also verifies a single-item stage/ACK and incremental checkpoint against 100,000 retained catalog entries with full-map enumeration guarded against.

Results are in [source-settlement.json](validation/2026-09-23/source-settlement.json): 199 files and one subsequent note archived, one version isolated; seven one-item stage/ACK rounds median 1.96 ms, maximum 16.19 ms; checkpoint 0.75 ms; maximum worker message 981 bytes and five patches. Ten loopback HTTP requests had a measured p95 of 124.99 ms. This small local sample excludes WAN RTT and is not a cross-device capacity claim.

The complete desktop fixture suite passed 311 tests in 45 files, serial execution (43.95 s). Android JVM fixtures passed 188 tests with no skips; development app and instrumentation APKs compiled including the native dependency. Dedicated emulator checks are recorded separately below as they complete.

## Scope boundaries

Startup reconstructs the retained client catalog once. A completed directory reconciliation still visits the directory catalog to identify files not observed in that scan. Explicit policy changes and node checkpoint copies also operate on the full retained state. Routine one-item stage/ACK and incremental checkpoint changes do not copy or diff the full catalog.

No live-model quality claim comes from these transport fixtures. Local Codex Luna Max persona/Memory evaluation is reported separately by the main review.


## Controlled RTT and Android emulator results

`MOTE_REVIEW_RTT_MS=50 node --import tsx scripts/verify-source-settlement.ts docs/validation/2026-09-23/source-settlement-rtt-50.json` passed the same actual HTTP 99-success/one-410 scenario, interrupted ACK persistence, restart/replay, next 100 files and subsequent note. The injected round-trip delay is split before the request and after complete response parsing. Ten requests measured p95 195.13 ms including parsing and the injected 50 ms. This is a controlled latency test, not a lossy WAN simulation. The earlier zero-delay report is preserved separately; its timing ended at response headers, so those p95 values should not be directly compared. The 100,000-entry structural check in this run had median one-item stage/ACK 2.23 ms, maximum 19.60 ms, checkpoint 0.79 ms, and maximum 981-byte worker messages/five patches. See [source-settlement-rtt-50.json](validation/2026-09-23/source-settlement-rtt-50.json).

The dedicated `mote_fixture_api35` headless emulator ran the development APK. Twenty-two selected instrumentation checks passed in 24.835 seconds with no skips: 14 offline/batch/realtime transport cases plus eight generated privacy, encrypted-queue, UI/state and source-provider checks. The added realtime case saved three sequential notes and verified automatic acknowledgement without an explicit sync request. Batch fixtures exercise 25-record transport, partial/mismatched/lost ACKs, legacy individual fallback, threshold/age scheduling, manual mode and disconnected origin protection. Source UI assertions now resolve their expected strings through the app localization instead of assuming Chinese on an English device.

The production Android scanner/queue/HTTP/central archive file scenario passed in 6.561 seconds. It checks a 237-byte text original, generated offline-TTS WAV and 9 MiB + 3-byte multipart binary; bad-token retention and disconnect after the first multipart ACK; exact content hashes; local spool cleanup while phone originals remain; four modification/deletion/restoration versions; 205 references with zero original-content reads; provider failure retention; new-only then backfill; old reference-to-original migration; and central forget. See [android-file-sync.json](validation/2026-09-23/android-file-sync.json). A first attempt encountered a resident-server/new-worker interface mismatch while source files were being edited; restarting with one consistent code snapshot passed. This was a test-environment version mismatch, not a passing product result.

Commands: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest --offline --no-daemon`; `./gradlew assembleDevelopment assembleDevelopmentAndroidTest -Pmote.testBuildType=development --offline --no-daemon`; `adb -s emulator-5580 shell am instrument -w -r -e class <selected fixture classes> dev.mote.collector.dev.test/androidx.test.runner.AndroidJUnitRunner`. The fixture node is `MOTE_FILE_TEST_DIR=<temporary directory> node --import tsx scripts/file-sync-fixture-server.ts`, bound to loopback with generated credentials. No physical-device capture, personal screenshots or live model calls were part of these tests.

## Web and desktop interaction checks

Web resource invalidations now coalesce behind the active read. A slow read can publish even when operation events arrive more frequently than its response; one follow-up refresh incorporates the latest state. Explicit refresh, last-observer removal and changed session/scope retain cancellation and generation fences. Regression coverage uses two-second reads with one-second invalidations.

Uploads retain selected files and upload identities when paused, abort on unmount, fence late responses, and preserve the import request UUID across an uncertain create response. The UI separates upload progress from import creation, exposes recovery for history errors, clears inaccessible history and budget drafts on authorization loss, and offers Memory pause/resume/cancel/retry actions. Budget copy explains conservative admission reservations and per-request UTC day accounting. Desktop source details show retained file names and rejection reasons, rendering untrusted names as text.

The Web unit suite passed 109 tests. All 17 generated browser scenarios passed: budgets, connections, content storage, conversations, diagnostics, evidence focus, internationalization, login, metadata, navigation, operations, sessions/insights, sources, tasks/imports, Memory revisions, model profiles and capture browsing. The upload scenario submits eight originals in a batch and pauses/resumes a separate single-file upload without creating a phantom job. Budget and task/import browser checks passed again against the final bundle. Desktop UI smoke passed, including generated blocked-file details and escaping. Browser fixtures cover desktop/mobile layouts and selected 200% zoom states; they do not substitute for a manual test of every control or physical-device capture. Sanitized scenario results are in [web-ui-suite.json](validation/2026-09-23/web-ui-suite.json).

Reproduce after installing dependencies and building the shared libraries, server and Web bundles:

```sh
(cd apps/web && node --import tsx --test test/*.test.ts)
node_modules/.bin/electron scripts/test-web-budgets.cjs
node_modules/.bin/electron scripts/test-web-tasks-imports.cjs
node_modules/.bin/electron apps/desktop/scripts/ui-smoke.cjs
node scripts/sync-i18n.mjs --check
```

Every remaining browser command is listed in the scenario JSON and runs through the same Electron executable. Login and desktop smoke require the desktop TypeScript/UI build; desktop packaging also requires the pinned native dependency. These are fixture UI checks without a live model or personal capture.

## Final file commit responsiveness (R08)

Native file finalization and browser originals larger than 4 MiB use the same bounded worker preparation path. At most two workers hash, verify, copy and optionally encrypt file parts, including verification of an existing deduplicated asset. The HTTP process retains a short metadata transaction and rechecks cancellation, current upload authorization, asset identity and storage policy before publication. Disconnect/close cancellation preserves acknowledged upload parts for retry and releases staging pins. Browser uploads of at most one 4 MiB part retain the bounded synchronous path.

Targeted tests cover cancellation and resume, revoked credentials and forgotten files during preparation, corrupt parts, quota rejection, encryption-policy changes, shutdown, concurrent duplicate content and idempotent commit replay. The affected server suites passed; the added large-browser cancellation/replay regression also passed. Reproduce with:

```sh
node --import tsx --test apps/server/test/assets.test.ts apps/server/test/content-storage.test.ts apps/server/test/file-commit-worker.test.ts apps/server/test/import-uploads.test.ts
node --import tsx scripts/benchmark-file-commit.ts
```

The benchmark uses generated originals and real loopback HTTP, checking health, file listing and note ingestion while final commit runs. Upload transfer time is excluded from commit latency. Results are in [file-commit.json](validation/2026-09-23/file-commit.json).

| Protocol and size | New content commit | Deduplicated content commit |
| --- | ---: | ---: |
| Browser import, 64 MiB | 331 ms | 357 ms |
| Native file sync, 100 MiB | 417 ms | 1,489 ms |
| Native file sync, 512 MiB | 2,250 ms | 2,964 ms |

All concurrent API probes stayed below 134 ms; the 512 MiB cases stayed below 18 ms. Event-loop delay peaked at 139 ms overall and below 18 ms for the 512 MiB cases. Other test processes were active during this sample. Each case contains only 2–12 probe samples at 250 ms intervals; these measured maxima demonstrate local progress during commit, not a statistically stable percentile or production capacity target. This run used plaintext storage, no artificial RTT, and local disk. Encryption behavior is covered by fixtures, but encrypted throughput, physical disk exhaustion and WAN performance are not measured by this benchmark.


The final complex-note round also passed all three separately invoked instrumentation phases, with real `adb force-stop` process changes and reverse-port removal/restoration. Six synthetic notes include Unicode/combining characters, exact whitespace, quoted hostile instructions as inert text, a 100,000 UTF-16-unit note, blank mood, and a post-enqueue scheduling failure. Offline recovery reused the same prepared UUID; after reconnect, central text, timestamps and moods matched, there were no images, and explicit replay returned duplicate ACKs without extra notes. The long-note editor survived activity recreation. See [android-complex/round-1-evidence.json](validation/2026-09-23/android-complex/round-1-evidence.json). Invocation: `python3 apps/android/scripts/run-complex-fixtures.py --connection <temporary generated connection JSON> --serial emulator-5580 --rounds 1 --build-type development --output docs/validation/2026-09-23/android-complex`. The test selectors and replay metadata were corrected to preserve the app's actual locale; the earlier Chinese-only assertions had failed on the English fixture emulator. This is one bounded round, not repeated physical-device soak testing.

Android executed instrumentation total: **26 checks passed, zero skipped** (22 selected fixtures, one central file scenario, three forced-restart phases), in addition to 188 JVM tests. The [instrumentation inventory](validation/2026-09-23/android-instrumentation.json) lists the 22 selected checks. Dedicated fixture app/server/emulator processes were stopped after testing.
