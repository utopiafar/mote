# Native Memory topics — Android slice

Android consumes the existing context-tree directory and reference pages. The same Memory ID can appear under multiple trees; bodies remain in the existing Memory detail/original reader. Classification and authorization stay on the host.

Only navigation IDs, page cursor stack and scroll offset enter same-origin Activity saved state. A reopened detail is fetched again. Missing selected topics clear the whole derived view. Offline directory reads clear list members; a transport failure while editing an existing owner correction preserves its unsaved fields. Permission failures clear that content. Returning without saving never creates a fact.

## Shared hooks

- CentralLibrary: memory(id, returnTo?) retains the topic return callback through correction/delete; saveTopics/restoreTopics/pollTopics/clearTopics delegate to the new module.
- CentralScreens: Bundle delegation, foreground polling and private-state reset.
- CentralContent: same-origin Bundle restoration and the existing refresh scheduler. CentralActivity is unchanged.

Merge these method fragments with the independent discovery/material owners; never replace their files wholesale.

## Evidence (2026-10-26)

- Development APK and instrumentation APK build passed; MemoryTopicNavigationTest: 4 JVM tests passed.
- Dedicated emulator 5582 with a newly created AVD and generated-only HTTP service 47894: 4 instrumentation journeys passed. Covers same Memory in two trees; 32-member pagination; Activity recreation in list and detail; original/Memory/topic return; input deletion invalidating all derived labels; offline/403 clearing and retry; empty results; unsaved correction preserved through an offline poll and cancelled without publication.
- Initial fixture reset failed with 409 because its deletion review receipt was missing. Added the current synthetic deletion snapshot receipt and reran only those two blocked journeys successfully.
- Actual product view screenshots inspected; no personal screenshots or credentials captured. i18n check: 8664 messages; git diff --check passed.
- Activity recreation is verified, not OS process-death restoration. No physical Android device, production classifier trigger, or live-model quality claim. Mac native consumer is a separate next slice.

Fixture command: node --import tsx scripts/fixtures/native-topics.ts. Opt-in instrumentation requires topicsFixture=true and topicsPort=47894, a development application and an emulator. The fixture owns a fresh temporary data directory and exposes no real model.

## Independent review follow-up

Directory visibility no longer validates an open Memory. The rendered detail records its stable ID/version/status/fingerprint; polling separately re-reads that ID, including while its original is open. Deleted, denied, stale/superseded or changed details clear their original content and invalidate pending callbacks. The original reader rechecks the selected Memory before rendering its response. Existing Central session/view generations continue fencing callbacks.

Only fields actually edited by the owner are retained separately under “Unsaved changes” when invalidation clears the original; the old-version save action is removed. An invalidated view does not automatically redraw over those edits on a later poll. Transport-only outages keep the existing correction form unchanged. No new persistence or authorization policy was added.

Incremental validation: 2 new JVM detail-identity tests passed; development and instrumentation APK builds passed. Two actual emulator/HTTP regressions passed: all-memory view remains available through another Memory while selected detail is deleted, per-Memory denied or corrected; a held original response cannot restore withdrawn content. After adding edit preservation, only the affected first case was rerun, then rerun after the follow-up-poll guard with a further 6-second wait: passed, including retained actual owner edit and no old save action. The earlier successful journeys were not repeated. i18n 8675 and diff check passed. Fixture reset now also clears synthetic correction replacements so subsequent 32-record runs remain isolated.
