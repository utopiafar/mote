# Development

**English** · [简体中文](development.zh-CN.md)

Choose an entry point for the module being changed. [Architecture](architecture.md) maps the code; app AGENTS contain short platform constraints and focused commands.

## Choose a contribution path

| Goal | Preparation and entry point |
| --- | --- |
| Central / Web | Node.js 24 and npm; use the steps below for Central and Web hot reload. |
| Collectors | Prepare only the selected platform's native tooling and an isolated development app. Platform commands and limits: [Mac](../apps/desktop/AGENTS.md), [Android](../apps/android/AGENTS.md). |
| Plugins and source integrations | Use the existing SDK and examples through [plugin development](plugin-development.md). Enter a collector path when the extension needs native capabilities. |

## Start Central / Web locally

Use Node.js 24 and npm. From the repository root:

```sh
npm ci
node scripts/mote.mjs init --profile dev
npm run dev
```

`npm run dev` builds shared libraries, then starts Central and Web hot reload. Central uses port 47842 and Web 5173 by default. Stop an existing background dev Central before starting this path. Repeated init refuses to overwrite an existing profile.

Initialization selects no usable model and inherits no model key. Configure a model explicitly when AI is needed. Collection, browsing and ordinary interface development can start without a real model. Tunnel, Android SDK and Mac collection permissions are not default prerequisites.

With Central built and a named Tunnel configured, `npm run up` runs Central and the tunnel; it does not build, start capture or create domain routes. Use `npm run desktop:dev` for the isolated Mac development app; see the [Mac guide](desktop.md) for build and permission requirements.

## Environments and material

Keep dev, test and prod configuration, tokens, databases and app profiles separate. Test Central defaults to 47852; prod defaults to 47832. CLI `--home /absolute/private/profiles` selects a separate isolated home. Use generated material and private temporary profiles for tests, excluding production archives, actual screen content and everyday devices from automated fixtures.

Keep private configuration and credentials out of Git. Development stores Mote credentials in private profiles; production uses OS protection; third-party CLIs own their credential stores. Cross-device deployment uses HTTPS and a strong token.

## Format and upgrade stages

The current MVP maintains one wire and storage format, without migrations, old-format readers or dual writes unless explicitly requested. Reject incompatible input while retaining the old data; do not reset it automatically. Future long-term use needs data-preserving upgrades. The MVP exception is not a permanent product promise.

## Changes and collaboration

- Decide implementation details. Reuse existing terms, components, the SDK and task infrastructure, evolving interfaces and implementation as actual needs require.
- Run `npm run build:libs` for changed or missing shared/Agent outputs. Serialize shared builds across collaborators.
- For new `moteText` source strings, update all six target-language catalogs, then run `node scripts/sync-i18n.mjs` and `npm run check:i18n`.
- Connect the shortest real path early in multi-module work, using the actual entrypoint and producer/consumer. Delegate independent modules without parallel duplicate implementations.
- Update current documentation and both core-document languages with changes to behavior, interfaces, development commands or effective constraints. Internal refactoring does not require artificial documentation tasks.

## Verification and delivery

Decide implementation and delivery within existing authorization, without a prescribed sequence of task stages.

Select the smallest effective checks under Testing. PRs describe behavior, checks run or reused, and unverified scope. Keep full logs in CI or ignored files. Do not create a report, acceptance ledger or duplicate guide for each task.

References: [Testing](testing.md), [CI](ci.md), [background UI and emulators](testing-runbook.md), [plugins](plugin-development.md), [localization](internationalization.md), [releasing](releasing.md).

Configuration and operations: [server configuration](server-configuration.md), [CLI file import](files.md#cli-import), [diagnostics](troubleshooting.md).
