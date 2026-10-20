# Round 1 D module evidence

2026-10-20. Module-directed validation only; combined integration acceptance
belongs to the controller. PR remains draft.

- Frozen campaign base: `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
- Product implementation: `b59abd30c9d992c6be29e6fac9a31f5d79841100`.
- Frozen runtime/test candidate: `b080010f6fffcf5187067e3add1b374c4dc42b16`.
- Branch: `codex/perf-r1-d-web`; draft PR [#196](https://github.com/utopiafar/mote/pull/196).
- This evidence document is the only later repository change; runtime inputs
  and assertions remain those of the frozen candidate.

## Implemented and retained

The session owns an in-memory draft store; only the controlled composer
subscribes to input changes. Existing reset/restore sites, synchronous submission
read, API/account lifecycle, IME, guards, layout and navigation remain. AnswerView
and AnswerMarkdown gained no memoization/cache, so locale and evidence changes
continue through the original render path.

uploadFilePart forwards its locally computed slice checksum to the existing
Web JSON/base64 sender. Full-file/identity SHA, 4 MiB slicing, exact wire, resume
checksum-and-size comparison, part/index/byte checks, immutable owner/archive
receipts and abort checks remain. Import and legacy attachment consumers retain
their one-argument callbacks.

resource-cache/useResource/operation-feed and Server source are unchanged.
The [rolling-window proposal](performance-round1-D-resource-plan.md) received
design-direction approval only; it requires controller round-2 authorization
and a fresh implementation plan at its actual base/head.

## Independent reviews

Reviewer `/root/implementation_plan_review`, `gpt-6.1-sol`, High:

| Plan | Exact plan SHA-256 | Decision |
| --- | --- | --- |
| [D-r1-v1](performance-round1-D-plan.md), base/head af11ab7c | `1df851fd66affcf1987358474301ac5510c1ba7ed2beedb3abb005a3c61d9c43` | APPROVE before implementation. Post-implementation review: no findings. |
| [D-resource-v1](performance-round1-D-resource-plan.md), investigated base/head af11ab7c | `c59bd35171f1993cbeef140098ec3681fe652225f225c634010e9136a37031d2` | APPROVE design direction only; no implementation authorization. |
| [D-browser-v1](performance-round1-D-browser-plan.md), candidate 28a849f5 | `a7a87fbc14b28efc397a664672fa2e8659aeeff85f90cc747c68414c0be82fba` | APPROVE before the new current-entry fixture; final comparison at b080010f: no findings. |

## Measured work and generated regression states

Same new regressions against an exact `git archive` of af11ab7c product source
and the candidate, using only D's installed dependencies:

| Loaded historical answers | Input events | Original AnswerView renders / Markdown parses | Candidate renders / parses |
| --- | --- | --- | --- |
| 1 | 10 | 10 / 10 | 0 / 0 |
| 20 | 10 | 200 / 200 | 0 / 0 |
| 100 | 10 | 1000 / 1000 | 0 / 0 |

Counts instrument the real AnswerView callback and the real unified parse
method while preserving its implementation. Each case asserts the loaded turn
and GFM table counts first. These are DOM work counts, not browser INP or a
production latency ratio.

Web attachment probes cover 1 B, exactly 4 MiB, and 4 MiB + 17 B. Every emitted
JSON string matches the independently reconstructed original base64/checksum
wire byte for byte. Per-slice SHA falls from two calls to one; full-file SHA
remains. A one-part file therefore hashes identical full-file/slice bytes twice
instead of three times. Candidate total SHA calls, including identities, are
5/5/6 for those sizes.

The 85 focused tests cover IME/Shift+Enter/form submission, disabled pending
draft, success/failure/ambiguous admission, historical retry, cancel, background
refresh, locale/citation focus, supplemental-route unmount/remount, new/select/
delete, older-page merge/revision withdrawal, API/account retirement and ignored-
abort late admission/poll. Upload cases include lost ACK/resume, damaged resume
checksum, wrong resume length, bad checksum/index/bytes and commit/owner receipts,
pre-upload/in-part/post-hash cancellation. Failure cases assert that the intended
part or commit stage was actually reached. Existing legacy attachment and
401-file import fairness/order/checksum consumer tests remain unchanged.

## Exact final directed commands and results

All installs, builds and tests used the campaign run-resource.py. Final commands
ran sequentially under owner D's exclusive heavy lease
`68a4e714-ca52-4bb8-beed-2774bce512b1`; every exit code was 0 and the complete
owned process group ended before release. Node 26.11.1, npm 11.20.0, macOS arm64;
independent node_modules and dist in this worktree, generated data only.

```sh
node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json --test --test-concurrency=1 \
  apps/web/test/performance-round1-D-composer.test.ts \
  apps/web/test/performance-round1-D-attachments.test.ts \
  apps/web/test/answer-markdown.test.ts \
  apps/web/test/note-attachments.test.ts \
  apps/web/test/import-upload-scheduler.test.ts \
  apps/web/test/read-state-closure.test.ts \
  apps/web/test/owner-questions.test.ts \
  apps/web/test/multiuser-request-model.test.ts \
  apps/web/test/multiuser-page-compatibility.test.ts
