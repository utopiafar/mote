# Current architecture map

**English** · [简体中文](architecture.zh-CN.md)

These responsibility groups map current code. [Product](product.md) and [Design](design.md) describe the long-term direction.

Central owns the shared archive, processing and retrieval, and submitted conversation, task and action state. Clients own local collection, privacy processing, offline persistence and synchronization, and authorized device capabilities.

```mermaid
flowchart LR
  I[Collection and intake] --> A[Archive and processing]
  A --> R[Original and memory retrieval]
  R --> P[Applications and agents]
  P --> X[Authorized actions]
  X --> P
```

Material can be retrieved directly while Memory and interpretations are produced under authorization. Plugins, models, configuration, execution and diagnostics support the entire path.

## Responsibilities and entry points

| Responsibility | Current content | Code entry points |
| --- | --- | --- |
| Collection and intake | Mac / Android collection, explicit records, source synchronization and Central intake | [desktop](../apps/desktop), [android](../apps/android), [ingress.ts](../apps/server/src/ingress.ts), [sources.ts](../apps/server/src/sources.ts) |
| Archive and processing | Originals and versions, Material, decoding, image and audio processing | [materials.ts](../apps/server/src/materials.ts), [evidence-archive.ts](../apps/server/src/evidence-archive.ts), [plugins](../apps/server/src/plugins) |
| Memory and retrieval | Memory extraction, review and publication; material, memory and original reads | [memory-pipeline.ts](../apps/server/src/memory-pipeline.ts), [context-query.ts](../apps/server/src/context-query.ts), [evidence-reader.ts](../apps/server/src/evidence-reader.ts), [agent](../packages/agent) |
| Assistant applications | Main conversation, tasks, matters, suggestions, feedback and notifications | [web](../apps/web), [assistant-tasks.ts](../apps/server/src/assistant-tasks.ts), [assistant-notifications.ts](../apps/server/src/assistant-notifications.ts) |
| Action execution | Connected Todo, calendar and messaging product commands, authorization, targets and results | [assistant-actions.ts](../apps/server/src/assistant-actions.ts), [assistant-drafts.ts](../apps/server/src/assistant-drafts.ts), [actions.ts](../apps/server/src/actions.ts) |
| Shared foundations | Plugin contracts and host, models, configuration, execution, shared types and diagnostics | [plugin-sdk](../packages/plugin-sdk), [plugin-host](../packages/plugin-host), [plugin-api](../packages/plugin-api), [model-agent.ts](../apps/server/src/model-agent.ts), [execution-engine.ts](../apps/server/src/execution-engine.ts), [shared](../packages/shared), [diagnostics](../packages/diagnostics) |

[host.ts](../apps/server/src/host.ts) is the Central composition root. Existing assembly, features and plugins connect domains. Extensions reuse the existing SDK, models and task infrastructure. Interfaces and implementation evolve with actual needs.

## Technical foundations

- Central uses Node.js / TypeScript and Fastify; Web uses React. Mac uses Electron and native helpers; Android uses a native Kotlin client.
- The MVP defaults to SQLite and file archives, with FTS5 full-text search and optional semantic retrieval. Keep originals, published Memory and task state distinct from rebuildable indexes, retaining the existing storage and retrieval extension boundaries.
- Runtime adapters connect DSH and Codex under the same Mote context and authorization principles. DSH ecosystem compatibility prioritizes unchanged packages, followed by general configuration and composition adapters. Native applications may retain internal sessions and workflows, with Mote connecting authorized context, visible state and artifacts.
- Plugins use the existing Cordis, PluginHost and SDK. Composition depends on actual platform support and dependencies; new OS primitives ship with client builds.

## Current boundaries

- Central, macOS and Android are formally supported. iOS has an experimental client outside the formal support matrix.
- Originals, structured material, Memory, conversations and task state are distinct. Receipt does not establish parsing, indexing or Memory completion.
- Queries, Memory and insights currently use read-only context tools. Product commands and Actions perform external effects. Dedicated runtimes such as import have their own tool boundaries.
- A module or request selects its model configuration. Central stores metadata, indexes and archives, with source identity, versions and current permissions controlling reads and publication.

## Product direction and implementation gaps

