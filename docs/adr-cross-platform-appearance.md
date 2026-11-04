# ADR: local Light, Dark and Auto appearance

Date: 2026-10-17. Owner requested an independent theme change on remote main, with autonomous implementation and a PR; no merge or deployment.

Base: `6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed` (fetched origin/main). Branch: `codex/mote-cross-platform-theme`. No multi-user branch or dependency is included.

The existing UI surfaces are Central Web, the macOS Electron collector and Android Activities. There is no iOS application or browser-extension UI in this repository. Swift files implement macOS capture/update helpers; CLI and backend workers have no appearance controls.

Each UI exposes the existing Settings pattern with a labelled native select or single-choice dialog: 浅色 / 深色 / 跟随系统 (Light / Dark / System default). New installations follow the system. Store `light`, `dark` or `auto` locally per browser/profile/install, never the currently resolved OS color. There was no previous owner appearance setting to migrate. Existing language and presentation provider choices retain their own ownership.

The Linear visual language, spacing, typography, navigation and stable content slots remain. Dark keeps the warm graphite palette; Light uses warm paper and the same purple accent. A shared light token source accompanies the original dark source. The generator emits both schemes, first-paint bootstrap, CSS, and native day/night resources. Presentation packs may supply complete `schemes.light` and `schemes.dark`; older trusted packs with only `tokens` keep their explicit palette. This does not introduce preference synchronization, remote presentation installation or arbitrary code.

Web uses a synchronous local script before application paint and `prefers-color-scheme` CSS, then a `matchMedia` change listener. The root's tokens, `color-scheme`, browser theme color, controls, selection and scrollbars agree. Rejected or corrupt storage follows the system. There is no SSR app here; shared appearance imports avoid browser globals. Storage events and resume refresh the local state.

Electron reads a private per-profile JSON preference before constructing its window, sets `nativeTheme.themeSource` (`system` for Auto), and uses the resolved background for the native window. A trusted synchronous preload snapshot provides the renderer's first frame. Changes are saved atomically through the existing trusted IPC boundary. The renderer updates tokens in place; no reload, navigation, draft write or capture command is triggered. Native menus and dialogs use Electron's native theme. The app uses opaque surfaces, so Reduce Transparency does not require a transparent alternative; native high-contrast behavior remains platform-owned. Accessibility settings require explicit validation, not an inference from palette ratios.

Android retains its existing native Activity / Material themes. API31+ `UiModeManager.setApplicationNightMode` persists the package override and matches the system splash. App-local AUTO clears the package night override; it does not change global night mode. API29/30 use a scoped configuration and explicit Material light/dark parents; the starting preview is disabled there to avoid the OS showing a mismatched manual-color launch window. Activities handle `uiMode` in place and replay registered semantic styles, including owned dialogs, while preserving View identity, editor closures, focus, selection and navigation. Resume reconciles system changes. Force Dark is disabled. System-owned permission and file-picker UI retains the host system appearance.

The user explicitly requested three states. Apple HIG supports adaptive appearance but does not mandate a separate app appearance selector.

| Supersession | Decision |
| --- | --- |
| KEEP | `adr-ui-presentation-packs.md` presentation contracts, trusted local renderers, stable nodes, domain authorities, Linear visual language, native controls and generated-fixture privacy. |
| CHANGE | Built-in fixed graphite appearance becomes locally selectable Light/Dark/Auto. Color roles get complete light/dark variants and matching native chrome. |
| REMOVE | Fixed dark `color-scheme`, light Electron launch background, dark-only Android launch resources. |
| EXCEPTION | Legacy trusted packs with a single fixed token map preserve that palette; native permissions/pickers remain OS-owned; API29/30 omit the starting preview. |
| UNKNOWN | Physical device/OEM behavior, native accessibility settings and actual launch surfaces beyond the executed fixture matrix; record these in validation. |

Official references: [Android dark theme](https://developer.android.com/develop/ui/views/theming/darktheme), [Apple Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode), [web color-scheme](https://web.dev/articles/color-scheme), [MediaQueryList change](https://developer.mozilla.org/en-US/docs/Web/API/MediaQueryList/change_event), [WCAG text contrast](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum), [Android package-local night-mode implementation](https://github.com/aosp-mirror/platform_frameworks_base/blob/main/services/core/java/com/android/server/UiModeManagerService.java).

Executed evidence and remaining boundaries belong in [the validation record](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/validation/cross-platform-appearance.md).
