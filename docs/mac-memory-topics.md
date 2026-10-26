# Mac native Memory topic reader

The Content page opens a native Electron topic dialog. The host catalogue supplies multiple trees and stable Memory references; no classifier or body copy is introduced. Topic/node selection, cursor history and exact detail return live only in renderer memory. Closing/reopening keeps the current page; renderer/app restart reads current server state rather than restoring cached private bodies.

## Shared interfaces and review

New fixed commands: memoryTopics(), memoryTopicPage({treeId?,nodeId?,cursor?}), memoryTopicDetail(id), memoryTopicEvidence(memoryId,evidenceId). They use existing Central credentials and browseWithConnection; there is no arbitrary-URL bridge. UUID/tree syntax, bounded responses and no redirects apply.

Coordinator approved the evidence command on 2026-10-26: first read the Memory and verify evidence membership, then read that fixed capture ID. Check the captured connection after both awaits and again at the outer result boundary. The existing device-limited centralContentDetail/captureDetail interfaces are unchanged. An initial actual UI attempt exposed their device restriction; it was not relaxed to make the fixture pass.

Shared file edits are additive: contracts/preload/main named handlers; content-library-ui only the entry callback; ui/index only initialization, status invalidation and dialog container. Preserve independent Ask scope and connectActionCalendar fragments when integrating.

## Verification

- 14 focused tests initially passed (topic transport/navigation plus existing content reader); added member-bound evidence and two-fence regression then reran its affected transport file: 4 passed. Final TypeScript check, renderer bundle, i18n (8675 messages), diff check passed.
- Actual hidden Mac product window, actual preload/IPC and HTTP to the generated Central fixture from Android slice #255: two trees share the same Memory ID; Memory/original/return; 32-item pagination and close/reopen; HTTP 503 and 403 clear old labels/members and explicit retry works; deleting one dependency hides the entire derived batch; empty; renderer reload fetches current content.
- A fresh second Mac process verified current reads, 820x620 layout, and removal of IPC error wrappers. Generated screenshots inspected. Capture stayed stopped. This is synthetic classifier output, not live-model quality or whole-machine network-off testing. Android evidence remains separate.
- Full desktop build reached iconutil then failed under sandbox; the same local iconutil action succeeded with normal approved execution. TypeScript, renderer assets and native helpers had already been generated; no build logic was changed.

Run the isolated generated service from #255 with `node --import tsx scripts/fixtures/native-topics.ts`, then `electron apps/desktop/scripts/memory-topics-smoke.cjs`. Optional MOTE_TOPICS_LAYOUT_ONLY=1 runs just the follow-up layout/error check. Service port 47894 is dedicated to this fixture. No personal profile, model or calendar is accessed.

No selection persistence, automatic Memory correction, authorization redesign or calendar execution was added. Production topic scheduling remains the core owner's separate integration.
