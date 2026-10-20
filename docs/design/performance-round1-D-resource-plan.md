# D design only: rolling-window slow reads

Identity: D-resource-v1. Investigated base/head:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
No resource lifecycle implementation is authorized in round 1. This proposal is
independent of the composer/hash implementation plan and does not approve a
second-round start. D remains the sole source owner.

## Original journey and confirmed gap

Web main advances visible-page revision every 30 seconds; rolling periods
produce a new exact `after/before` URL. A `useResource` subscriber uses
`[api,path]` identity. Changing URL unsubscribes the old Resource; its final
observer aborts the request and advances generation. Existing `continuityKey`
retains display data only. Repeated clock changes can indefinitely cancel a
first read slower than 30 seconds. `Resource.invalidate` already coalesces
same-URL hints, so it does not close this cross-URL gap.

The legacy/non-Web main batch also aborts status/devices/activity/captures/
insights reads whenever its range/revision/page effect changes. A hook-only
patch misses that entry point. Consumers include ScopedSummary recent captures,
ActivityCollection, Media and Memories. Memory detail freezes the opened range
and must keep doing so. Background-refresh docs explicitly retain this known
slow-first-read gap; current browser fixture has a 28-second deadline and does
not establish behavior across two 30-second ticks.

## Intended equivalent journey

Introduce an explicit opt-in logical read handle. The handle identity includes
the Api instance, resource namespace, period, device, filters, paging and every
non-clock option affecting the result. Only progressing clock endpoints are
excluded. Do not infer semantic identity by stripping URL parameters or promote
existing `continuityKey` values automatically: some consumers pass only period,
and different resources can share that string.

The handle observes the original exact-URL Resource, retaining same-URL cache
deduplication, imperative `readResource` sharing, operation-feed matching,
polling and final-observer cancellation. During a read, committed same-logical-
range URL changes update only one `desiredPath`. After the current read settles,
publish its valid result and begin the most recent URL; skip intermediate URLs.
The result must record its exact source URL, and must never mark the latest URL
as satisfied by an earlier result. A slow follow-up follows the same rule.

Identity/scope changes, disabling and unmount immediately release the previous
subscription; its final observer aborts. Existing generations reject transports
that ignore abort. React render itself must not start reads or change targets.
Use commit-time subscriptions/effects. Keep bounded unobserved handle/cache
eviction. The exact-URL Resource key remains immutable.

For main's legacy batch, separate subscription identity (`Api + verified + page
+ period` and relevant real filters) from the revision hint. Preserve the exact
endpoint combination, independent application/error handling and visibility
cadence. A clock hint must not execute the old batch cleanup. No hook-only fix
can claim this main journey complete.

## Error and refresh contract

- For P1 → P2 → P3 while P1 is pending, P1 success may end initial loading,
  followed by P3. P2 never runs. Repeated hints retain just the newest demand.
- An obsolete P1 failure cannot finish or block P3. It remains an observed
  failure, and `401` still executes existing logout. An obsolete authorization
  failure cannot leave old content visible pending P3.
- `401/403/404/410` immediately withdraw invalid content. Preserve the existing
  distinction between same-URL temporary errors (allowed cached display) and
  cross-URL errors (clear retained display). Track displayed URL to avoid
  silently weakening this rule through a stable handle.
- After withdrawal, retry/loading must not resurrect `snapshot.data`; only a
  new successful authorized read restores it.
- Explicit force refresh retains the existing cancel/restart meaning; normal
  poll/feed/revision invalidation remains a hint. Their exact call sites need
  inventory in the second-round implementation plan.
- Transfer paths at a settle boundary. A Resource can publish then begin its
  own coalesced follow-up. If other exact-URL observers remain, their original
  follow-up continues; a handle departing must not cancel those observers.

## Supersession check and owners

| Classification | Treatment |
| --- | --- |
| KEEP | Login/request authority; per-Api cache; actual rolling URLs; visible-page 30-second cadence; endpoint/limit/sort/cursor; initial loading; background DOM/selection/focus; fixed Memory detail range; same-URL sharing; poll/feed; retry; withdrawal; generation and teardown protection. |
| CHANGE | Explicit same-logical-range clock updates finish their current read, then revalidate the newest exact URL. Main revision becomes a read hint. |
| REMOVE | Pure clock changes causing final-observer teardown; requests for obsolete intermediate URLs. |
| EXCEPTION | Actual account/range/filter/page identity change, disable/unmount still cancel immediately. Explicit force refresh still restarts. No opt-in identity means unchanged exact-URL lifecycle. |
| UNKNOWN | Never-settling requests: Resource already supplies a signal so createApi's fallback timeout is not automatically added. Do not invent a new timeout/retention policy. Production latency/savings and required second-round implementation details remain unmeasured. |

Minimum possible edits are D's resource-cache.ts, useResource.ts, main.tsx and
explicit call sites ScopedSummary.tsx, features/collections.tsx, Media.tsx,
Memories.tsx, with D-specific tests/docs. operation-feed.ts should stay unchanged
because it still matches exact-URL resources; any changed matching contract
needs delta review. No Server/shared/protocol/root/helper ownership required.

Inspected source, resource-cache/resource-lifecycle tests, actual built-main
ask-loading-browser fixture, multiuser-home-browser and background-refresh docs.
No storage, worker, auth policy, data retention, Blob/encoding/compression,
package splitting or network format change is proposed. Current docs' display-
only continuity explanation would need a narrow update once opt-in scheduling
actually ships; unrelated ADRs/prompts retain their responsibilities.

## Required second-round validation

| State / real entry | Required result |
| --- | --- |
| First read takes 65 seconds; real ticks at 30/60 seconds | Original signal remains live, first result actually appears, latest 60-second URL reads next, intermediate URL absent. |
| Follow-up also slow; continuous clock/feed hints | Every started generation can finish; one latest demand; no lost final update or cancellation storm. |
| Empty/nonempty and loaded refresh | Correct cold loading; stable loaded DOM/empty state, draft, focus, selection. |
| Switch Api/account/period/device/filter/cursor in flight | Immediate cancellation and new-scope loading; ignored-abort late success/failure cannot publish; positive result for new scope. |
| P1 obsolete success/503/403/404/410, then latest retry | Latest read continues; cross-URL/error and withdrawal rules hold; no retry resurrection. |
| Multiple hooks/imperative observer same URL | Single transport; one observer cancellation leaves others; final departure stops read and polling. |
| Poll/feed/topbar together and shared Resource follow-up | Preserve each refresh meaning; no mount duplicate; settle handoff cannot cancel another observer or drop latest URL. |
| Hide/resume/unmount/reenter | No hidden periodic starts; in-flight completion allowed; original resumed cadence and cleanup/reentry revalidation. |
| Main legacy batch | Same endpoint inputs/order requirements and independent errors; no clock cleanup starvation. |

Use generated fixtures only, D resource gate, independent worktree outputs and
profiles, random loopback ports. Add a separate hidden browser scenario through
the built main spanning both real 30-second ticks; do not relax/extend the old
28-second fixture deadline. Scoped account boundaries use the existing real
Cookie login host pattern. Controlled-clock DOM tests prove state transitions,
not browser INP. Keep physical devices, live models and personal deployment
checks explicitly unperformed. Future implementation requires a fresh approved
bounded plan against its actual base/head and controller authorization to begin
round 2.
