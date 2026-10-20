# Round 1 D: composer and attachment work reuse

Plan identity: D-r1-v1. Base and pre-implementation HEAD:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
Branch: `codex/perf-r1-d-web`. Owner: D. The campaign approval authorizes
ownership and resources; this bounded implementation plan needs independent
Sol Medium/High approval before implementation.

## Current and intended journeys

Ask enters through Web main → Conversations → account-keyed ConversationSession.
History/recent runs restore a conversation; detail and older pages merge only at
the same API/id/revision. A controlled ConversationComposer accepts the draft,
including IME and Shift+Enter. Enter/form submit trims the current draft, applies
the unchanged readiness/upload/opening guards, submits one idempotent admission
body, keeps the draft while disabled, and polls the run. Success clears it;
failure restores the submitted text. Cancellation, retry, explicit conversation
selection/new/delete, supplemental-question routes, attachment controls, and
account/API teardown retain their current timing and behavior. Resource updates
must still withdraw deleted evidence and copied pages at revision boundaries.

Today `question` is state on ConversationSession, so each input rerenders every
historical AnswerView and reparses its Markdown. Intended: create one small
in-memory draft store per session (`getSnapshot`, `set`, `subscribe`), subscribe
only a local composer wrapper with React `useSyncExternalStore`, and keep all
existing programmatic `setQuestion` sites in the parent. Submission reads the
store's current value synchronously. The store survives conditional composer
unmount for supplemental routes and is retired with its session. No answer
memoization, deep equality, deferred rendering, locale caching, HTML/layout,
navigation, input limit, or lifecycle policy is introduced. The render-prop
wrapper retains the existing composer/footer markup and controls.

Attachments enter via uploadChatImage/uploadNoteAttachment. Web mode registers
device/source, hashes the full file and identities, creates/resumes the upload,
hashes each selected slice, skips only matching checksum+byte receipts, sends
JSON/base64, checks part acknowledgements, then validates the immutable account's
durable source-item/original receipt. Today the JSON sender hashes that same
slice again. Intended: add the computed hash as the second `send(body, checksum)`
callback argument of uploadFilePart; Web attachment encoding sends that value.
The other legacy attachment and import scheduler consumers continue accepting
only `body`. All byte encodings, JSON key order, full-file and identity hashes,
4 MiB slicing, resume comparison, part/commit checks and abort gates remain.
Removing one async digest may shorten time to send; the immediately-before-send
abort check remains after synchronous base64 encoding.

## Supersession and ownership

| Classification | Scope |
| --- | --- |
| KEEP | Complete journeys above; all guards, forms/IME, draft clearing/restoration, model/attachment selection, locale, citation focus, revision/authorization withdrawal, transport and checksum validation. |
| CHANGE | Only draft subscription location and callback propagation of the computed part hash. |
| REMOVE | Parent renders caused solely by typing; second SHA of each transmitted Web attachment slice. |
| EXCEPTION | None to product policies or account isolation. Existing legacy API branch is retained, not expanded into compatibility work. |
| UNKNOWN | Real browser INP, physical devices, live-model quality/network latency are not established by DOM counts or generated fixtures. Rolling-URL starvation is a separate design-only deliverable. |

Minimum product edits: `apps/web/src/Conversations.tsx`,
`apps/web/src/upload-part.ts`, `apps/web/src/note-attachments.ts`.
Read-only consumers: AnswerMarkdown, shell-components/AnswerView,
ConversationShell, import-upload-scheduler, resource-cache/useResource,
main/operation-feed and existing Web fixtures. New D-only tests belong under
`apps/web/test/`; design/evidence docs use `docs/design/performance-round1-D-*`.
No Server/shared/protocol/helper/root package or lock changes.

Inspected current source, existing Markdown tests, read-state-closure and
multiuser model tests, import/attachment tests, built-main hidden
ask-loading-browser fixture, background-refresh documentation and development
rules. These encode the retained boundaries; no ADR or prompt responsibility
is superseded. No new translation keys.

## Validation and resources

1. Generated DOM fixture through actual Conversations/AnswerView/AnswerMarkdown:
   1/20/100 loaded turns and 10 input updates. Count unchanged answer renders
   and actual Markdown parse passes separately; assert zero after baseline for
   typing. Instrumentation stays test-only. DOM time is diagnostic, never INP.
2. Draft/input states: controlled send-enabled state, IME Enter, Shift+Enter,
   form submit/current value, disabled pending draft, terminal success/failure,
   retry, cancel, new/select and API/account retirement; existing actual shell
   and no changed lifecycle entry points. Background refresh, old-page merge,
   evidence withdrawal and locale updates/citation focus remain covered by
   focused existing tests plus new assertions as needed.
3. Web attachment generated 1 B, 4 MiB and 4 MiB+tail fixtures: independently
   compute the original exact JSON/base64 wire and assert byte-for-byte equality;
   digest instrumentation proves one slice SHA, while full-file SHA remains.
   Cover matching resume, damaged resume receipt, lost ACK recovery, bad part
   checksum/index/bytes, bad immutable account/commit receipt, abort before and
   during part transport, and no commit after failed/aborted part. Exercise
   uploadChatImage and uploadNoteAttachment; run existing legacy attachment and
   import scheduler consumer tests.
4. Build only actual prerequisites and Web; Web typecheck and focused Web
   tests; run existing generated `ask-loading-browser.cjs` against built main
   with hidden Electron, independent profile, loopback port 0. No Server suite,
   complete check:affected/check:local, AVD, physical device or model calls.
   `check:affected -- --dry-run` only documents final driver's selected scope.

Every install/build/test/benchmark uses the campaign run-resource.py as owner D.
Install/build/browser/scaled render probe use heavy; small focused tests/type
checks use light. One command at a time per owner. Independent node_modules and
dist in this worktree; external D/tmp, D/artifacts, D/profiles for task outputs.
Preserve existing driver lock. Capture exact inputs/commands/results, resource
lease cleanup and unverified scope in D/status.json and draft PR. Final combined
check:affected and main integration belong solely to the controller.

Risks: stale draft closure (read store at submission), missing offscreen draft
(store outlives wrapper), programmatic clear not notifying composer (store
subscription), account leak (new store per existing keyed session/API reset),
locale freeze (no memo/cache), and part hash accidentally trusted from remote
(only locally computed hash passed; acknowledgement still independently compared).
New tests strengthen coverage without changing old assertions, entry points,
limits, timeouts or success criteria.
