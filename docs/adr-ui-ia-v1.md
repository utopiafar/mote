# UI IA v1

Presentation supersession, 2026-10-29: [Three-client UI finalization](adr-ui-final-three-clients.md) and its [source inventory](design/ui-final-three-clients-2026-10-29.md) supersede overlapping UI placement, Android navigation and Mac landing decisions below. Existing authorization, privacy and execution contracts remain in force until their separately recorded conflicts are resolved.

Accepted 2026-10-25 from the owner's [UI decisions](https://chatgpt.com/share/6add8286-7754-83e9-9c63-de2aab62ec8f). This decision supersedes the navigation, landing page and page responsibilities in the earlier presentation-pack and client-navigation decisions. Their appearance, native interaction and state-preservation rules still apply.

The owner's complete A–N decisions, Hold boundaries, journeys and single implementation checklist are recorded in [User journeys and UI](ui-user-journeys.md) (2026-10-26), verified against all 56 rounds of the [complete discussion](https://chatgpt.com/share/6aded7e7-8e04-83ea-86ed-fa36a31fc8e5). That document records the 2026-10-26 baseline and takes precedence over recommendations earlier than that date; the 2026-10-29 UI target takes precedence for overlapping presentation. It retains these primary destinations, adds first real-data onboarding, manual-first source setup, interface layering, plugin/action and cross-device directions, and Agent-assisted installation. Privacy/deletion lifecycle, MCP details, memory correction, notification algorithms, iOS pages and model routing remain on Hold; direct record editing/version propagation is unconfirmed.

Mote is a personal context center: sources collect originals, Central archives and understands them, and people and authorized Agents use the context. Captured or shared content remains untrusted evidence. A record is a deterministic save; a conversation is an AI interaction. Neither implies the other.

## Destinations

| Surface | Primary destinations | Default | Secondary |
| --- | --- | --- | --- |
| Central | Overview, Library, Data sources, AI access | Overview | Full Ask workspace, discovery history, execution/activity, Settings |
| Mac | Workbench, Content, Sources, Ask | Workbench | Sync/activity, Settings, global Central management |
| Android | Home, Materials, Ask, Sources | Home | Global **+ Record** action, Settings, sync/activity |

Explicit links and restored destinations remain meaningful. Presentation extensions may reorder each platform's own destination set; themes do not change data, authorization, drafts or navigation state. Local Light/Dark/System appearance remains unchanged.

Central exposes a persistent search/ask entry with explicit modes and Cmd-K. Ask has its own full conversation workspace, history, selected scope and evidence. Data sources includes incoming MCP resources; AI access manages outgoing MCP authorizations. Credentials and their authorization semantics are reused.

Library has two primary views: **My materials** and **My memories**. Detailed content categories, extraction controls and execution queues sit below these views. Memory dimensions reference the same IDs. The built-in topic, knowledge-type and use-case views use existing model-assigned fields; a trusted `moteContextTrees` contribution can add trees or explicit ID membership. The registry performs no semantic keyword classification and never duplicates a memory. Evidence scope, history and current provider binding still constrain every read.

## First use and daily use

Central guides an empty instance through connecting a collector, receiving a real material and opening its original. Model configuration, Ask and external AI authorization are optional next steps, not completion requirements. Pairing alone, aggregate counts or an issued authorization do not establish a completed real-data journey. Daily Overview shows actual source and processing status, few supported discoveries and recent content.

Mac Workbench leads with three tasks: quick note, import file and add source. Normal capture, connection and sending state occupies a compact row. Source problems link directly to their controls. Sources are grouped by screen/app activity, files/folders, Coding Agents, and local calendars/other sources. Completed one-time imports remain in Content.

Android Home emphasizes asking, recent intentional records and compact status. Automatic screen captures do not crowd out manual notes. **+ Record** directly opens one native editor. Settings and diagnostics remain reachable without occupying the main reading flow.

## Recording

The Android editor combines text, full-resolution photo originals, selected images, microphone recordings and files. No title or category is required. Drafts and original bytes are stored privately. Explicit Save durably enqueues the record, closes the editor and returns to the prior page without waiting for AI.

Attachments upload through the existing resumable file protocol before the note publishes their exact capture references. Retries preserve submission and attachment identities. Sending gates, origin binding and independent source/capture/send pause policies remain in force. Local save, Central receipt, and processing readiness are distinct states.

System shares prefill an editor and require Save. Shared originals and quoted conversation excerpts are stored separately from the owner's comment in `metadata.noteOrigin`; they are not presented as an owner assertion. Android records open Ask with `anchorEvidenceIds`: exact starting record locators that the model reads through the normal evidence tool, with other currently authorized retrieval still available. Explicit “only this record” uses strict `evidenceIds` instead. Central can resume these conversations with reference records or strict scope visible. Non-null anchors and strict selections are mutually exclusive; selecting either clears the other. Omitted fields inherit the conversation selection. Explicit `anchorEvidenceIds: null` clears only anchors, and `evidenceIds: null` clears only strict selection, for the next accepted turn; clearing both restores ordinary retrieval. Each admitted turn freezes its resolved selection before asynchronous work. Anchor IDs contain no delivered original body or additional permission: current privacy, time/device scope, content fingerprints, availability and deletion checks gate model admission and publication. Central and Android conversation-to-record actions require an explicit reviewed submission; rendering never rewrites the original answer. Mac retains its existing full local Ask, history and evidence flow.

Mac menu-bar quick recording uses one independent editor backed by the existing durable draft service. Workbench and tray target the same editor, avoiding competing writers. Closing the main window retains the established background collection lifecycle.

## Writing and visual tone

Retain the warm paper/graphite surfaces, restrained purple accents, existing components and native platform controls. The owner explicitly rejects explanatory prose filling everyday pages. Default surfaces show content, state and actions. Explanations belong in first-use guidance, help, an error or a consequential choice where the information is needed.

iOS is a confirmed complete-client direction with platform-specific collection. Its concrete IA and interactions remain on Hold, and this repository has no iOS client. Do not start one as part of the current UI slices.

## Validation

Use generated data in isolated profiles. Validate actual UI entrypoints, saved drafts, restart/recreation, original bytes, durable upload, exact evidence references and recovery. The candidate follows `check:affected`; actual Android emulator, Electron fixture and live Codex model results are reported separately. Existing successful historical checks do not establish this revision's behavior.
