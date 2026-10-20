# D browser fixture entry delta

Identity D-browser-v1. Frozen campaign base
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`; product/test candidate HEAD
`28a849f565e6ea624d422bbd4102e10d25383aec`.

The unchanged built-main `ask-loading-browser.cjs` failed before entering Ask:
all history/detail/owner/feed counters were zero and main displayed signed-out
UI. It seeds an obsolete sessionStorage bearer token. Current Web main discovers
a Cookie session through `/api/auth/self`; it does not accept that token. This
is fixture setup debt, not evidence of a composer regression. Existing DOM tests
and Web build pass. The baseline performance probe now correctly confirms
10/200/1000 old-answer renders and real Markdown parses before this change.

Propose one new D-owned `apps/web/test/performance-round1-D-browser.cjs` derived
from the existing generated-HTTP fixture. Preserve its complete original cold
history/detail, restored conversation, capture/file/import/query refresh,
five-second owner poll, draft/focus/DOM, explicit refresh, other-conversation and
Media/Activity/RecordTimeline assertions, delays, gates and 28-second deadline.
Do not edit the existing fixture or any product source.

Only entry/setup changes: use main's actual visible login controls in a hidden
renderer; generated local HTTP `/api/auth/login` validates generated credentials
and sets an HttpOnly Cookie; `/api/auth/self` supplies the immutable generated
Web identity; all subsequent generated API requests require the Cookie and
matching session/CSRF headers. Replace the old model/device fixture endpoints
with `/api/models`, `/api/models/selection/chat`, `/api/ingress/devices` as used
by current ScopedAsk. No server or production credentials, no real model calls.
This validates the current renderer's real login/discovery/request entry, not
Server authentication implementation. Output goes to D/artifacts/browser, and
the existing background fixture still hides windows and rejects dialogs.

KEEP: all original journey assertions, real polling/delay/size requirements,
deadline, built main, local port 0, generated data, hidden window, network fence,
natural close and temporary-profile cleanup. CHANGE: obsolete bearer bootstrap
becomes current Web UI Cookie-session entry with required generated endpoint
shapes. REMOVE: sessionStorage token seeding. EXCEPTION: none to product policy
or tested success criteria. UNKNOWN: Server authentication, actual supplier/
model/device and INP are not proven by this generated HTTP renderer fixture.

Only D owns this new test and design doc; no shared helpers or Server paths are
modified. Run through exclusive heavy resource gate against the already built
candidate; report the obsolete fixture failure separately. A setup/control
correction preserving this approved entry and assertions needs a recorded delta
and focused rerun; any changed coverage or relaxed success/deadline needs review.
