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

The workspace offers a note, file import or source connection without requiring screen configuration first. Folders keep checking their selected scope; one-file import is one-time unless explicitly configured to track changes. Confirmation shows scope, inclusion of existing files, complete-file destination, source context and retention choice.

Screen recording starts after scope review and explicit start. Per-app duration, screenshots and structured fields are independent choices. Saving settings or granting OS permissions does not start paused capture. Duration-only capture needs neither pixels nor Accessibility; screenshots need Screen Recording, and page fields need Accessibility. If macOS requests a restart, reopen and resume explicitly.

Fixed masks and optional text privacy rules run locally before persistence. Privacy OCR is not a saved OCR product. Structured capture uses registered field rules and preserves provenance; app names do not classify topics or tasks. See [privacy](privacy-and-metadata.md) and [collection](collection-and-sync.md).

Closing the window hides the resident app; quitting stops it. Pausing screen recording stops new screen/app samples, while enabled file/calendar sources and existing uploads retain their own policy. Restart waits for manual screen start and restores permitted persistent source/queue state.

## Connect and synchronize

Import a Central invitation as JSON, a pasted link, a file or a QR image. QR decoding is local. Confirm the complete origin before exchanging its one-time code. The full client receives owner scope; dedicated collector and MCP credentials have separate roles. [Connections](connections.md) covers login, browser handoff and revocation.

Unbound records need a confirmed first destination. Same-node reauthorization preserves IDs, content, time and pending versions. A different origin cannot silently inherit another node's queue. Coordinate in-flight work before changing credentials; only matching per-item acknowledgements retire pending uploads.

The four upload modes, pauses and offline behavior are in [collection and sync](collection-and-sync.md). Sleep or complete exit prevents timely execution. Central receipt, organization, OCR, index and Memory status stay separate. Files use native selection; calendars use EventKit and explicit OS access. Planned calendar time does not establish attendance. [Files](files.md) explains stable versions and archive semantics.

## Updates and recovery

Current Dev distributions use [GitHub Dev releases](https://github.com/utopiafar/mote/releases?q=desktop-dev-+prerelease%3Atrue+draft%3Afalse&expanded=true): quit and replace the Dev app bundle, keeping external profile data. Current Dev releases do not supply `mote-release.json`; do not assume the retained signed-manifest updater is available for them.

For a supported signed channel, the updater verifies publisher signature, component, architecture, Bundle ID, hashes, archive paths and expanded app. Its helper retains the old app until startup acknowledgement and can roll back failed startup. Uncertain transactions retain recovery files; `.mote-stage-*` is not disposable cache. Read-only/translocated apps need manual replacement in a writable location. OS trust and data-format compatibility are separate checks.

Diagnostics expose actual queue/state, safe counters and measured main-process usage, not whole-app energy. [Troubleshooting](troubleshooting.md) covers logs/support bundles. Focused tests and hidden-UI limits are in [Desktop AGENTS](../apps/desktop/AGENTS.md) and the [runbook](testing-runbook.md); historical pass counts are not current verification.
