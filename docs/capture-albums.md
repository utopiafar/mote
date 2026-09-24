# Screenshot sessions and App albums

## Browsing flow

Screenshot browsing opens a date-scoped list of Sessions on Web, Mac and Android. A Session contains consecutive samples from the same device and app. Switching apps, a gap greater than five minutes, or an unknown app identity starts a new group. Exactly five minutes stays in the current group; returning to an app after another app starts a new group. Grouping happens before pagination and never merges devices. Equal timestamps use capture IDs for deterministic ordering. The first capture ID identifies the group and also selects its exact members.

Cards show observed first/last capture time, app, record count and image count. These times describe the observation range, not continuous usage duration or an inferred task/topic. Grouping is limited to the selected date and the records retained in the selected store; local and central archives can therefore show different groups. Metadata-only captures remain visible and count as records, without claiming an image exists.

Android and Web also offer App albums, grouping one app's captures within a fixed 15-minute clock bucket. Mac offers the existing individual-record view alongside Sessions. Android installed app icons resolve asynchronously; a system icon remains when a package is unavailable.

Opening an album synchronously renders grid placeholders. Only the selected page's lightweight image references are then loaded; three background workers progressively fill the thumbnails. Images are capped at 20 records per page. Text/OCR/context details and the full-resolution image remain behind the individual image action. Returning goes back to the App albums. Date/source changes reset the album selection, and stale image work cannot update a newer page. Non-screen record browsing keeps its existing behavior.

Both local and central screenshot browsing use this flow. Central browsing requires a server that supports the selected grouping endpoint; older servers show an explicit unavailable/version error. Web retains the full record view with its existing filters. Mac session image pages use its existing 30-record page size; Web and Android use 20.

For the current validation, see [Session and preview checks](session-preview-validation.md).

## Why the previous path was slow

`capturePage` built its cold date/source cache by opening each encrypted event. It then opened each visible event again for OCR previews and metadata. Local thumbnail rendering opened the original image, even when the desired output was only a small grid preview. Directory sorting also repeatedly queried file timestamps, although the browser actually sorts by capture timestamps.

The new album/grid path reads a separate minimal projection. It neither deserializes OCR/device metadata nor opens any image before returning the list. Its directory scan is unsorted; capture ordering comes from the projection. Keyset cursors prevent incoming captures from shifting the grid pagination.

## Local storage

- Authoritative `.event` and content-addressed `.blob` files keep their existing formats.
- Sixteen `.browse-v1-*` shards (plaintext by default, optional content encryption) contain only record ID, source, timestamp, app identity, image availability/blob reference and file size/mtime. New writes update their shard; reads use a bounded directory cache across queue handles.
- A shard is invalidated on disk before its authoritative event changes. After a crash, missing or stale entries are reconstructed from events. A broken derived index can be rebuilt; unreadable authoritative events are preserved and surfaced as errors.
- Older queues build the projection on first recovery/browse. This first migration still needs to read old event metadata; later launches read the compact index. Explicit integrity checks still open and verify all authoritative records/blobs.
- `.thumb` files are derivatives using the selected content-encryption policy, generated from the final privacy-processed bitmap. Older images generate a thumbnail when first opened in the grid. Derivatives share their parent's blob identity, follow queue retention/migration/orphan cleanup, and count toward storage usage. Thumbnail writes are optional when the configured storage limit leaves no room. Decoded display bitmaps use a bounded memory cache; on-disk derivatives are plaintext unless content encryption is enabled. See [content storage](content-storage.md).

The central server maintains its own SQLite `capture_gallery` projection, backfills it once, and cascades deletes with parent captures. Image authorization now reads only the owner device and blob reference. See [protocol](protocol.md#screenshot-albums).

## Validation — 2026-09-15

- Android development and test APKs built successfully; 113 JVM unit tests passed, no skips.
- Service typecheck and all 156 server tests passed, no skips. Full server tests require permission to listen on fixture loopback ports.
- A generated 1,000-record cold-directory fixture queried albums and two grid pages in 66 ms on the development JVM: 16 shard decryptions, zero full-record reads. This is a structural regression check and development-machine measurement, not Android hardware latency.
- Tests cover app/time boundaries, cold/rebuilt indexes, interrupted commits, thumbnail retention, deletion, device authorization/revocation, and grid pagination with concurrent new capture insertion.
- `CaptureRecordsInstrumentedTest#localBrowserDisplaysGeneratedThumbnailsPagesAndOcrDetail` passed on the dedicated read-only `mote_fixture_api35` emulator (3.762 s). It verifies no screenshot views at album level, immediate grid placeholders after tapping, page navigation, and generated image/OCR detail.
- No physical-device capture, personal screenshots, live model calls, or production installation were performed. Central transport behavior was verified by server fixtures; the emulator interaction test used the local queue.

### Release follow-up

The initial v0.0.14 release was blocked by Android's `GestureBackNavigation` lint check. The v0.0.15 fix registers the native `OnBackInvokedDispatcher` on API 33+, with the legacy callback used only as an API 29–32 fallback. The header and system back actions share the same album-return behavior.

After the fix, local release/development lint both reported zero errors, all 113 debug JVM tests passed, and the expanded API 35 emulator test passed in 4.238 s. It sends a real system back event and verifies that the activity remains open at the album list after leaving the grid. Physical-device and live-model validation remain unperformed.
