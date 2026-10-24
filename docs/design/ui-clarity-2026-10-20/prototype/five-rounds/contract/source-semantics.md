# Source semantics and supersession record

## Authority and freeze

The independent inventory is frozen for R30–R34 at application source revision `81a73c0ec81af876d6eeef71451b75cd51684b34`. The source audit produced 188 named semantic features: 128 Central web/application features and 60 native collector features. The historical 20 task families and 78 directory entries are a crosswalk only. They neither define the current product nor prove preservation of nested functionality.

Authority order is: **the owner’s current corrections → implemented current code → historical descriptions**. The inventory agent did not read candidate R30–R34 implementations to decide what features should exist. Candidate evaluation belongs to the separate evaluator. Source anchors in `user-features.json` include immutable revision URLs, valid line bounds and complete-file SHA-256 digests.

This is a source audit. No server, model, Android device, macOS device, OAuth provider, vendor account or native permission journey was run by the inventory agents. Every runtime journey starts as `not_run`.

### Cross-platform applicability clarification

The `platforms` field records where the implementation evidence was audited. `central-web` is **not** an automatic exemption for Mac or Android candidate surfaces. Every `UF-*` requirement applies wherever a candidate exposes that shared Central task, including Library, Import, Ask, Activity, Sources and Settings. In particular, an import form rendered on any of the three platforms must retain import explanation, options, persistence and recovery.

Where current native code delegates a capability to Central, a clearly identified functional Central handoff is acceptable; preserve the originating task and destination. Do not label an unsupported local-looking form as native implementation. `NAT-*` requirements retain their exact supported native platforms. A not-applicable decision needs a source-backed capability reason, not just the `central-web` label. This clarifies the frozen requirements without introducing new native capabilities.

## Material explanation is a supported input, not decorative copy

The actual import form has an optional `instruction` text area, labeled **格式、作者与归属说明**, with a 12,000-character limit. Its examples support format, authored/recorded time and timezone, authors or speakers, and which content belongs to the owner. Subject, topic and background can be supplied in that same free-form description. The current code does **not** require seven new independent structured fields for those concepts.

The minimum preservation contract is:

1. A labeled explanation input is reachable before enqueueing. A material name or generic “metadata” badge is insufficient.
2. The selected files, parser, image plan, name and exact explanation are submitted together.
3. The saved explanation is inspectable from the same import’s details.
4. Awaiting-confirmation, model-required, failed and unsupported imports allow the explanation to be revised and the preview regenerated.
5. Quoted third-party and AI content keep their original speaker/role. An import-level personal explanation does not convert the whole batch into the owner’s statements.
6. Leaving the explanation empty does not prevent original archiving or make unknown attribution unusable.

Evidence: `apps/web/src/Imports.tsx:91–97,133–138,145–158,176–179`; `packages/shared/src/material-context.ts:24–31`; `apps/server/src/materials.ts:270–275,358–359`. These map to `UF-IMPORT-CONTEXT`, `UF-IMPORT-CONTEXT-RECOVERY`, `UF-IMPORT-PARSER`, `UF-IMPORT-IMAGE-PLAN`, and `UF-IMPORT-PREVIEW-CONFIRM`.

## Source explanation, attribution and document metadata are separate

| Mechanism | Current input or evidence | Scope and precedence | Required preservation |
| --- | --- | --- | --- |
| Import explanation | Owner-entered `instruction` prose | That import’s original captures; independently versioned declaration identity | Preserve exact prose through enqueue, saved detail and reinterpretation |
| Source explanation | `description` prose, up to 12,000 characters | Existing and future material from that source | Keep source editor, acknowledgment/version, dirty draft and conflict recovery |
| Source attribution | `owner`, `third_party`, `mixed`, `unknown`, or unset | Source-wide default for existing and new material | Retain selection, save, effective relation and declared scope |
| Material attribution | Same relations or “follow source” | Explicit material correction takes precedence over source declaration, then connector/default context | Keep revision-bound correction and visible basis |
| Document provenance | Path, source ID, original file/attachments, original metadata, content role, recorded/event time | Evidence about the individual source record and its version | Preserve available facts without inventing missing author/subject/date values |
| Clarification answer | Free text or an authored option | Only the question’s specific material/work scope | Preserve original evidence, defer/end/reopen and stale-question behavior |

