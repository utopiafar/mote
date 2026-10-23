# Omission audit and regression priorities

## What this document establishes

The owner reported that R29 lost import explanation/context, incorrectly made Central synchronize its own folders, and remained too dense across pages. This document records the source-backed semantics those reports put at risk. It does **not** claim that the inventory agent independently ran R29 or every later candidate. The separate evaluator owns rendered-candidate findings and per-round scores.

The independent source contract is frozen at current application SHA `81a73c0ec81af876d6eeef71451b75cd51684b34`. Its 188 feature IDs, per-feature inputs/actions/outcomes, platform scope and representative adversarial journeys are in `user-features.json`, `user-features.md` and `journeys.json`.

## Why the historical “78/78” count is insufficient

A directory unit says that an area exists. It does not prove that all of the area’s controls still work. For example, C09 includes file/folder/ZIP selection, material naming and explanatory context. A02 additionally includes parser and per-import image-plan choices. C10 includes uploaded originals, parsing, preview correction, confirmation, failure recovery, partial dispositions, readable records and memory states. A candidate with an “Import” button can therefore match three directory IDs while omitting most of their user value.

The current contract retains the 20 family IDs and all 78 historical entries. **77 are mapped to semantic features; A01 is superseded by the owner’s correction.** It separately specifies 400 input requirements, 642 action requirements and 618 required outcomes. Those are evaluation checklist items, not a claim that all backend state combinations are enumerated or runtime-verified.

## Critical regression matrix

| Risk | Current source evidence | Must survive / correction | First adversarial check |
| --- | --- | --- | --- |
| Import name replaces contextual explanation | `Imports.tsx:133–138` | `UF-IMPORT-CONTEXT`: exact optional prose for format, author, subject/background, time/timezone and ownership | Mixed owner text, third-party quote and AI reply with timezone explanation |
| Explanation vanishes after enqueue | `Imports.tsx:91–97,145,176–179` | `UF-IMPORT-CONTEXT-RECOVERY`: inspect and revise the same import’s explanation | Leave/reopen failed import and regenerate preview with revised attribution |
| Parser dropdown replaces background prose | `Imports.tsx:134–135` | `UF-IMPORT-PARSER`: parser/version and contextual explanation are independent | Select Source Pack, then edit prose; both remain in submission |
| Entire batch treated as owner-authored | `AttributionContext.tsx:6–18`; `material-context.ts:16–31` | `UF-SOURCE-ATTRIBUTION`, `UF-MATERIAL-ATTRIBUTION` | Mixed source with one third-party material override; inspect basis |
| Source explanation reduced to a badge | `SourceContextEditor.tsx:83–97` | `UF-SOURCE-CONTEXT`: real editor, exact value and acknowledged version | Edit background and inspect saved source detail |
| Stale metadata overwrites a newer version | `SourceContextEditor.tsx:14–79` | `UF-SOURCE-CONTEXT-CONFLICT`: retained dirty draft and explicit reload | Competing edits in two sessions |
| Android metadata pending/conflict is hidden | `FileTaskActivity.kt:243–245,322–363`; `SourcesActivity.kt:75–79` | `NAT-005`, `NAT-006`: pending ACK and local/Central resolution | Affected files wait while metadata conflict is resolved |
| Central owns a local folder watcher | Owner correction; `DeviceOverview.tsx:23–36` | Remove historical A01 and all Central disk-collection affordances; collectors own local files | Central user requests continuous folder sync and reaches Mac/Android handoff |
| Browser folder upload disappears with server directory removal | `Imports.tsx:130–137` | `UF-IMPORT-SELECTION`: selected local folder remains a one-time upload | Choose browser folder, remove one file, submit exact remainder |
| File-source options compressed into “sync on” | Mac/Android native audit | `NAT-003`–`NAT-013`: initial history, retention, continuous scope, filtering, interval and per-source recovery | Reference-only vs snapshot vs archive with first-sync options |
| Snapshot and archive called the same thing | `sources.ts:134`; native file-source controls | Retain original availability and extracted-body policy separately | Device offline after snapshot temporary original cleanup |
| Pause actions affect the wrong scope | Native controls; `Sources.tsx:80` | `NAT-001`, `NAT-002`, `NAT-013`: capture/source/sending independent | Pause source while unrelated queued upload proceeds |
| Privacy mode becomes one checkbox | Native privacy and held-review controls | `NAT-017`–`NAT-025`: app policy, masks, exact text gate, uncertain hold/drop/allow and held-record recovery | Change rule without silently releasing previously held evidence |
| Received is represented as fully ready | `Imports.tsx:159–167`; `CodingUploads.tsx:52–59` | Separate originals, body, index and memory | Audio received, extraction failed, memory disabled |
| Unsupported input silently omitted | `Imports.tsx:148` | `UF-IMPORT-DISPOSITIONS`: per-file outcome and reason | ZIP with parsed, attached, excluded and unsupported items |
| Missing model means re-upload or lost draft | `Imports.tsx:153–158`; `WorkIssueNotice.tsx:39–41` | `UF-IMPORT-RECOVERY`, `UF-MODEL-ASSIGNMENTS` | Configure missing module and return to same archived import |
| Retry creates a duplicate unknown request | `FileProcessingControls.tsx:73–83`; `Conversations.tsx:190–204` | `UF-FILES-RECOVERY`, `UF-ASK-RUN-RECOVERY` | Lost response followed by retry of identical operation |
| Failed speaker separation loses transcript | `Files.tsx:122–132`; `FileProcessingControls.tsx:82–85` | Preserve raw transcript and retry only relevant step | ASR succeeds, diarization fails, summary remains independent |
| Readable body blocked until memory/index complete | `Materials.tsx:107–120`; `LibraryBrowse.tsx:118–136` | `UF-MATERIAL-BODY-REVISION`, `UF-MATERIAL-INDEX-RECOVERY` | Read partial published material with failed index |
| Contextual settings lose original task | `WorkIssueNotice.tsx:39–41`; native unsaved navigation | Named task return and draft preservation | Open settings from blocked import, save, return to that import |
| Device pairing presented as full account login | `DevicePairing.tsx:38`; `ClientLoginApproval.tsx:14–20` | Device collection credential vs private library/account access | Pair device, then inspect separate Ask login requirement |
| Native parity invented from common labels | Current native audit | Mac-only coding, Android description conflicts, platform-specific page modes | Switch platform and inspect supported/not-applicable rationale |
| Density reduced by deleting secondary functions | All source-audited controls | Preserve labeled progressive disclosure and state-specific actions | Inspect major page, then intentionally open each task-relevant detail |

