# Android article/product capture validation — 2026-10-10

This file separates generated-fixture verification from physical App acceptance.
No personal screenshots, article bodies or chat records were captured or uploaded
for this change. Exact versioned compatibility identifiers came from read-only
inspection of the local historical UI experiment; all test text/pixels are generated.

## Journey and state matrix

| Entry / transition | Required result | Regression level |
| --- | --- | --- |
| Fresh Local → start → cancel preview → recreate | Saved default scope displayed; no capture or first-start acceptance | Android instrumentation |
| App configuration → save/preview → recreate | Mode and field rules durable; app scope unchanged; no implicit start | Android unit/instrumentation |
| Installed App → exact version rules/import | App/version displayed; wrong App/version rejected; fields described without live compatibility claim | Shared + Android unit/instrumentation |
| Permissions → original settings / Local; rotate | Return to intended entry, no Today detour | Android instrumentation |
| Article visible title/author/body, long text, actual URL | Only fields; original visible text retained and bounded | TS/Kotlin shared fixtures + generated Android nodes |
| Repeated product cards, advertisement/hidden sibling | Independently scoped titles; original child indices; no guessed URL | TS/Kotlin shared fixtures |
| Wrong version/page, empty required fields, parser failure | Screenshot fallback in authorized content scope | Android decision tests + real service on generated fixture |
| Generated article/product Activity → real accessibility service → durable queue | Article and two product objects enqueue without images; missing body/empty page/wrong version use real system screenshot callbacks; privacy refusal makes no screenshot request | Isolated API 35 emulator instrumentation |
| Partial but valid fields | No screenshot, `visible_window` coverage retained | Shared + Android decision tests |
| Privacy refusal/mask/input/password/occlusion | Excluded text absent; refusal does not trigger screenshot | Android generated node/decision tests |
| Page/configuration changes, stopped/locked collector; late worker callback | No stale frame/activity enqueue | Android pipeline instrumentation |
| Real capture API → retry → organizer → restart | Fixed IDs/fields retained, no image/OCR job, material restored | Central HTTP integration |
| Same real ID, distinct titles/paragraphs or no ID | Exact overlap only; changed/disjoint originals retained; title alone never merges | Central HTTP integration + Android unit |
| Same URL on other device/App; multiple cards | Scope isolation, one object per event | Central HTTP integration |
| Delete one member → delete last → new event | Rebuild from remaining originals; retire empty material; new event revives correctly | Central integration |
| Old organizer archive → v4 backfill | Readable materials rebuilt without new automatic model authorization | Central regression |
| Forged text/time/identity, raw nodes, attached image | Rejected before durable intake | Shared + Central HTTP integration |
| Android Z / nanosecond / offset timestamps → retry → export → import | All observation timestamps normalized together; stable IDs and original fields survive retries and archive schema validation | Central HTTP integration |
| Queue/HTTP failure, missing ACK | Existing durable retry contract retained | Existing transport/queue suite |

## Execution record

The final `npm run check:local` completed successfully: 2,429 tests passed and two
existing opt-in tests were skipped (macOS sandbox execution and installed Codex
against a synthetic Responses fixture). This includes Desktop 402, Central 1,294,
diagnostics 254, agent 240, web 5, shared 177, release/security scripts 53 and CLI 4.
Type checks and 6,444 bilingual call sites/catalog entries passed. The noisy central
runner restart/permissions/private-output check also passed.

`npm run build:central`, both generated-rule `--check` commands, both component
`release:verify` commands and `git diff --check` passed. Shared and Kotlin engines
replay the same 45 structured fixtures, including independently pinned historical
App/Activity metadata and deep article structure.

Android `testDevelopmentUnitTest` passed 281 tests with no failures or skips;
`lintDevelopment`, `assembleDevelopment` and `assembleDevelopmentAndroidTest`
passed. The packaged rule asset was inspected and matches its canonical source,
including Taobao 10.66.22's observed `com.taobao.tao.welcome.Welcome` Activity.

On the isolated `mote_fixture_api35` emulator, the final App setup suite passed 5/5
(first preview/cancel/rotation, exact-version fields, scope-preserving configuration,
two-mode legacy save and permissions return). The separate Navigation 10/10 and
Library responsiveness 2/2 runs also passed without skips. Saved XML evidence is in
the ignored Android build reports, not source control.

The final generated capture lifecycle runner passed 7/7 twice consecutively against
the same frozen APKs (30.610s and 25.734s). It uses real Android
accessibility nodes (depth 29 readable, depth 33 bounded/truncated), a real
AccessibilityService, the system screenshot callback and the durable queue. Article
and two product objects produce field records without images; missing body, empty
page and wrong version produce screenshots; a configured literal privacy refusal
produces no screenshot request. A late pipeline callback cannot enqueue a stale
frame or activity. The runner restores test permissions, service state and settings.

Central's targeted 28/28 HTTP/organizer regressions passed, including bundled ACKs,
idempotent retries, restart/backfill, timestamp variants through export/import,
identity/device/App isolation, long-text budgets and real HTTP deletion/rebuild.
Independent review corrected rebuilds being marked as new source changes, mismatched
historical Activity metadata, and observation timestamps being normalized only in
one field. The corresponding regressions are durable.

Fixture failures also tightened the test entry path: an external Activity must have
rendered the requested scene and exited the previous window before collection
starts. Generated field bounds respect actual system-bar occlusions; UiAutomation
explicitly enables interactive-window retrieval. These changes keep production
privacy filters intact instead of bypassing them to make a fixture pass.

To reproduce the generated service suite, build the two development APKs above,
start the dedicated `mote_fixture_api35` AVD, then run:

```sh
node scripts/android-page-capture-e2e.mjs --serial emulator-5556
```

The script rejects physical devices and other AVDs. Its ignored
`apps/android/app/build/reports/page-capture-fixture/last-run.json` records the actual
run and cleanup result. No remote node or live model participates.

## Acceptance still separate

This run does not claim physical Android/OEM permissions, live WeChat/Taobao
compatibility, full article capture across offscreen scrolling, battery longevity,
or live model interpretation. Real accessibility service and system screenshot
callbacks are verified only against generated content on the isolated API 35 AVD.
WeChat 8.0.78 historical pages expose no reliable article URL/ID: identity-free
fragments remain separate, and a later viewport without a required title falls back
to screenshots. Taobao 10.66.22 historical cards expose title but no link/ID; textless
detail pages fall back. New App versions need exact-version adapters and physical
acceptance rather than silently inheriting a rule.

Central 0.0.86 must be deployed before Android 0.0.84; old nodes reject v2 and the
collector keeps pending events. Desktop is regression-checked but is not republished.
