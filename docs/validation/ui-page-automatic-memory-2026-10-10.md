# Structured page automatic Memory validation · 2026-10-10

This validates the intake wiring in [the ADR](../adr-ui-page-automatic-memory.md).
It does not change the personal extraction/review admission policy or establish
daily-event recall completeness.

The later owner-approved daily-event policy and its own live/fixture evidence are
recorded in [daily-event validation](daily-event-memory-2026-10-10.md). These five
intake regressions explicitly select the original personal recipe to isolate the
intake contract from event admission.

## Environment and evidence boundary

macOS, Node 26.11.1; an isolated temporary vault and generated article/product
fields. Requests use the real authenticated `buildApp` HTTP routes, store,
organizer, Memory queue, packages, evidence reader and publication fences. The
model agent is a deterministic fixture using the real supplied evidence reader;
it does not prove live-model semantic quality. Background workers are disabled in
these cases so publication and Memory drains can be driven across controlled
restart/review transitions. Existing screenshot fixture regressions remain in the
full suite. No personal captures, production vault or physical device were used.

## Journey coverage

| Journey/state transition | Verified result |
| --- | --- |
| Gzipped bundled article/product upload → archive → publication → restart → Memory | Both fresh inputs receive pinned authority; the existing bounded package extracts and independently reviews before publication. |
| Scoped input versus incomplete source | Ready `source-body` is eligible; the material still reports `partial / visible_window`; whole-material requirements and explicit privacy denial remain enforced. |
| Automatic Memory → original query | Captured fields and metadata remain exact; query catalog/read grants the original evidence. No OCR, image input or screenshot is fabricated. |
| Duplicate upload and second restart | ACK replay and restart do not add receipts or repeat completed extraction/review. |
| Preexisting archive → startup/replay/rebuild | Originals remain queryable without retroactive automatic authorization. Organizer-version rebuild tests also compare all existing receipts and grants unchanged. |
| Recipe change before extraction | Prior authority is revoked; a later new arrival uses the source-selected recipe. Existing archived inputs are not granted that recipe. |
| Zero candidates | A zero-result draft is independently reviewed and checkpointed once, rather than forcing a personal claim. |
| Delete original during independent review | Late publication is fenced; neither Memory nor the deleted original/material survives. |
| Change source recipe during independent review → restart | Late publication is fenced; originals remain queryable and no historical authorization appears after restart. |

## Executed checks

- `node --import tsx --test --test-timeout=120000 apps/server/test/ui-page-memory.test.ts`: 5 passed, 0 failed.
- Targeted screenshot processing and field organizer-backfill regressions: 26 passed, 0 failed after separating the shared capture-intake hook.
- `npm run build:libs` and `npm run typecheck -w @mote/server`: passed.
- Full repository `npm run check:local`: exited 0. i18n, shared-library builds,
  all workspace/script type checks and the test chain passed; 2 existing
  platform/opt-in tests were skipped. The new 5 journey tests ran in this full
  check as well. Skips do not establish physical-device or live-model validation.
- `git diff --check`: passed; all 195 local Markdown links across the 7 changed
  documents resolve.

## Unverified

Physical Android App/page compatibility, capture permissions and lifecycle, live
model admission/summary quality, real-user daily recall completeness, production
latency and deployment are unverified. No Android payload, adapter, UI or APK is
changed by this central wiring. Selecting an event-focused recipe and any broader
daily-memory policy remain owner product decisions.
