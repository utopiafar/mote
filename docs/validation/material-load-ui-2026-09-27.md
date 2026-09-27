# Generated 160 → 400 Material UI validation

The full production Web application and loopback server passed the generated `interactive-400` Electron journey on 2026-09-27: 124 checks, 77 measured actions, exactly 400 Materials, and 16 actions overlapping actual source HTTP requests or publication ticks that increased the Material count. No production business code was changed for this test.

This is a generated fixture result, not a physical device, capture, live-model quality, or isolated performance benchmark. Another isolated vault concurrently ran generated-data live-model extraction/review/integration or Ask. This UI process made **zero live-model calls** and **two local stub calls** (body extraction and review).

## Inputs and execution

- 335 short Coding source records, 64 long custom source-item records, and one controlled Material with ready body and pending transcript. These represent protocol paths, not simulated real diaries.
- Each long record contains 17,072 UTF-16 code units, including newlines, quotes, Chinese text and emoji. First and last markers and hashes are frozen.
- Initially 160 Materials: 135 Coding + 24 long + one controlled. A further 240 arrive in 12 batches of 20, with 500 ms between batches: 200 Coding + 40 long.
- Normal records go through the source API, production source pipeline and organizer. A narrowly selected fixture organizer controls the one pending transcript. A real production Memory job uses local fixed replies and the production review/publication path.
- Lists remain bounded at 12 items. All 400 unique titles map one-to-one to the final catalog IDs and frozen manifest; enumeration takes 34 pages.
- The existing `legacy-631` profile remains the default. This run used the explicit `interactive-400` profile. The historical 400-note collector test failure was an upload-fairness unit test, not evidence of a 400-Material UI failure.

Runtime: Electron 41.10.7, Chromium 146.0.7680.216, Node 24.18.0, Darwin 27.0.0 arm64. Base Git commit: `8a6606d1f0915567e0292e28722791283a2fb9ae`, with the fixture scripts uncommitted at run time. Production server/Web builds preceded the run; shared/agent builds were unchanged during it.

| Frozen artifact | SHA-256 |
| --- | --- |
| Generated fixture JSON | `a4cd41c3af5107606cac477e8fd2d493181334d29eea2eb0ef45c04869df2b61` |
| Runner used by the successful run | `550b616e2b12af38a388a4b5925fe94253c128bc88426293cf95b04c23443612` |
| Fixture generator | `bd56269c9a9b02758c9a57ec28499f76dfd06d2dbcfc08a2557e1b0e50354b63` |
| Fixture server helper | `7eef0e5f3d629123e9486aa8f827495a5e4120f6340caba15e5e02dcee931368` |
| Original successful report | `8cc56dd8b7facf2b61ff75aef281fc7bafd89c4a0cb9df9c85aeb8f81c06fa57` |

To reproduce after the normal workspace build, choose an output directory outside the checkout. A frozen fixture is optional; when supplied, the runner requires its bytes to match the generator exactly.

```sh
MOTE_MATERIAL_UI_PROFILE=interactive-400 \
MOTE_MATERIAL_UI_FIXTURE=/absolute/external/path/fixture.json \
MOTE_MATERIAL_UI_OUTPUT=/absolute/external/path/material-load-ui \
MOTE_MATERIAL_UI_CONCURRENT_LOAD='Describe the actual concurrent system load here' \
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-material-load-ui.cjs
```

The actual run set the concurrent-load description to: “Another isolated vault concurrently executes generated-data live-model extraction/review/integration or Ask; timings are not an isolated benchmark.” Raw reports, generated screenshots and temporary vault details remain outside source control.

## Observed behavior

The journey passed pagination before/during/after ingress, exact long-text range reading and complete reconstruction including the tail, real wheel input with measured viewport displacement, citation → Material → original navigation, Escape and exact opener focus restoration, pending progress at 1/2, cancellation, and late input after cancellation without a resumed transcript job. Desktop and narrow responsive layouts were exercised. HTTP errors, renderer console errors, crashes and blocked outbound requests were all zero in the successful run.