The attribution relation is a separate owner declaration. Free-form import prose does not directly set `ownerRelation`. The code represents original content roles as `authored`, `transcript`, `summary`, `reference`, or `other`. A title or provider subject may already live in source metadata; that is not evidence of a universal editable “subject” form field.

Source descriptions live in a versioned private declaration store. Evidence pins their immutable identity. Authorized reads open the owner-entered prose. A descriptor preview is a lead, not proof that a model has actually read that description in a particular answer. See `packages/shared/src/material-context.ts:3–31`, `apps/server/src/source-context.ts:45–76`, `apps/server/src/source-context-catalog.ts:14–25`, and `apps/server/src/materials.ts:270–275,358–359`.

## Drafts, acknowledgment and conflict are part of the feature

The Central source editor does not overwrite a dirty draft during refresh. Saving uses the expected version. An edit made while a save is in flight remains a draft against the server acknowledgment. A version conflict preserves the draft and provides explicit reload/discard controls. Loading, saving, saved acknowledgment and failure are separate states.

Android’s local file-source flow has an additional concrete acknowledgment boundary: `description`, `contextVersion` and `contextDirty` are persisted. A local/Central description conflict can require choosing the local or Central version. Affected files wait while required description acknowledgment is unresolved. This is a functional dependency, not optional explanatory chrome.

Mac’s current local `sourceOptions()` UI does **not** expose an equivalent free-form source-description editor. Do not label that parity as already implemented. Central’s source editor remains an implemented editing home. A candidate may give a Mac user a clearly identified Central handoff, but it must not describe a new native control as preservation of existing native behavior.

Changing source prose applies background to existing and future material. It does not automatically retranscribe or recompute historical memory. Relevant IDs: `UF-SOURCE-CONTEXT`, `UF-SOURCE-CONTEXT-CONFLICT`, `UF-SOURCE-ATTRIBUTION`, `UF-MATERIAL-ATTRIBUTION`, `NAT-005`, `NAT-006`.

## Collection responsibility correction

| Surface | R30–R34 disposition | Meaning |
| --- | --- | --- |
| Central server directory picker, watch/sync controls or self-collection claims | **REMOVE / superseded by owner correction** | Central must not be presented as collecting folders on its host machine |
| Browser-selected files, folder, dragged directory, ZIP | **KEEP** | The browser sends only selected local bytes as a one-time upload |
| Mac local file/folder collection | **KEEP** | Collector controls local path, history, retention, filtering and ongoing change capture |
| Android SAF file/folder collection | **KEEP** | Collector owns local URI permission, history, retention and ongoing scanning |
| Central device page | **KEEP as reporting and authorization** | Latest device report, connection management and installation/handoff guidance; collection start/pause/privacy stay on the device |
| Central Gmail, Google/Lark calendars, Lark docs, registered vendor recordings, MCP resources | **KEEP** | Authorized external-service intake is distinct from reading Central’s local filesystem |
| External/NAS reference | **KEEP as reference only** | Stores title/location/time; no automatic body access or server folder scan |

Historical directory unit **A01** is retained in the crosswalk as superseded, not required. Current `Imports.tsx` still contains a legacy non-web server-directory branch; it is disabled for the browser mode. That residue does not override the owner’s requested responsibility boundary. Removing that branch from prototype navigation is a correction, not feature loss.

Collector file choices must remain distinguishable: first sync `all` vs `new_only`; continuous vs one-time; snapshot vs reference vs archived original; optional full extracted-body retention; supported types, interval, extensions, exclusions, size limits, and per-source state. Source pause, capture pause and pause-all-sending are separate operations.

## Original, body, index and memory are independent outcomes

