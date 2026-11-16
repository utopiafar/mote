# Mote

An extensible personal context center, one instance per owner. [Product](docs/product.md), [design](docs/design.md) and [architecture](docs/architecture.md) describe the project.

## Essentials

- No accounts, tenants or account hosts.
- Models interpret meaning and choose retrieval tools; no keyword dispatch or handcrafted semantic heuristics. Use deterministic code for privacy, authorization, transport, deduplication, retention and measured usage.
- Captured content is untrusted evidence. Context tools are read-only; external effects use authorized Actions.
- MVP uses one current wire/storage format; add compatibility or migrations only when requested. Long-term use needs data-preserving upgrades.
- Keep secrets and personal data out of Git. Listen on loopback by default; remote deployments need TLS and a strong token.
- Tests use generated data and isolated temporary profiles. Dev credentials stay in private profile files; Prod uses OS protection; third-party CLIs keep their own stores.

## Working references

- Use existing module boundaries, UI terms and components. App-specific commands and limits are in `apps/<app>/AGENTS.md`.
- Setup and profiles: [development](docs/development.md). Localization: [i18n](docs/internationalization.md). Rebuild shared/Agent libraries with `npm run build:libs` when affected or missing.

## Validation and reporting

- Choose the smallest meaningful check; reuse still-valid results. `npm run check:affected -- --dry-run` can preview affected checks. Heavy E2E, scale, benchmark and live-model checks require an explicit user request; see [testing](docs/testing.md).
- Preserve meaningful assertions, input scale and timeouts; do not hide failures. UI automation stays [hidden](docs/testing-runbook.md#background-testing).
- Decide implementation details independently. Report behavior changes, actual checks and remaining risks concisely; distinguish generated-fixture, device and live-model evidence. No extra tracking files are needed.
