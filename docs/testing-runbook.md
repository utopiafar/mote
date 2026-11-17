# Test runbook

Procedures for checks that need extra setup. Which layer to run, and when, is decided by [testing](testing.md).

## User scenario reference

Choose the relevant scenario under the testing policy; this table is not a fixed suite. Reuse existing checks when they already exercise the changed behavior.

| Scenario | Result to observe | Existing entry |
| --- | --- | --- |
| First saved record | The selected local Central can save a record and open its original. | [Installation](agent-install.md) |
| Collection, offline save and retry | Local data remains readable before upload; resuming respects the send policy and does not duplicate the acknowledged record. | [Collection and sync](collection-and-sync.md) |
| Drafts and explicit saves | Sharing or saving a separate record preserves the existing draft and original conversation. | [Android](android.md), [Mac](desktop.md) |
| Retrieval and Memory | Selected evidence is findable; remembered facts and original quotations remain distinguishable. | [Generated cases](synthetic-persona-dataset.md) |
| Data controls | Pause, disconnect and deletion affect their stated scopes; the UI reports the actual result. | [Files](files.md), [connections](connections.md) |

## Android intake contract

The light Android intake contract starts a private `buildApp` with generated SQLite data and feeds its real HTTP responses into Kotlin `CentralClient`, `CentralAttachments.upload`, and the production part/final receipt validators:

```sh
# Shared/Agent compiled inputs and the current Node SQLite ABI must be ready.
node --import tsx apps/android/test-fixtures/central-kotlin-contract.ts
# Include the ordinary Android JVM units in the same Gradle invocation:
node --import tsx apps/android/test-fixtures/central-kotlin-contract.ts --all-unit-tests
```

The runner selects `CentralProducerContractTest`, forces only the Gradle test task to execute, and rejects skipped contract cases. It verifies partial upload recovery, lost final ACK recovery, exact revision/ID and original bytes, current ingress requirements, permission failures, forgotten originals and late responses after session invalidation. It also runs the production meeting archive transfer through a real local journal rename failure after Central's exact ACK: pending state and WAV bytes survive, restart consumes `begin.ack`, and part/commit requests each remain at one. A JDK HTTP adapter replaces the unavailable Android transport runtime; this establishes actual Kotlin use-case consumption, not `HttpJson`'s Android clock/meter, native permissions, background workers, physical-device behavior or model quality. Running other JVM unit selections without this runner skips the producer-dependent class.

## Android advanced Web contract

With the same built libraries, Node SQLite ABI, JDK and SDK prerequisites, run:

```sh
node --import tsx apps/android/test-fixtures/advanced-web.ts
```

This light contract creates its own temporary Central profile, owner sessions, collector credential and recording. It passes real HTTP ticket responses through production Kotlin navigation, then consumes the generated links with the actual Web ticket exchange, recording reader/tools and models settings page. It checks speaker sample reads, raw/original comparison, all three media preparation destinations with archive-only plans, and unchanged model authority, processing policy and plugin selection. Replay, expired and parent-revoked tickets fail through the real exchange; a collector link keeps the normal Web login in control. The same Gradle invocation runs the focused navigation/session-fencing and Central failure units, and rejects skipped contract cases.

The runner substitutes a JDK HTTP adapter for Android transport, generated ASR/diarization artifacts for model output, and DOM media methods for device playback. It does not start an emulator or external browser, download models or verify physical audio. Temporary profiles are removed at completion; JVM results remain in the ordinary Android build directory. The producer-dependent `AdvancedWebCentralContractTest` skips when selected without this runner.

<a id="background-testing"></a>

## Background UI

Local automated tests do not show windows, activate apps or take focus by default. Unit tests, typechecks, builds and Gradle JVM tests run directly in the terminal without starting a client or emulator. UI verification still runs the real renderer, preload/IPC and app lifecycle, with generated material and an isolated test profile.