All 12 generated screenshots were inspected. Long Material text, quotes, emoji, progress counts and dialog controls were readable, without horizontal overflow or text overlap. The parent reviewer separately inspected the 400-long mobile, pending desktop and original mobile screenshots. The requested widths were 1280 and 430; these are responsive Electron windows, not physical mobile devices. macOS limited the requested window height, so the screenshots do not establish a 1000 CSS pixel viewport height.

**Original-dialog limit:** the cited record is the full 17,072-character record, not a short fixture summary. The capture browser API, `EvidenceReader.context()` and the original dialog pass its full `ocrText` without a slice. At widths ≤760 px, existing CSS gives the original `<pre>` `max-height: 240px; overflow: auto`. This explains the screenshot showing about three paragraphs followed by metadata: the text has its own scroll area. The test checked the original identity and head marker, but did not scroll that inner region to its tail or record its DOM text length. Full Material paging was verified separately; original-dialog tail interaction remains unverified. The small viewport and normally hidden macOS scrollbar may make that inner scroll area hard to discover. No UI change was made.

## Timings and limits

The successful run lasted **201,723 ms** (05:05:10.641–05:08:32.364 UTC). This includes three explicitly recorded phase breaks totalling **183,005 ms**, required to stay within the existing shared owner request limit of 180/minute. Action timings exclude those breaks. The 18,718 ms remainder is arithmetic wall time, not a throughput result. The 12 × 20 concurrent ingress section and the requirement for at least three genuinely overlapping actions were unchanged.

| Measured action | Samples | Median ms | Maximum ms |
| --- | ---: | ---: | ---: |
| 160: next page | 3 | 34 | 87 |
| 160: open long Material | 3 | 31 | 78 |
| Ingress: next page | 4 | 56 | 91 |
| Ingress: open long Material | 4 | 56 | 81 |
| 400: next page | 3 | 33 | 82 |
| 400: open long Material | 3 | 30 | 75 |
| Full 400 enumeration: next page | 33 | 64 | 67 |
| Cancel Memory job | 1 | 79 | 79 |

Six wheel journeys sent 36 actual wheel events and moved the viewport 929–934 px per journey. Their 555–557 ms durations include six paced input events; they are not rendering latency. Citation journeys took 451 ms desktop and 322 ms narrow, including screenshots and nested navigation. Long-read samples mix one complete 17k-character traversal with shorter forward/backward checks and are not interchangeable latency samples.

Five short frame windows collected 628 intervals (509 during interaction), maximum gap 18.8 ms, zero gaps above 50 ms and zero observed long tasks. These windows do not establish a sustained SLO over the whole run. Sampled server RSS peaked at 364,986,368 bytes. There were 336 completed requests, 312 under `/api/`, with a maximum recorded request duration of 156 ms. Hardware and concurrent load prevent causal speed comparisons.

The original runner used the upper middle sample for even-sized groups. A subsequent statistics-only correction uses the conventional average of the two middle samples. The table above was recomputed from all 77 original actions; an independent offline replay agreed across 18 groups. The original report remains unchanged, and no UI/model rerun was used for this correction. The corrected runner SHA-256 is `a5ddb68190676c03669b9a69d8a96c1707b14c9262fef61e077fd9850e3d9f51`.

## Retained failed attempts

1. First attempt published 400 Materials but failed in the harness overlap aggregation with an undefined variable. The variable was corrected.
2. Second attempt reached the cancel flow, then the fixture late-input POST received a real HTTP 429 because the robot exceeded the existing shared request quota. The failure is retained; the quota was not changed. Three recorded phase breaks were added. The successful result does not claim the same unpaced automation rate works.
3. Third attempt completed all 124 journey checks but failed the final HTTP-error assertion on two model-catalog HTTP 502 responses. The query stub did not cover the separate model-catalog capability. A precise local fixture GET catalog response was added and independently smoke-checked with HTTP 200 and zero model calls. The errors were not excluded from acceptance.
4. Fourth attempt passed the complete unchanged journey. All earlier failure reports are retained externally.

The three script syntax checks, generated-manifest consistency checks and `git diff --check` passed. This document records the targeted UI run; the parent task owns the final full `check:local` result and commit.
