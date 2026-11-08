# Plugin surfaces

This page is the author reference for the complete public plugin surface:
16 contribution surfaces, 4 runtime locations and 6 extension methods. It
describes the current code in this repository, not a plan or a future version
promise. The canonical package descriptor is
[`PackageManifest`](../packages/plugin-api/src/manifest.ts); authors install
`@mote/plugin-sdk` and use `@mote/plugin-sdk/node` only for Node-only host
helpers.

A package authors one `mote-plugin.json`, and the host validates it with
`packageManifestSchema`. The package `runtime` and `entry` select the process
that starts the package; each contribution's `runtime` says where that
contribution actually executes. These are different facts. `trust` is a
declaration, not a permission, and declared capabilities/configuration are
verified by the host rather than trusted.

Every section below has the same five parts: what it does, manifest fields, a
minimal manifest example, lifecycle and common errors. A block marked
`json manifest-example` is a complete package manifest and is parsed by
`packageManifestSchema` in the contract test. Runnable packages live in
[`examples/`](../examples). Where an example package does not publish a
surface, its link points to the closest existing package showing the same
manifest and lifecycle mechanics.

## Platform support

The current `hostKinds` contract contains `central`, `web`, `mac`, `android`
and `ios`, but **iOS does not load plugins today**. The iOS client is
experimental at first release; this repository has no iOS plugin host, plugin
installation path or iOS runtime contribution. The presence of `ios` in the
host-kind union is not a promise that an iOS package can be installed.

`worker` and `service` contributions activate only on `central`; `host`
contributions activate on every host; `native` contributions activate only on
`mac` and `android` (`runtimeSupported` in
[`composition.ts`](../packages/plugin-host/src/composition.ts)).

## Contribution surfaces

`contributionSurfaces` is the closed set in
[`manifest.ts`](../packages/plugin-api/src/manifest.ts). A contribution
declares exactly one `surface`. The surface does not grant a capability: a
capability listed on a contribution must also appear in the package
`capabilities` list, or composition rejects the package with
`undeclared_capability`.

### Surface: `ingress`

**What it does.** Declares an entry point that brings external source data into
Central, normally a connector or an owner route that accepts pushed records.
The current connector host creates one scoped instance and asks the module to
initialize, report status, mount owner routes and close.

**Manifest fields.** `contributions[].surface: "ingress"`, `runtime` (normally
`service`, or `host` for a host-owned route), optional `entry`, optional
`requires`, optional `provides`, optional `capabilities`. An executable entry
must be a relative package path.

**Minimal example.** [examples/external-plugin](../examples/external-plugin/mote-plugin.json)
declares a service-runtime ingress contribution and its
[source module](../examples/external-plugin/source.mjs) shows the connector
shape.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.ingress","name":"Ingress example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.ingress","version":"1","surface":"ingress","runtime":"service","entry":"plugin.mjs"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The host creates the connector instance, calls `init`, mounts
owner routes through `configure`, and keeps sibling instances independent. An
accepted source operation drains before `close`; a failure is reported through
the instance state and does not become a silent success.

**Common errors.** Missing host-injected `ctx.state`, a duplicate source kind,
a capability descriptor conflict, a route registered outside the owner
dispatcher, or a connector that treats `close` as proof that a remote write was
rolled back.

### Surface: `upload`

**What it does.** Declares an owner upload or file-sync write contribution.
The host mounts the route through the feature or connector dispatcher and
attributes the HTTP `upload` capability to the declaring package.

**Manifest fields.** `contributions[].surface: "upload"`, `runtime: "host"`
for a host-owned upload route (or `service` when the package owns the route in
its process), optional `entry`, optional `requires`, optional `capabilities`.

**Minimal example.** The closest existing package is
[examples/media-intake-plugin](../examples/media-intake-plugin/mote-plugin.json),
which registers the file-format and processing steps used by intake.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.upload","name":"Upload example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.upload","version":"1","surface":"upload","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The route is mounted before the host listens and is removed with
its feature scope. Quiescing stops new admissions; an accepted upload keeps its
durable import job and acknowledgement identity. Disposal is idempotent.

**Common errors.** Mounting an upload route without collector authorization,
treating an upload acknowledgement as decoded content, or persisting into the
integrity-checked package payload instead of instance-configured storage.

### Surface: `data`

**What it does.** Declares read-only data access or a typed domain port. A
service-runtime contribution can publish a `serviceContract` that consumers
acquire through an exact binding; a host contribution can expose host-owned
read routes.

