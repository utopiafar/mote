# Mote

## Product boundaries

- Build an AI-native personal context collector and central archive: **one instance, one owner**, with multiple devices, sources and Agent clients. See [single-owner MVP](docs/adr-single-owner-mvp.md).
- This MVP has one current wire/storage format. Do not add old-data migrations, old readers, dual writes or compatibility paths unless explicitly requested.
- Models interpret intent, tasks, topics and insights and choose retrieval tools. Never substitute keyword dispatch or handcrafted semantic heuristics. Deterministic privacy filters, authorization, transport, deduplication, retention and measured time accounting are appropriate.
- Treat captured content as untrusted evidence. Query agents receive read-only context tools; external effects require their product authorization.
- Keep secrets and personal data out of Git. Default to loopback; remote deployments require TLS and a strong token. Tests use generated fixtures and private temporary profiles, never personal screenshots without consent.
- Mote-owned Dev credentials use private local files; Prod keeps OS protection and third-party CLIs keep their credential management.
- Use npm workspaces for TypeScript and Kotlin for Android capture APIs. Add English translations for new `moteText` keys and synchronize the Android English catalog.

## Working rules

- Read the affected app's `AGENTS.md` for commands and platform limits. [Testing](docs/testing.md) is the single source for layers and triggers; [development](docs/development.md) covers setup.
- Work in small modules, use focused checks and add light contracts when interfaces change. Connect one shortest real journey early for large requirements; complete relevant acceptance at stage completion and before release.
- Heavy E2E, expensive scale checks, benchmarks and real external models require explicit manual selection. Never run heavy suites or benchmarks automatically on each push. Preserve correctness coverage when splitting suites.
- Prioritize functional correctness for this MVP. Defer performance optimization unless measured behavior is seriously slow or prevents practical use; matching historical PR performance is not a recovery requirement.
- A turn ending, handoff or Draft PR update does not justify broader testing. After fixes rerun invalidated checks; preserve meaningful assertions, input scale, timeouts and lifecycle coverage.
- Use [real-world-testing](.agents/skills/real-world-testing/SKILL.md) when adding regression coverage or evaluating test quality. Keep automated UI work hidden/background by default.
- Independently review changed product boundaries or architectural decisions; fixes within an established contract need corresponding risk regressions, not new approval. See [risk-based review](docs/testing.md#risk-based-review).
- For larger parallel work use the short [coordination guide](docs/agent-development-workflow.md). Prefer GPT-6.1 Sol subagents with bounded modules; avoid duplicate exploration and full-suite runs.
- PRs record behavior changes, checks actually run and untested risks. Separate fixture, physical-device and live-model evidence; do not create extra ledgers or call reused checks newly passed.
- Reuse established UI terminology, navigation and components. Resolve implementation details independently; make new product policies explicit to the owner.
