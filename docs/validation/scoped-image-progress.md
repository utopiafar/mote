# Scoped original image progress

This is a narrow ImageProgress handoff, not an M13 or Joint final freeze.
M13 explicitly authorized exact baseline
`9565bc7fbec0d0ee90ce47ed49d8f7df75af1abf`, including the declared Joint
`a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695` contracts. No later owner WIP was taken.
The PR targets `codex/mote-multiuser-integration`; no main merge or deployment.

## Boundary and wire

KEEP the original Files, LibraryBrowse and evidence-detail ImageProgress entry
points, five separate original/OCR/understanding/Material/Memory states, explicit
unknown confirmation and separate complete/recompute actions. CHANGE the missing
legacy route to a host-authenticated presentation of M03 originals, M05 tasks,
M06 publications and M07 intake/job receipts. REMOVE the assumption that an
original, OCR success or Material publication implies Memory completion.
EXCEPTION: external OCR/language transports in tests return generated responses.
UNKNOWN: this receipt does not establish real-model semantics or the later Joint
custom-profile/attachment processing chain.

`GET /api/images/:captureId` returns:

- `proof`, bound to deployment/user, original/hash, persistent original generation,
  processing control generation, applied policy and attachment generation;
- `original.state`, `automatic`, `understandingEnabled`, `enabled`,
  `processingRequired`, `policy`, `wait`, `canCancel`;
- `jobs[{name,state,error?}]` from the latest admission's original/file/settings/
  policy/attachment fences; no admission means no historical task scan;
- `products[{id,name,kind,text}]` and `materials[{id,state}]` from visible M06
  publications; `memory[{state,count,error?}]` from exact M07 material receipts.

`POST /api/images/:captureId/retry` requires
`{proof,operationId:UUID,mode:'complete'|'recompute',confirmUnknown:boolean}`.
It uses the existing M06 retry transaction, durable operation receipt, M05
physical-call/unknown checks and file-control fence. `complete` reuses successful
OCR and schedules only missing derivatives; fully complete work is a no-op.
`recompute` uses the existing fresh generation and calls the processors again.
The same operation ID/body recovers a lost admitted ACK. The Web stores only its
owner-bound command in `mote.image-retry.v1`, separate from file retry intent.

`POST /api/images/:captureId/cancel` requires `{proof}` and uses existing M06
cancellation. Source disable/deletion, foreign data and stale proofs reject before
new admission. Administration does not grant another user's private projection.
No second pipeline, scheduler, ledger, provider configuration or model store.

M03's existing `ig_file_generations` also records raw-image capture retirement
under reserved source key `@capture` (not a valid external source ID). The counter
survives capture/source deletion, so first GET → delete → identical raw ID/bytes
cannot revive an old proof, ticket or admitted M06 input. Account lifecycle already
erases this counter table. Existing Files forget/allow-again intent is unchanged.

## Acceptance evidence

Exact baseline RED: the original `FileDetail` with generated M03 image data
failed to expose its image progress controls and rendered
`scope_unavailable`. The identical journey passes with this thin fix.

`TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test
apps/web/test/multiuser-image-progress.test.ts apps/web/test/image-exclusion.test.ts`
exercises actual scoped application services and the original React components:

1. Original Files detail, generated same-ID A/B, genuine OCR and Material,
   admitted ACK loss/remount/replay, complete reuse, recompute, cancel, restart,
   A/B isolation, real list pagination/cursor ownership and source disable.
2. Account and selected-image changes, ignored aborts, delayed response and empty
   selection cannot publish old content or retain actionable old controls.
3. Raw screen (Files correctly returns 404), first GET/delete/same-ID reintake,
   persistent proof changes, unknown physical outcome/restart without replay,
   original UI checkbox confirmation, successful retry, deletion and B positive.
4. Real generated OCR and Anthropic transports: failed understanding is retried
   without another OCR call; all-success complete calls neither provider;
   recompute calls both. No helper-seeded success or numeric fake completion.
5. Existing metadata exclusion regression remains green.

Supported hidden IAB also used the built original Web UI: username/password →
Files list → image detail → complete; OCR and Material became ready while Memory
remained waiting. Switching through the original account settings to same-ID B
showed historical-unscheduled OCR and waiting Material, without A's result.
Generated fixture runner: `node --import tsx scripts/scoped-image-progress-browser.ts`.
Screenshot is local `../image-progress-iab.jpg` (generated-only, not private data).
ImageProgress source SHA256:
`57e0a4a44e606e77d599c34c48fe134a3b7c5c07937965043f1c8c5e9d286787`.

Independent review found and corrected: accidental audio recipe selection for
image reuse; historical success masking current work; redoing successful
understanding on complete; raw capture incarnation reuse; and attachment binding
proof omission. The last attachment change reuses the existing M03 binding only;
this does not claim later Joint attachment/profile WIP acceptance.

Scope inventory, production import boundary, `git diff --check`, focused tests,
Web/server type checks and `build:central` have passed during development.
The full required affected gate is recorded separately below when it terminates;
these bounded receipts are not a whole-platform final acceptance claim.
