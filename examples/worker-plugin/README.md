# Mote worker-runtime template (deep runtime)

This is a minimal `runtime: "worker"` package for the current Central plugin
center. `main.mjs` exports `createMemoryProvider(configuration)` and the host
runs it inside the dedicated plugin-worker process over JSON lines — deeper
isolation than a connector module, with per-call cancellation, drained
shutdown and capability verification. See
[plugin-development](../../docs/plugin-development.md) for the three template
kinds.

## What the package owns

| File | Responsibility |
| --- | --- |
| `main.mjs` | The worker ABI entry. It stays self-contained (Node builtins only) because the installed payload has no `node_modules`. Implements `health`, `put`, `read`, `remove`, `search`, `export` and `close`. |
| `mote-plugin.json` | The current package Manifest: `runtime: "worker"`, `entry`, one required `dataFile` configuration field and the `repository`/`retrieval` capability claims. Declarations are verified by the host, not trusted. |
| `scripts/pack.mjs` | Builds the deterministic ZIP payload and completes the Manifest digest into `dist/`. |
| `package.json` | Depends on `@mote/plugin-sdk` for the development-time Manifest schema used by the pack script. The provider entry itself imports no package. |

The provider stores immutable records in the instance-configured `dataFile`,
replays writes by exact `opId`, keys reads by the host-issued
`{ownerId, instanceId, bindingRevision}` namespace plus exact
`{memoryId, version, fingerprint}` key, and answers `search` with a literal
substring match on `memory.title`/`memory.statement`. That is a fixture-grade
retrieval proving the ABI — replace it with the provider's real index; never
present it as semantic search. Receipt digests follow the host contract:
`sha256(JSON.stringify({namespace, key, memory}))`.

## Create, build and verify

From a built Mote checkout, generate a project outside the repository and
install the packed SDK tarball:

```sh
node scripts/mote.mjs plugin-dev create ./my-memory-plugin --template worker --sdk-tarball /absolute/mote-plugin-sdk-0.1.0.tgz
cd my-memory-plugin
MOTE_REPOSITORY=/absolute/mote npm run build
```

`npm run build` writes `dist/mote-plugin.json` (digest completed) and
`dist/template-local-memory-0.1.0.zip`. `plugin-dev dev` does not apply to
worker packages — they install through the plugin center release path
(`GET/POST /api/plugins`), which resolves a pinned GitHub release, verifies
the archive digest, expands the payload, creates an instance with the
declared configuration fields and probes `health` before enabling.

A worker module runs with Central's process permissions. It is a lifecycle
boundary, never a security sandbox: keep the entry self-contained, treat
cancelled calls as possibly-submitted remote effects, and persist only in
instance-configured locations — never in the installed payload directory,
whose file list is integrity-checked.
