# ADR: replaceable presentation and the default archive workspace

2026-10-25：导航、默认首页及页面职责已由 [UI IA v1](adr-ui-ia-v1.md) 更新。下文更早的导航描述保留为历史；视觉、原生行为与采集安全边界继续适用。

Date: 2026-10-15. Accepted by the owner in this conversation. Executed validation is tracked in [the rollout ledger](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/design/ui-presentation-rollout-2026-10-15.md).

## Decision

Mote shares a versioned presentation contract across Central Web, the Mac collector and Android. Theme roles and layout profiles are separate from feature capabilities, authenticated state, domain commands and background work. Each platform renders locally. The default UI uses the same registration and selection boundary as alternative trusted implementations.

The selected structure is Library / Ask / Sources / Activity. Native Library retains the label Content. Today / Home is auxiliary; Settings and feature discovery remain reachable. Opening without an explicit route or a restorable page lands in Library / Content. Explicit links and native restoration retain priority. Legacy routes keep their identity or an explicit equivalent.

The selected visual language is Design Lab A, Linear: warm graphite surfaces, restrained purple accents, warm light primary buttons, compact desktop controls and low container weight. This supersedes the previous fifth-round palette and container treatment. Touch targets, system text scaling, pickers, dialogs and system navigation retain platform adaptations.

## Contracts and ownership

`UiThemePack` carries an exact identity, version and complete role map. It is data, not a stylesheet or script. The token generator emits CSS, a browser-safe TypeScript theme, Kotlin fallback constants, Android XML and native JSON from the selected shared JSON. `--check` detects stale generated consumers from any working directory.

`UiLayoutProfile` names the four primary destination identities, initial destination, navigation geometry and detail preference. A platform's trusted layout pack adds a local renderer. The shared `UiPresentationHost` reuses FeatureRegistry identities and precise versions. Activation validates both selections before publishing a stable snapshot; installation order does not select a provider. Removing an active extra provider selects its pinned built-in counterpart and reports the reason. Native renderers map preferences to supported presentations; a profile is not an arbitrary UI language.

Web and Mac maintain stable content nodes across presentation changes. Android resolves theme and navigation through a native host, reapplies explicitly registered color, typography and shape roles, and rearranges the existing shell slots within the same Activity and View tree. Open dialogs refresh through the same role bindings. Theme/layout changes retain editor closures, unsaved values, focus and selection; configuration and language changes retain their existing restoration paths. Native layout mapping supports bottom navigation on phones and a sidebar on wide screens. New renderer code remains part of the trusted platform build. There is no new plugin marketplace, preference synchronization policy or arbitrary native code hot installation.

Providers arrange slots and render facts. Session credentials, privacy filters, permissions, capture, transport, publication, indexing, Memory authorization, retention, charging and task lifecycle remain with existing authorities. Activation must not resubmit work or expand Agent access. Query agents retain read-only tools. Existing trusted feature contributions keep their current authority; extracting a presentation interface does not sandbox arbitrary third-party code.

Mac layout mounts receive a host-owned resource scope with an AbortSignal, `listen` for event handlers and `effect` for registering subscription, timer and DOM-effect cleanup. Trusted providers must register their side effects as they acquire them, including before mount returns. The host closes that scope on replacement, disposal or mount/update/dispose failure; scoped navigation commands stop after abort. This releases partial setup even when no renderer handle was returned. DOM rollback preserves host editors, while the default renderer and a visible notice recover presentation. The scope is a lifecycle contract for trusted code; it cannot clean up arbitrary side effects that bypass registration.

The integration anchors are explicit and local to the platform build:

| Platform | Registration and consumption |
| --- | --- |
| Shared | [Presentation host](../packages/shared/src/ui-presentation.ts): `registerTheme`, `registerLayout`, then `activate` with exact theme/layout references; registration returns an idempotent disposal handle. |
| Web | [Presentation surface](../apps/web/src/presentation.tsx): `webPresentation` consumes `WebShellRenderer` implementations with navigation, toolbar, content and footer slots. Business content stays in a stable portal container. |
| Mac | [Desktop presentation](../apps/desktop/src/presentation.ts): `createDesktopPresentation` exposes its host; layout implementations mount stable sidebar/toolbar/main slots and acquire effects through the supplied scope. |
| Android | [Native providers](../apps/android/app/src/main/java/dev/mote/collector/NativeUiPacks.kt): register bundled theme/layout providers, then bind exact identities. [Native shell](../apps/android/app/src/main/java/dev/mote/collector/NativeAppShell.kt) and explicit style roles consume the binding. Unsupported native layout preferences are rejected. |

The replacement/disposal examples in each platform's presentation tests demonstrate this boundary without introducing an owner-facing selection or synchronization policy.

Library contains reading destinations. Source-wide configuration belongs in Sources; source reading retains metadata and an exact source link. Activity presents user goals and existing recovery entry points. Technical execution remains a distinct advanced destination. Removing a duplicate entry does not remove commands or historical data.

Related Activity accepts one exact material or source ID. Durable material evidence, Memory receipts, capture/import membership and explicit execution inputs are joined before pagination. Titles, source display names, logs and keywords never determine relationships. Coverage is explicitly partial: a missing link does not prove that no work exists. The existing owner-only authorization and collector rejection remain in force.

## Supersession

| Classification | Treatment |
| --- | --- |
| KEEP | Existing capabilities and domain authorities, draft/return semantics, exact evidence identity, read-only QueryAgent, native permissions/lifecycle, generated fixtures and truthful validation. |
| CHANGE | Navigation and first landing in [action-first](adr-client-action-first.md), [client navigation](client-navigation.md) and [Slate](ui-slate.md); the [previous rollout](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/design/ui-rollout-2026-10-14.md) palette; fixed shells and compile-only theme consumption. |
| REMOVE | Duplicate activity entries in reading collections, source-wide editors in reading mode, uncontrolled theme overrides and implicit provider precedence. Legacy deep links and technical pages keep destinations. |
| EXCEPTION | Native renderers, dialogs, touch dimensions, keyboard/IME, system bars and back behavior remain platform-specific. New native code requires a build. UI disposal does not stop domain work. |
| UNKNOWN | Real-device and accessibility behavior outside executed fixtures, real-model quality, future account/device preferences and remote UI distribution. |

Historical design and validation records remain historical evidence. Compatibility covers only the roles and layouts actually consumed and tested by the corresponding platform. Runtime prompts, agent instructions, configuration and background work keep their existing ownership; this presentation change does not introduce dispatch based on captured content or new processing policies.
