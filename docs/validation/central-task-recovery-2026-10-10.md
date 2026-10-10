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
The authorized live index retry reached `indexed` without a model call. Runtime
deployment and current-operation reconciliation must be verified separately.