| Product direction | Current implementation and gap |
| --- | --- |
| Main conversation, background tasks and authorized actions | Messages still queue per conversation and tasks produce drafts tied to archive evidence. User steering, current instructions without archive evidence, lightweight recording/onboarding and authorized Actions still need wiring. Message sends still require individual confirmation; external Agent Action access is not connected. |
| Notification delivery | The current MVP retains Android polling while the app process is alive, without background push. Online presentation does not establish timely delivery while the phone is idle. |
| Default retention and synchronization | Central has no total-content quota or age-based material deletion; new file sources default to archived originals while existing explicit choices are retained. Incomplete uploads and retryable processing inputs survive by age; successful processing, explicit cancellation and acknowledged transport copies keep their release paths. Central history deletion rejects deleted/admitted old revisions while permitting future source versions; upload sessions persist the existing Central scope generation, and Desktop binary queues isolate confirmed deleted versions without blocking successors. See [files](files.md). Original archives now use safe-integer sizes, fixed parts, paged receipts and streaming read/backup beyond the former 512 MiB cap; parsing and Buffer/portable formats keep separate budgets. Mac formal captures and meeting audio now retain local bytes after exact ACKs without lifetime quotas or age cleanup; new file sources default to archive, source-only staging is released on exact whole ACK, and local scope withdrawals isolate old input and fence request leases. Android formal captures and meeting audio also retain local originals after exact ACKs without lifetime quotas or age cleanup. File-source spool is released only after an exact whole-file ACK; source admission and connection-generation fences preserve isolated old inputs across scope changes and restarts. Mac owner-confirmed cleanup leaves receipt-only records and uses existing permission-checked APIs to read the original Central, including streamed meeting-original saves; pending/isolated input, unproven receipts and selected files are excluded. Android explicit local-copy cleanup and Central readback remain separate client work. Day-based material retention is outside the current MVP scope. |
| Memory use and lifecycle | Extra review follows the pinned recipe: an independent reviewer or explicit no-review decision, with the same host validation and no handcrafted semantic routing. Valid Memory can be used directly; explicit standing context remains visible within current permissions and the actual model budget. Original quotation and source-specific claims still require the relevant originals. Ordinary pause/resume preserves authorized receipts, jobs and finite lifecycle rounds across restart; denied input and unregistered gaps gain no authority, and immediate stop withdraws the automatic tail. Ordinary original release preserves already-published valid Memory under current scope; forgetting, source withdrawal and privacy revocation still invalidate it. Host delivery receipts distinguish Memory ancestry from actual original reads in ongoing queries and saved dialogue. See [Memory lifecycle](memory.md). |
| DSH ecosystem compatibility | The [official query composition](../packages/agent/src/official-composition.ts) loads installed original ESM packages, Hooks and a Factory through restart-only owner selections/grants and per-query live Host pins. Explicit APP selections resume the original SDK session across interactions/restarts, protect private history, and publish declared UTF-8 state/products as Materials with current disclosure-role checks. Offline profile backup retains complete sealed SDK generations and their SQLite controls/receipts with a separately preserved original key; restore does not grant or launch an old interaction. Scheduled backup policy remains a separate follow-up. Native pages and arbitrary third-party compatibility remain separate. See [native pack and application configuration](agent-runtime.md#installed-native-dsh-packs). |
| Plugin production activation | General processing service packages validate declarations in an isolated host scope and publish them into the existing processor runtimes only after explicit enablement; failures block activation and disable fences late outputs. Pure data/domain releases install directly into the existing PluginHost with typed ports, exact active dependencies and persistent instance state; withdrawal fences leases and late writes. Supported installed pages/theme/layouts reach the authenticated Web startup through activation-bound inventory: isolated HTML and declared instance methods, role values and compiled-shell layout data. See [Plugin Center](plugin-center.md). |
| Source connection and coverage | Notion/Slack/Feishu-session packages have Web catalog, read authorization, content/history selection, save-and-sync and source-detail management flows. Source coverage is separate from execution state. Notion database enumeration, page bodies and child blocks resume from bounded durable checkpoints and reject stale scope writes. Retained body prefixes and unsupported content report partial coverage in both sources and Materials. Slack and Feishu-session history and thread replies resume durably within fixed windows and bounded rounds; archives precede conditional checkpoints, and coverage advances only after the window completes. Google/Lark cloud calendars enter the Action registry after separate write consent; execution requires an exact calendar and input-source grant. See [connectors](connectors.md). |
| Media preparation | On supported Macs, local-image pages prepare dependencies and model assets; optional inference is enabled separately through the plugin. Default audio pages follow FunASR/CAM++ and no longer offer unsupported WeSpeaker installation. Full journey, real-model quality and platform evidence remain separate. |
| Android advanced media operations | Common reading, playback and text correction stay native. Contextual entries open the exact Central recording's Web speaker audition/naming, original comparison or raw transcription, and the corresponding media preparation panel without changing model authority or processing selection. Short-lived tickets retain the current owner session; logout, node/object changes and late results are fenced. [Generated Central → Kotlin → Web evidence](testing-runbook.md#android-advanced-web-contract) covers actual consumers, without device/browser-launch or live-model claims. Dedicated automatic photo-library collection remains a later roadmap item beyond manual photo/file intake. |
| Coding dialogue coverage | The conversation projection admits verified human messages and protocol-confirmed visible assistant text, including intermediate explanations. Native event order, speaker and provider remain attached; tools, hidden reasoning, host context and subagent output stay excluded. |
| Execution and extensions | Generic batch processing and older delegation coexist. Reuse task foundations and consolidate duplicate state progressively as real work requires. MVP interfaces may evolve without blanket host, delegation or interface freezes. |

Update this map as implementation changes. Keep necessary short references for protocols, the plugin SDK, configuration, deployment and verification; code and schemas own concrete interfaces.

Technical references: [material and sources](materials.md#publication-and-extension), [Memory](memory.md), [execution](agent-runtime.md#execution-state-and-recovery), [protocol](protocol.md), [configuration](server-configuration.md), [content storage](content-storage.md).
