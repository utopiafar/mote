# Central task recovery regression scenarios

This change follows owner approval for precise validation feedback, current
organizer generations, AppleDouble exclusion with originals retained, one explicit
index retry, and three same-conversation output corrections.

## Supersession check

- KEEP: strict original quotes, independent Memory review, scoped read-only query
  tools, existing outer retries/replanning, original retention and total deadlines.
- CHANGE: JSON/citation/host-output validation shares a maximum of three correction
  turns per run; corrections receive the latest error on the original session.
  Dedicated import preview correction uses the same ceiling without repeating
  analysis. Current organizer progress reflects its saved generation.
- REMOVE: the single-correction ceiling and active legacy organizer memberships
  that made historical input changes affect current completion.
- EXCEPTION: source changes, authorization, transport and provider failures are
  not output corrections. AppleDouble receives an explicit terminal exclusion,
  not a successful image product. Old failed attempts remain historical.
- UNKNOWN: the real-model improvement from the additional two correction turns;
  generated protocol tests prove control flow, not model quality or cost savings.

## Generated regression coverage

| Journey/state transition | Required assertion | Test entry |
| --- | --- | --- |
| Held organizer input is revised, deleted or gains an attachment | New generation completes; old stale step stays historical | `material-organizer-backlog.test.ts` |
| Restart with legacy active memberships; latest generation succeeds or fails | Only saved generation determines current progress; no replay | `material-organizer-backlog.test.ts` |
| Extraction/review has an invalid exact quote | Numeric candidate/span feedback reaches the live session; rejected output never publishes | `memory-work-packages.test.ts` |
| Three successive output issues, success on fourth candidate | One Codex thread / Harness session; latest feedback each time; immediate stop | Agent `codex.test.mjs`, `output-limit.test.mjs` |
| All four candidates invalid; cancellation or deadline during repair | No fourth correction; original deadline/cancellation remains effective | Agent `codex.test.mjs`, `output-limit.test.mjs`, `import-lifecycle.test.mjs` |
| ZIP/direct import contains AppleDouble bytes under a misleading image suffix | Original retained; excluded disposition; no model or image work | `import-media.test.ts` |
| Valid generated PNG has a `._` name | It processes normally | `import-media.test.ts` |
| Synchronized metadata and legacy failed image, followed by restart/retry | Current image/file operation skipped; failed receipt retained; no provider call | `image-processing.test.ts` |
| Owner opens image/file processing detail | Reason and retained original visible; no ineffective retry controls | Web `image-exclusion.test.ts` |

No physical device, personal screenshot or live model is used in these fixtures.

## Verification on 2026-10-10

- `npm run check:local` passed on the complete implementation. Server, web and
  Agent suites passed; the existing installed-Codex fixture remains skipped.
- An independently exported release of commit `546fbb7b8423e88437d8fba62ea324a5a1872ac6`
  passed `npm run build:central` and was selected by the running native central
  profile. Its health endpoint returned 200. Upgrade retained a consistent
  pre-upgrade vault backup.
- Read-only runtime checks found 14 AppleDouble exclusions: both the image and
  parent file operations were skipped, all original hashes were unchanged, and
  authenticated image detail reported every original ready with its exclusion
  reason. All 28 old failed image receipts retained their state and attempt count.
  The other 14 images remained successfully processed.
- All 63 stale organizer steps present immediately before upgrade remained
  historical and had no active operation membership afterward. All 1,218 current
  organizer operations were successful at verification time. These are snapshot
  counts, not a guarantee that later source revisions cannot create new work.
- The explicitly retried material remained indexed with no error. Index retry
  and metadata exclusion do not invoke a model. Interrupted Memory batches
  retained their pending work; the restarted scheduler was running three batches.

No physical device validation or controlled live-model comparison of one versus
three corrections was performed. Ordinary pre-existing live Memory work continued
after the upgrade; it is not a quality experiment for the new correction ceiling.
