# Platform adapters

## R20 initial pass

- `platform.js` exposes `enhancePlatformUI()` (called after every render) and `platformAction(action, element)` (called before other extension actions).
- The adapter loads after the existing R19 app and common.js. It does not call render on load.
- Mac has a desktop window/title bar, menu-bar collection popover, current-device source choices, keyboard search / quick note, and denser desktop sidebar controls.
- Android has its own status / app bars, bottom navigation, touch-sized forms, bottom sheets and a visible contextual back action. Folder sync and screen recording are equal local collection options.
- Existing R19 actions still perform saves, pauses, drafts, source filtering and return behavior. The native menu is only a second visible entry to those actions.
- Android synthetic screen/folder fixtures adopt Android labels/device metadata; Coding and other historical material fixtures keep their own devices. User-entered text is preserved.
- The only existing function replaced is sourceSubtitle, which delegates to the baseline and adapts the local Android screen label.
- Platform-specific permission copy points to the appropriate conceptual OS step, retaining the existing explicit allow/deny demo controls.
- All new UI strings have Chinese and English forms. No native or service execution is claimed.

### R20 focused author execution

Run against frozen R20 HTML in headless Chrome at Mac 1440×1000 and Android 390×844. Mac SHA-256 `0bd4fe3d76af1e189d562c36aa47b7eb5f74458dadd2083d03036f609e7f0e6e`; Android SHA-256 `828b76a01226ae036e7484fcf99cae4482bdb8be3efb3a9c46581ade6d56caa6`.

- Mac: open menu-bar collection status → see screen “尚未开启” and folder “尚未连接” → choose screen setup → see the Mac system permission path → Command N opens note editor.
- Android: first-note action → type a synthetic draft → contextual back → reopen note → exact draft retained → back → screen action → Android permission explanation visible.
- Both executed views had no page errors or horizontal overflow.
- Author observation for a later round: Command K on an empty library currently returns to the welcome screen without a search field. It needs a clearer empty-search response.

## R21 revision

- Android places the workflow example after the continuous-collection choices. Folder and screen choices retain equal card styling, and the lead uses less vertical space while preserving full purpose text and two primary starting actions.
- Mac Command K with no saved materials opens a specific search empty state explaining what will become searchable, with first-note and file-import actions.
- Android sheet styling uses the actual baseline `.modal` selector; regular and icon buttons have 48 px minimum touch dimensions. These corrections are preserved in the R21 source snapshot.
- After independent R20 feedback on obscured cancellation, Android main content reserves 120 px plus the safe-area inset below its content; scrolling to form buttons also reserves the navigation bar area. Dialog and bottom navigation padding include the safe-area inset. Root handles the separate stale-toast cause in the common layer.

## R22 revision

- Connected-source rows on compact layouts now place the badge and source identity in a two-column grid, status on its own line, and actions across the full row. Long paths wrap within the content column instead of being squeezed by action buttons.
- Android first connection routes to a new-folder form, says “连接手机文件夹”, uses phone-specific storage wording, and offers a simulated Android folder picker with explicit selected-folder scope. The first connection copy describes future receiving; existing-source management retains management language.
- Folder picker selection fills an editable path and source name, preserves form drafts, and delegates the actual source save to existing R19 behavior.
- Android screen scope labels now use Browser, Notes & documents and Messaging with mobile-specific descriptions. Selected-range summaries use the same labels.
- `screenAppNames` delegates on other platforms and adapts Android labels; `resetPreviewData` clears the added native folder drafts before delegating. Successful new-source saves discard their completed picker draft, so the next new folder starts independently.

## R23 revision

- Source settings on all three platforms now put a live current-state panel directly before the pause/resume actions. Folder receiving, continuous policy, screen permission and screen pause state derive from the same existing state as the upper status panel.
- Existing folder checkboxes are explicitly labeled as sync policy; the helper names the saved value and explains that pausing retains it. An edited checkbox still needs Save settings, and pause/resume remains an independent action.
- No defaults, permission state, receiving policy or saved source data are changed by this presentation update. Android first-connection forms retain their first-connection language.
- The native source overview now names a single connected folder and offers its management / resume entry directly. Multiple connected folders link to their existing rows; a separate secondary action connects another folder.
- On folder settings, the duplicate generic “settings saved” banner is removed when its same completion is already available as the common toast; detailed range and current-state feedback are kept.

