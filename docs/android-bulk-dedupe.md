# Android local bulk image deduplication

Open **Settings → About → Developer options → 本机图片批量去重**.

- Scans the local capture queue snapshot, across all dates. Newly captured records belong to the next scan. Central archive copies and the device photo library are outside this operation.
- Choose the existing exact/conservative/balanced/aggressive tier and a maximum time gap (default 60 seconds, configurable from 1 to 3600). Sort by capture time and ID; compare each image with the last retained reference only when the app matches and the time gap fits. A duplicate does not become the next reference, preventing transitive drift. Different original dimensions never match.
- Reuses `ScreenshotDedupeHelper` and the capture pipeline's filtered sampling operation on decoded stored images. Stored JPEG pixels can differ from the pipeline's pre-encoding pixels. Corrupt, missing or oversized images are skipped and counted; a failed image resets the comparison reference.
- Results show ten candidates per page, retained/candidate thumbnails, timestamps, measurements and selected logical image bytes. Shared blobs mean logical bytes are not a promise of physical space savings. Open the comparison for pinch zoom, dragging and double-tap reset.
- Select all candidates, a page or individual candidates, then confirm moving or deleting. Moving preserves the full encrypted event, OCR and upload state in the app's internal `noBackupFilesDir/bulk-dedupe/pending` directory. This is an explicit pending-decision area: no upload/OCR worker or automatic retention prunes it. It consumes disk space independently of the active queue limit. Restore checks the active queue's configured capacity.
- The pending area supports individual/page/all selection, preview, restore and confirmed permanent deletion. Restored records resume their previous queue state. Already uploaded central copies remain unaffected.

## Background and commit behavior

A unique WorkManager task performs scanning and mutations. The foreground polls persisted progress off the UI thread and displays phase, processed/total, matches/successes and failures. Navigation or activity recreation does not cancel the job. Android can defer or stop background work; a restarted scan starts over, while a restarted mutation rechecks each original candidate. Explicit cancellation stops between records; completed moves/deletions remain committed. An incomplete scan offers no candidates for deletion.

Reports and operation plans are encrypted and atomically replaced. Preview pixels remain in memory and windows use `FLAG_SECURE`. List thumbnails are bounded to a page and stale image callbacks are rejected.

Queue locks cover individual storage operations, not the image comparison loop. Immediately before mutation, the source blob and retained reference must still match the reviewed identities. Moves commit and verify the complete encrypted destination before removing the source; an interrupted copy can leave both records, and conflicting copies are preserved. Removing one record never removes a blob still referenced by another event. OCR/upload state survives moves and restores. Concurrent sync may already have uploaded a record; local cleanup does not retract uploads.

## Validation (2026-09-15)

- 115 development JVM tests passed, zero failures/skips. Added cases cover shared-blob retention, OCR/upload state round trips, stale reference/blob rejection, restore capacity rejection and an incomplete destination copy.
- Development app and instrumentation APKs build; development lint passes with zero errors (existing warnings remain).
- The dedicated, headless `mote_fixture_api35` emulator passed the generated-image bulk workflow and existing image-dedupe diagnostics regression. The bulk fixture uses 106 generated images with 100 expected candidates, time/app boundaries, background UI response checks, result reload after activity recreation, preview, move/restore/delete/purge, cancellation and all four tiers. A generated high-frequency pattern checks feature parity with the existing pipeline sampling at every tier.
- No physical device, personal screenshots, live model calls, central archive mutation or production APK installation was used. This validates fixture behavior, not large-library performance on physical hardware.
