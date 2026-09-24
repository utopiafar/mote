# Android capture recovery and central navigation

## Queue regression in 0.0.63–0.0.65

The material-stage addition in `e4fed23` introduced a batch-wide privacy floor. It required every activity-only output to use `source=activity`, although media and notification records also support `privacy.collection=activity`. A valid record could therefore persist in the stage inbox, fail commit, and fail every subsequent queue open.

The queue now relies on the shared source-specific record validators. The default state-series stage preserves privacy fields and only extends structurally equivalent records. Other stages own their transformations and must test their own preservation rules. Upload-review holds remain durable authorization state; they are not removed by this change.

Pending stage processing failures no longer prevent reading already committed records. The inbox remains intact and writers must retry it before accepting a later input. Journal recovery still must complete before opening the store, since the journal represents a committed transaction. An old activity-only media inbox can replay directly, without deleting records or clearing application data.

## Screenshot diagnostics

New installations default to activity-only collection. Legacy settings without an app-rule field migrate to full content. Explicit saved rules take precedence. Adding any activity-only or excluded rule requires reliable visible-window identity; changing settings can therefore expose an existing window-identification limitation.

On Android 11+, system-bar identification uses platform window metrics and system-bar insets, the system UI package, system window type, and inactive/unfocused state. It does not depend on English window titles. Unknown packages and overlays extending into the content area remain subject to normal privacy rules. Android 10 retains its previous title-and-geometry fallback.

`mote.log` records bounded `CAPTURE_DECISION` rows with window/unknown/system-bar/restricted counts, identity reliability, foreground presence, Mote visibility and selected collection mode. Rows are emitted on decision changes and at least once a minute while eligible sampling continues. No window title, package identity, screenshot, text or token is recorded.

`PROTECTED_APP`, `APP_RULE`, `WINDOW_UNKNOWN`, `WINDOW_CHANGED` and `PIXEL_COPY` distinguish Mote's own protected UI, configured restrictions, unidentified windows, stale callbacks and pixel conversion failures. `CAPTURE_API` preserves the numeric Android screenshot error code. The native technical status also retains a separate last screen-collection message so media and notification status cannot overwrite it.

Old `EXCLUDED` rows combine multiple causes and cannot retrospectively establish which window blocked a sample. A successful screenshot only proves that one sample reached the API, queue and upload paths, not that every foreground app was eligible.

### Physical-device follow-up: Xiaomi navigation surface (2026-09-24)

Read-only ADB inspection after the user installed 0.0.66 confirmed successful queue uploads, but a separate `APP_RULE` pause remained. The decision reported three windows, one recognized system bar, one restricted package, reliable identity, and an unprotected foreground. Bilibili had no app override and inherited content collection; the launcher had an explicit activity-only rule.

WindowManager exposed a launcher-owned `GestureStubHome` navigation panel at `[0,2534][1200,2608]`, while the actual launcher Activity was hidden. Accessibility exposed an inactive, unfocused system window at the same bounds. Standard navigation insets covered only `[0,2560][1200,2608]`. The current recognizer therefore misses both the OEM owner and the extra panel height: merely allowing the launcher package inside standard insets would still fail.

Source history explains why earlier configurations could work:

- Before `66fb100` (0.7.0, September 14), only application windows contributed package rules; inactive system navigation windows did not contribute the launcher package.
- `66fb100` introduced graded collection and included keyboard/system window packages in the rule decision. A launcher-owned navigation window can consequently veto another foreground app when the launcher is activity-only or excluded.
- `9abe00a` (0.0.23, September 16) changed fresh-install rules from content to activity-only, retaining content defaults for legacy settings. Resetting data and configuring rules again can expose the pre-existing window limitation. The currently inspected configuration explicitly defaults to content, so the fresh-install default is not itself the present blocker.
- `bb8a102` (0.0.59) exempted standard System UI bars by title/geometry. 0.0.66 replaced the Android 11+ title check with platform insets, but retained the System UI package restriction. Neither handles this Xiaomi panel.
- The 0.0.63 queue regression is independent and was fixed in 0.0.66.

The diagnosis called for a fix to identify OEM navigation surfaces separately from application content, using verified system ownership and navigation-window evidence, while retaining rules for the real launcher Activity, split-screen apps, keyboards and content overlays. Do not solve this by granting content collection to the launcher or ignoring every inactive system window. Regression coverage must include the 74-pixel OEM panel versus 48-pixel platform inset, plus negative cases for launcher content and overlays. Physical verification should first inspect the resulting window decision without taking a personal screenshot; end-to-end capture should use generated content.

This follow-up establishes source history and live window/configuration evidence, not an APK downgrade comparison. The user's pre-reset settings are unavailable, so their precise last working configuration cannot be reconstructed.

### Local OEM-navigation fix and physical verification

The local patch adds a narrow HyperOS compatibility rule: `com.miui.home` must be a system application; the window must be a system window, inactive and unfocused, span the entire display width, touch the display bottom, overlap a visible platform navigation inset, and be no more than 32dp tall. This explicit OEM bound accommodates the observed 74px navigation panel at density 3 without exempting launcher Activities or larger content panels. Unsupported geometries continue through normal privacy rules. Standard System UI handling is unchanged.

207 Android JVM tests passed, including the 74px/48px mismatch, real launcher activity, larger overlays, non-system owners, active/focused windows, missing navigation insets and unrelated packages. The development APK and instrumentation APK built locally. A manually opted-in metadata-only instrumentation check confirmed the physical window owner and bounds without reading node text or taking screenshots.

The local APK uses the same signing certificate as the installed release and was installed over 0.0.66 without clearing data or changing app rules. With a generated external fixture Activity in the foreground, physical-device logs at 17:25:10–17:25:11 (Asia/Shanghai) showed `systemBars=2 restricted=0 mode=content`, followed by `CAPTURE_REQUESTED`, `FRAME_RECEIVED` and `SCREEN_QUEUED`. Personal Bilibili content was not captured as a test; live-model behavior was not tested. This is a local 0.0.66 patch, not a new published GitHub release.

## Shared central UI

Ask opens the central web conversation page directly. Archive, workbench and Ask reuse one WebView browsing context within the application process, including its window-scoped session storage. Native navigation detaches the view and releases its Activity references without discarding that document. Changing central origins destroys the old view, and the central site's logout operates on the shared session.

The central login lifetime controls restart behavior. A window-scoped session ends on process death; persistent web sessions retain their configured lifetime. Device collection credentials are never injected into the page. Initial central access requires a valid central URL, not a collector token. The web UI handles central login, conversation history, citations, model selection and cancellation.

## Validation

Generated regression cases cover old media-inbox replay, activity-only notifications, committed-history access during stage failure, state-series privacy separation, fresh/legacy app rules and system-bar boundaries. Dedicated emulator tests use generated HTML to verify session continuity and origin isolation, and a generated external Activity to exercise Android screenshot capture after an activity-only media record. These fixtures do not establish physical-device or live-model validation.

Validated locally: `npm run check:local`; 206 Android JVM tests (no failures); development APK and test APK builds; two dedicated API 35 emulator tests for the shared central session and generated screenshot recovery. At that initial checkpoint, physical-device work was read-only diagnosis. The later local OEM-navigation follow-up above installed the patched APK and verified capture using a generated fixture on the physical device; it did not run a live model. These are separate validation stages.
