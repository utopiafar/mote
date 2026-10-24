# R18 bounded settings, import, and application activity completion

## Candidate and merge contract

- Frozen input: `dist/r17.html`, SHA-256 `290534ad7b054e1349ca836e13e7c30d3913860964479517052c8523031d7c6c`.
- Own candidate: `work/settings-r18.html`, 499,024 bytes, SHA-256 `29d9c1be5831a0f60351ebbf075fdedbdc65c2dd9d0e1a18725da5d7a0743228`.
- Merge artifact: `reports/settings-r18-replacements.json`, 17 ordered `{label, before, after}` replacements. Exact sequential replay against frozen R17 reproduces the candidate byte for byte.
- Additional implementation and 57 explicit English labels are isolated in `SETTINGS_R18_COMPLETION_START` / `SETTINGS_R18_COMPLETION_END`, immediately after the retained `ENGLISH_COMPLETION_END` marker. No original translation function replacement is required.
- Defaults are inserted before, and preserve, the `initialDefaults` anchor. Click dispatch adds one `settingsCompletionAction(action,el)` call; it does not replace the complete dispatcher or state object.
- Frozen R17, the shared integration file, and the R15/R17 comparison viewers are unchanged by this work.

## Completed changes

### C01 — Account service and browser sign-in retention

The account page now identifies the current example service URL and central node. It provides a browser sign-in retention selector with stable values `session`, `7d`, and `30d`, an explicit Save action, an unsaved draft state, and saved/reopened feedback. The page explains that this prototype saves an example preference and does not create or extend a real authentication session. Service and node names are preserved as original data.

### A02 — Image processing for the current import

The current import form offers Follow default settings, Archive originals only, and Local OCR (example plan). The first two correspond to the actual import form's choices; the third represents an existing image profile in this HTML demonstration. Changing the choice retains the selected file, material title, storage setting, and parser. Language changes preserve control values.

Each imported batch now has an `import/details/<id>` view with its own saved file, title, storage method, parser, device, and image plan. The plan can be changed and saved without rewriting those other fields or global defaults. Completion, import history, and the readable result provide an entry to this detail view. The result reflects the updated per-import plan.

Android's local-file tab reads “Android 本机文件” / “Files on this Android device”. A new import's device metadata and original path use the current preview platform. The underlying `电脑文件` selector value remains stable for existing handlers. Original filenames, titles, and paths remain unchanged by localization.

### A13 — Duration-derived app shares and collection coverage

The demonstration fixture has a five-hour sampling window from 09:00 to 14:00 in Asia/Shanghai on the example Mac. Its app durations are 138, 66, and 32 minutes: 236 recorded minutes total. Visible shares derive from those durations: 58.47%, 27.97%, and 13.56%. Bar widths use the same unrounded ratios, with accessible meter values.

Three explicit gaps total 64 minutes: 09:45–10:05 (screen locked, 20 minutes), 11:20–11:44 (capture paused, 24 minutes), and 13:40–14:00 (device disconnected, 20 minutes). The page shows the sampling time, timezone, source device, 300-minute window, recorded time, and unrecorded time. It explains that gaps are not estimated or included in the percentage denominator. These are synthetic UI fixtures, not actual device telemetry.

## Focused evidence

`reports/settings-r18-dom.json` records 23 passing checks against the candidate SHA above, with no DOM execution errors. The checks cover only these additions: retention save/reopen, current import preservation, language/value stability, saved image-plan edits, Android result metadata, localized controls, duration/share arithmetic, and sampling/gap explanations. No backend, authentication, OCR, or complete product integration is claimed.

`reports/settings-r18-browser/` contains isolated Chromium screenshots and rendered-DOM observations for four English Android views at 390 × 900: account, current import, import details, and app activity. All four had a document width of 390 pixels; no browser errors occurred. The resulting screenshots were inspected for readable new controls and labels. The capture summary predates the script's optional input/output arguments and added hash metadata; its candidate binding is the unchanged hash recorded in this report and the DOM evidence.

## Reuse after integration

Both check scripts now accept an optional candidate file followed by an output directory. Paths are resolved from the invocation directory. No arguments uses this own candidate and its original report destinations.

```sh
node docs/design/ui-clarity-2026-10-20/prototype/continuation/scripts/verify-settings-r18.mjs <candidate.html> <output-directory>
node docs/design/ui-clarity-2026-10-20/prototype/continuation/scripts/capture-settings-r18.cjs <candidate.html> <output-directory>
```

The DOM script writes `settings-r18-dom.json` in the supplied directory. The browser script writes its four `.png` / `.json` view pairs and `capture-summary.json` there. The browser run needs the existing isolated Chromium socket permission; all page requests remain intercepted locally. Neither script starts a new full journey matrix.

Implementation and static sweep are complete. This handoff introduces no additional scope; the comparison viewer remains on R17 until the final integrated candidate is frozen.
