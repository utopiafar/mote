# Mac client

The Mac client collects permitted local context, keeps durable local records and synchronizes with an independent Central. Notes and selected sources work before connecting. Capture requires macOS 13.3+; native helpers need Apple Command Line Tools. Windows/Linux do not have supported capture.

## Build and profiles

From the repository root with Node 24 and npm 11:

```sh
npm ci
npm run build:libs
npm run build -w @mote/desktop
npm run dev -w @mote/desktop
```

`npm run package -w @mote/desktop` produces a local app directory and builds Swift helpers. An ad-hoc build is not a notarized Developer ID release; see [releasing](releasing.md).

An unqualified packaged launch uses `default`; development uses a separate `dev` profile. Explicit `--profile=<name>` selects another profile. Data, device identity, credentials, drafts, source checkpoints and queues remain separate. Dev uses private credential files; Prod retains OS protection. Only the default profile registers the ordinary login item because macOS does not preserve profile arguments.

Current local storage is format 4. Old or incomplete formats are rejected with files retained, without implicit migration or deletion. Back up required data before an explicit reset. Replacing the app preserves package-external data; this alone does not make an old format readable. See [content storage](content-storage.md) and [updating](updating.md).

## Start with a useful source

The workspace offers a note, file import or source connection without requiring screen configuration first. Folders keep checking their selected scope; one-file import is one-time unless explicitly configured to track changes. Confirmation shows scope, inclusion of existing files, complete-file destination, source context and retention choice. New file sources default to archived originals; existing explicit snapshot/reference choices remain unchanged.

Screen recording starts after scope review and explicit start. Per-app duration, screenshots and structured fields are independent choices. Saving settings or granting OS permissions does not start paused capture. Duration-only capture needs neither pixels nor Accessibility; screenshots need Screen Recording, and page fields need Accessibility. If macOS requests a restart, reopen and resume explicitly.

Fixed masks and optional text privacy rules run locally before persistence. Privacy OCR is not a saved OCR product. Structured capture uses registered field rules and preserves provenance; app names do not classify topics or tasks. See [privacy](privacy-and-metadata.md) and [collection](collection-and-sync.md).

Closing the window hides the resident app; quitting stops it. Pausing screen recording stops new screen/app samples, while enabled file/calendar sources and existing uploads retain their own policy. Restart waits for manual screen start and restores permitted persistent source/queue state.

## Connect and synchronize

Import a Central invitation as JSON, a pasted link, a file or a QR image. QR decoding is local. Confirm the complete origin before exchanging its one-time code. The full client receives owner scope; dedicated collector and MCP credentials have separate roles. [Connections](connections.md) covers login, browser handoff and revocation.

Unbound records need a confirmed first destination. Same-node reauthorization preserves IDs, content, time and pending versions. A different origin cannot silently inherit another node's queue. Coordinate in-flight work before changing credentials; only matching per-item acknowledgements retire pending uploads.

The four upload modes, pauses and offline behavior are in [collection and sync](collection-and-sync.md). Sleep or complete exit prevents timely execution. Central receipt, organization, OCR, index and Memory status stay separate. Files use native selection; calendars use EventKit and explicit OS access. Planned calendar time does not establish attendance. [Files](files.md) explains stable versions and archive semantics.

## Local retention and source staging

Formally saved screenshots, notes, structured observations, activity records and meeting audio stay on the Mac after upload acknowledgment. The existing capture queue stores a per-record acknowledgment with its original Central origin; upload selection, pending counts and work lists exclude those acknowledged records, while local browsing continues to read the same event and image bytes. Meeting recordings keep their audio, session time, original upload origin and exact archive receipt. Restart and Central history deletion do not erase those local originals or enqueue them again. Late responses after settings changes, shutdown or an A → B → A connection change cannot attribute acknowledgment to the new Central or generation.

The capture queue and source outbox have no lifetime byte/count quota and do not delete formal records by age. Actual storage failures preserve old records and pending input and report failure. Per-image validation, bounded transport slices and the portable JSON codec's memory/input budgets remain resource protections. Queue statistics count stored capture-event metadata plus deduplicated screenshots; pending count is separate, and these figures do not measure the entire application's physical disk use, meeting directories or source staging.

Selected existing files and folders use an index, sync state and immutable pending transport parts. Exact whole-file acknowledgment releases only those transport parts, leaving the selected source file untouched. A narrower local scope persistently isolates old pending inputs that are excluded or cannot be proven safe under the current path, retention and privacy representation. The UI identifies this as local policy isolation, keeps its original bytes and blocks their transmission. Restart or later expansion does not rearm an isolated input; a current authorized scan can create a fresh revision and admission. Selection checks and the running request's canceled lease are independent fences, checked before dispatch and before accepting a response.

In Content, open an acknowledged local record and choose **Clear local copy** to confirm explicit cleanup. This removes its saved body, metadata content and screenshot bytes, or the app-owned meeting audio directory. A receipt-only record retains time, source, device, acknowledgment time and its original Central origin and IDs. Pending, review-held, isolated or unproven records and selected source files are not eligible. A capture stage that still holds input or an opaque checkpoint blocks cleanup. Cleanup is durable and retryable; an incomplete attempt is shown as needing attention rather than a completed release. It never runs by age.

After restart, receipt-only records remain browsable without being uploaded again. Notes and screenshots read their original Central through the existing archive APIs under the current session; a cleared meeting recording offers **Save original from Central** to a native owner-selected destination. A different Central receives no read request for the old origin. Authorization, token and connection generations are checked before requests and after response bodies, including A → B → A changes. Offline, deleted or unauthorized archives leave the lightweight record visible and clearly identify the missing local original. A download is checked against the available exact receipt identity, byte length and hash before replacing its destination; it does not repopulate the capture queue.

Queue JSON exports include local capture records, upload state and retained images; released records export only their lightweight receipt. Import and restart preserve those states without resending acknowledged history, and an older full-body backup cannot overwrite a released record with the same ID. User-created backups are independent copies. Source-file originals and meeting recordings require separate backup.

## Updates and recovery

Current Dev distributions use [GitHub Dev releases](https://github.com/utopiafar/mote/releases?q=desktop-dev-+prerelease%3Atrue+draft%3Afalse&expanded=true): quit and replace the Dev app bundle, keeping external profile data. Current Dev releases do not supply `mote-release.json`; do not assume the retained signed-manifest updater is available for them.

For a supported signed channel, the updater verifies publisher signature, component, architecture, Bundle ID, hashes, archive paths and expanded app. Its helper retains the old app until startup acknowledgement and can roll back failed startup. Uncertain transactions retain recovery files; `.mote-stage-*` is not disposable cache. Read-only/translocated apps need manual replacement in a writable location. OS trust and data-format compatibility are separate checks.

Diagnostics expose actual queue/state, safe counters and measured main-process usage, not whole-app energy. [Troubleshooting](troubleshooting.md) covers logs/support bundles. Focused tests and hidden-UI limits are in [Desktop AGENTS](../apps/desktop/AGENTS.md) and the [runbook](testing-runbook.md); historical pass counts are not current verification.
