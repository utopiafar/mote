# Memory questions and owner replies: validation

This matrix covers the accepted [clarification ADR](adr-memory-user-clarification.md).
All automated text, model output and browser screenshots use generated fixtures.

## Implemented regression coverage

| Journey / transition | Required outcome | Fixture coverage |
| --- | --- | --- |
| Complete anonymous conversation → reviewed owner question | Original operation waits; no identity-feedback planner or duplicate extraction | `memory-owner-questions.test.ts` |
| Participant name or mixed speaker label → uncertain identity | Contract preserves the distinction between a name, a role and owner correspondence | Coverage/review contract tests |
| Unknown attribution → justified complete uncertainty | Unknown is not a blanket processing gate | Coverage contract tests |
| Specific useful unread evidence → `needs_context` | Existing bounded context path remains separate | Coverage contract and existing feedback tests |
| Empty/repeated context → proposed adjustment | No new model task; exact joint inspection history survives retry/restart | History/progress fixtures |
| Owner-dependent range + supported sibling | Supported result/checkpoint commits; unresolved range has no completed checkpoint | Real source/API/Memory fixture |
| Waiting → retry/restart → later independent job | Stable question identity, no new model work for unchanged gap, released capacity | Real source/API/Memory fixture |
| Question → Activity/Material → Ask | Existing overview, source-context and history expose a stable dialogue | DOM integration and browser fixture |
| Activity work regrouping → question entry | Operation children scope question lookup; direct work ID is fallback | Web contribution test |
| Owner-dependent coverage → Activity needs input | Cards, branches and record counts agree; persisted old projections and SQL triggers migrate | Activity fixture |
| Authored choice → answer and continue | Exact authored answer, per-material statement, one continuation, fresh extraction/review | API/Memory integration and DOM fixture |
| Edited choice/free text → unresolved answer | Literal text reaches provider; follow-up stays in the same open dialogue | Provider/API and DOM fixtures |
| Unknown → closed → explicit new information | No automatic retry; same question accepts a later explicit answer | Service/Memory and DOM fixtures |
| Defer → later answer | Passive waiting retains answerability and releases execution capacity | Service/Memory and DOM fixtures |
| Repeated request, race or restart | Idempotent receipt, optimistic revision and current authority prevent duplicate admission | Generic service and Memory integration |
| Evidence deleted/corrected or work cancelled | Stale question cannot continue; obsolete private content is scrubbed | Service/Memory integration |
| Provider removed/replaced or permission revoked | Provider epoch/capability checks and UI copy disposal prevent stale answering | Service and Web feature tests |
| Previous identity reply arrives late | Abort and identity fences prevent filling the replacement dialogue | DOM fixture |
| Captured text contains instructions | Evidence cannot manufacture owner authorization or a write tool | Contract/trust-boundary fixtures |
| Same label in another material | Scoped statement is not inherited across materials | Material/continuation fixtures |
| Large Coding work metadata → understanding/reuse | Compact generation handle keeps the existing transport bound; model still receives exact policy, package, member and history context | Coding understanding integration |
| Coding generation handle → revoked or revised source | Resolver refuses old authority before stale products can commit | Coding understanding integration |

Server integration creates source items through the receive API, publishes actual
Materials, starts an ordinary recipe job, independently reviews its generated
coverage, and submits replies through the owner API. Its deterministic model
adapter makes fixture state transitions reproducible; it does not prove a live
model will make the same semantic judgment.

A per-material owner statement changes that material's attribution snapshot.
Continuation therefore reevaluates its previously authorized affected ranges;
it does not reread other materials merely because they were sibling inputs.

Coding preparation resolves its complete Memory context through a host-owned
generation handle rather than copying large policy and work metadata into the
processor configuration. Fixtures cover an input whose resolved context exceeds
the existing transport configuration bound, exact context at the model reader,
and refusal after cancellation or source revision. Existing candidate reuse,
independent empty-result review, usage receipts and full-character long-dialogue
coverage remain regression checks.

## Commands and evidence

Focused Web verification runs `node --import tsx --test` from `apps/web` for
`test/owner-questions.test.ts`, `test/read-state-closure.test.ts`,
`test/activity-ui.test.ts`, `test/attribution-context.test.ts` and
`test/feature-host.test.ts`. This includes actual Ask composition, one existing
history sidebar, ordinary conversation navigation, feature registration and
disposal, exact capability matching, source quotes, answer actions, raw free
text, pagination, transport retries and stale/revoked state. The focused checks
passed during implementation; operation-scoped Activity coverage was rerun after
its addition.

`npm run build:libs` and `npm run build -w @mote/web` prepare the isolated browser
fixture. Run `node_modules/.bin/electron scripts/test-web-owner-questions.cjs`.
It starts a fresh loopback service with a temporary database and a generated
model adapter, receives generated conversations through real source routes,
publishes Materials and creates questions through Memory extraction/review.
The renderer then logs in through the real owner session API and exercises Ask,
defer, unknown, reopening, choice submission, free-text follow-up, source links,
Activity entry and desktop/mobile layout. Generated screenshots and the result
manifest are written to ignored `.mote/owner-question-browser/`. The browser
journey passed during implementation. Desktop, mobile and source-context
screenshots were visually inspected. A discovered mobile sticky-composer overlap
was fixed with scoped layout rules and a renderer geometry regression assertion.

Browser continuation verification checks admission, the honest pending-review
message, automatic resumed execution and its independent review receipt. The
generated review preserves uncertainty with no selected Memory; lifecycle
completion does not imply that a claim was saved. Server fixtures additionally
cover supported selected results and per-material dependency scope. The browser
does not contact an external model provider.

Before a runtime PR, the full `npm run check:local` remains required. Report its
actual result separately from these focused checks. Browser screenshots must be
visually inspected as well as checked for layout overflow.

## Remaining observation

Live-model question necessity, interpretation of tentative answers and
utterance-level attribution with unreliable diarization remain unverified by
deterministic fixtures. Physical Android/iOS/device behavior is also unverified.
Do not report model semantics or physical-device checks as passed from DOM,
Electron or server fixture results.
