# Feature packs

Mote adds functionality through plugin contributions. A package authors one `mote-plugin.json` (`PackageManifest`); the host validates its exact identities, capabilities and dependencies, then activates only the contributions it declares. Pages, HTTP routes, Agent read tools, processing steps, connectors and native entries are contributions, not additions to a shared service bag or a hand-written feature registry.

The complete surface reference is [plugin surfaces](plugin-surfaces.md). External SDK projects, template selection and private `plugin-dev` runs are in [plugin development](plugin-development.md). The domain contracts a contribution consumes are in [library and plugin extension contracts](library-plugin-contracts.md); themes and layouts use the separate [UI presentation contract](adr-ui-presentation-packs.md). `FeatureManifest` and `/api/features` are projections of installed package contributions and the capabilities a host actually registered, not a second package authority.

## Where contributions run

| Host | Current contribution path | Lifecycle |
| --- | --- | --- |
| Central server | Trusted build-time HTTP features in `apps/server/src/features/` mount through `FeatureRoutes` and `FeatureScope`; domain packages run through the common `PluginHost`. | Routes mount before `listen`; every request checks the live feature scope. Stopping blocks new dispatch with `503`; disposal releases routes, timers and owned resources exactly once. |
| Central web | `WebFeatureHost` installs page, collection, card, action, renderer, panel and home contributions in a disposable Cordis context. Theme and layout packs are data bound by the presentation host. | React subscribes to the registry. A missing or failed specialized view falls back to the generic reader; disposal removes only that registration. |
| macOS / Android | Native contributions ship with the app build and use the existing native hosts for capture, permissions and UI. | Native code is not downloaded at runtime; a new native primitive requires a client build. |
| iOS | Experimental; this repository has no iOS plugin host or package install path. | The `ios` host kind is not a promise that an iOS package can be installed. |

The server, web and native hosts keep their existing authorities. A contribution may register a route, a view or a processing step, but it does not create a second archive, task engine, authorization table or output service. Material, evidence, execution, Memory publication and Agent output stay with their existing owners.

## Contribution surfaces

A contribution declares exactly one `surface`. The current closed set is `ingress`, `upload`, `data`, `command`, `agent`, `processing`, `page`, `collection`, `card`, `action`, `renderer`, `panel`, `settings`, `home`, `theme` and `layout`. A capability named by a contribution must also appear in the package capability list, or composition rejects the package.

| Group | Surfaces | What they add |
| --- | --- | --- |
| Central data and execution | `ingress`, `upload`, `data`, `command`, `agent`, `processing` | Source intake, owner uploads, typed ports, owner commands, read-only Agent tools and bounded processing steps. |
| Web presentation | `page`, `collection`, `card`, `action`, `renderer`, `panel`, `home` | Navigation and views matched by exact declared kind, schema version and representation. |
| Declarative presentation | `settings`, `theme`, `layout` | Configuration editing for the package schema, theme data and navigation geometry. |

The host does not infer a surface from captured text, a route name or an installation order. Exact dependency versions and explicit service bindings select implementations; a missing, ambiguous or disposed provider makes the dependent capability unavailable instead of silently choosing another.

## Adding a feature

1. Declare the package and its contributions in `mote-plugin.json`: stable contribution IDs and versions, capability list, exact dependencies, configuration fields and, for executable contributions, a relative `entry` inside the payload.
2. Implement the contribution in its owning scope. A server contribution mounts its routes through the feature or package host and keeps ingestion, upload, publication and authorization in the existing trusted services. A UI contribution registers a declarative descriptor and never infers a feature type from captured text. An Agent contribution exposes read-only context with bounded output.
3. Compose the contribution through the trusted build (`apps/server/src/distribution/default.ts`, the domain assemblies and the web composition) or install a verified package through the plugin center. Do not maintain a second package description or a second runtime host.
4. Test through the real entry point with generated data: receipt through publication and Agent/model reading, duplicate delivery, scope rejection, stale reference rejection, missing dependencies, restart and disposal. Update all six `packages/shared/src/i18n-*.ts` catalogs for authored UI strings.

This MVP bundles trusted plugins with the deployment. Changing HTTP topology or installing new built-in packs requires a rebuild/restart; it is not a remote plugin marketplace or arbitrary-code sandbox. HTTP disposal blocks new dispatch without deleting data. UI disposal never stops processing or changes Agent access. Existing native collector upload and permission modules keep their native platform implementation and wire behavior; they do not execute browser Cordis plugins.

## User surfaces

| Entry | Data authority |
| --- | --- |
| Library → Published materials | Bounded material list, immutable revision/body ranges, lineage and named processing outputs |
| Sources → Coding sync status; Activity → advanced receipts | Received archive event heads/bytes, source pipeline states, published/indexed material counts and actual memory-work states; published conversation bodies remain in Library and assembled transcripts stay server-owned |
| System → Model-visible directory | Query Agent's real catalog, materials, memories, source-item and segment projections; virtual paths, never host directories |
| Model-visible directory → Recorded inputs and reads | Existing opt-in trace events at context assembly/model/tool boundaries; retention gaps and truncation are explicit; old input is never rebuilt from current memory |
| Extensions | Runtime capabilities joined across the server and browser hosts |
| Memory / task details | Read-only saved-record panels; existing review, correction, retry and cancellation commands remain in control |

The Agent inspector is owner-only and cannot mint disclosure grants for a real query. It previews the current Ask archive scope, not arbitrary administrator impersonation or every possible custom agent task. Historical trace availability still follows the explicit diagnostics setting and log retention. New trace pages have a bounded response and clearly mark truncated payloads.

## Validation

- `npm run check:local`: all workspace type checks, i18n synchronization and unit/integration fixture suites.
- `node --import tsx --test apps/server/test/feature-packs.test.ts apps/web/test/feature-host.test.ts`: scoped lifecycle, duplicate upload, publication, inventory, Agent scope and stale-revision fixtures (three initial Coding events and one append).
- `node_modules/.bin/electron scripts/test-web-feature-packs.cjs`: isolated server and actual renderer, three generated Coding events, upload/aggregate/Agent views, 29 route smoke probes, mobile overflow and screenshots under ignored `.mote/feature-packs`.
- `node_modules/.bin/electron scripts/test-web-navigation.cjs`: existing navigation, settings, identity, diagnostics and responsive regression flow. Use `--library-only` for the focused library/keyboard/history/responsive acceptance slice.
- `MOTE_TEST_CODEX_MODEL=gpt-6-luna node --import tsx scripts/test-codex-provider-live.ts`: opt-in real local Codex App Server model catalog, probe, retrieval/evidence tool call and citation against a generated note. No personal captures are collected or sent.

Physical Android/Mac capture and external-account writes are not covered by these fixtures; report them separately. Release CI builds and verifies both platform packages, which does not establish a physical-device capture check.
