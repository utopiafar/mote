# Mote domain-package template

This template contains a `runtime: "service"` data domain and a separate page
declaration. Its explicit `--data-only` build produces a pure data release for
the current Central host. Install that release through Plugin Center, configure
an instance, check it and explicitly enable it. Central runs `createPlugin`
under the existing `PluginHost` and publishes `template.collection.log` for
typed consumers. The collection persists in the host-injected `ctx.state`.

## Files and boundaries

| File | Responsibility |
| --- | --- |
| `mote-plugin.json` | Package authority: service-runtime data and its exact typed service/API, plus the separate page declaration. |
| `port.mjs` | Public `serviceContract` shared by producers and consumers. |
| `domain.mjs` | Bounded collection, durable compare-and-set writes and lifecycle cleanup. |
| `plugin.mjs` | Factory and matching data declaration; `prepare` loads state, `start` provides the port, later phases stop admissions and release resources. |
| `scripts/pack.mjs` | Deterministic release ZIP and completed Manifest digest; bundles the entry and public SDK so an installed profile needs no development dependencies. |
| `test/` | Generated StateStore and real SDK `PluginHost` lease fixtures. |
| `source.mjs`, `seed.mjs` | Optional owner-route adapter and generated seed for a development Manifest that explicitly selects ingress. |
| `web/index.html` | Presentation example retained in the default release; the explicit data-only release omits this contribution. |

Package code imports only `@mote/plugin-sdk`, never host internals or a raw
Store. Central supplies package/installation/instance/activation identity.
Disable keeps durable state; a later explicit enable or normal host restart
loads the same instance namespace under a fresh activation.

## Build and install

From a built Mote checkout, generate a project outside the repository and
install the packed SDK:

```sh
node scripts/mote.mjs plugin-dev create ./my-domain-plugin --template domain --sdk-tarball /absolute/mote-plugin-sdk-0.1.0.tgz
cd my-domain-plugin
npm test
MOTE_REPOSITORY=/absolute/mote npm run build
```

The build writes `dist/mote-plugin.json` and
`dist/template-collection-0.1.0.zip`. Attach both to the same fixed GitHub
release. Resolve and install that release through Plugin Center, create an
instance, check it and enable it. Installation does not create an instance or
authorize model work. The entry is self-contained ESM; the installer runs no
npm or shell lifecycle scripts.

The default build includes the isolated page and its declared `state/add`
bridge. After explicit enablement, the authenticated Web startup adds its page
to navigation under Settings. It reads and writes only this instance's typed
collection port; no owner token or Host API enters the sandbox. Stop/restart
fences old channels while retaining instance state. `npm run build -- --data-only`
is still available to build an explicit service-only artifact. See the
[installed Web contract](../../docs/plugin-development.md#installed-web-presentation)
for supported presentation entries, dependencies and lifecycle boundaries.

The current data entry exports `manifest` and
`createPlugin(context, {configuration, required, optional})`. Its declaration
must match the verified package's data contributions and cannot add ports,
capabilities or dependencies. Central resolves `required` and `optional` to
exact live `ServiceBinding` values. A consumer acquires its selected binding
with `context.services.acquire(collectionPort, binding)` and releases the
resulting lease with its scope. Multiple matching active providers produce an
explicit ambiguity; installation or catalog membership cannot satisfy a
required dependency, and checking never enables dependencies.

Check runs the lifecycle with guarded instance state and staged publication:
`prepare` can load state, `start` must supply every declared port, state writes
are refused and no live port remains. Enable publishes through the actual
host. Missing/extra ports, wrong APIs and lifecycle failures block readiness;
a partially started package releases its own ports. Provider withdrawal
invalidates required consumers and their old leases. Recovery needs an
explicit consumer retry after a dependency failure.

The optional `source.mjs` adapter still demonstrates owner-route error mapping
for connector development. Select its ingress contribution explicitly before
using `plugin-dev dev --once --seed`; the production data Manifest uses the
formal release path above. Page/theme/layout loading is documented separately
in [plugin development](../../docs/plugin-development.md).

Generated production coverage lives in
[the formal domain test](../../apps/server/test/plugin-production-domain.test.ts):
actual template build, release digest/install, typed consumer writes, restart,
missing/ambiguous dependencies, failed publication, withdrawal and late-write
fences. These fixtures use temporary profiles and generated content only.
