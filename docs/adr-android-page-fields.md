# ADR: Android page fields first, central organization

Date: 2026-10-10. Status: accepted by the owner.

Android uses App configuration as its primary capture setup entry. Before its first
start, it previews the saved scope and generated record formats. Saving settings
does not start collection. Existing content/activity/ignore authorization remains
the boundary; loading an adapter never changes an App's authorization.
The UI offers only screenshot-only and pages-first with screenshot fallback.
This page mode is global for all content-authorized Apps; field rules remain pinned
to each App and installed version. Loading, configuring or importing fields selects the global
pages-first mode without expanding content authorization. Existing `hybrid` and
`page_only` values remain readable, appear as pages-first, and become `ui_preferred`
only when the user saves that settings page. Choosing and saving MediaProjection
selects screenshot-only. The permissions page offers return to Local or the previous
settings page, where the user can continue the start flow.

The collector maps article and product fields through declarative rules pinned to
an exact installed App version. Rules may select a page region or repeated product
card, and use resource IDs, roles, ancestors and original child positions. This is
structural field mapping, not intent or topic classification. No scripts, network
fetches, gestures, hidden page reads or semantic keyword dispatch run in a rule.

An article requires an observed title and body; author and actual URL are optional.
A product requires a title; actual URL and source item ID are retained when exposed.
An absent URL is never invented. Each transport record contains one content object
and observation times, not UI nodes, coordinates or unrelated controls. The source
text is kept verbatim. Scope is always `visible_window`, including truncated reads;
a successful rule does not prove the user read the whole document.

For a content-authorized App in accessibility mode, successful field extraction
replaces that sample's screenshot, including a partial but usable visible fragment.
No applicable rule, missing required fields or a read failure falls back to the
existing filtered screenshot path. A privacy rejection, locked device, stopped
collector or stale page/configuration produces neither. A queue failure reports a
failure and waits for the next sample rather than changing the representation.
Explicit screen-only and MediaProjection collection continue to use screenshots.

The collector immediately persists each accepted object in the existing durable
queue. Its small volatile cache may merge exact overlapping text for the same real
URL or item ID, unchanged scalar fields and unchanged capture context. It advances
only after durable enqueue. There is no delayed buffer that could lose an unseen
fragment on process death. App/configuration changes reset the cache.

Central accepts the version 2 field shape on the existing capture/Ingress transport.
Its `mote.ui-page-object` organizer groups by device, App, content kind and exact
declared URL/item identity. Identity-free observations remain independent. It
preserves original records, paragraph text, changed headers, disjoint fragments and
observation/adapter history. Only exact contiguous containment or suffix/prefix
overlap is collapsed. These objects bypass the compressed screen-segment organizer.
Materials remain partial (`visible_window`); deeper interpretation is central model
work under the existing authorization/read-only evidence contracts.
The subsequent [automatic Memory decision](adr-ui-page-automatic-memory.md)
supersedes this release's initial automatic-Memory exclusion: newly accepted v2
fields enter the existing receipt/recipe pipeline over ready captured text.
Existing image/source receipts, page reads and explicit downstream requests keep
their authorization boundaries; historical rebuilds do not grant new model work.
The scoped reader uses the existing 2,000-member / four-million-character Material
budget while reading recent observations incrementally. Limited materials declare
partial coverage; all accepted original captures remain independently pageable.

| Classification | Disposition |
| --- | --- |
| KEEP | App content/activity/ignore scope, local privacy gates/masks, input/password exclusion, measured activity clock, immutable queue IDs/ACKs, transport, retention, untrusted evidence and central processing. |
| CHANGE | Android setup becomes App-first with first-start preview; new default is page-first; non-screen-only legacy modes now mean fields first with screenshot fallback; long visible Android text is bounded and retained rather than discarded. |
| REMOVE | New Android selected-node uploads, simultaneous structured-plus-screenshot capture on success, `complete:true` as Android's screenshot suppression gate and page-only's lack of fallback. |
| EXCEPTION | Explicit screen-only/MediaProjection, legacy v1 queued captures and desktop's existing v1 modes remain supported; privacy/state rejection never falls back. |
| UNKNOWN | Current physical App compatibility, offscreen content, real OEM lifecycle/permissions, long-running battery impact and live model results require separate validation. |

This supersedes the Android modes and node-upload behavior in
[page capture](ui-page-capture.md). It keeps the adapter/central boundary in
[central perception](central-perception.md) and [material architecture](material-architecture.md).
Settings/storage epochs and the wire protocol range are unchanged. Central must be
upgraded before Android: an old node rejects v2 fields and the queued event remains
pending. Existing queued v1 records are accepted without migration or rewriting.

The WeChat 8.0.78 and Taobao 10.66.22 rules reuse structural facts inspected from
the local historical experiment. Their fixture content is generated; historical
snapshots, personal article bodies and pixels are not included. See
[rule provenance](../adapters/ui/README.md) and [validation](validation/android-page-fields-2026-10-10.md).
