# Design

**English** · [简体中文](design.zh-CN.md)

Experience and design principles for the [product](product.md). See [Architecture](architecture.md) for current implementation coverage.

Put the owner's content and results first. Keep pages quiet and restrained, with natural, warm interaction.

## Conversation and presentation

- Answer directly and concisely by default. Use lists, tables or reports when the task benefits; do not impose fixed conclusion, evidence and next-step sections.
- Provide a very lightweight entry to sources and execution details. Users can open it or ask follow-up questions. Do not expand large evidence collections by default.
- The personal assistant uses one main conversation that remains available during long background tasks. Keep direct entries for browsing material, recording, collection and settings. Users do not have to select read-only or action modes first.
- Accept new guidance during ongoing work and prioritize the affected task. Use lightweight acknowledgements for plain recording; the “get to know me” entry opens the main conversation.
- Continue work already authorized. When asking, identify the concrete target, missing information or changed consequence.
- Make reasonable judgments when consequences are minor and correction is easy. Give the useful result first; mention or clarify key assumptions when they materially affect the current goal, without formulaic hedging.
- The model judges proactive help from the task, instructions and valid memories. Quiet updates and no new suggestion are valid outcomes. Muting, disabled notifications and explicit do-not-remind instructions remain effective.

## Honest state

Distinguish receipt, processing, indexing, memory and action completion. Report unknown outcomes honestly. An accepted request or generated draft does not establish execution success. Missing observations do not prove absence, and historical content does not establish current state.

## Interface and components

Retain the existing warm graphite palette, purple accent and light, dark and system-following appearance. Reuse navigation, terms, components and shared design definitions. Code owns exact values.

Keep information and action meaning consistent across clients while respecting platform conventions for input, file pickers, permissions and touch. This page describes current design principles; code owns concrete layouts and values.

## Presentation extensions

Theme packs provide exact versioned role data; layout profiles describe supported navigation and detail preferences. Trusted platform renderers bind them through the shared presentation host. Missing providers recover the pinned built-in choice with a reason; install order does not choose a provider. New renderer code ships in the trusted platform build, without arbitrary remote UI execution.

Presentation changes preserve content nodes, drafts, selection and navigation; registered lifecycle scopes release handlers/timers even after partial mount failure. Light/dark/system choices are local to the browser/profile/install and do not change capture, model or source authority. Contracts: [shared host](../packages/shared/src/ui-presentation.ts), [plugin surfaces](plugin-surfaces.md).
