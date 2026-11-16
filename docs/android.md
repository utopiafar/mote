# Android client

Android uses native Kotlin (`minSdk 29`, `targetSdk 36`) for local capture, privacy, persistence and transport. Central is independent. Notes, selected files and permitted capture work without a node; connecting later does not change original identities or redirect an existing queue.

## Build and installation

Use JDK 17+, Android SDK 36 and the included Gradle wrapper. Put the SDK path in ignored `apps/android/local.properties`. The current APK needs no Qwen/llama.cpp, NDK, CMake or model-source preparation.

```sh
apps/android/gradlew -p apps/android :app:assembleDebug
adb -s <dedicated-device-serial> install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```

`debug` is the automation package `dev.mote.collector.test`; `development` is Mote Dev (`dev.mote.collector.dev`); `release` is `dev.mote.collector`. Build Dev with `:app:assembleDevelopment`. UIDs, identities, settings, drafts, permissions and WorkManager state are separate. Dev credentials use private files; Prod uses Keystore. Do not clear or uninstall a daily app to switch environments.

Dev initially targets `http://127.0.0.1:47842` after explicit configuration. A dedicated emulator can use `adb -s <serial> reverse tcp:47842 tcp:47842`. Phone localhost is the phone. Production connections require HTTPS; see [connections](connections.md).

## Capture and system entries

Choose app duration, screenshots and structured content independently, including any combination or none. Default app capture records duration only. Accessibility field rules do not enlarge app authorization. Structured content needs Accessibility; MediaProjection supports screenshots and duration. Starting/resuming returns to scope preview and needs a fresh projection grant where applicable. Permission alone does not start capture.

App rules, masks and optional OCR privacy rules run before persistence. Content OCR is a separate opt-in, default off. Without selected screenshots, temporary OCR pixels are released without persistence/upload. Central screenshot OCR is a separate product. Missing field extraction does not silently turn screenshots on.

Screen pause is independent of notification/device events, folders and sending. The notification and Quick Settings tile can pause screen capture; starting returns to the app preview. Note/photo/audio shortcuts and the quick-record widget open the shared editor without discarding drafts or navigation; saving is explicit. Configuration screens retain `FLAG_SECURE`.

Notification and device-event sources need their corresponding access. Provenance is retained rather than treating a notification as an owner action. Only independent duration records accumulate measured intervals: first samples/app switches contribute zero; continuing intervals stay bounded. Screenshots, fields and OCR do not add duration again.

## Browse and synchronize

Native content uses paged projections and lazy images rather than decoding the entire queue. Local and Central records retain actual state; connection/device/record identity avoids duplicate navigation rows. Central requests use the unified owner session; a device filter is a view, not an account boundary.

Common audio reading, playback and text correction are native. The MVP direction is contextual entries to the same Central's Web for advanced speaker review, original comparison and model preparation; those entries are not implemented yet. Dedicated automatic photo-library collection is planned for later; manual photo/file intake does not establish that capability. Existing source files and photos remain outside Central archive deletion.

Folders use the Storage Access Framework with stable versions, one-time/continuous scope, resume checkpoints and matched receipts. Lost permission or provider failure does not prove deletion. Progress separates stability waiting, queueing, saving/uploading, retry and actionable conflict. See [files](files.md).

The four sending modes share [collection policy](collection-and-sync.md). WorkManager applies network, battery and charging constraints. Doze/OEM restrictions may delay execution, and force-stop cannot promise background continuation. Retry preserves UUIDs, bytes and timestamps; HTTP success without a matching ACK is not completion.

Current local format 4 stores raw record/image/file bytes. Credentials, sensitive recovery and private command state have separate protection. Old/incomplete formats are rejected without automatic conversion or deletion. Clearing storage destroys unarchived records and requires an explicit owner operation. Quotas and acknowledgement cleanup still differ from long-term retention; see [architecture gaps](architecture.md#product-direction-and-implementation-gaps).

## Updates

Install the latest APK from [Android Dev releases](https://github.com/utopiafar/mote/releases?q=android-dev-+prerelease%3Atrue+draft%3Afalse&expanded=true) over the same Dev package with its matching certificate. Production/Beta uses `android-v*`. Current releases do not supply `mote-release.json`; the retained manifest downloader is not the current distribution path.

An update preserves package/signing identity and increases `versionCode`. Release/Dev builds need the private keystore path/password and key alias/password. A new certificate cannot replace an existing install without data loss; do not propose automatic uninstall/reset. System confirmation and OEM policies apply; replacing the process may require a fresh projection grant.

For a validation-only signed build, `Release Android` accepts `profile=dev`, `publish=false`, retaining verification/artifacts without public distribution. See [releasing](releasing.md).

## Verification

Focused JVM and Central/Kotlin commands are in [Android AGENTS](../apps/android/AGENTS.md); dedicated hidden emulators are in the [runbook](testing-runbook.md#android-emulator). Unit results cannot establish OS permissions, OEM scheduling, battery behavior or physical capture. Heavy journeys and live models need their own explicit request under [testing](testing.md).