npm run build -w @mote/web
node_modules/.bin/electron apps/web/test/performance-round1-D-browser.cjs
npm run check:affected -- --base af11ab7c3e9fb5f38deaea4e4bae11462a7306b4 --dry-run
```

- Focused tests: 85/85 PASS, 4.955 seconds command wall time.
- Web TypeScript + Vite build: PASS, 4.664 seconds.
- Hidden built-main browser: PASS, 11.422 seconds command wall time;
  11.158 seconds measured inside the original 28-second fixture deadline.
  Starts signed out, uses the actual LoginDialog, discovers a generated Cookie
  session, and requires scoped session/CSRF request headers. It retains all
  original cold/background/poll/draft/focus/DOM/selection and Media/Activity/
  RecordTimeline refresh assertions. The initial unauthenticated discovery is
  recorded separately. This is renderer entry against generated HTTP responses,
  not validation of Server authentication implementation.
- Dry-run: selected Web plus shared/Agent prerequisites, shared contracts and
  release checks; no Desktop/Android workspace or Server suite. It reports scope
  only, not a completed check:affected gate.

Independent npm ci and shared/Agent prerequisite builds passed earlier through
their own heavy leases. The final tests, Web build and browser above were newly
executed; no reused driver task receipt is claimed (`REUSED: none`). Full
check:affected/check:local and the complete Web/Server suites were not run.

External D artifacts contain exact command arrays, paths, exit codes and timings
in `artifacts/final-module-run.json`; final logs and `browser-final/result.json`
contain the assertions/counts. `D/status.json` records reviews, final Git/PR
identity and cleanup. They contain generated evidence and metadata only.

## Failed attempts and limits

Three resource waits returned UNRUN without acquiring a lease. The first test
attempt had generated receipt sourceId setup errors and a missing design-token
asset in the archived baseline; those failures are not performance evidence.
Fixture-only corrections were recorded without changing product behavior,
assertion meaning, required states, input scale or deadlines. The corrected
baseline's six red assertions then identified precisely the old repeated work.

The old ask-loading-browser fixture failed before entering Ask because its
sessionStorage bearer bootstrap is obsolete. Its all-zero request counts and
signed-out UI remain recorded separately. The reviewed new D fixture uses current
Web login while retaining the original assertions and deadline; the old fixture
was not edited.

Browser windows stayed hidden; independent temporary userData and HTTP port 0
were removed/closed naturally. No personal node, personal captures, existing
service, AVD, physical device or live model was used. No claim of browser INP,
Server auth implementation, production network/model performance, main-branch
delivery or readiness to merge is made. Final integration and any main drift
remain the controller's responsibility.
