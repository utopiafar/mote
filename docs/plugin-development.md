# Plugin development

Mote plugins are developed outside the repository against the public
`@mote/plugin-sdk` contract. This page describes the three runnable SDK
templates, when to pick each, and how the generated projects build and run on
a real host. All templates use generated fixtures and private
profiles only — never vault scans, personal data, credentials or models.

The complete author reference for every current public surface — 16
contribution surfaces, 4 runtime locations and 6 extension methods — is
[plugin surfaces](plugin-surfaces.md). It describes the code as it is today,
including that iOS does not load plugins.

Public APIs are available during the MVP and may change. Keep the SDK,
examples and incompatibility notes in sync when an interface changes; the
MVP does not promise a transition window for old APIs. Define compatibility
support before long-term stable use.

The author-facing boundary is `@mote/plugin-sdk` alone: a plugin never
imports `apps/*`, `packages/*` internals or `@mote/shared`. The SDK tarball
bundles the public contracts and the host entry; `plugin-dev` verifies the
installed copy (`PLUGIN_CONTRACT_VERSION 1`, package version `0.1.0`) before
starting a dev profile. The in-repository example packages
(`examples/journal-plugin`, `examples/media-intake-plugin`,
`examples/text-normalization-plugin`) are a different deployment seam described
in [library-plugin-contracts](plugin-surfaces.md#material-and-processing-contracts); they are assembled
by the host and are not covered by these templates.

## Choosing a template

| Template | Directory | What it is | Deployment today |
| --- | --- | --- | --- |
| `connector` — ordinary integration | `examples/external-plugin` | A repository-external Source plugin package: declares source kinds, uses injected `ctx.state`, publishes owner-only routes. | `plugin-dev dev` package install |
| `worker` — deep runtime | `examples/worker-plugin` | A packaged `runtime: "worker"` plugin: `createMemoryProvider` ABI executed inside the dedicated plugin-worker process over JSON lines with per-call cancellation and drained shutdown. | Plugin-center release (`/api/plugins`) |
| `domain` — new domain | `examples/domain-plugin` | A service-runtime data domain with typed port, lifecycle and durable `ctx.state`, plus a separate page declaration. | Explicit `--data-only` release through Plugin Center; real `PluginHost` typed leases |

Use `connector` for an external source or integration that fits the
connector manifest (`apiVersion`, `id`, `sourceKinds`, `create`). Use
`worker` when the plugin must run in its own hosted process behind the
durable memory-provider ABI — the deepest runtime isolation the current host
offers. Use `domain` when the plugin is a new product domain that provides a
typed service port other contributions can acquire, owns durable state, and
may contribute a custom page.

## Creating a project

From a built Mote checkout:

```sh
# Pack the SDK once (dist must be built; produces mote-plugin-sdk-0.1.0.tgz)
npm run pack:sdk -w @mote/plugin-sdk -- --pack-destination /absolute/output-dir

# Generate a project in an external directory
node scripts/mote.mjs plugin-dev create /external/my-plugin --template connector|worker|domain --sdk-tarball /absolute/output-dir/mote-plugin-sdk-0.1.0.tgz
```

`create` copies the whole template directory (never `node_modules`,
`vendor`, `dist` or `archive` — those are generated), installs the SDK
tarball, and rewrites the dependency to `file:vendor/...`. The generated
runtime uses the public SDK; the release packer is supplied by the Mote checkout.

## Building and running

Every generated project supports `npm run build`:

- `connector`, `worker` and `domain` run `scripts/pack.mjs`, which stages the
  payload, produces a deterministic ZIP and completes the `mote-plugin.json`
  archive digest into `dist/`. The packer comes from the Mote checkout
  (`--mote PATH` or `MOTE_REPOSITORY`) as development tooling; the package
  source itself never imports repository internals. `node scripts/mote.mjs
  plugin-validate --manifest dist/mote-plugin.json` checks the artifact
  end-to-end.

Running on a real host:

- `connector`:
  `node scripts/mote.mjs plugin-dev dev --plugin /external/my-plugin --once --seed`.
  This creates a private plugin-dev-owned profile (ownership marker, native,
  loopback, non-prod, storage inside the private home), validates
  `mote-plugin.json`, installs the package into the private dev host, loads its
  ingress contribution through the real connector registry, mounts owner
  routes, runs the generated seed and stops. Reusing `--home`/`--profile`
  proves `ctx.state` persistence across restarts. Configuration never selects
  executable modules.
- `domain` builds with `npm run build -- --data-only` install through the same fixed-release Plugin Center
  path, with a service-runtime `data` contribution and no ingress requirement.
  Check validates the lifecycle and typed ports without live publication or
  state writes; explicit enablement publishes them into the existing host.
  The generated
  project's `npm test` installs the package on a real `PluginHost` (from
  `@mote/plugin-sdk/node`) and exercises the typed port through a lease.
  Its optional source/seed files require an explicitly declared ingress adapter
  for `plugin-dev dev`; the explicitly selected data-only release omits ingress.
  The default build includes the isolated page and its declared `state/add`
  bridge. The complete release installs, checks and enables through the same
  production path; the authenticated Web startup registers its navigation.
  `--data-only` remains an explicit artifact choice for a service-only package.
