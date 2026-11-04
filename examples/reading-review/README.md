# Reading review example plugin

A repository-external domain package built only on the public
`@mote/plugin-sdk`. The domain is deliberately absent from the main product
source: `apps/*/src`, `packages/*/src`, `scripts`, `protocol` and `plugins` have
no reading-review branch, route, table or import. Copy this directory outside a
Mote checkout, install the packed SDK tarball, and it still has one place for
its plan and UI.

## What the package owns

| File | Responsibility |
| --- | --- |
| `domain.mjs` | Strategy selection, card/review state machine, bounded history and compare-and-set writes through the injected `StateStore`. |
| `port.mjs` | The package's own service contract: `example.reading-review.plan@1`. |
| `plugin.mjs` | SDK host factory. It publishes the port from `ctx.state`, and implements `prepare → start → quiesce → stop → dispose`. |
| `source.mjs` | Ingress contribution for the current Central connector host (`plugin-dev` package install). It exposes owner-only routes from the same service. |
| `web/index.html` | Isolated Web custom page. It receives only a `MessagePort`, a nonce, a document key, an instance ID and a generation. |
| `web/bridge.mjs` | Host-side invoker the host passes to `customPageContributions`; it maps the page's three declared methods to the domain service. |
| `mote-plugin.json` | Current package Manifest: one `data` contribution providing the domain port and one `page` contribution running `web/index.html`. |
| `archive/reading-review-1.0.0.zip` | Deterministic payload for release attachment. Regenerate with `npm run pack`. |

The plan is one instance-scoped record in `ctx.state` (`review-plan`). It contains
the selected strategy, cards and at most 40 review rounds. The plugin never
passes a package, installation or instance ID to the state API, and it never
uses a private database, profile path or token.

## Strategies

- `spaced` — first successful interval 3 days, then grows by rating.
- `daily` — successful reviews stay on a one-day cadence.
- `intensive` — weak cards repeat the same day, successful intervals grow slowly.

A review round before strategy selection is rejected with
`reading_review_strategy_required`; the selection is not inferred from the
first rating.

## Run on a clean instance

From a built Mote checkout:

```sh
node scripts/mote.mjs plugin-dev dev \
  --plugin examples/reading-review \
  --home /private/tmp/mote-reading-review-dev \
  --profile reading-review --seed
```

`plugin-dev` creates a generated private profile, chooses a free loopback port,
loads `source.mjs` through the real connector registry, and passes the owner
URL/token to `seed.mjs`. The seed creates one generated card, selects `spaced`
when no strategy exists and reviews one round. The plan survives stopping and
starting the same private profile.

The package also exposes owner-only routes while it is loaded:

```text
GET  /api/connectors/reading-review/state
PUT  /api/connectors/reading-review/strategy   {"strategy":"spaced"}
POST /api/connectors/reading-review/cards      {"prompt":"...","answer":"..."}
POST /api/connectors/reading-review/round      {"cardId":"...","rating":"good"}
```

`GET /api/connectors/status` includes the package's `reading-review` summary.

## Checks

```sh
cd examples/reading-review
npm test          # domain, host port and state-restart contracts
npm run boundary  # [U] no domain name in main product sources
npm run acceptance # [M] real entrypoint, clean profile, restart, state retained
```

`npm run acceptance` starts the actual `apps/server/src/index.ts` entrypoint
with a generated YAML profile and a temporary SQLite vault. It installs this
package through the private plugin-dev host, selects `spaced`, reviews one generated
card, stops, restarts the same profile and verifies the strategy, card, review
round, due time and state revision. No model or personal data is used.

## Web custom page

The Manifest page contribution points at `web/index.html`. A host that projects
the Manifest custom page supplies:

```js
import {createCustomPageInvoker, customPageMethods} from './web/bridge.mjs';
const invoke = createCustomPageInvoker(service);
// customPageDeclarations(manifest, {resolveEntry, declared: () => customPageMethods, invoke})
```

The page's declared bridge methods are `state`, `select-strategy` and `review`.
It renders with `textContent`, never injects captured text as HTML, and disables
writes when the host bridge is absent. The host owns the iframe, nonce,
document key, generation and MessagePort; the package cannot read the owner
token or another instance's plan.

The manual [J] G4/J11 scenario (install → open the custom page → choose a
strategy → review a round → hide/return) is a stage-gate selection, not part of
the ordinary checks above.

## Packaging

```sh
npm run pack
```

This writes the current `mote-plugin.json` digest and
`archive/reading-review-1.0.0.zip`. The release artifact is external to the
main product tree; the main repository never loads this package by a hard-coded
path or adds a domain-specific distribution entry.
