# R34 independent Central subreview

No confirmed product defect was found in the exercised bounded paths. This is **not** a completeness pass or platform score. The main evaluator retains responsibility for the frozen rubric and full 188-feature table.

## First-screen observation

See [first-look.md](first-look.md). These three fresh initial observations were saved before deeper controls were operated. The reviewer inherited project history, so they are independent current observations rather than blind user tests.

## Observed behavior

### Unknown cost and known failure cost remain separate

The failed October 22 filter shows 2 runs: usage-002 with USD unestimated and usage-003 with USD 0.001420. Known input/output 2100/250 are shown alongside 1 incomplete run. Unestimated is explicitly not described as free.

Evidence: [01-usage.json](evidence/web/01-usage.json), [02-failed-unknown-run.json](evidence/web/02-failed-unknown-run.json), [03-failed-priced-run.json](evidence/web/03-failed-priced-run.json), [08-usage-filters-quality.json](evidence/web/08-usage-filters-quality.json), [09-failed-filter.json](evidence/web/09-failed-filter.json), [26-usage-page-two.json](evidence/web/26-usage-page-two.json).

### Changing future prices preserves historical currency, rates and estimate

Changed all four per-million prices and currency for the existing demo-cloud/demo-text pair, saved revision 2, reloaded, and reopened usage-003. Current values were CNY 1.23/4.56/0.12/0.78; historical values remained USD 0.8/3.2/0.2/1 and estimate USD 0.001420. New provider/model ID entry and future-run generation were not exercised.

Evidence: [03-failed-priced-run.json](evidence/web/03-failed-priced-run.json), [04-pricing-before.json](evidence/web/04-pricing-before.json), [05-pricing-saved.json](evidence/web/05-pricing-saved.json), [06-pricing-reloaded.json](evidence/web/06-pricing-reloaded.json), [25-historical-price-expanded.json](evidence/web/25-historical-price-expanded.json).

### Agent directory, preview and retained input remain visibly distinct

Browsed source folder and material m2, expanded body from 80 to 94 characters, then previewed a custom question with mac and explicit UTC start/end. Preview stated zero model calls and zero memory clues and did not include the browsed body. Source had no acknowledged description; pending-save/ACK transition, memory evidence expansion and directory-list pagination were not tested. Selected trace-demo-partial, inspected retained initial context, model event, actual excerpt 80–170/320, failed read and truncated return across event pages 1–3. An explicit unknown run ID removed previous content and showed absence with the prerequisite for prior detailed logging. Editing current memory/material and toggling logging during this session were not exercised.

Evidence: [18-agent-directory.json](evidence/web/18-agent-directory.json), [19-agent-sources.json](evidence/web/19-agent-sources.json), [20-agent-source-detail.json](evidence/web/20-agent-source-detail.json), [21-agent-material.json](evidence/web/21-agent-material.json), [22-agent-material-complete.json](evidence/web/22-agent-material-complete.json), [23-initial-context-form.json](evidence/web/23-initial-context-form.json), [24-initial-context-preview.json](evidence/web/24-initial-context-preview.json), [12-agent-trace-entry.json](evidence/web/12-agent-trace-entry.json), [13-partial-trace.json](evidence/web/13-partial-trace.json), [14-partial-trace-page-two.json](evidence/web/14-partial-trace-page-two.json), [15-retained-read.json](evidence/web/15-retained-read.json), [16-partial-trace-page-three.json](evidence/web/16-partial-trace-page-three.json), [17-missing-trace.json](evidence/web/17-missing-trace.json).

### Mobile usage retains meaning but starts with a substantial header and filter region

At 412×915 the mobile usage first viewport fits the category selector, title, fixture explanation, dates and filter disclosure. The actual cost summary is below the first fold. No horizontal overflow or overlapping controls was observed. This is a density tradeoff, not a demonstrated blocked workflow.

Evidence: [01-usage-entry.json](evidence/android/01-usage-entry.json), [01-usage-entry.png](evidence/android/01-usage-entry.png), [02-failed-unknown-run.json](evidence/android/02-failed-unknown-run.json), [02-failed-unknown-run.png](evidence/android/02-failed-unknown-run.png).

## Feature scope

| Feature | Web | Mac | Android |
|---|---|---|---|
| UF-USAGE-ANALYSIS | partial | untested | partial |
| UF-USAGE-PRICING | partial | untested | untested |
| UF-AGENT-VIRTUAL-CONTEXT | partial | untested | untested |
| UF-AGENT-ACTUAL-TRACE | partial | untested | untested |

Exact assertion statuses and representative journey evidence are in [observations.json](observations.json).

## Material limits

- Reviewer inherited project history and read the inventory before current first-screen observation; this is not blind human testing.
- Mac received first-screen observation only in this subreview. Android received first-screen observation and one usage-detail path only; Web findings do not verify shared native variants.
- No live model, vendor service, backend, operating-system permission or real charge was used. All displayed ledger and trace data are marked synthetic.
- Pending source description ACK exclusion was not tested by editing and submitting a pending description. The observed directory says the existing source has no acknowledged version and does not display description content.
- Post-reload Web screenshots from 06 onward lost the harness-injected CJK font and contain glyph boxes. Their DOM remains semantic evidence; they cannot establish typography quality. First-look, Web 01–05, Android and supplemental web-visual capture retain the font.
- One attempted next-page action followed Clear conditions while the one-day range remained; Next was correctly disabled. No 10-usage-page-two evidence exists. Seven-day pagination was subsequently operated and saved as 26-usage-page-two.
- No final page of the partial trace, all grouping/daily/model drill-downs, new provider/model-ID configuration, memory mutation or logging toggle was exercised. Untested assertions remain explicit.

## Visual evidence

The first-use screens give import and note-taking clear priority. Web explicitly names Mac/Android as collectors; the native versions describe scope on the current device. The Android usage page fits without horizontal overflow, although the result summary requires scrolling past its header and filters. The supplemental [Agent preview viewport](evidence/web-visual/agent-initial-preview.png) confirms readable Chinese typography in a fresh font-equipped context.

No page exception was observed. All 31 captured DOM states have document width within the current viewport. These checks do not substitute for full accessibility, keyboard, localization or native-runtime validation.