- `worker` artifacts install through the plugin-center release path: the
  host resolves a pinned release, verifies the archive digest, expands the
  payload, creates an instance with the declared `dataFile` configuration
  and probes the provider (`health`/CRUD/scope/restart) before enabling.
  `plugin-dev dev` does not apply to worker packages — they have no
  ingress or processing contribution for the private dev host.

## Contracts the templates demonstrate

- **Host-bound identity and state.** The host supplies `ctx.state` scoped to
  the package installation; the plugin never chooses a package,
  installation, instance or activation identity. `ctx.state` persists across
  restarts and disable/re-enable; writes use `compareAndSet`. Connector state
  can pass `{sourceId, syncScopeVersion}` as its fourth argument to reject a
  checkpoint after the host-owned source scope changes. The host checks this
  condition in the same SQLite write transaction, using the connector's
  verified `sourceKinds`; generic state handles cannot use source conditions.
  This adds no namespace or per-instance source ownership authority. Source
  ingestion and status publication must separately pin the same scope version.
- **Lifecycle.** Factories construct domain objects only inside `create` /
  `createPlugin`. `prepare` builds and loads; `start` publishes; `quiesce`
  stops accepting new work; `stop` drains accepted work; `close`/`dispose`
  releases resources. Failure during `prepare` must release locks, timers
  and files it acquired.
- **Ports and leases.** A domain package provides a typed `serviceContract`
  port through `context.provide`; consumers acquire it through
  `host.acquire`, which returns a lease — there is no shared service bag.
- **Routes.** The connector adapter publishes owner routes once through the
  host dispatcher; owner authorization and error mapping stay host-owned.
  A plugin failure is honest either way: keep domain errors in the
  dispatcher-mapped shape (`name` `ConnectorError`, string `code`, integer
  `statusCode`) so the dynamic dispatcher returns the domain's status — never
  return a silent success.
- **Manifest authority.** `mote-plugin.json` is the sole package authority:
  `schemaVersion 1`, exact dependency identities (no ranges), declared
  contributions and capabilities. `trust: "external"` plus `runtime` selects
  the execution surface. Capabilities and configuration fields are verified
  by the host, not trusted. A contribution-provided capability must also be
  declared in the package `capabilities` list; when `plugin-validate` or the
  composition planner rejects a package, each failure names the missing or
  mismatched declaration and the remediation that fixes it.
- **Worker discipline.** The worker entry must be self-contained (the
  installed payload has no `node_modules`), persist only in
  instance-configured locations — never inside the integrity-checked payload
  directory — and treat a cancelled call as a possibly-submitted remote
  effect that needs reconciliation.
- **Generated fixtures only.** Seeds and tests write generated data into
  private plugin-dev-owned profiles and temp directories.

## Verifying a template end to end

The commands the repository's own acceptance runs (see
`apps/server/test/plugin-templates.test.ts`):

```sh
# [U] Generate + build each template in a temporary directory
for t in connector worker domain; do
  node scripts/mote.mjs plugin-dev create /tmp/gen-$t --template $t --sdk-tarball /absolute/output-dir/mote-plugin-sdk-0.1.0.tgz
  MOTE_REPOSITORY=/absolute/mote npm run build --prefix /tmp/gen-$t
done

# [K] Real host installs and runs the built artifacts
node scripts/mote.mjs plugin-dev dev --plugin /tmp/gen-connector --home /tmp/dev-home-connector --once --seed
# domain: the formal release fixture builds the template, installs its archive,
# enables it and consumes the actual typed port in an isolated Central profile.
npm run test:file -w @mote/server -- test/plugin-production-domain.test.ts
# worker: expand dist/*.zip to a private directory and run it under the real
# worker runtime; the repository test probes health/CRUD/scope/restart.
```

