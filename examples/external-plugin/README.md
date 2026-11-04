# Mote external source template (ordinary integration)

This is a minimal repository-external Source plugin package — the ordinary
integration template described in
[plugin-development](../../docs/plugin-development.md). It imports only the public
`@mote/plugin-sdk` package, declares one namespaced external-push source kind, and
registers one owner-only status route through the existing connector host. It does
not scan a vault, read credentials or call a model.

The host injects a bound `ctx.state`; the plugin keeps a generated launch counter
there and never passes a package, installation or instance identity. The counter
survives profile restart and disabling the connector.

## What the package owns

| File | Responsibility |
| --- | --- |
| `mote-plugin.json` | The package Manifest: `runtime: "service"`, one ingress contribution and its declared capability. |
| `plugin.mjs` | The package entry. It exposes the connector manifest as both `connector` and `default`. |
| `source.mjs` | The connector manifest itself, also usable as a direct adapter by a connector host. |
| `seed.mjs` | Generated-seed hook for `plugin-dev dev --seed`; writes one generated source and item through owner ingress. |
| `scripts/pack.mjs` | Builds the deterministic ZIP payload and completes the Manifest digest into `dist/`. |
| `package.json` | Depends on `@mote/plugin-sdk` for the package Manifest schema used by the pack script. |

## Create and run

From a built Mote checkout, create an external project and install the packed SDK
tarball produced by H07:

```sh
node scripts/mote.mjs plugin-dev create ./my-source-plugin --sdk-tarball /absolute/mote-plugin-sdk-0.1.0.tgz
MOTE_REPOSITORY=/absolute/mote npm run build --prefix ./my-source-plugin
node scripts/mote.mjs plugin-dev dev --plugin ./my-source-plugin --once --seed
```

`plugin-dev dev` creates an isolated private profile under the system temporary
directory, chooses a free loopback port, validates `mote-plugin.json`, loads the
declared ingress entry through the real Central connector host, waits for
`/api/status`, and stops it again for `--once`. `--seed` uses the existing owner
source/ingress routes to create one generated source and one generated item; no
vault, model, credential or user profile is touched. Without `--once` it stays in
the foreground until Ctrl+C. Reusing `--home <private-directory> --profile <name>`
starts and stops the same profile without leaving a process or port behind. A
profile is reused only when it was created by `plugin-dev` (ownership marker) and
remains native/loopback/private; ordinary profiles are rejected without
modification. `plugin-dev stop` requires the private `--home` printed by `dev`.

Only `--host central` is supported by this template. Other client hosts build
their own native UI/device providers and are rejected with a concrete error.

This template proves package loading, lifecycle and the controlled owner ingress
boundary. A complete external source processing chain (C09/C10B), processor
migration, installation UI and UI contributions are separate tasks; no Material
or full G1 chain is claimed.

## Missing SDK

The template's `package.json` depends on `@mote/plugin-sdk`. Install the packed
SDK tarball; if the dependency is missing, `plugin-dev dev` reports the exact
missing package instead of silently importing a monorepo alias.
