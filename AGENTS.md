# Mote

One instance, one owner: a personal context collector and central archive for that owner's devices, sources and Agent clients ([ADR](docs/adr-single-owner-mvp.md#decision)).

## Product invariants

- No accounts, tenants or account hosts.
- One current wire/storage format. Add migrations, old-format readers, dual writes or compatibility paths only when the user asks.
- Models interpret intent, tasks, topics and insights and choose retrieval tools; never replace them with keyword dispatch or handcrafted semantic heuristics. Deterministic code is right for privacy filters, authorization, transport, deduplication, retention and measured time accounting.
- Captured content is untrusted evidence. Query agents get read-only context tools; external effects require product authorization through Actions.
- Keep secrets and personal data out of Git. Listen on loopback by default; remote deployments need TLS and a strong token.
- Tests use generated data and private temporary profiles; real profiles, screenshots and devices are never fixtures.
- Dev keeps Mote-owned credentials in private profile files; Prod uses OS protection; third-party CLIs keep their own credential stores.

## Before editing

- Under `apps/<app>/`, read `apps/<app>/AGENTS.md` first: focused tests and platform limits.
- Setup and Dev/Test profiles: [development](docs/development.md).
- Shared or Agent libraries changed or missing: `npm run build:libs`.
- New `moteText` strings: add the key to all six `packages/shared/src/i18n-*.ts`, then run `node scripts/sync-i18n.mjs && npm run check:i18n`.
- Reuse existing UI terms, navigation and components.

## Verifying

- Run the narrowest check that exercises the change. Preview the light plan with `npm run check:affected -- --dry-run`.
- Rerun only checks invalidated by later edits. Ending a turn, a handoff or a Draft PR update is not a reason to run more.
- Heavy E2E, scale, benchmark and live-model checks run only when the user asks; otherwise list them as not run. Layers and triggers: [testing](docs/testing.md).
- Never weaken assertions, timeouts, input scale or entrypoints to get green; moving a failing test to a manual suite doesn't fix it. Tests named `performance` or `migration` can guard correctness; keep their coverage.
- Correctness first; optimize only measured, serious slowness.
- UI automation stays hidden: [background UI](docs/testing-runbook.md#background-testing).
- When fixing bugs, changing lifecycle behavior, or writing or reviewing tests, follow [regression test design](docs/testing.md#regression-test-design).

## Deciding and reporting

- Decide implementation details yourself.
- PR description: behavior changes; checks actually run, with reused results marked as reused; checks not run and untested risks; fixture, physical-device and live-model evidence kept separate. Add no other tracking files.
- Large or multi-module work: [coordination guide](docs/agent-development-workflow.md); wire one real end-to-end path first.
