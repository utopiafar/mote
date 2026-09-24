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

## Shared central UI

Ask opens the central web conversation page directly. Archive, workbench and Ask reuse one WebView browsing context within the application process, including its window-scoped session storage. Native navigation detaches the view and releases its Activity references without discarding that document. Changing central origins destroys the old view, and the central site's logout operates on the shared session.

The central login lifetime controls restart behavior. A window-scoped session ends on process death; persistent web sessions retain their configured lifetime. Device collection credentials are never injected into the page. Initial central access requires a valid central URL, not a collector token. The web UI handles central login, conversation history, citations, model selection and cancellation.

## Validation

Generated regression cases cover old media-inbox replay, activity-only notifications, committed-history access during stage failure, state-series privacy separation, fresh/legacy app rules and system-bar boundaries. Dedicated emulator tests use generated HTML to verify session continuity and origin isolation, and a generated external Activity to exercise Android screenshot capture after an activity-only media record. These fixtures do not establish physical-device or live-model validation.

Validated locally: `npm run check:local`; 206 Android JVM tests (no failures); development APK and test APK builds; two dedicated API 35 emulator tests for the shared central session and generated screenshot recovery. Physical-device work was read-only diagnosis; the patched APK was not installed there and no live-model test was performed.
