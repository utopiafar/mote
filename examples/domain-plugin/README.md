# Mote domain-package template (new domain)

This is a minimal domain package for Mote: one `runtime: "service"` package
Manifest whose contributing entry runs the package's own domain under the
SDK `PluginHost` lifecycle, plus a connector adapter that deploys the same
domain on today's Central. See
[plugin-development](../../docs/plugin-development.md) for the three template
kinds and how to choose between them.

## What the package owns

| File | Responsibility |
| --- | --- |
| `mote-plugin.json` | The package Manifest: `runtime: "service"`, one data contribution that `provides` the typed service port `template.collection.log`, and one host-runtime custom-page contribution that requires it. |
| `port.mjs` | The typed port contract (`serviceContract`). Contributing entries provide it; consumers acquire it through the host lease. |
| `domain.mjs` | The domain itself: an append-only collection with durable `ctx.state` persistence, compare-and-set writes, bounded input and fail-closed normalization. Lifecycle-aware (`quiesce` refuses writes; `close` stops everything). |
| `plugin.mjs` | The SDK service-runtime entry. The factory constructs the service, `prepare` loads state, `start` provides the port, `quiesce`/`stop`/`dispose` drain it. The package never chooses its own package/installation/instance identity. |
| `source.mjs` | Ingress contribution: the real install path today (`plugin-dev dev` package install). Publishes owner routes under `/api/connectors/template-collection/` on the same injected `ctx.state`. |
| `seed.mjs` | Generated-seed hook for `plugin-dev dev --seed`; writes one generated item and prints JSON. |
| `web/index.html` | Custom page speaking the plugin-host page bridge (`state` and `add` methods). |
| `scripts/pack.mjs` | Builds the deterministic ZIP payload and completes the Manifest digest into `dist/`. |
| `test/` | Fixture `StateStore`, domain tests and a real-`PluginHost` lease test — run them with `npm test`. |

The domain never imports host internals — only `@mote/plugin-sdk` for the
port contract. Failures keep the dispatcher-mapped shape (`name`
`ConnectorError`, `code`, `statusCode`); the dynamic dispatcher preserves that
shape, and the seed's error branch asserts the real mapping rather than a
silent success.

## Create, build and verify

From a built Mote checkout, generate a project outside the repository and
install the packed SDK tarball:

```sh
node scripts/mote.mjs plugin-dev create ./my-domain-plugin --template domain --sdk-tarball /absolute/mote-plugin-sdk-0.1.0.tgz
cd my-domain-plugin
npm test                                  # domain + real PluginHost lease
MOTE_REPOSITORY=/absolute/mote npm run build   # dist/ artifact + completed Manifest
```

`npm run build` writes `dist/mote-plugin.json` (digest completed) and
`dist/template-collection-0.1.0.zip`. Generic `service` packages validate as
release artifacts; current Central releases admit `worker` packages, so the
package deployment surface for a new domain today is the connector adapter
— `source.mjs` is a deployment seam, not a second implementation of the
domain.

Run it on a real host from the Mote checkout:

```sh
node scripts/mote.mjs plugin-dev dev --plugin /absolute/my-domain-plugin --home /absolute/plugin-dev-home --once --seed
```

That creates a private plugin-dev profile, loads `source.mjs` through the
real connector registry, mounts the owner routes, runs `seed.mjs`, and stops.
The `ctx.state` binding persists across restarts, so a second run shows the
items the first run wrote.
