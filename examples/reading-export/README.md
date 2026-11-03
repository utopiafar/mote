# Reading export example plugin

A repository-external second-level plugin. Its only external dependency is the
public reading review service port published by
[`examples/reading-review`](../reading-review): `example.reading-review.plan@1`.
It imports no reading review domain, source adapter, test fixture or Web page.
The main product tree has no reading-export branch, route, table or import.

The package copies the source plan view into an instance-scoped archive of
generic Markdown materials and publishes its own port,
`example.reading-export.materials@1`. It never schedules a review or recomputes
an interval.

## What the package owns

| File | Responsibility |
| --- | --- |
| `port.mjs` | The consumed public identity `example.reading-review.plan@1` and the package's own published port `example.reading-export.materials@1`. |
| `domain.mjs` | Copying the reading plan view into bounded generic materials, archive state, compare-and-set writes and source-loss status. |
| `plugin.mjs` | SDK host factory. It acquires the public plan port, publishes the export port and starts the background export loop. |
| `web/index.html` | Isolated Web custom page. It reads the archive and can request one explicit export. |
| `web/bridge.mjs` | Host-side invoker for the page's `materials`, `read` and `export-now` methods. |
| `mote-plugin.json` | Current package Manifest: one archive contribution, one independent page contribution and the exact plan-port dependency. |
| `archive/reading-export-1.0.0.zip` | Deterministic payload for release attachment. Regenerate with `npm run pack`. |

## Dependency and activation rules

The Manifest declares the exact install-time service dependency:

```text
example.reading-review.plan@1
```

`planComposition` rejects a missing provider with `missing_dependency` and a
provider that exposes another API version with `api_incompatible`; both
failures name the dependency identity. The runtime factory repeats the check
before tuning anything: a binding with another id or API version throws
`ReadingExportDependencyError` from `prepare`, so `start` never publishes the
export port or starts the background loop. The error message names the required
`example.reading-review.plan@1` and the offered binding.

The runtime lease is deliberately optional after activation. If the reading
review package is uninstalled, its UI is disabled or its authorization is
revoked, the host revokes the lease but leaves the archive consumer active.
Then:

- `list` and `read` continue to serve every already published material.
- `exportNow` fails with `reading_export_source_unavailable` and records a
  visible source status. It does not choose a local strategy, reuse a previous
  strategy for new calculations or infer a default.
- A later activation without the source binding starts archive-only, so the
  same materials remain readable. The source status is `unavailable`, never
  `ready`.

Disabling the page contribution only removes the Web surface. The archive
service and its periodic export loop belong to the data contribution and keep
running while that contribution is active. `createCustomPageSession().close()`
is the same boundary in tests: closing a page session does not quiesce the
service.

This example is not installed by `plugin-dev`: that development host loads
Central connector modules, while this package consumes an SDK service port. The
real activation path is the public SDK host used by the checks below.

## Published port

```js
const lease = await host.acquire(readingExportPort, binding);
await lease.value.list();       // metadata for published materials
await lease.value.read(id);     // one full generic Markdown material
await lease.value.exportNow();  // one explicit export attempt
lease.value.summary();          // source status and archive counts
```

`list`, `read` and `summary` never call the reading review port. Only
`exportNow` (and the background loop) reads it.

## Checks

```sh
cd examples/reading-export
npm test           # domain, archive, page bridge and host lifecycle contracts
npm run boundary   # [U] no domain in product sources; runtime imports only the SDK
npm run acceptance # [M] real SDK host, export, page close, source removal, restart
```

`npm test` exercises the real public `PluginHost` with the actual EXT01 package
as the provider. It covers a mismatched domain API version failing before
`start`, archive readability after provider removal, no local algorithm
fallback and a background export that continues after the page session closes.

`npm run acceptance` uses the real SDK host, generated private SQLite-free state
files and the actual EXT01 plugin. It exports one generated plan, closes the
page, confirms the background loop publishes another material, removes the
provider, reads the archive, restarts the host and reads the same material from
the same instance archive without a source binding.

The manual [J] custom-page scenario (open the page → export → hide/return) is a
stage-gate selection, not part of these ordinary checks.

## Packaging

```sh
npm run pack
```

This writes the current `mote-plugin.json` digest and
`archive/reading-export-1.0.0.zip`. The release artifact is external to the main
product tree.