Originals can be archived while parsing, OCR, transcription or a model waits. A body may be published and readable while its index is incomplete. A received coding event count is not a published conversation count. A completed media import does not prove that searchable text or memory exists. Cancelling a processing task retains already saved originals and products according to that task’s scope.

Required distinctions include:

- Local queued bytes versus Central-acknowledged originals.
- Reliable automatic publication versus ambiguous preview awaiting confirmation.
- Parsed, attachment, container, excluded, unsupported and file-pipeline dispositions.
- Raw transcription versus human correction, anonymous speaker grouping, confirmed speaker name, semantic grouping and summary.
- Body publication versus search-index readiness versus memory completion.
- Current source revision versus historical evidence and source-reported deletion.
- Operation submission uncertainty versus a confirmed running, failed or cancelled task.
- Source pause, sending pause, automatic-memory pause, immediate stop and deletion.

Relevant source anchors include `Imports.tsx:15–20,141–172`, `Materials.tsx:107–120`, `Files.tsx:122–132`, `FileProcessingControls.tsx:73–85`, and `CodingUploads.tsx:52–59`.

## Current-code corrections to historical directory text

| Historical description | Current authoritative interpretation | Contract IDs |
| --- | --- | --- |
| C01 “management token” login | Username/password, session duration, active account/origin/expiry; device invitations are separate | `UF-ACCOUNT-LOGIN`, `UF-ACCOUNT-SESSION`, `UF-DEVICE-INVITATION` |
| A01 Central machine directory import | Excluded from candidate UI by owner correction | Superseded historical crosswalk item |
| C39 v2-only portable import | Scoped portable3 requires original deployment/account; credentials and execution grants are not restored | `UF-ARCHIVE-PORTABLE-IMPORT` |
| A30 only validate/download an environment-file difference | Current scoped settings have saved/effective state and explicit applied/restart-required feedback | `UF-RETRIEVAL-CONNECTOR-CONFIG` |
| A09 browser installs Lark CLI | Current account workflow rechecks deployment-prepared CLI; missing/version mismatch directs the administrator to deployment preparation | `UF-LARK-AUTH` |
| Native note “mood up to 80 characters” help | Android current note UI sends an empty mood value; no implemented editable mood control is required | `NAT-047` |
| A common page-capture mode selector across clients | Mac exposes four modes, Android two; Android projection is screenshot-only | `NAT-018`, `NAT-029` |
| Coding-agent source on every platform | Local Claude Code/Codex/Kimi capture is Mac-only; other supported surfaces read Central-published material or hand off | `NAT-015`, `UF-CODING-RECEIPTS` |

## Density and progressive disclosure

Simplification can move secondary settings into a labeled source detail, focused editor, advanced section or task-specific dialog. It cannot discard the decision itself or make the user submit before supplying relevant context. The normal page should answer: **what is this item, what state is it in, what can I do next, and where are its originals/results?**

For each required input, the evaluator checks whether its entry is discoverable at the point of need. For each action, the evaluator operates it in the state where it should be available. For each outcome, the evaluator inspects the resulting item, not just a toast. A single generic “advanced JSON” box or all-features directory does not establish that the named control remains usable.

The inventory does not impose a new universal number of cards, fields, columns or clicks. Density evaluation should use the candidate’s rendered major pages and critical flows, with disclosure states exercised. A lower on-screen field count earns no completeness credit by itself.

## Limits of the audit

Every historical directory entry has a recorded disposition: 77 map to named semantic features and one is explicitly superseded. That does not mean the product has only 188 possible behaviors. The list names the independently audited user surfaces and high-risk state transitions; state combinations remain open-ended. Native Central management screens are represented by Central semantics plus honest native capability/handoff boundaries, not a promise that each web setting is natively implemented.

The evaluator must record **observed, partial, missing, blocked, not exercised, or not applicable with a reason**, and distinguish source evidence, prototype interaction evidence and production runtime evidence. Missing conditions or unavailable environments remain gaps. They cannot be converted into a pass by repeating a happy path.
