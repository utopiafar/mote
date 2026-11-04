# Plugin development

Mote plugins are developed outside the repository against the public
`@mote/plugin-sdk` contract. This page describes the three runnable SDK
templates, when to pick each, and how the generated projects build and run on
a real host. All templates use generated fixtures and private plugin-dev
profiles only — never vault scans, personal data, credentials or models.

The author-facing boundary is `@mote/plugin-sdk` alone: a plugin never
imports `apps/*`, `packages/*` internals or `@mote/shared`. The SDK tarball
bundles the public contracts and the host entry; `plugin-dev` verifies the
installed copy (`PLUGIN_CONTRACT_VERSION 1`, package version `0.1.0`) before
starting a dev profile. The in-repository example packages
(`examples/journal-plugin`, `examples/media-intake-plugin`,
`examples/text-normalization-plugin`) are a different deployment seam described
in [library-plugin-contracts](library-plugin-contracts.md); they are assembled
by the host and are not covered by these templates.

## Choosing a template

| Template | Directory | What it is | Deployment today |
| --- | --- | --- | --- |
| `connector` — ordinary integration | `examples/external-plugin` | A repository-external Source plugin package: declares source kinds, uses injected `ctx.state`, publishes owner-only routes. | `plugin-dev dev` package install |
| `worker` — deep runtime | `examples/worker-plugin` | A packaged `runtime: "worker"` plugin: `createMemoryProvider` ABI executed inside the dedicated plugin-worker process over JSON lines with per-call cancellation and drained shutdown. | Plugin-center release (`/api/plugins`) |
| `domain` — new domain | `examples/domain-plugin` | A packaged `runtime: "service"` domain: typed port (`serviceContract`), host-bound lifecycle (`prepare`/`start`/`quiesce`/`stop`/`dispose`), durable `ctx.state`, custom page — plus a connector adapter as the deployment seam. | `PluginHost`; `plugin-dev dev` via adapter |

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
project is self-contained and buildable without the monorepo.

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

- `connector` and `domain` (via their declared ingress contribution):
  `node scripts/mote.mjs plugin-dev dev --plugin /external/my-plugin --once --seed`.
  This creates a private plugin-dev-owned profile (ownership marker, native,
  loopback, non-prod, storage inside the private home), validates
  `mote-plugin.json`, installs the package into the private dev host, loads its
  ingress contribution through the real connector registry, mounts owner
  routes, runs the generated seed and stops. Reusing `--home`/`--profile`
  proves `ctx.state` persistence across restarts. Configuration never selects
  executable modules.
- `domain` additionally runs on the SDK host directly: the generated
  project's `npm test` installs the package on a real `PluginHost` (from
  `@mote/plugin-sdk/node`) and exercises the typed port through a lease.
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
  restarts and disable/re-enable; writes use `compareAndSet`.
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
node scripts/mote.mjs plugin-dev dev --plugin /tmp/gen-domain --home /tmp/dev-home-domain --once --seed
# worker: expand dist/*.zip to a private directory and run it under the real
# worker runtime; the repository test probes health/CRUD/scope/restart.
```

The `domain` seed itself checks one error branch (invalid input must fail
through the real mount with the domain's mapped error, never as a silent
success).

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

## G4 — independent author checklist

For manual verification by an author who did not participate in the
implementation, in an external directory, with no repository writes:

1. Pick a template (`connector`, `worker` or `domain`); a second author picks
   a different one.
2. `plugin-dev create --template <t> --sdk-tarball <packed-sdk>` into a new
   external directory.
3. Read the generated `README.md`; change one small behavior (route,
   configuration field or domain method).
4. `npm run build` (worker/domain need `MOTE_REPOSITORY` pointing at the
   checkout) and — for the domain template — `npm test`.
5. Run on the real host (`plugin-dev dev --once --seed` for connector and
   domain; plugin-center release install for worker) and observe the
   artifact serving the changed behavior.

Both authors succeeding without repository edits satisfies the unit's G4
check.
