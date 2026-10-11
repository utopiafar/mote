# ADR: Action-first native clients

Date: 2026-10-11. Status: accepted by the owner.

The owner requested a complete macOS and Android UI revision using the recommended
direction in the [shared design review](https://chatgpt.com/share/6acad1ba-aaf8-83ea-b7b4-d188d204cb68).
The decision is to use A's action-first entry structure, C's source management,
and B's content reading experience. These are parts of one information architecture,
not three additional navigation systems.

Both native clients have three primary destinations: Home, Content, and Ask.
Home explains what Mote can save and offers four peer actions: Sync a folder,
Import files, Record the screen, and Quick note. Add controls use the same actions.
Sources and settings remain reachable from these destinations; transport batches,
capture internals, and the local/central implementation boundary are not separate
primary destinations.

## Source lifecycle

Syncing a folder defaults to continuing to observe changes. Importing files defaults
to one completed discovery pass. An individual file can explicitly continue to sync
future changes. Existing continuous sources keep their behavior until the owner
changes their settings.

Completing a one-time import stops discovery and watching; it does not disable
delivery of already saved revisions. Incomplete scans continue from their checkpoint.
Offline operation, process restart, and transport retry retain the same pending
revision and its original bytes. A later file edit must not silently create a new
revision for a completed one-time import. This lifecycle belongs to each client's
source host; the central wire protocol does not need a new source kind.

The confirmation surface states the selected scope, whether existing files are
included, where complete file bytes will be sent, and whether the central archive
keeps originals. Snapshot extraction still sends the complete file to central
processing before releasing its temporary input. It must never be described as
uploading only a summary. A disconnected client can first save the local task;
the existing explicit first-connection and destination-binding protections remain.

## Content and progress

Content brings local saved records, source items, and received content into one
reading entry. A detail view explains the actual stages: saved locally, received by
the central node, processing, and available outputs. A receipt proves reception;
it does not prove processing or search readiness. Current central presence is
separate from the immutable reception receipt: expired or deleted content does not
erase the fact that it was received.

Clients use validated ingress receipt IDs and server-authoritative record and
Material relationships. A title, path, captured URI, or piece of source text cannot
select a different central record. Central processing state, Material coverage,
full-text indexing, and Memory readiness are different facts. A completed OCR job,
a non-empty preview, a successful upload, or elapsed time is insufficient evidence
for a blanket “ready to search and ask” claim. Unsupported or unreachable central
status remains unknown; it does not become ready through a silent fallback.

Home keeps normal progress compact and exposes the relevant content or source when
attention is needed. The source list identifies the failing scope and offers its
existing edit, authorization, and retry path. Refusing screen permission does not
block notes or file sources. Offline Ask explains the connection requirement.

Controls name three scopes: pause screen recording, pause this source, and pause all
sending. Pausing screen recording retains content and leaves source work and
delivery under their own settings. Pausing a source retains its pending versions.
Pause all sending is a persisted client flag separate from the configured sending
policy. It blocks automatic and explicit content sends, source metadata writes,
and device heartbeats; in-flight transport is cancelled and unconfirmed content
remains pending. Local recording, discovery, privacy settings, and editor drafts
continue independently. Resuming sending retains the chosen policy, including its
manual-mode requirement for an explicit send action. Pause is not cancellation or
deletion of queued content.

## Supersession check

| Classification | Disposition |
| --- | --- |
| KEEP | App content/activity/ignore authorization, masks and privacy rules, explicit capture start, native file/calendar permission requests, read-only model evidence, durable queue IDs, ACK validation, node binding, retention, locale catalogs, safe windows, and independent releases. |
| CHANGE | Native primary navigation becomes Home / Content / Ask; folder, file, screen, and note entry points become peers; file import gains a real one-time lifecycle; content detail presents receipt and processing facts together; pause all sending becomes an independent persisted flag. |
| REMOVE | Native top-level capture / local records / upload stages and Android's top-level device settings destination; screen configuration as the universal first-use funnel; labelling a successful transfer as completed processing. |
| EXCEPTION | Advanced capture, source, connection, storage, update, and diagnostic pages remain reachable; the central Web information architecture and processing contracts remain independent; existing continuously monitored files remain continuous. |
| UNKNOWN | Physical-device permissions and OEM background behavior, large-font and keyboard behavior on untested devices, actual source-provider failures, and live-model processing quality require separate validation. |

This supersedes the native navigation descriptions in
[client navigation](client-navigation.md) and [Slate UI](ui-slate.md), and the
universal first-use routing implied by [Android page fields](adr-android-page-fields.md).
The page-fields privacy, structural extraction, and central organization decisions
remain in force. It does not change the capture or source processing architecture,
grant permissions, alter the wire compatibility range, introduce a semantic dispatch
heuristic, or promise that a generated prototype has validated native behavior.

Relevant regressions belong to native user journeys: first use without a node,
cancelled selection and authorization, duplicate sources, one-time versus continuous
changes, offline first binding, restart before delivery, source-specific failures,
content expiry, settings and note drafts, and navigation with a keyboard. Tests use
generated content in isolated profiles; device and live-model checks are reported
separately. Historical reports retain their original dates and do not count as
validation of this redesign.