## R24 revision

- Actual R23 Mac first-use observation: the welcome folder action opened “管理文件夹来源”, filled a sample path/name, and described restoring reception before anything was connected. R23 evidence remains in `rounds/r23/author/native-checks/mac-first-folder.*`.
- Mac first-use folder actions now enter a new, blank connection form. The title and policy copy distinguish first connection from later management.
- Added a Finder-style sample folder chooser, using the same explicit selection/draft/save stages as Android. The selected path remains visible and editable, and existing R19 source save behavior is retained.
- Native folder draft handling now covers both Mac and Android, with independent drafts per form route.

## R25 revision

- Returning Mac and Android source settings now begin with the existing live status, pause/resume action, saved scope and browse-source action. The original controls are moved, so the same actions do not appear twice.
- Folder management names the connected folder and shows its saved path before editable fields. Screen management shows the existing saved application range.
- Repeated native setup instructions move into an expandable helper for existing sources. Already-authorized screen permission demo controls remain available in the helper; when system permission is missing or denied, its controls remain visible in the main flow.
- First connections keep their expanded setup instructions. Source relationship fields, saved policy, editing controls, and original action handlers are retained.

## R26 revision

- Frozen R24 Android evidence confirmed that native Back after a successful new-folder connection reopened the now-blank creation form. The new-folder → saved source transition now replaces that completed step in native history, so Back returns to the actual entry page. Other navigation and uncompleted drafts retain their previous behavior.
- Frozen R25 Android source-flow screenshots also showed inherited scroll: entering screen setup from a scrolled Sources view could hide the native app bar. Android route changes now start at the top after rendering; same-page changes, including edited fields and pause/resume, keep their scroll position. Explicit “view connected folders” scrolling still runs after navigation.
- Root handles the separate import handoff and storage-copy terminology changes for this round.

## R27 revision

- Existing sources now keep the optional content relationship/background form in a disclosure with a meaningful saved-relation summary and saved / optional / unsaved status. Dirty drafts open on return; editing updates the summary status immediately. The complete original relationship controls and handlers remain inside.
- This optional-context presentation applies to existing source forms on all three HTML surfaces.
- A disabled native screen-save action now has an adjacent permission reason and a “review screen permission” action. That action scrolls to and focuses the actual existing allow control; it never changes permission state. The permission panel receives a visual focus outline, and missing/denied permission controls remain visible.

## R28 revision

- R26 author evidence at 360×740 in English/dark appearance showed the first phone-folder chooser partly behind bottom navigation (`r26/author/language-theme/android-folder.png`). For first Android connections, the native chooser is now the primary action before the manual path field. The selected path remains visible/editable below it; existing-source editing keeps its saved-path-first order.
- This changes the order of the first action rather than reducing permission text legibility or touch dimensions. Root owns weekly-review date/range semantics for this round.

## R29 revision

- Independent R27 Web evidence found server-folder status/pause/browse below the full editor. Existing Web sources explicitly marked `location: workspace` now reuse the status/actions/saved-scope-first layout. The scope names the workspace server, and root-provided target metadata/device handoff remains intact. Device-owned sources keep their device handoff page.
- Targeted frozen R27 Android evidence confirmed that opening the folder picker retained path/name but discarded unsaved continuous/save-mode values (`folder-draft-repro-result.json`). Native draft rehydration now restores all four form controls and refreshes the visible storage helper on both Mac and Android.
- Rehydration changes editable draft controls only. Current receiving status and the “saved policy” summary continue to reflect saved source configuration until the user saves settings.

- An adjacent frozen R28 author check confirmed a native overview contradiction after saving continuous receiving off: the row said “未持续接收”, while the overview counted it as actively receiving. Native overview/menu receiving counts now require both unpaused state and saved continuous policy. The saved off state remains visibly distinct from paused reception.
