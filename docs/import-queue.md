# Import admission queue

The Web import workflow admits a frozen batch of related files or a central-server directory into a connection-owned queue. Admission returns immediately, leaving the next draft editable. Two batches can upload or create their server jobs at a time. Parsing, preview confirmation, record storage and memory extraction continue through the existing durable server execution queue; they do not consume browser admission slots.

`ImportQueue` owns scheduling, per-batch upload identities, an immutable create request ID, cancellation fences and observable snapshots. `ImportSource` describes transport inputs independently from scheduling; new source transports can extend that discriminated union and admission execution without changing the view's draft or server processing rules. Existing file transport still verifies hashes, resumes fixed parts and rotates between files within a batch. Committed originals are cached per File identity, so retries advance beyond completed prefixes even across repeated transport interruptions. Each transport request has a three-minute deadline; failures release admission slots and require explicit retry. Central has no HTTP request quotas or fixed upload/queue count caps. An upstream gateway HTTP 429 uses its Retry-After delay (one minute if absent) to apply connection-wide admission backpressure and resume automatically without changing request identities. Waiting tasks can still be paused or removed. A retried create request retains its exact payload and request ID, so a lost response does not manufacture another job.

The application connection owns queue lifetime. Page navigation only changes subscribers, while logout or a connection change aborts requests and clears local File references. The generation fence rejects late responses after teardown, including transports that ignore cancellation. The queue may restart after a development Strict Mode lifecycle; completed admissions release their File references, and server history acknowledges and removes their temporary queue entries.

Pause affects a queued/uploading batch. Removing an admission aborts its local transfer and preserves archived originals. Creating a server job must settle before the admission can be removed; accepted server jobs use the existing explicit cancellation and deletion actions. Preview confirmation, media controls and Memory actions lock only the selected server job, and late results never change the current selection or draft.

Browser-selected files remain in memory for the current browser session. This version continues across application page navigation, but does not persist local files through a browser refresh or restart. Originals already archived on the node and accepted server jobs remain server-owned. The UI explains this boundary. No new vault schema, content classification or model routing is introduced.

Recoveries follow browser exception names and authored server protocol codes. A missing/unreadable local file offers file reselection. Directory enumeration returns `import_directory_missing`, `import_directory_unreadable` or `import_directory_required` with safe guidance and an edit action. Editing a rejected source restores its import settings in the draft and creates a fresh request on resubmission. History read errors retain a refresh action; an individual admission error belongs to its queue item.

## Validation

Generated-only queue and DOM fixtures cover bounded admission, immutable batches, independent job controls, pause/resume, discarded admissions, lost responses, original/session identity, preview slot release, page navigation, connection teardown, late responses and source-specific recovery. Server fixtures verify directory codes before admission and safe HTTP errors. `scripts/test-web-tasks-imports.cjs` runs the built Web app in Chromium against a generated-only real central node, including concurrent admission, navigation, resumption, missing-directory recovery, original retention and desktop/mobile layout. It captures only that fixture window. Physical devices and live models are outside these checks.

The local test runners bound desktop workers to two and server test files to four. Desktop filesystem fixtures have a 15-second default timeout, with 90 seconds for the fixture that durably stages and drains 400 records. HTTP import fixtures poll at 250 ms while asynchronous processing settles. All assertions and production limits are retained.

## Parser preflight and disposition failures

The import Agent writes both `records.jsonl` and `dispositions.json` before running
`mote-files.mjs validate`. Preflight checks every supplied input is listed exactly
once, disposition paths are supplied inputs, evidence paths are `parsed`, and
attachments are `parsed` or `attachment`. The helper and Central share the path
accounting and reference/status rules. Central independently verifies original
bytes and validates the result before publishing a preview. A contradiction
reports the physical JSONL line (including blank lines), reference field, actual
and expected statuses, and workspace-relative input path. It does not publish a
partial preview or insert records.

A failed preparation retains archived originals for an explicit retry. It does
not add an automatic model retry; the Agent can repair preflight errors during
its existing writable analysis session. Existing parsers that omit dispositions
still follow Central's warning and manual-review behavior; the bundled Agent's
preflight requires the disposition file. Attempt files are cleaned up as before;
the job retains the actionable error rather than the temporary converter or
personal text.

Generated regressions in `import-runtime.test.ts` compare helper and host failures
for evidence/status conflicts, invalid attachments, missing, duplicate and unknown
inputs, combined evidence and blank-line numbering. They also run the helper via
Node's CLI. `imports.test.ts` verifies a later conflicting record cannot partially
publish, originals survive, and an explicit retry can preview and confirm the
corrected records. Live-model retries of owner-selected files are separate checks.
