# Android local bulk image deduplication

Open **Settings → About → Developer options → 本机图片批量去重**.

- Scans the local capture queue snapshot, across all dates. Newly captured records belong to the next scan. Central archive copies and the device photo library are outside this operation.
- Choose the existing exact/conservative/balanced/aggressive tier. Sort by capture time and ID and scan once from oldest to newest, comparing each image with the last retained reference when the app matches. There is no time cutoff: an unchanged screen stays duplicate even across long gaps. A duplicate does not become the next reference, preventing transitive drift. Different original dimensions never match.
- Reuses `ScreenshotDedupeHelper` and the capture pipeline's filtered sampling operation on decoded stored images. Stored JPEG pixels can differ from the pipeline's pre-encoding pixels. Corrupt, missing or oversized images are skipped and counted; a failed image resets the comparison reference.
- Results show ten candidates per page, retained/candidate thumbnails, timestamps, measurements and selected logical image bytes. Shared blobs mean logical bytes are not a promise of physical space savings. Open the comparison for pinch zoom, dragging and double-tap reset.
- Select all candidates, a page or individual candidates, then confirm moving or deleting. Moving preserves the full event, OCR and upload state in the app's internal `noBackupFilesDir/bulk-dedupe/pending` directory. This is an explicit pending-decision area: no upload/OCR worker or automatic retention prunes it. It consumes disk space independently of the active queue limit. Restore checks the active queue's configured capacity.
- The pending area supports individual/page/all selection, preview, restore and confirmed permanent deletion. Restored records resume their previous queue state. Already uploaded central copies remain unaffected.

## Background and commit behavior

A unique WorkManager task performs scanning and mutations. The foreground polls persisted progress off the UI thread and displays phase, processed/total, matches/successes and failures. Navigation or activity recreation does not cancel the job. Android can defer or stop background work; a restarted scan starts over, while a restarted mutation rechecks each original candidate. Explicit cancellation stops between records; completed moves/deletions remain committed. An incomplete scan offers no candidates for deletion.

Older reports remain labeled as old-rule results until a new scan replaces them. Reports and operation plans are atomically replaced. In 0.0.25, new local content is plaintext by default with optional encryption; the pending area and reports remain compatible with previously encrypted content. Preview pixels remain in memory and windows use `FLAG_SECURE`. List thumbnails are bounded to a page and stale image callbacks are rejected.

Queue locks cover individual storage operations, not the image comparison loop. Immediately before mutation, the source blob and retained reference must still match the reviewed identities. Moves commit and verify the complete destination before removing the source; an interrupted copy can leave both records, and conflicting copies are preserved. Removing one record never removes a blob still referenced by another event. OCR/upload state survives moves and restores. Concurrent sync may already have uploaded a record; local cleanup does not retract uploads.

## Large-library behavior in 0.0.25

- Shared-image reference counts replace the old full-library event read after every removal. A batch defers only rebuildable index persistence; each record still commits independently, and cancellation releases the remaining records unchanged. A missing on-disk index shard after interruption is rebuilt from retained events.
- Retained-reference image validation is reused while its file stamp remains unchanged. Moves avoid rewriting an already-present shared image and still validate source/destination content before source removal.
- WorkManager progress updates are limited to one per 250 ms, plus stage changes and completion, rather than a synchronous SQLite write for every record.
- Scanning reuses up to 64 compact feature entries keyed by image content hash. Exact-mode hashing uses bounded chunks; comparisons use the compact features directly. The thresholds, last-retained-reference rule, dimensions and app boundaries are unchanged.
- Selecting a page or all candidates only updates checkboxes and counts. It does not recreate thumbnails. While a job runs, the user can leave the screen or browse existing result pages. Result refresh checks current record membership; mutation still revalidates the exact reviewed candidate and reference blobs.

The current 2,000-image generated-fixture results and physical-device limits are recorded in [Android library performance](android-library-performance.md). The following dated acceptance record remains the result of the earlier implementation.

## Validation (2026-09-15)

- 115 development JVM tests passed, zero failures/skips. Added cases cover shared-blob retention, OCR/upload state round trips, stale reference/blob rejection, restore capacity rejection and an incomplete destination copy.
- Development app and instrumentation APKs build; development lint passes with zero errors (existing warnings remain).
- The dedicated, headless `mote_fixture_api35` emulator passed the generated-image bulk workflow and existing image-dedupe diagnostics regression. The bulk fixture uses 106 generated images with 102 expected candidates, identical images separated by 99 days, app boundaries, background UI response checks, result reload after activity recreation, preview, move/restore/delete/purge, cancellation and all four tiers. Three additional gradually changing generated images verify that a rejected frame never becomes the reference for the next comparison. A generated high-frequency pattern checks feature parity with the existing pipeline sampling at every tier.
- No physical device, personal screenshots, live model calls, central archive mutation or production APK installation was used. This validates fixture behavior, not large-library performance on physical hardware.