**Manifest fields.** `contributions[].surface: "data"`, `runtime` (`service` or
`host`), optional `entry`, optional `provides` (`kind`, `id`, `apiVersion`,
`cardinality`), optional `requires`, optional `capabilities`.

**Minimal example.** [examples/reading-export](../examples/reading-export/mote-plugin.json)
publishes a service-runtime data contribution and its
[plugin module](../examples/reading-export/plugin.mjs) provides the typed port.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.data","name":"Data example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.data","version":"1","surface":"data","runtime":"service","entry":"plugin.mjs",
   "provides":[{"kind":"service","id":"example.surface.data.reader","apiVersion":"1","cardinality":"single"}]}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The factory loads durable state during `prepare`, publishes the
port during `start`, and consumers hold a lease. `quiesce` stops new leases,
`stop` drains accepted fixed-version work, and `dispose` releases the port and
any store resources. A lease invalidates on revocation, not on ordinary
configuration refresh.

**Common errors.** Providing a service that the manifest never declared,
publishing an API version different from the contract, exposing the raw store
instead of the domain port, or ignoring `lease.assertCurrent()` at a sensitive
call.

### Surface: `command`

**What it does.** Declares a write command or an HTTP write route. The current
feature host classifies non-GET/HEAD HTTP routes as `command`; the route may be
an owner action, a settings write or a domain mutation.

**Manifest fields.** `contributions[].surface: "command"`, `runtime` (`host`
for a host-owned route or `service` when the package owns it), optional
`entry`, optional `requires`, optional `capabilities`. The domain still owns
the command ID, revision and authorization checks.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json); its
[source module](../examples/domain-plugin/source.mjs) publishes an owner POST
route on the same host dispatcher.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.command","name":"Command example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.command","version":"1","surface":"command","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The host mounts the command once and dispatches every request
against the live domain activation. Owner identity, expected revision and the
current commit fence are checked at call time. An unknown external result stays
unknown and is reconciled with the original operation identity.

**Common errors.** Treating a declared command as authorization, replaying a
write whose result is unknown, returning success when the domain rejected the
mutation, or changing the command meaning without changing its version.

### Surface: `agent`

**What it does.** Declares a read-only Agent capability or tool. The host
projects the contribution into the Agent feature inventory; query agents keep
read-only tools and never receive write authority from a plugin.

**Manifest fields.** `contributions[].surface: "agent"`, `runtime: "host"`
(current host-owned registration), optional `requires`, optional
`capabilities`. A tool's actual schema and result validation stay with the
owning domain.

**Minimal example.** The closest existing package is
[examples/reading-export](../examples/reading-export/mote-plugin.json), which
publishes a scoped read-only port consumed by other features.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.agent","name":"Agent example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.agent","version":"1","surface":"agent","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The tool is installed with its feature scope and removed with
it. An uninstalled feature is fenced before its results can be returned; late
results do not become current context. Registered metadata is not proof that a
resource or grant is open.

**Common errors.** Giving a query agent write tools, selecting tools by content
keywords, exposing an undeclared capability, or letting a removed feature
return a late result.

### Surface: `processing`

**What it does.** Declares a processing contribution: a context processor, a
file format/recipe/output step, a material consumer or a memory lifecycle
extension. Processors perform one bounded step; the host owns authorization,
inputs, limits, retries, cancellation and commit.

**Manifest fields.** `contributions[].surface: "processing"`, `runtime`
(normally `service`), `entry`, optional `requires`, optional `provides`,
optional `capabilities`. The contributor version participates in cache
identity.

**Minimal example.** [examples/text-normalization-plugin](../examples/text-normalization-plugin/mote-plugin.json)
declares one processing contribution and registers a deterministic
CRLF-to-LF processor through `ctx.effect`.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.processing","name":"Processing example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.processing","version":"1","surface":"processing","runtime":"service","entry":"plugin.mjs"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** Registration happens in the package scope and is disposed with
it. Accepted work keeps its exact processor version; uninstalling blocks
pending steps and fences in-flight results. Changing output semantics requires
a new version, while identical input and version reuse the completed result.

**Common errors.** Exceeding the host input/output bounds, using keywords to
choose a semantic lane, writing the database directly, ignoring the abort
signal, or changing output without bumping the version.

### Surface: `page`