## Major page coverage expected from the evaluator

Review at least the default and task-detail states of the following workspaces. A major page is an information architecture surface, not one historical source file.

| Workspace | Primary work | Required secondary depth |
| --- | --- | --- |
| Library/content | Find, filter, read and return | Versions, provenance, originals, attribution, partial/index states, source links |
| Add/note/import | Select and submit intended material | Context explanation, parser/image override, exact selections, draft/queue recovery, preview confirmation |
| Sources/devices | Choose and manage the correct intake | Native/platform boundary, source context/conflicts, external ranges, authorizations, versions, per-source pause |
| Ask | Compose, follow progress, inspect citations | History, model override, attachments, stop/retry, deleted/stale evidence, return to same conversation |
| Activity | Find attention and results | Goal/stage, precise cause, branches/evidence, task-owner recovery, technical steps when needed |
| Memory/insights | Read and generate evidence-backed outcomes | Scope, corrections, versions, manual recipes, clarification, independent processing state and report coverage |
| Actions | Todos and confirmed calendar proposals | Target device/calendar, fixed review, unknown-result verification, no duplicate calendar writes |
| Settings | Configure one purposeful category | Provider/module distinction, saved/effective/draft state, image/file policy, plugins, storage, export, usage, diagnostics |
| Native capture/privacy | Decide what to record | Modes, permissions, masks, held review, power/sampling, clear collection vs sending scopes |
| Native file/sync/storage | Control local collection and destination | History/retention/filtering, offline queue, receipt/conflict/reupload, local cleanup/backup/update |

## Required critical journey IDs

The following are the first checks to run after the freeze; they supplement rather than replace the full contract:

- `J-IMPORT-CONTEXT` and `J-IMPORT-CONTEXT-RECOVERY`: explanation survives selection, enqueue, detail, reinterpretation and return.
- `J-IMPORT-PARSER`, `J-IMPORT-IMAGE-PLAN`, `J-IMPORT-DISPOSITIONS`: advanced choices and partial input outcomes remain meaningful.
- `J-PRODUCT-BOUNDARIES`, `J-EXTERNAL-REFERENCE`, `J-DEVICE-REPORTED-STATE`: no Central local-folder collection claim.
- `J-SOURCE-CONTEXT`, `J-SOURCE-CONTEXT-CONFLICT`, `J-NAT-005`, `J-NAT-006`: source explanation and version/acknowledgment recovery.
- `J-SOURCE-ATTRIBUTION` and `J-MATERIAL-ATTRIBUTION`: source defaults and per-material corrections preserve third-party speech.
- `J-NAT-002`, `J-NAT-003`, `J-NAT-008`, `J-NAT-009`, `J-NAT-013`: native file choices and independent pause scopes.
- `J-NAT-017`, `J-NAT-022`, `J-NAT-023`: app privacy and held-review recovery.
- `J-IMPORT-RECOVERY`, `J-IMPORT-STAGES`, `J-FILES-PROCESSING-STAGES`, `J-MATERIAL-INDEX-RECOVERY`: originals/body/search/memory stay separate.
- `J-WORK-CAUSE-RECOVERY`, `J-MODEL-ASSIGNMENTS`, `J-MODEL-TEST-DRAFT`: repair the actual missing model condition without losing the originating task.
- `J-ASK-EVIDENCE-HISTORY`, `J-ASK-RUN-RECOVERY`, `J-MEMORY-CLARIFICATION`: context returns and exceptional states beyond a happy path.

## How to report actual coverage

For each round, retain the frozen feature ID and record every applicable input/action/outcome that was observed, partial, missing, blocked or not exercised. Include the fixture state, platform, actual user steps and resulting artifact/screenshot/DOM evidence. A not-applicable decision needs a platform or capability reason from the contract, not a convenience exception.

Do not combine directory reachability, semantic preservation, observed journey completion, visual density and production integration into one opaque “coverage” percentage. If a percentage is useful, name its denominator and distinguish those layers. A prototype may preserve a feature’s intended interaction with a fixture while its backend integration remains untested; report both facts.

No baseline omission beyond the owner’s stated findings is claimed as observed by this inventory agent. The matrix above is a source-backed audit plan. Candidate-specific findings must be added by the independent evaluator in that round’s evidence and evaluation records, leaving the frozen requirement list unchanged.