Central web regressions for first load, same-scope background refresh, empty states, scrolling time ranges, pagination and revocation are in [Web background refresh](#web-background-refresh).

Electron UI and desktop fixture entrypoints must load `scripts/fixture-background.cjs` (desktop scripts use the matching relative path) before importing `electron` or product modules. This test-only entry forces hidden windows, stops native windows from taking focus and disables background render throttling, so animation frames, DOM focus, keyboard/wheel input and screenshots of generated pages remain verifiable. On macOS it uses the accessory activation policy to avoid a Dock icon, not the prohibited policy, which blocks window creation. New and rebuilt windows and later `show()` / `focus()` calls follow the same rule. Normal product startup is unchanged.

```sh
# Generated-fixture regression for hidden windows, real input, animation frames, screenshots and window rebuilds
npm run test:background-ui
# Build the client, then run the real desktop UI and profile restart flows
npm run test:ui -w @mote/desktop
npm run test:profiles -w @mote/desktop
```

Cross-client visual consistency is compared by a person, not by automated checks. The commands below build the clients, capture the Home, Library, Source, Ask and Settings pages of Web (wide and phone) and Mac with generated data, and write a comparison page to `.mote/cross-client/index.html`. Android screenshots exported from the dedicated emulator as `home.png`, `library.png` and so on can be passed with `--android`. `packages/shared/test/ui-presentation.test.mjs` checks navigation names and icons automatically.

```sh
npm run snapshots:cross-client
npm run snapshots:cross-client -- --android /absolute/android-screens
```

Hidden windows do not hide native file pickers, message boxes or the external browser. A background fixture therefore fails on an unexpected native dialog or `shell.openExternal`; uncaught exceptions, including startup failures before `ready`, print the error and exit non-zero instead of letting Electron show its own error window. Tests that need these operations provide an explicit generated response, or record the target URL, after loading the entry. The native Chrome sign-in fixture already intercepts `/usr/bin/open`; do not silently choose cancel or bypass authorization to make a test pass. The Library test profile `interactive-400` names a data and interaction scenario; it also hides windows by default.

When you need to see the UI, set `MOTE_TEST_SHOW_UI=1` explicitly, for example:

```sh
MOTE_TEST_SHOW_UI=1 npm run test:ui -w @mote/desktop
```

The switch applies only to the test process: it shows fixture windows and allows native prompts, while existing generated dialog/browser responses keep their per-test behavior. An automated agent that needs foreground UI, system authorization or manual steps first explains why and what it affects; when the user explicitly asks to see the UI, do it directly. Hidden mode cannot replace checks that must run in the foreground, such as native focus, menus and system authorization; report those separately as not run.

## Android emulator

插件开关的三端验收使用真实 Central、实际 Mac renderer/preload/IPC、Web 构建和 Android 原生插件页面。先构建 Web、Mac、Android debug 与 debugAndroidTest APK，将两份 APK 安装在本次任务创建的空白模拟器；指定串号后运行：

```sh
MOTE_TEST_ANDROID_SERIAL=emulator-5582 electron scripts/journeys/plugin-controls-clients.cjs
```

`ANDROID_HOME` 选择 adb，`PATH` 或 `MOTE_NODE_EXECUTABLE` 提供匹配 SQLite ABI 的 Node 24+。脚本只接受 `emulator-*` 串号。Android instrumentation 在修改前要求无账号、无采集和无待传数据；它验证手机关闭 Gmail 后 Web/Mac 自动更新、Web 开启后手机自动更新、Google Calendar 独立停止与恢复，以及 Activity 重建后的状态。Mac 必须通过真实设置行和短期登录票据进入插件中心。脚本启动独立的私有生成 Central 与 Mac profile，只拦截外部浏览器启动并加载到隐藏浏览器窗口；不接触个人 Central、原生采集权限或真实第三方账号。截图与回执位于忽略目录 `.mote/plugin-controls-clients`，并区分为 fixture 与 emulator 证据。

Android instrumentation and ADB UI checks prefer the dedicated, windowless `mote_fixture_api35` emulator. Start it in another terminal (adjust the SDK path to your machine):

```sh
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator/emulator" \
  -avd mote_fixture_api35 -port 5580 -no-window -no-audio -read-only -no-snapshot-save
adb -s emulator-5580 wait-for-device
adb -s emulator-5580 shell getprop sys.boot_completed
```

After `sys.boot_completed` returns `1`, run the install, instrumentation or page-capture commands from [Android setup](android.md) with an explicit serial. `-no-window` hides the emulator window on the host; Android activities still run in the foreground inside the virtual device, so do not push the activity to the background, or the real page cannot be verified. `-no-audio` disables sound; `-read-only` and `-no-snapshot-save` avoid writing back to the AVD or its snapshots. If the port is taken, pick another free even port and update the serial to match; do not stop emulators this run did not start.

The emulator reads `http_proxy` from the process that starts it and can redirect TCP at the virtual network layer, even when Android's global proxy shows as empty. The command above removes inherited proxy variables only for the generated-fixture emulator, so local Central requests are not sent to a proxy; it does not change the host's proxy settings.

Existing Android E2E scripts attach to an emulator that is already running; they do not start it or hide existing windows. Do not run page-switching tests on a physical device that is in use; schedule and report physical-device or system-permission checks separately. When the run ends, clean up only the test processes and temporary directories it created.

## Media installer fixture

For an explicitly requested native installer check, `node apps/server/test/media-index-resolution.mjs --uv /absolute/pinned/uv --python /absolute/python3.11` runs the production audio preparer with generated local wheel indexes and network access disabled. Supply uv at the pinned `MEDIA_UV_VERSION`; the test creates and removes its own private profile. It verifies a pin available only on the primary index, a CPU package available only on the secondary index, dependency probing, atomic publication and restart without reinstallation. It does not install real audio dependencies or download model weights; actual platform/package installation remains separate evidence.

## Focused Node checks

Use the affected app's focused command: [server](../apps/server/AGENTS.md), [web](../apps/web/AGENTS.md), [desktop](../apps/desktop/AGENTS.md), [Android](../apps/android/AGENTS.md), [iOS](ios.md). For Agent tests, build changed or missing shared/Agent inputs with `npm run build:libs`, then select an existing file, for example `node --test packages/agent/test/task-context.test.mjs` from the root. A package's `npm test` always runs its full glob, so appending a filename does not narrow it. Use Node `--test-name-pattern` before the filename for a single diagnostic case and report that selection.

Never build shared inputs concurrently with another agent or session. `better-sqlite3` must match the active Node ABI.

## Manual plugin stage and release journeys

The plugin convergence candidate has manual stage, release and artifact checks outside the ordinary test glob and the automatic affected plan. Select these only for explicitly requested acceptance; they are not per-push, per-PR or handoff checks.

```sh
# Real source entrypoint, owner Note round-trip, restart and a repository-external plugin.
node --import tsx scripts/journeys/plugin-central-stage.ts

# Packaged default distribution, same-profile restart, provider/plugin lifecycle,
# unknown writes, revoked sources and CLI backup restore.
node --import tsx scripts/journeys/plugin-central-release.ts

# Default distribution artifacts. Build/verify/clean-run cover Central, Web, Mac
# and Android when the platform tools are available; Android needs JDK 17–24 and
# SDK platform 36, Mac packaging needs macOS.
node scripts/plugin-distribution.mjs build
node scripts/plugin-distribution.mjs verify
node scripts/plugin-distribution.mjs clean-run
```

The stage journey starts the real server entrypoint with a private generated profile and loads the repository-external `examples/external-plugin` through the private plugin-dev package host. The release journey builds the default distribution, inventories its features, restarts the packaged candidate, exercises provider and plugin lifecycle, and restores a stopped CLI profile. `plugin-distribution.mjs` builds and verifies the default compositions and deliberately rejects a mismatched plugin contract version; its clean-run starts the Central artifact from a fresh temporary home and installs a generated SDK sample. These scripts write generated artifacts under ignored paths and never publish or sign anything. Record the actual checked revision and each covered or unverified boundary; historical journey results are not current evidence.

Report evidence by kind: **fixture** (generated profiles, loopback services, generated model transports, generated artifacts), **real model** (an actual provider with a declared model), **emulator**, **physical device**, or **third-party account**. A fixture journey cannot stand in for provider semantic quality, native permissions/OS effects, physical-device behavior or a third-party account. A successful artifact build or clean-run is stage/build evidence, not a signed release, deployment or full release qualification. If physical-device or third-party-account journeys are missing, record them as `未验证` and do not claim complete release eligibility.

## Logs

Keep verbose logs in ignored files; print a short result and inspect failure excerpts. Preserve exit status, for example:

```sh
mkdir -p .mote/checks
npm run typecheck -w @mote/server > .mote/checks/server-types.log 2>&1
check_status=$?
if [ "$check_status" -ne 0 ]; then tail -60 .mote/checks/server-types.log; fi
exit "$check_status"
```

## Backup and restore

[combined-backup-recovery.test.ts](../apps/server/test/combined-backup-recovery.test.ts) runs the production backup/restore path with generated current-epoch data. It checks chunk bytes and hashes, source revisions, corrected Memory, partial imports, checkpoints, restart and foreign-lease invalidation. [mvp-baseline.test.ts](../apps/server/test/mvp-baseline.test.ts) covers real query shutdown/restore and rejects an old epoch without changing its bytes. No migration, live model or physical device is established.

## Archive recency

Quality cases distinguish original time from Memory publication, earlier and later stages, one-off events from lasting change, scoped-out newer records, a planned toy base from an assembled body, a completed practice stage from later unfinished work, and a started tool-sorting task from remaining plans. Models choose relevant reads; valid Memory does not require routine rereading. [instructions.test.mjs](../packages/agent/test/instructions.test.mjs) and [task-context.test.mjs](../packages/agent/test/task-context.test.mjs) cover context/permission delivery. Semantic experiments compare actual disclosed evidence and answers at fixed input/model settings; prompt presence or a missing wrong phrase is not a positive quality result.

## Central discovery

Existing Web tests cover catalog terms, unavailable capabilities, exact Library/task return links, draft/history navigation, recording status/date editing, long original paging and retained-run discovery. Use the affected cases in [Web tests](../apps/web/test) and [agent-view-pagination.test.ts](../apps/server/test/agent-view-pagination.test.ts). A guided fixture visit is not human usability research or a live-account result.

For the generated native-keyboard recording-date case, build Central and select the needed timezone run:

```sh
TZ=Asia/Shanghai node_modules/.bin/electron apps/web/test/recording-date-browser.cjs
TZ=UTC node_modules/.bin/electron apps/web/test/recording-date-browser.cjs
```

The fixture edits a four-digit year, preserves polling drafts and seconds, distinguishes clearing an optional end, saves/reopens the chosen range, and never starts real recording sync.

## Diagnostic retention

Generated cases cover UTC rollover/channel budgets, shrinking limits without truncating survivors, shared Central/supervisor locking, interrupted publication and live/unknown locks, startup after recovery, original failure causes, changed cleanup previews, trace cache removal/deadlines, malformed/large UTF-8 pages and bounded stdout/stderr. Existing scale and correctness assertions remain in their tests.

Entries: [diagnostics](../apps/server/test/diagnostics.test.ts), [log store](../apps/server/test/diagnostic-log-store.test.ts), [retention lock](../apps/server/test/diagnostic-retention-lock.test.ts), [startup](../apps/server/test/diagnostic-retention-startup.test.ts), [CLI policy](../scripts/release/dev-log-retention.test.mjs), and `node scripts/test-central-runner.mjs`. Select affected checks under Testing; a generated process run does not establish deployed-profile behavior.

## Lark document fixtures

The [generated corpus](../apps/server/test/fixtures/lark-document-journeys.ts) contains diary, meeting, collection memo, revision, work report, study, retrospective, travel-plan and third-party manual cases. Preserve subjects, purposes, time, revision and plan/completion distinctions. Repeated links, pagination, interruption, scope narrowing, withdrawn access, partial failures and duplicate/restarted sync use the real HTTP/archive boundaries; raw material can remain useful without selected Memory.

Ordinary transport tests use generated CLI replies. The separate real-model journey uses the normal owner API and only generated text:

```sh
node --import tsx --test apps/server/test/lark*.test.ts
node --import tsx scripts/test-lark-document-journey-live.ts
```

The [real-tenant runner](../scripts/test-lark-document-tenant-live.ts) is a further explicit opt-in, using the pinned real CLI and a newly created generated-only folder with diary, meeting, collection and project-revision. Its manifest stays outside Git with private permissions:

```json
{"version":1,"runLabel":"Mote合成验收-YYYYMMDD-<6hex>","folder":{"token":"generated-folder-token","url":"https://tenant/drive/folder/generated-folder-token"},"documents":[{"caseId":"diary","documentId":"generated-document-token","url":"https://tenant/docx/generated-document-token","title":"exact generated title","expectedText":"complete generated Markdown read back"}]}
```

Supply all four documents. Existing-login mode uses `MOTE_LARK_TENANT_MANIFEST` and `MOTE_LARK_TENANT_EXISTING_PROFILE=1` after checking `lark-cli auth status --verify` privately; it does not configure, log in or grant new scopes. For a new test login, use a private `MOTE_LARK_TENANT_CREDENTIALS` file with appId/secret/brand, omit existing-profile, and complete the runner's private auth-request/continueFile. After baseline-ready, revise only the generated project document and provide revision-continue with caseId and complete expectedText. Title/content and read allowlists reject personal or unrelated data.

Raw account responses, identifiers, credentials, model output and auth links remain private. Only the privacy-filtered public-summary and actual covered/unverified stages are shareable. Existing-login coverage does not establish first-time OAuth.

## Recording context

Source-description cases preserve exact text, versioned clears, polling/error/conflict drafts, provider/account isolation and node-switch cancellation. Description PATCH completes before enabling the selected sync; description-only saves do not restart discovery or media work. Original lineage supplies context without automatically approving historical paid replay. Tests: [source-context-editor](../apps/web/test/source-context-editor.test.ts), [recording settings](../apps/web/test/recordings-settings.test.ts), and Central source-context/recording cases. The generated browser entry is `node_modules/.bin/electron scripts/test-recordings-browser.cjs` after a Central build; real recorder/accounts/models remain separate.

## Web background refresh

The first read shows loading; same-scope background refresh retains permitted DOM, empty-state text, drafts, focus and pagination. Time endpoints keep advancing while a provided logical selection key preserves display identity. Scope/account/filter changes, late results, cancellation, deleted versions and 401/403/404/410 cannot reuse or revive stale data. Shared subscriptions and the two audio model pollers avoid duplicate reads.

Affected cases live in Web resource-cache/resource-lifecycle, read-state-closure, content/library/settings-background-refresh and archive-pagination-scope tests. `node_modules/.bin/electron apps/web/test/ask-loading-browser.cjs` runs the actual Web entry with generated replies and a private profile after a Central build. Current UI, model semantics, native permissions and deployed-instance results are separate.

Agent protocol fixtures and explicit real-model command options: [runtime checks](testing-agent-runtimes.md).
