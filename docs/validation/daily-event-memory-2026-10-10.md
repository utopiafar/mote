# Daily event Memory validation · 2026-10-10

This records the [daily-event decision](../adr-daily-event-memory.md), including
the earlier structured-intake wiring. All inputs, screenshots and vaults are
generated and isolated; no personal capture or production vault is used.

## Durable regression journeys

- Screenshot and v2 field intake through actual authenticated HTTP routes,
  source-specific pinned authorization, named event input, ordinary-event
  extraction, independent review and publication.
- The same article on both sides of midnight in Asia/Shanghai remains separately
  recallable. Each event uses its own original dependency, independent of merged
  article/group time ranges. This became a regression after the first daily query
  incorrectly lost the earlier day when the merged article spanned midnight.
  A subsequent real-model run exposed a second boundary: automatic UTC processing
  combined separate capture events on one UTC day, preventing Shanghai day-scoped
  recall. The daily policy now keeps independent capture observations separate;
  a recap may summarize repeated events after scoped retrieval.
- Date-scoped observation recall exposes current exact supporting ranges;
  original page metadata and generated image assets remain archived.
- Restart and duplicate upload do not repeat completed model work; deleting the
  original removes dependent event products and blocks late review publication.
- General defaults stay unchanged; capture defaults include the daily strategy;
  source overrides remain authoritative; removing events from capture defaults
  remains removed after restart and inheritance can be restored explicitly.
- Existing field overlap, disjoint fragments, identity/device isolation, bounded
  large article groups and organizer-version rebuilds retain their contracts.
- The existing editor saves capture defaults separately, retains unsaved edits,
  source overrides and inheritance, and keeps at least one recipe selected.

The deterministic model/processor fixtures verify routing, evidence contracts
and lifecycle transitions. They do not establish semantic extraction quality.

## Checks and live-model rubric

`npm run check:local` exited 0 after the final runtime changes: i18n checks,
shared builds, all workspace/script type checks and the full repository test
chain passed. The server suite passed 1,306 tests with 1 existing skip; the web
suite passed 254. Across the full chain, 2 existing platform/opt-in cases were
skipped. Skips are not device or live-model validation. `git diff --check` passed,
and all 212 local Markdown links in changed/new docs resolved.

Generated fixture checks passed: 7 daily/field HTTP journeys, followed by 15
focused exposure, source-disclosure and daily-recall cases after the disclosure
fix. The existing raw-screen discovery regression remains enforced. The
production screenshot zero-outcome regression explicitly selects the personal
recipe; the new daily journey tests both recipes through actual intake.

The Electron renderer script passed all 9 interaction/layout checks against the
real built owner API and web renderer. Desktop and narrow screenshots were
visually inspected; both retained the existing editor layout without overflow.
Outputs are outside Git at `/tmp/mote-daily-recipe-ui`.

The live script is
`node --import tsx scripts/test-daily-event-memory-live.ts`; it uses real local
Codex extraction, independent review, visual interpretation and recap, with
matching generated OCR text. Its executable assertions check original proof,
coverage and day-scoped retrieval; semantic acceptance requires independently
reading the actual outputs against the saved rubric.

The seven generated cases cover two article observations across midnight,
external Mira's opinion, a product recommendation, a draft plan, an unpaid order,
the same order paid but unshipped, and a completed expense-submission task whose
reimbursement outcome is unknown. The expected distinctions are not provided to
the model as test answers. The runtime receives the source records and installed
general policy.

## Live results and independent inspection

The generated Codex `gpt-6.1-sol / high` rerun passed: 3 extraction calls,
3 independent reviews and 1 recap, in addition to the existing real visual
processing stages. Seven event cards retained seven original capture dependencies;
Shanghai day queries returned 1 event for October 9 and 6 for October 10. All
quotes matched current formal original ranges, and fields/images remained archived.

The saved cards and actual recap were independently inspected against all eight
rubric points above. They retained ordinary displays, kept each timestamp
separate, attributed Mira's opinions to Mira, distinguished the draft, unpaid,
paid/unshipped and completed-task states, and left ownership, receipt and
reimbursement payment unknown. The recap converted capture times to Shanghai,
cited the six October 10 observations and explicitly limited coverage to those
samples; it did not claim to have viewed original pixels during recap.
Semantic acceptance is limited to these generated cases.

The immutable live report remains at a generated temporary directory ending in
`mote-daily-events-live-lhmmh6/report.json`; independent findings are saved in
`independent-review.json` alongside it. The live run preceded the final narrowing
of capture-card discovery. The current code was reopened on that same generated
vault, with model calls prohibited: both day counts and every card's verified
proof remained readable. Current fixture regressions additionally enforce hidden
raw-only screenshot cards, separate metadata/proof permissions and absence of an
arbitrary raw-image grant.

## Limits

No physical Android/macOS capture, permission or lifecycle check; no real OCR
quality, private-user recall/completeness study, production latency or deployed
release validation. This central feature does not add Android App/page adapters.
Background model/processing availability and source privacy remain prerequisites.
The PR is a reviewable change; it does not itself upgrade a running private vault.
