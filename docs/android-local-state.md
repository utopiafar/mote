# Android shared local state

## Inventory definitions

`QueueInventory` counts committed records separately from image-bearing records and distinct referenced image files. Metadata-only deduplicated screen records are records, not images. Multiple image-bearing records can share one content-addressed image file. Active and pending-decision storage are counted separately; their image-record counts sum to the current local image total.

Moving to the pending-decision area reduces active images and increases held images without changing that total. Permanent deletion reduces the owning area's count. Upload acknowledgement can reduce pending work without removing an image while OCR is unfinished. OCR completion, conflict state and final acknowledgement update the same inventory. Cumulative operation counters retain their historical meaning and never decrease during cleanup or restoration. The home screen explicitly labels current image inventory and cumulative screenshot records separately. Central archive counts remain independently owned by the server.

## Update contract

- `DurableQueue` invokes a nonblocking mutation callback after successful atomic file commits and event removals. Active queue handles and pending-decision handles both connect this callback to `LocalStateChanges`. Failed writes before commit do not announce record changes; partial commits still invalidate state.
- Storage migration and startup recovery also invalidate state. Source-store commits and the operation ledger announce their changes; the repository listens to runtime settings changes.
- Invalidation carries monotonically increasing state, record and storage revisions, never count deltas or image content. Record revisions invalidate browser pages; thumbnail cache writes only invalidate storage statistics, preventing thumbnail-refresh loops.
- `LocalStateRepository` owns a read-only `StateFlow` for the application. One IO coroutine merges bursts with a fixed 300 ms window, so continuous writes cannot indefinitely postpone updates. It reads both storage areas under the queue's shared lock, ensuring a move is not reported halfway through. Changes during a read remain pending for the next read. Runtime-only updates reuse inventory; committed storage mutations force a fresh inventory.
- Operation completion/cancellation requests immediate calibration. Each resumed page requests calibration; process startup reads retained local storage. StateFlow is a replayed in-memory view, not the durable source of truth.
- Errors retain the previous inventory and mark it stale. A first-read failure is unavailable, never an invented zero. Notification publication failure cannot terminate the state producer.

## Consumers

Home, storage, statistics, sync recovery, capture browsing and the pending-decision page subscribe while resumed and cancel subscriptions when paused. Home and sync recovery keep their existing lightweight runtime timers for conditions such as permissions, network and battery, while inventory comes from the shared snapshot. Notification inventory is maintained by the application-owned consumer even without a visible Activity, and a stock update does not create a notification when no collection notification is active.

Capture browsing reloads the current query on committed record changes, retaining the selected date, source, album, cursor and scroll position; an emptied trailing page retreats to the previous page. Concurrent requests are coalesced and stale thumbnails rejected. Local changes never trigger central browsing requests. The pending-decision page combines queue revisions with its existing WorkManager progress; its polling stops when the page pauses. Statistics distinguish live inventory from their bounded record-detail sample and retain expanded sections/history page selection.

## Large-library behavior in 0.0.25

Connecting the selected storage location is separate from background maintenance. Starting capture no longer waits for the complete library's migration, index upgrade or orphan cleanup. Existing storage-migration recovery and unavailable-media errors still protect the selected directory; the app does not silently switch to an empty location.

The shared browse index now persists fixed inventory/OCR/upload fields alongside date, app and image references. Inventory and browsing reuse this projection instead of independently decrypting and parsing every event. Missing or obsolete metadata can be rebuilt in small queue-lock acquisitions. Screens show loading or stale inventory until a valid snapshot is available, rather than inventing a zero count.

Unchanged visible pages keep their existing views and thumbnails when unrelated records change. Date/page switching drops superseded queued requests; thumbnails appear progressively and their cache writes use a separate executor. The browse index remains derived metadata: records and image files are authoritative, and invalidation precedes every authoritative mutation.

New Android local content is written in plaintext by default, including records, images, thumbnails and the metadata index. Encryption is optional for future writes. Existing encrypted content remains readable; the developer page provides an explicit one-time background decryption task with progress and cancellation. Credentials still use Android Keystore. Server and desktop content encryption also defaults off. See [performance and storage details](android-library-performance.md) for scope and current validation; the historical results below describe the earlier release.

## Validation

- JVM inventory fixtures cover shared blobs, metadata-only records, pending/OCR transitions, rejected writes, thumbnail-vs-record invalidation and missing image files.
- Dedicated `mote_fixture_api35` instrumentation uses generated images/notes to exercise home and actual notification updates, storage, pending-decision removal, capture-page removal, Activity background/recreation, stale-state recovery, OCR cleanup and burst coalescing. Cumulative collection counts remain unchanged during moves/restores.
- Existing bulk-dedupe, capture-browser and dedupe-diagnostics fixtures are rerun for regression coverage. No personal screenshots, physical-device capture, live model calls or central archive mutations are part of this validation.
- Verified on 2026-09-15: 118 JVM tests and six emulator tests passed; development builds plus development/release lint passed. Emulator coverage also includes deferred OCR acknowledgement and battery/charging OCR transitions. The browser test waits for Activity window focus after dialog dismissal before sending a system back event.