**What it does.** Declares a host-rendered custom page. Central Web can mount
an isolated page or a trusted same-bundle page; a page contribution can also be
the navigation anchor for an instance.

**Manifest fields.** `contributions[].surface: "page"`, `runtime: "host"`,
optional `entry` (host/page contributions may omit it), optional `requires`,
optional `capabilities`. A custom page must not import repository internals.

**Minimal example.** [examples/reading-export](../examples/reading-export/mote-plugin.json)
declares a host page that requires the package's data contribution; the page
lives at [web/index.html](../examples/reading-export/web/index.html).

```json manifest-example
{"schemaVersion":1,"id":"example.surface.page","name":"Page example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.page","version":"1","surface":"page","runtime":"host","entry":"web/index.html"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The page is installed with its instance scope and public IDs are
qualified per instance, so two instances of one package can coexist. A failed
mount rolls back only that scope. Hiding a page aborts view-scoped reads and
polls; explicitly authorized durable work continues.

**Common errors.** Loading an external page without an explicit isolated
loader, importing `apps/*` or `@mote/shared` internals, colliding two instances
on one route, or treating page hide as cancellation of durable work.

### Surface: `collection`

**What it does.** Declares a collection or tab in a host navigation surface.
The Web host lists collections by `order`; a collection is a declarative host
entry, not a second package authority.

**Manifest fields.** `contributions[].surface: "collection"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`. The host
matches the declared contribution ID when a feature manifest supplies an exact
component list.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json), which
shows the same host contribution and instance-scoped state mechanics.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.collection","name":"Collection example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.collection","version":"1","surface":"collection","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The collection is registered with the host scope and sorted by
its declared order. Uninstall or rollback removes only that instance's entry.
If a required HTTP capability disappears, the collection becomes unavailable
and the host keeps its generic fallback.

**Common errors.** Reusing a collection ID across owners, relying on install
order instead of `order`, omitting a required contribution dependency, or
starting durable work from a collection that is merely hidden.

### Surface: `card`

**What it does.** Declares a card view for one material kind. Cards are matched
by exact `kind`, `schemaVersion` and `representation`, never by content
inspection; a missing card falls back to the generic reader.

**Manifest fields.** `contributions[].surface: "card"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`. The UI
descriptor carries the exact data schema reference.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json), which
shows the host contribution lifecycle used by UI packages.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.card","name":"Card example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.card","version":"1","surface":"card","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The card is registered with the host view registry and mounted
per matching value. A failed render is contained and the generic card/reader
remains usable. The view is torn down when the value or instance changes.

**Common errors.** Guessing a kind from text, rendering raw HTML or remote
code, using a schema version the host does not list, or keeping a stale card
after the instance is removed.

### Surface: `action`

**What it does.** Declares an action view for a card or detail position or a
declarative command entry. The host binds actions to the exact view identity
and the domain's allowed actions; the UI declaration is not an authorization
grant.

**Manifest fields.** `contributions[].surface: "action"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`. Commands are
declared explicitly with `{id, apiVersion}` in the UI descriptor.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json); its
source module shows an owner command that still checks domain authorization.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.action","name":"Action example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.action","version":"1","surface":"action","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The action is mounted with its view generation. Undeclared
commands return `undeclared`; a host failure returns `failed`; a late result
from an old generation returns `stale` and cannot write the current view. The
domain rechecks owner, revision and commit fence at execution.

**Common errors.** Treating a visible action as permission, dispatching an
undeclared command, replaying an unknown write, or applying a late result to a
new generation.

### Surface: `renderer`

**What it does.** Declares a detail renderer for one material kind. Renderers
are exact `kind + schemaVersion + representation` matches; the generic reader
remains the fallback when no renderer is available.

**Manifest fields.** `contributions[].surface: "renderer"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`. A renderer
must not execute captured text as instructions or load remote code.

**Minimal example.** The closest existing package is
[examples/reading-export](../examples/reading-export/mote-plugin.json), which
shows a host page and data contribution in one package.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.renderer","name":"Renderer example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.renderer","version":"1","surface":"renderer","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The renderer is registered with the view scope and mounted only
while its detail is visible. A render failure is contained to that view. On
hide, the view-scoped read is aborted; on removal, the registration is rolled
back.

**Common errors.** Rendering raw HTML from captured content, matching by a
prefix instead of exact schema identity, leaking a subscription after hide, or
assuming the renderer can mutate domain state directly.

### Surface: `panel`

**What it does.** Declares an additional panel on a detail surface. The host
matches a panel by exact value identity and an optional catalog allow-list;
panels do not become a second page or navigation authority.

**Manifest fields.** `contributions[].surface: "panel"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`.

**Minimal example.** The closest existing package is
[examples/reading-export](../examples/reading-export/mote-plugin.json), which
shows a host view contribution with an exact dependency on its data port.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.panel","name":"Panel example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.panel","version":"1","surface":"panel","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The panel is mounted with the detail, removed when the detail
closes, and never extends the lifetime of durable work. A failed panel does not
remove the detail or its other panels.

**Common errors.** Writing state from a panel without a declared command,
leaking a poll after the detail closes, or assuming a panel is visible on every
platform.

### Surface: `settings`

**What it does.** Declares a settings surface for a package instance. The
manifest `configuration` field remains the only configuration schema; the
settings view edits those declared values and does not invent a second config
authority.

**Manifest fields.** `contributions[].surface: "settings"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`, plus the
package-level `configuration` array. A configuration field is text, number,
boolean, select, model-profile or secret-reference; credentials remain in the
existing private credential store.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json), which
shows instance-scoped state without embedding credentials.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.settings","name":"Settings example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.settings","version":"1","surface":"settings","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** Saving configuration, checking an instance and enabling it are
separate steps. A saved value is not a verified capability, and an enabled
instance is not a model or historical-data authorization. Replacing
configuration drains pinned work according to the host lifecycle.

**Common errors.** Storing secrets in the manifest or form, treating a saved
endpoint as connected, enabling on an unknown capability, or changing the
meaning of an existing configuration field without a new field ID.

### Surface: `home`

**What it does.** Declares a home/Today entry for a host. Home entries are
ordered host contributions; they can surface an existing capability but do not
create a second capture or task authority.

**Manifest fields.** `contributions[].surface: "home"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json), which
shows an instance-scoped host contribution.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.home","name":"Home example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.home","version":"1","surface":"home","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The entry is registered with the home scope and sorted by its
declared order. Hiding or suspending the home surface aborts view-scoped reads
but does not stop independent capture or upload work.

**Common errors.** Starting capture from a home card, assuming a fixed order
across packages, keeping a poll alive after hide, or relying on home presence
as proof that a feature is enabled.

### Surface: `theme`

**What it does.** Declares a theme presentation pack. A theme is data: an exact
identity, version and complete role map consumed by the presentation host. It
is not a stylesheet, script or a second UI authority.

**Manifest fields.** `contributions[].surface: "theme"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`. The theme pack
itself is registered through `registerTheme` and validated as data.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json), which
shows a host contribution and its lifecycle; theme packs are not currently
published by an example package.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.theme","name":"Theme example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.theme","version":"1","surface":"theme","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The pack is registered with the shared presentation host.
Activation validates the exact theme identity and version; removing the active
provider selects the pinned built-in theme and reports the reason. Theme
changes do not resubmit work or change data, authorization or navigation state.

**Common errors.** Shipping CSS or JavaScript in a theme, changing command or
authorization meaning, assuming installation selects the theme, or treating a
theme label as a translated route ID.

### Surface: `layout`

**What it does.** Declares a layout presentation pack: the four primary
destinations, initial destination, navigation geometry and detail preference.
A platform's trusted build supplies the local renderer; the pack itself is
data.

**Manifest fields.** `contributions[].surface: "layout"`, `runtime: "host"`,
optional `entry`, optional `requires`, optional `capabilities`. The layout is
registered through `registerLayout` with an exact identity and version.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json), which
shows a host contribution; layout packs are currently part of the trusted
platform build rather than an example package.

```json manifest-example
{"schemaVersion":1,"id":"example.surface.layout","name":"Layout example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.surface.layout","version":"1","surface":"layout","runtime":"host"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The layout is registered with the shared presentation host and
activated only with an exact version. Removing the active provider restores
the pinned built-in layout and reports the reason. Open editors, drafts, focus
and selection survive a presentation replacement.

**Common errors.** Treating a layout as an arbitrary UI language, hot-loading
native renderer code, changing destination authority from a layout, or
assuming a layout change cancels in-flight work.

## Runtime locations

`runtimeLocations` is the closed set in
[`manifest.ts`](../packages/plugin-api/src/manifest.ts). It is separate from
`hostKinds`: a host is the client/process that activates a contribution, and a
runtime location says where the contribution actually executes.

### Runtime: `worker`

**What it does.** Runs an executable contribution in the dedicated plugin
worker process. The current generic worker ABI is the memory-provider entry:
the host calls `createMemoryProvider(configuration)` and then dispatches
health, put, read, remove, search and export over JSON lines with a per-call
abort signal.

**Manifest fields.** Package `runtime: "worker"` and `entry` (for example
`main.mjs`); a worker package may declare no contributions. The installed
payload is self-contained and must not expect `node_modules`.

**Minimal example.** [examples/worker-plugin](../examples/worker-plugin/mote-plugin.json)
is a worker-runtime package whose [main.mjs](../examples/worker-plugin/main.mjs)
implements the memory-provider ABI.

```json manifest-example
{"schemaVersion":1,"id":"example.runtime.worker","name":"Worker runtime example","version":"0.1.0","runtime":"worker","entry":"main.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "capabilities":["repository","retrieval"],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The host spawns the worker, supports cancellation of a single
initializing or running call, and drains accepted calls on close. A cancelled
call may already have submitted a remote effect; cancellation is not a
rollback. Persistence belongs in an instance-configured location, never in the
integrity-checked payload directory.

**Common errors.** Shipping `node_modules`, writing inside the payload,
treating close as remote rollback, returning a non-scoped result, or claiming
semantic search when the provider only returns the scoped set.

### Runtime: `service`

**What it does.** Runs a contribution in the host's service process through
the `PluginHost` lifecycle. This is the current location for connector,
domain-port, processing and most Central-side packages.

**Manifest fields.** Package `runtime: "service"` and `entry`; each executable
contribution declares `runtime: "service"` and its own `entry`. The package
entry can expose `createPlugin` or the connector factory expected by its host
adapter.

**Minimal example.** [examples/domain-plugin](../examples/domain-plugin/mote-plugin.json)
is a service-runtime domain package; its
[plugin module](../examples/domain-plugin/plugin.mjs) provides a typed port.

```json manifest-example
{"schemaVersion":1,"id":"example.runtime.service","name":"Service runtime example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.runtime.service","version":"1","surface":"data","runtime":"service","entry":"plugin.mjs",
   "provides":[{"kind":"service","id":"example.runtime.service.port","apiVersion":"1","cardinality":"single"}]}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The factory constructs domain objects only inside the host
scope. `prepare` acquires resources, `start` publishes ports, `quiesce` stops
new work, `stop` cancels/drains, and `dispose` releases resources and remains
idempotent. Contributions are staged until `start` succeeds.

**Common errors.** Creating resources before the factory, publishing a port in
`prepare`, closing a shared service twice, ignoring a required binding, or
treating a dependency-unavailable projection as a real stop.

### Runtime: `host`

**What it does.** Runs a contribution in the activating client or host process.
Host contributions are used for pages, collections, cards, panels, settings,
home, theme, layout, host-owned routes and Agent registration. The package
entry itself still runs in its declared `worker` or `service` runtime.

**Manifest fields.** A contribution with `runtime: "host"`; `entry` may be
omitted for host/page contributions. The package-level `runtime` remains
`worker` or `service` and `entry` remains required.

**Minimal example.** [examples/reading-export](../examples/reading-export/mote-plugin.json)
declares a host page contribution alongside its service-runtime data
contribution.

```json manifest-example
{"schemaVersion":1,"id":"example.runtime.host","name":"Host runtime example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.runtime.host","version":"1","surface":"page","runtime":"host","entry":"web/index.html"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The host projects the contribution from the package manifest
and UI descriptor, mounts it within a scoped registry, and rolls back only that
scope on failure. View hide aborts view-scoped reads; durable host work keeps
its own authorization.

**Common errors.** Assuming a host contribution can import Node internals,
forgetting that the package still needs a `worker`/`service` entry, treating a
host route as owner-authenticated by default, or loading arbitrary external
code without an isolated loader.

### Runtime: `native`

**What it does.** Declares a contribution implemented by native code shipped
with the Mac or Android build. The code is not downloaded at runtime; the
manifest describes the contribution and the host matches it to an installed
native provider.

**Manifest fields.** A contribution with `runtime: "native"`; `entry` is
usually omitted because native code is part of the build. The package-level
`runtime` remains `worker` or `service`. Native requirements use exact
`capability + apiVersion + platform` identities and declare a fallback.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json); no
example package currently declares a `native` contribution.

```json manifest-example
{"schemaVersion":1,"id":"example.runtime.native","name":"Native runtime example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.runtime.native","version":"1","surface":"action","runtime":"native"}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The native provider is registered by the client build, and the
host matches it before activating the contribution. A required provider that is
absent reports `requires-build`; a platform mismatch reports `unsupported`; an
optional requirement does not block other platforms. Native UI/OS lifecycle
remains owned by the client.

**Common errors.** Promising hot installation of native code, matching only a
capability name without version and platform, treating an OS grant as a
capability, or assuming a native contribution activates on `web` or `central`.

## Extension methods

These are the six public methods of `ExtensionHost` in
[`packages/plugin-host/src/extensions.ts`](../packages/plugin-host/src/extensions.ts).
All values remain in Cordis; the extension host owns metadata, binding and
selection only. A selection is not an authorization grant: the domain must
still recheck its own grants and commit fences.

### Extension: `define`

**What it does.** Defines an extension point and publishes its definition
metadata. `define({contract, contributionId, ...})` installs a host plugin that
provides `mote.extension.definition/<service.id>` and returns
`{point, handle}`. The point carries the contract and the exact definition
binding.

**Manifest fields.** `contributions[].provides` with `kind: "service"`,
`id: "mote.extension.definition/<contract id>"`, the contract `apiVersion` and
`cardinality: "single"`. The actual package `entry` runs in its declared
runtime.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json); its
[port module](../examples/domain-plugin/port.mjs) defines a typed service
contract, the same contract style used by an extension point.

```json manifest-example
{"schemaVersion":1,"id":"example.extension.define","name":"Extension define example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.extension.define","version":"1","surface":"data","runtime":"service","entry":"plugin.mjs",
   "provides":[{"kind":"service","id":"mote.extension.definition/example.reader","apiVersion":"1","cardinality":"single"}]}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The host installs the definition provider; the definition port
is available after `start`. Closing the returned handle removes the point and
its required graph. Sibling points and consumers are not closed.

**Common errors.** Defining two points with the same service identity,
publishing a definition whose kind/service does not match the contract, or
assuming a point survives its owner's unload.

### Extension: `provide`

**What it does.** Publishes an implementation to an existing point.
`provide(point, {contributionId, publication, factory})` acquires the
definition port, checks the publication shape for the point's cardinality, and
returns `{member, handle}`. The publication is `{}` for `single`,
`{name}` for `collection`, and `{name, order}` for `ordered`.

**Manifest fields.** `contributions[].provides` with the extension kind and
cardinality: `service`/`single`, `collection`/`collection`, or
`chain`/`ordered`. The service ID and API version must match the point's
contract.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json), whose
[plugin module](../examples/domain-plugin/plugin.mjs) publishes a typed port
during `start`.

```json manifest-example
{"schemaVersion":1,"id":"example.extension.provide","name":"Extension provide example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.extension.provide","version":"1","surface":"data","runtime":"service","entry":"plugin.mjs",
   "provides":[{"kind":"service","id":"example.reader","apiVersion":"1","cardinality":"single"}]}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The host acquires the definition lease first, then publishes the
member during the adopted `prepare` phase. The member becomes active after
`start`; `quiesce`/`stop`/`dispose` follow the provider lifecycle. A failed
publication removes the member and releases the definition lease.

**Common errors.** Wrong publication shape for the cardinality, a duplicate
member name in one namespace, publishing before the factory returns a value,
or assuming a member selection creates a domain grant.

### Extension: `members`

**What it does.** Returns the currently active member metadata for a point.
`members(point)` is a read-only projection sorted by binding identity; it does
not acquire a lease, start work or select a provider.

**Manifest fields.** No extra package field. The point's provider declarations
use `contributions[].provides`; consumers describe their requirements with
`requires`.

**Minimal example.** The closest existing package is
[examples/domain-plugin](../examples/domain-plugin/mote-plugin.json), which
shows a package providing one typed service; a collection point lists the same
membership metadata for named providers.

```json manifest-example
{"schemaVersion":1,"id":"example.extension.members","name":"Extension members example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.extension.members","version":"1","surface":"data","runtime":"service","entry":"plugin.mjs",
   "provides":[{"kind":"collection","id":"example.readers","apiVersion":"1","cardinality":"collection"}]}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The projection follows member activation and revocation.
Unloading the point makes `members` throw `unknown_member`; a revoked member
disappears from the list. Metadata never proves that a lease is currently
available.

**Common errors.** Using the member list as permission to call a provider,
caching it after a revocation, or treating names as global rather than local to
the provider contribution identity.

### Extension: `single`

**What it does.** Consumes one explicitly selected member of a single-valued
point. `single(point, binding, options)` requires the exact binding even when
the point has only one member; it returns a lease to the consumer factory.

**Manifest fields.** A `requires` dependency with `kind: "service"`, the exact
service `id` and `version` (the API version). The provider contribution
declares `provides` with `kind: "service"` and `cardinality: "single"`.

**Minimal example.** [examples/reading-export](../examples/reading-export/mote-plugin.json)
requires the reading-plan service and acquires its exact lease in the
[plugin module](../examples/reading-export/plugin.mjs).

```json manifest-example
{"schemaVersion":1,"id":"example.extension.single","name":"Extension single example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.extension.single","version":"1","surface":"data","runtime":"service","entry":"plugin.mjs",
   "requires":[{"kind":"service","id":"example.reader","version":"1"}]}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The consumer install acquires the definition and selected
member leases, passes the lease to the factory, and releases it on stop or
scope revocation. A missing binding fails with `binding_required`; more than
one unbound member fails with `ambiguous_binding`.

**Common errors.** Letting installation order choose a provider, ignoring
`unknown_member` after a provider restart, using a lease after revocation, or
replacing the exact binding with a global service lookup.

### Extension: `collection`

**What it does.** Consumes all explicitly selected named members of a
collection point. `collection(point, bindings, options)` validates and sorts
the selection, acquires one lease per member, and passes the lease list to the
consumer factory.

**Manifest fields.** A `requires` dependency with `kind: "service"`, exact
service `id` and `version`. The provider uses `provides` with
`kind: "collection"` and `cardinality: "collection"`.

**Minimal example.** The closest existing package is
[examples/reading-export](../examples/reading-export/mote-plugin.json), which
shows exact service acquisition and lease cleanup; a collection consumer uses
the same contract with multiple bindings.

```json manifest-example
{"schemaVersion":1,"id":"example.extension.collection","name":"Extension collection example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.extension.collection","version":"1","surface":"data","runtime":"service","entry":"plugin.mjs",
   "requires":[{"kind":"service","id":"example.readers","version":"1"}]}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The selected member leases are acquired before the factory
runs. Duplicate bindings fail with `invalid_selection`; a stale member fails
with `unknown_member`. Closing the consumer releases its leases without
closing sibling consumers or providers.

**Common errors.** Passing an unselected or duplicate binding, assuming
`single` can consume a collection point, sorting by install order, or letting
one closed consumer release another consumer's lease.

### Extension: `chain`

**What it does.** Consumes an ordered chain of selected members.
`chain(point, bindings, options)` sorts by the published finite `order`, then
by binding identity for ties, and passes the ordered lease list to the consumer
factory. Installation and input order never decide priority.

**Manifest fields.** A `requires` dependency with `kind: "service"`, exact
service `id` and `version`. The provider uses `provides` with `kind: "chain"`
and `cardinality: "ordered"`. The actual `order` is supplied when publishing
the member, not in the manifest.

**Minimal example.** The closest existing package is
[examples/journal-plugin](../examples/journal-plugin/mote-plugin.json), which
shows a bounded processing chain with deterministic steps; an extension chain
uses the same explicit ordering discipline.

```json manifest-example
{"schemaVersion":1,"id":"example.extension.chain","name":"Extension chain example","version":"0.1.0","runtime":"service","entry":"plugin.mjs",
 "archive":{"asset":"example.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"},
 "contributions":[{"id":"example.extension.chain","version":"1","surface":"data","runtime":"service","entry":"plugin.mjs",
   "requires":[{"kind":"service","id":"example.transformers","version":"1"}]}],
 "capabilities":[],"configuration":[],"dependencies":[],"access":[]}
```

**Lifecycle.** The chain acquires the definition and selected member leases,
sorts the active members, then runs the consumer factory. A provider whose
`order` is not a safe integer is rejected as `invalid_selection`; a provider
that unloads is removed from future selections but accepted work drains under
its own fence.

**Common errors.** Using install order as priority, omitting a finite `order`,
duplicating a chain step, assuming ties fall back to input order, or treating
chain position as an authorization scope.