The optional domain ingress fixture explicitly adds that adapter declaration
before checking owner-route writes and mapped invalid-input failures. The data
installation fixture exercises the production path independently.

## Scanning generated artifacts

`scripts/ci/sensitive-scan.mjs` checks support bundles and built bundles
before they are shared, attached to a release or copied into an issue. It
reports redacted locations only, so the report does not repeat the value that
must be removed.

```sh
# A support bundle: also rejects captured-content fields outright
node scripts/ci/sensitive-scan.mjs --support /tmp/mote-support.json

# Compiled files or directories
node scripts/ci/sensitive-scan.mjs --bundle apps/web/dist packages/plugin-sdk/dist

# Generated private-body markers can be supplied explicitly for a fixture
node scripts/ci/sensitive-scan.mjs --bundle --private "$GENERATED_PRIVATE_BODY" dist
```

The scan rejects private-key blocks, common API/token formats, host-private
absolute paths (user profiles, temporary roots and the current checkout), and
support-bundle fields that would export captured text, titles, URLs,
credentials or device identities. A compiled bundle cannot distinguish
arbitrary user prose from product copy, so generated private-body values are
passed with `--private`; every artifact is still checked for keys and host
paths. `--json` prints the complete report and a finding exits nonzero.
`--private-root` adds an isolated host root when a fixture lives outside the
standard home, temporary or repository directories.

## Contributions and domain services

`mote-plugin.json` is the package authority. Feature inventories project its declared contributions and actually registered capabilities; they are not a second manifest. Central features mount before listen, check their live scope on every request, and dispose routes/timers/resources. Web registers declarative views in a disposable host; native primitives ship in client builds. iOS currently has no plugin host. Theme/layout packs use the trusted presentation host, not arbitrary downloaded React/HTML.

A new source declares explicit source kinds and uses the existing connector/source-pipeline services. A processing contribution registers `moteContextProcessors`; file decoders use `moteFileProcessors`. The [text-normalization example](../examples/text-normalization-plugin) demonstrates deterministic processing. Owner workflows at `POST /api/processing/workflows` name processors and versioned original/artifact inputs, and can use `dependsOn` for a DAG. The host retains authorization, cancellation, measured usage, output bounds and commit checks. Lane names (`extract`, `aggregate`, `semantic`, `memory`) are scheduling categories, not semantic intent classifiers.

Self-contained `runtime: "service"` releases with a processing contribution and `processing.pack` export their Cordis plugin as `backendPlugin` or `default`. Plugin Center checks declarations in an isolated host scope, then explicit enablement publishes them into the same production registries. Supported registration ports are `moteContextProcessors`, `moteFileProcessors`, `moteFileOutputs`, `moteFileRecipes`, `moteImportIntake`, `moteImageInputs`, `moteImageRecipes` and `moteMaterialConsumers`. Only registration methods are passed, without Store access; declarations must complete during plugin application. Empty declarations, unsupported injected ports, invalid definitions and publication conflicts block activation. Registration cleanup and guarded callbacks belong to the installed instance scope, so disabling or changing its configuration withdraws the old implementation and prevents late output publication. A failed package does not remove another instance's registrations.

Pure data service releases use the [domain template](../examples/domain-plugin). The entry exports `manifest` (`apiVersion: 1`, matching package ID/version, data contributions, capability IDs, `required` and `optional` dependency declarations) and `createPlugin(context, {configuration, required, optional})`. Data declarations match the verified package, use its entry, and provide distinct `kind: "service"`, `cardinality: "single"` ports with one exact API version per contribution. The factory receives host-bound `scope`, `state`, `services` and `provide`, plus configuration and exact resolved dependency bindings. Construct the domain in the factory, load in `prepare`, publish every declared port in `start`, and release resources in the remaining lifecycle phases. A capability summary may be empty; the actual typed declaration still needs a successful check for the current configuration.

