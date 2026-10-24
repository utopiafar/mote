# A36 — English interface completion

## Frozen handoff

- Candidate: `continuation/work/interface-states.html`
- Final SHA-256: `1a5e1a5da473b7c008bca52bf1533b2f976995badc119152776d5c53dc8c8d6d`
- Proposed frozen continuation round: R17. R16 is retained separately by the integration driver.
- Mergeable localization block: `continuation/scripts/english-completion.js` (`ENGLISH_COMPLETION_START` / `END`).
- The only changes outside that block are the two original-answer content annotations in `continuation/scripts/english-content-annotations.json`.
- Static copy review is finished. This agent will not modify the candidate after this handoff.

The final candidate is based on the root's integrated account, memory, offline-note and source-flow candidate. This work changes the HTML prototype only. It does not run, configure or validate the application backend.

## Changes

The original partial dictionary is extended by **1,286 explicit copy mappings**. The dictionary covers navigation, all-feature directory descriptions and paths, settings explanations, toolbars, accessible names, placeholders, dialogs, confirmation text, errors and saved-state messages.

A central `translateUI()` function handles the variable forms that a single saved screenshot cannot cover: feature and result counts, material counts, app selections, pagination, elapsed time, dates and date ranges, recording permission/status, correction history numbers, source labels, note queue counts, import deletion with an arbitrary original filename and material count, selected memory schemes and validation states, and saved model prices with the actual entered values. These are explicit interface templates; the implementation does not remove, conceal or generically replace Chinese text.

The two additional answer annotations distinguish original example/model answer content from the interface explanation immediately above it. The explanation now appears as **“Example answer · Check the scope, citations and return path”**. Original answer paragraphs retain their language.

### Original content and stable values

`[data-user-content]` is the principal boundary. It protects memory content/history, usernames, source names/paths, queued note content and other annotated original material. The localizer also preserves textareas, preformatted/raw material content, material titles/previews, message content, history question titles, task text, filenames and named devices. User-entered field values are not translated.

The prototype contains selects whose options originally had implicit values. Before translating their displayed text, the localizer pins the original option text as the explicit value. Already explicit values, IDs, selectors, action identifiers and `data-*` business values are unchanged.

The English language selector is the visible `select#language-choice` on `#/settings/appearance`, with `value="en"`. No `?lang=en` query handling was added.

## Evidence and scope

| Evidence | What it actually checks | Result |
| --- | --- | --- |
| `reports/english-boundaries.json` | Final SHA above; 52 unique feature routes compared in Chinese and English for select option values, plus original-content and new-state language checks | 62 assertions passed; no DOM execution errors |
| The same final boundary report | A note whose title is literally `保存设置`, English → Chinese → English switching, original history questions, an account whose username is literally `用户名`, original answer text versus interface explanation | Original content retained; interface copy translated |
| The same final boundary report | Offline saved note, offline retry, queued preview, discard confirmation, sign-out confirmation, sign-in screen, missing username and incorrect password | Eight state inventories; zero untranslated interface text in those inventories |
| `reports/english-final-inventory.json` | 54 routes covering all 78 feature targets, populated and empty fixtures; visible and discoverable DOM text and relevant attributes | Last full scan of the preceding `a952…` candidate; 46 retained Chinese content/name/autonym records, classified below |
| `reports/english-final-actions.json` | 107 distinct primary action openings, used to extract modal/confirmation/error copy during development | Supporting working-copy inventory, not a frozen final-candidate pass |

The last full route scan has its own recorded SHA (`a9528188ef5703a9b368ace47e44632ab472f0ec31c7e661b0d7c0201400dad6`). The final change after that scan added explicit variable-state templates and 13 associated dictionary entries. The report is deliberately not relabeled as a full-route scan of the final hash. The final 62-check boundary verification was rerun against `1a5e…` and passed. Final browser rendering and independent journey evaluation belong to the integration driver's single frozen R17 run.

These DOM checks establish copy coverage, data preservation and control-value stability. They do not establish viewport layout, English wrapping, touch target size or clipping; those require the root's real browser evidence. No claim is made here about backend synchronization, real account authentication, recording permissions or live model execution.

## Remaining Chinese text

**Known untranslated interface copy after this review: none.** The full retained-content classification is in `reports/english-retained-content.json`.

Chinese text still present by design includes:

- The native language name `简体中文` in the language selector.
- Original material titles and previews, filenames such as `研究资料.md`, source and device names such as `研究资料` and `我的 Mac`, and original paths.
- Original note and memory text, task titles, user questions and conversation history.
- The content of example model answers, clarification questions, source quotations and generated insight paragraphs.

Mixed strings such as `View evidence · 产品评审记录` are translated interface actions followed by an unchanged original material name. These are not language omissions. The work does not require source material or user content to be English.

## Maintenance and merge interface

`english-translations.tsv` and `english-action-translations.tsv` retain the reviewed mappings keyed to their immutable source inventories. `english-extra.json` contains the final integration additions. `english-runtime.js` holds the small set of explicit templates and data-preservation rules. `apply-english.py` builds the central block in the candidate; later overrides in `english-extra.json` intentionally win.

To merge onto an integrated candidate that already has a completion block, replace that block with `scripts/english-completion.js`. If the two answer content annotations have not yet been applied, apply the `before`/`after` pairs in `scripts/english-content-annotations.json` once. No source-flow, account, note or memory action logic needs replacement.
