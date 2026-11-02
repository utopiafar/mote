# Mote external source template

This is a minimal repository-external Source connector. It imports only the public
`@mote/plugin-sdk` package, declares one namespaced external-push source kind, and
registers one owner-only status route through the existing connector host. It does
not scan a vault, read credentials or call a model.

## Create and run

From a built Mote checkout, create an external project and install the packed SDK
tarball produced by H07:

```sh
node scripts/mote.mjs plugin-dev create ./my-source-plugin --sdk-tarball /absolute/mote-plugin-sdk-0.1.0.tgz
node scripts/mote.mjs plugin-dev dev --plugin ./my-source-plugin --once --seed
```

`plugin-dev dev` creates an isolated private profile under the system temporary
directory, chooses a free loopback port, loads `source.mjs` through the real
Central connector registry, waits for `/api/status`, and stops it again for
`--once`. `--seed` uses the existing owner source/ingress routes to create one
generated source and one generated item; no vault, model, credential or user
profile is touched. Without `--once` it stays in the foreground until Ctrl+C.
Reusing `--home <private-directory> --profile <name>` starts and stops the same
profile without leaving a process or port behind.

Only `--host central` is supported by this template. Other client hosts build
their own native UI/device providers and are rejected with a concrete error.

This template proves host loading, lifecycle and the controlled owner ingress
boundary. A complete external source processing chain (C09/C10B), processor
migration, installation UI and UI contributions are separate tasks; no
Material or full G1 chain is claimed.

## Missing SDK

The template's `package.json` depends on `@mote/plugin-sdk`. Install the packed
SDK tarball; if the dependency is missing, `plugin-dev dev` reports the exact
missing package instead of silently importing a monorepo alias.