Check uses the real PluginHost lifecycle with staged port publication and read-only instance state. Enable alone publishes actual typed services; missing ports, undeclared ports/APIs, module claims beyond the verified Manifest and lifecycle failures block readiness and release partial publications. `context.services.acquire(contract, binding)` accepts only the resolved required/optional pins. Required service/package/contribution/host dependencies must resolve to exact live providers, multiple matching providers are an explicit ambiguity, and dependencies are never enabled automatically. Normal restart restores already-enabled providers before consumers; dependency withdrawal aborts the pinned consumer and projects it blocked, while a new explicit check/enable can acquire a fresh binding. Stop fences old leases and state writes, including asynchronous startup and late results. State stays in the same instance namespace across disable and restart. Installed page/theme/layout activation remains a separate host boundary.

## Installed Web presentation

The current Web contract supports `runtime: "service"` packages with these
`runtime: "host"`, contribution-version `"1"` declarations. The package Manifest
stays the authority; the installer never runs build or package-manager scripts.

| Surface | Package-relative entry | Actual consumer |
| --- | --- | --- |
| `page` | Self-contained `.html`/`.htm`, at most 1 MiB | Host-owned `CustomPluginPage` in an opaque-origin, script-only sandbox. |
| `theme` | `.json`, at most 128 KiB, containing `UiThemePack` | Complete validated role values, optionally both color schemes, applied by the existing presentation host. No CSS files, URLs or executable fields. |
| `layout` | `.json`, at most 128 KiB, containing `UiLayoutProfile` | Compiled `WorkspaceShell`: `sidebar/adaptive/top` navigation, `split/stack` detail, the desktop primary destinations in any order and the existing secondary destinations. No downloaded renderer. |

The JSON pack has its own exact `id/version`; the Web host qualifies its ID by
instance so two instances coexist. Enable registers choices; it does not choose
a provider by install order. The owner selects a theme/layout in appearance
preferences. Selection is saved under the current login's non-secret view scope
when browser storage is available, restored on refresh, and falls back to the
built-in pack when the selected provider is unavailable. The stable content
portal preserves mounted fields and work while presentation changes.

A render-only page needs no bridge. A page that uses a domain port declares one
same-instance data contribution and only the methods it needs, for example:

```json
{
  "bridge": {
    "contributionId": "template-collection.port",
    "service": {"id": "template.collection.log", "apiVersion": "1"},
    "methods": ["state", "add"]
  }
}
```

The page must also require that contribution at its exact version. Check validates
the actual staged port's own function properties without calling them; expose a
plain method facade when the domain uses a class or accessors internally. The bridge carries the
existing nonce/documentKey/instance/generation envelope over a document-bound
MessagePort. The trusted parent dispatches only declared methods to an owner-only
API using the exact live instance/activation; no owner token or Host API enters
the frame. Requests and results stay within the 64 KiB bridge resource bound.
Instance commands do not grant model work or external effects; those still use
their existing authorization and Actions. The example uses button/keyboard
events because native form submission is deliberately absent from the sandbox.

`GET /api/plugins/presentation` is the authenticated startup inventory, separate
from the package/instance control view. A document URL reads only enabled static
package HTML, under a server CSP that denies network/subresource loads, nested
frames, forms and origin privileges. Assets must be inline (data images are
allowed). A declaration cannot supply an arbitrary remote React component.

Required local references must match checked sibling declarations; remote
service/package/contribution/host references need active exact typed providers.
The built-in `host: mote.web.presentation@1` fact identifies this compiled
contract. Missing, incompatible or ambiguous providers and unsupported
declarations block readiness. Normal restart restores selected providers first
and issues fresh activation identities. Disable, uninstall, dependency loss and
sign-out withdraw the Web scope and fence old documents and late replies. Page
navigation closes its channel without cancelling separately authorized server
work; stopping a plugin remains a distinct owner action.

Installing or upgrading a consumer does not scan history or grant model work. Versioned outputs, source scope, runtime removal and current installation identity control reuse and publication. Disabling presentation does not revoke or enable processing. A native application can keep internal workflows while connecting authorized Mote context, visible state and artifacts. See [material and consumer contracts](plugin-surfaces.md#material-and-processing-contracts), [materials](materials.md), [processing](processing.md) and [Memory](memory.md).

Use the smallest meaningful existing check under [testing](testing.md); the example commands above describe available fixtures, not a required contributor sequence or a claim of live-platform validation.
