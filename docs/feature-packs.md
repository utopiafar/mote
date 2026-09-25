# Feature packs

The central Web console and server now have independent Cordis hosts. Shared, browser-safe descriptors join transport, read APIs, commands, processing registrations, UI pages/collections/detail panels and read-only Agent capabilities by feature ID. The execution engine, receipt protocol, material publisher, privacy rules and existing feature behavior remain authoritative.

## Ownership

- `apps/server/src/features/`: per-feature HTTP entries. Capture, notes, devices, media, files, sources, Coding, materials, context, imports, memory, Ask, insights, actions, processing, models, storage, usage, diagnostics and system routes mount through `ServerFeatureHost`. Its child Fastify scopes inherit authentication, protocol gates, request budgets and diagnostics. Binary begin/chunk/commit and playback continue to use the existing file store and durable receipts.
- Connector adapters retain their existing scoped `ConnectorRegistry` (MCP, Google, Gmail, Lark and trusted local extensions). Its installed entries also contribute to the feature inventory. OAuth/MCP retain their separate authorization boundaries.
- `apps/server/src/agent-feature-host.ts`: all archive reader methods are registered by owning feature. The model and Agent inspector consume the same dispatch facade. No writer or raw filesystem operation is exposed. Direct conversation attachments retain their separate request-scoped authorization.
- `apps/server/src/feature-inventory.ts`: `/api/features` joins actual HTTP, Agent, connector, source-pipeline, file-processor and context-processor registrations. Capability revisions change with the registered surface. This is registration state, not proof that any material ran every processor.
- `apps/web/src/features/`: page entries declare route, navigation label, section and renderer. Library collections, exact kind/schema/representation renderers and additive detail panels are separate registrations. React subscribes to a disposable registry; Cordis owns the browser registrations. Existing API-instance caches remain scoped to authenticated identity and exact request scope.

The shared registry pins descriptor copies, rejects duplicate component IDs and contract-version conflicts, detects missing/cyclic dependencies and revokes dependent lookup when a provider disappears. Disposal is idempotent and cannot unregister a replacement instance. A missing/failed/ambiguous specialized material renderer falls back to safe Markdown; panel failures stay local. New pages that need new server contracts check the returned capability ID/version before rendering.

## User surfaces

| Entry | Data authority |
| --- | --- |
| Library → Published materials | Bounded material list, immutable revision/body ranges, lineage and named processing outputs |
| Library → Coding Agent uploads | Received archive event heads/bytes, source pipeline states, published/indexed material counts and actual memory-work states; assembled transcript stays server-owned |
| System → Model-visible directory | Query Agent's real catalog, materials, memories, source-item and segment projections; virtual paths, never host directories |
| Model-visible directory → Recorded inputs and reads | Existing opt-in trace events at context assembly/model/tool boundaries; retention gaps and truncation are explicit; old input is never rebuilt from current memory |
| Extensions | Runtime capabilities joined across the server and browser hosts |
| Memory / task details | Read-only saved-record panels; existing review, correction, retry and cancellation commands remain in control |

The Agent inspector is owner-only and cannot mint disclosure grants for a real query. It previews the current Ask archive scope, not arbitrary administrator impersonation or every possible custom agent task. Historical trace availability still follows the explicit diagnostics setting and log retention. New trace pages have a bounded response and clearly mark truncated payloads.

## Adding a feature

1. Add a server entry under `features/` and compose it in `features/index.ts`. Receive only a typed `Pick<FeatureServices,...>`; keep ingestion, file upload and publication in the existing trusted services. Register processing recipes/executors using the existing Source Pack and processing extension contracts.
2. Add a browser page/collection/view contribution under `features/`, then include it in the deployment composition. Navigation derives from page entries. Match renderers by exact declared kind, schema version and representation; never infer feature type from captured text. Add panels without changing the owning page's business logic.
3. Reuse generic read-only Agent methods for new data shapes. Add a new Agent capability only when it has genuinely new read semantics, with the same server authorization and bounded output.
4. Test on a tiny generated fixture from receipt through publication and UI/model reading. Test duplicate delivery, scope rejection, stale reference rejection, missing dependencies and disposal. Update English and Android catalogs for authored UI strings.

This MVP bundles trusted plugins with the deployment. Changing HTTP topology or installing new built-in packs requires a rebuild/restart; it is not a remote plugin marketplace or arbitrary-code sandbox. HTTP disposal blocks new dispatch without deleting data. UI disposal never stops processing or changes Agent access. Existing native collector upload/permission modules keep their native platform implementation and wire behavior; they do not execute browser Cordis plugins.

## Validation

- `npm run check:local`: all workspace type checks, i18n synchronization and unit/integration fixture suites.
- `node --import tsx --test apps/server/test/feature-packs.test.ts apps/web/test/feature-host.test.ts`: scoped lifecycle, duplicate upload, publication, inventory, Agent scope and stale-revision fixtures (three initial Coding events and one append).
- `node_modules/.bin/electron scripts/test-web-feature-packs.cjs`: isolated server and actual renderer, three generated Coding events, upload/aggregate/Agent views, all 26 pages, mobile overflow and screenshots under ignored `.mote/feature-packs`.
- `node_modules/.bin/electron scripts/test-web-navigation.cjs`: existing navigation, settings, identity, diagnostics and responsive regression flow.
- `MOTE_TEST_CODEX_MODEL=gpt-6-luna node --import tsx scripts/test-codex-provider-live.ts`: opt-in real local Codex App Server model catalog, probe, retrieval/evidence tool call and citation against a generated note. No personal captures are collected or sent.

Physical Android/Mac capture and external-account writes are not covered by these fixtures; report them separately. Release CI builds and verifies both platform packages, which does not establish a physical-device capture check.
