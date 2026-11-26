# Design

**English** · [简体中文](design.zh-CN.md)

Experience and design principles for the [product](product.md). See [Architecture](architecture.md) for current implementation coverage.

Put the owner's content and results first. Keep pages quiet and restrained, with natural, warm interaction.

## Conversation and presentation

- Answer directly and concisely by default. Use lists, tables or reports when the task benefits; do not impose fixed conclusion, evidence and next-step sections.
- Provide a very lightweight entry to sources and execution details. Users can open it or ask follow-up questions. Do not expand large evidence collections by default.
- The personal assistant uses one main conversation that remains available during long background tasks. Keep direct entries for browsing material, recording, collection and settings. Users do not have to select read-only or action modes first.
- Accept new guidance during ongoing work and prioritize the affected task. Use lightweight acknowledgements for plain recording. Show progress and results from Connections' “Get to know me” in Chat.
- Continue work already authorized. When asking, identify the concrete target, missing information or changed consequence.
- Make reasonable judgments when consequences are minor and correction is easy. Give the useful result first; mention or clarify key assumptions when they materially affect the current goal, without formulaic hedging.
- The model judges proactive help from the task, instructions and valid memories. Quiet updates and no new suggestion are valid outcomes. Muting, disabled notifications and explicit do-not-remind instructions remain effective.

## Honest state

Distinguish receipt, processing, indexing, memory and action completion. Report unknown outcomes honestly. An accepted request or generated draft does not establish execution success. Missing observations do not prove absence, and historical content does not establish current state.

## Interface and components

Retain the existing warm graphite palette, purple accent and light, dark and system-following appearance. Reuse navigation, terms, components and shared design definitions. Code owns exact values.

Keep information and action meaning consistent across clients while respecting platform conventions for input, file pickers, permissions and touch. This page describes current design principles; code owns concrete layouts and values.

### Motion

Use the shared timing in [the token generator](../scripts/generate-design-tokens.mjs) for press feedback, selection, overlays and loading. Preserve the reader, scroll position and focus as content updates. Let a dismissed overlay release input immediately so it can be opened again during its exit. Keep ordinary background refresh quiet. Loading placeholders wait briefly and then hold still. Honor the platform's reduced-motion setting and keep scrolling, dragging and resizing under direct control.

### Navigation

Put Chat, Feed, Ideas, Goals and Library in that order among daily entries. Group Memory, Skills, Connections and Settings together as management entries. Web and the Mac main window use a sidebar. Android keeps the five daily entries along the bottom and puts management in the `m` menu. Start in Chat. Keep search and actions close to the content they affect.

For the MVP, Android keeps common media reading, playback and text correction native. Advanced speaker review, original comparison and model preparation use lightweight entries to the same Central's Web, retaining the selected object and authorization. This is the intended boundary; current entry coverage is in [Architecture](architecture.md).

## Interface copy

- Do not add subtitles, onboarding paragraphs or sentences that explain a boundary. If text is needed to understand the page, change the layout.
- Do not show normal state. On an exception, state the object and its status, with at most one action.
- Do not use these source constructions: `不是…而是`, `不代表`, `不等于`, `只表示`, `并不意味着`.
- Length limits: buttons 6 characters; labels and filters 8; status 16; an empty state is one sentence of 12; an error is 24 plus one action.
- Delete, external-send and payment promises keep their exact meaning. Shorten an individual promise only after the owner confirms it.
- The central service returns status codes and data, not explanatory prose for people; clients render short labels.
- Tests assert states and available actions, not exact explanatory copy.

`npm run check:ui-copy` checks the full catalog for banned constructions, more than 24 Han characters, a bare 请, and trailing arrows. It also checks hidden Web and Mac markup for lone character icons and Central source for Chinese literals outside `moteText`. The checker recognizes one approved internal model example by its file, declaration, and exact content. Review and screenshots enforce the shorter limits for individual controls. The length exceptions for promises are listed in `scripts/ui-copy-promises.json`.

## Presentation extensions

Theme packs provide exact versioned role data; layout profiles describe supported navigation and detail preferences. Trusted platform renderers bind them through the shared presentation host. Missing providers recover the pinned built-in choice with a reason; install order does not choose a provider. New renderer code ships in the trusted platform build, without arbitrary remote UI execution.

Presentation changes preserve content nodes, drafts, selection and navigation; registered lifecycle scopes release handlers/timers even after partial mount failure. Light/dark/system choices are local to the browser/profile/install and do not change capture, model or source authority. Contracts: [shared host](../packages/shared/src/ui-presentation.ts), [plugin surfaces](plugin-surfaces.md).
