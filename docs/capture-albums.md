# Android screenshot albums

## Browsing flow

The Android capture browser now opens a date-scoped list of App albums. Each album groups one app's captures within a fixed 15-minute clock bucket. It shows the observed first/last capture time, app name, record count and image count. Installed app icons resolve asynchronously; a system icon remains when a package is unavailable. This is a browsing grouping, not an inferred task or activity session.

Opening an album synchronously renders grid placeholders. Only the selected page's lightweight image references are then loaded; three background workers progressively fill the thumbnails. Images are capped at 20 records per page. Text/OCR/context details and the full-resolution image remain behind the individual image action. Returning goes back to the App albums. Date/source changes reset the album selection, and stale image work cannot update a newer page. Non-screen record browsing keeps its existing behavior.

Both local and central screenshot browsing use this flow. Central browsing requires a server that supports the new album endpoints; older servers show an explicit unavailable/version error. Web and desktop browsing layouts are unchanged.

## Why the previous path was slow

`capturePage` built its cold date/source cache by opening each encrypted event. It then opened each visible event again for OCR previews and metadata. Local thumbnail rendering opened the original image, even when the desired output was only a small grid preview. Directory sorting also repeatedly queried file timestamps, although the browser actually sorts by capture timestamps.

The new album/grid path reads a separate minimal projection. It neither deserializes OCR/device metadata nor opens any image before returning the list. Its directory scan is unsorted; capture ordering comes from the projection. Keyset cursors prevent incoming captures from shifting the grid pagination.

## Local storage

- Authoritative `.event` and content-addressed `.blob` files keep their existing formats.
- Sixteen `.browse-v1-*` encrypted shards contain only record ID, source, timestamp, app identity, image availability/blob reference and file size/mtime. New writes update their shard; reads use a bounded directory cache across queue handles.
- A shard is invalidated on disk before its authoritative event changes. After a crash, missing or stale entries are reconstructed from events. A broken derived index can be rebuilt; unreadable authoritative events are preserved and surfaced as errors.
- Older queues build the projection on first recovery/browse. This first migration still needs to read old event metadata; later launches read the compact encrypted index. Explicit integrity checks still open and verify all authoritative records/blobs.
- `.thumb` files are encrypted derivatives, generated from the final privacy-processed bitmap. Older images generate a thumbnail when first opened in the grid. Derivatives share their parent's blob identity, follow queue retention/migration/orphan cleanup, and count toward storage usage. Thumbnail writes are optional when the configured storage limit leaves no room. Plaintext bitmaps remain only in the existing bounded memory cache.

The central server maintains its own SQLite `capture_gallery` projection, backfills it once, and cascades deletes with parent captures. Image authorization now reads only the owner device and blob reference. See [protocol](protocol.md#screenshot-albums).

## Validation — 2026-09-15

- Android development and test APKs built successfully; 113 JVM unit tests passed, no skips.
- Service typecheck and all 156 server tests passed, no skips. Full server tests require permission to listen on fixture loopback ports.
- A generated 1,000-record cold-directory fixture queried albums and two grid pages in 66 ms on the development JVM: 16 shard decryptions, zero full-record reads. This is a structural regression check and development-machine measurement, not Android hardware latency.
- Tests cover app/time boundaries, cold/rebuilt indexes, interrupted commits, thumbnail retention, deletion, device authorization/revocation, and grid pagination with concurrent new capture insertion.
- `CaptureRecordsInstrumentedTest#localBrowserDisplaysGeneratedThumbnailsPagesAndOcrDetail` passed on the dedicated read-only `mote_fixture_api35` emulator (3.762 s). It verifies no screenshot views at album level, immediate grid placeholders after tapping, page navigation, and generated image/OCR detail.
- No physical-device capture, personal screenshots, live model calls, or production installation were performed. Central transport behavior was verified by server fixtures; the emulator interaction test used the local queue.
