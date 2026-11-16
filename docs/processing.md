# File, image and audio processing

Central archives originals before processing. Receipt, decoding, indexing, interpretation and Memory have separate states; a missing worker must not make an accepted original disappear. Use [materials](materials.md) for source publication and [media setup](media-setup.md) to install local dependencies and models.

## Policy and composition

File settings select archive-only, a registered processor, or a versioned composition by source and explicit MIME rules. UTF-8 text has built-in extraction; reference-only sources do not download bytes or create processing jobs. Current audio defaults to local transcription with anonymous speaker separation. File images may be archive-only while captured screenshots use independently configured Central OCR/vision.

Trusted Cordis plugins contribute processors, recipes, stages and outputs through the existing services; they do not receive a new unrestricted model client or database. `/api/import-capabilities` and the file-processing capability view report installed implementations and effective settings. Shared original identity, permissions, usage and checkpointing remain host responsibilities.

Settings changes affect subsequent work; installing a model or upgrading a processor does not silently recompute completed history. Explicit reprocessing creates new versioned products and invalidates dependent evidence as needed. A historical preview/confirmation applies only to its selected scope. An uploaded attachment can enter processing through the owner route `POST /api/records/:id/attachments/:attachmentId/processing`, after retained-byte and MIME verification.

## Import and format work

Imports retain an immutable input manifest and archived originals. Preparing a preview, confirming records and later processing are separate. Model-driven parsing can interpret owner-supplied format context, file names and dates; low-consequence correctable details should use reasonable context rather than a hardcoded semantic rule or repeated clarification.

ZIP expansion, UTF-8 decoding, reviewed manifest parsing and original hashing use bounded short-lived format workers. They validate paths, duplicates, sizes, CRC, Unicode boundaries and original-file stability. Private workspace paths and file identities cross IPC; source text and secrets do not become command-line arguments. Cancellation propagates through materialization and decoding. Partial staging retains completed originals and identities, while incomplete input sets remain explicit.

The import Agent writes `records.jsonl` and `dispositions.json`, then invokes the workspace helper's `validate`. Every supplied input is accounted for exactly once; evidence must refer to parsed inputs and attachments to permitted dispositions. Central independently verifies original bytes and the complete result before publishing a preview. Contradictions report the physical JSONL line, field and workspace-relative path, without partially inserting records. Failed preparation retains originals for explicit retry.

An import queue owns independent jobs with durable stopping points, pause/resume/cancel and bounded admission. Leaving the page does not cancel accepted work; a lost HTTP response does not create a new original identity. Parser sessions can repair validation failures inside their existing writable session; validation does not add a separate automatic model retry.

## Images

Original pixels, OCR text with geometry and visual interpretation are separate products. Hashes and versioned input identities allow reuse without merging unrelated provenance. AppleDouble metadata is not an image original. OCR can tile a long image within current limits and retains original-coordinate polygons; repeated text in distinct places is not deduplicated as if it were one occurrence.

Memory targets distinguish an actual selected image from optional interpretive context. If an image is a target, its complete bounded payload must reach the selected extractor and, when used, reviewer. Disabled disclosure, unsupported input or missing delivery blocks that target before a false assessment can publish. OCR-only selection assesses OCR, not pixels. Each stage retains its own image proof; extraction delivery does not prove reviewer delivery.

An image context read may be omitted when unnecessary. No host rule forces every text job to reread images or every batch to call another model. Models and selected Memory implementations choose semantic review within the supported contract; current mandatory review remains an implementation difference described in [Memory](memory.md).

`GET /api/images/:id` reports independent readiness; `POST /api/images/:id/retry` retries selected failed work. Historical OCR uses a scoped preview/confirmation rather than an upgrade-time scan. Query images retain the existing `allowQueryImages` control. Local image understanding is an optional plugin, default off; enabling it does not switch the Ask or Memory model and never silently falls back to a cloud model.

## Audio

The current local pipeline is FSMN VAD → Fun-ASR-Nano-2512/CT-Punc → persisted recognition checkpoint → CAM++ anonymous separation → aligned dialogue → optional conservative cleanup. It preserves the original recording, raw transcript, speaker-labelled transcript, derived cleanup and mappings. Turning cleanup off uses the retained complete transcript. Rerunning separation reuses recognition; rerunning recognition creates a new product.

`SPEAKER_n` names are anonymous clusters, not real people, owner identity or cross-recording identity. Missing attribution remains `SPEAKER_UNKNOWN`; models must not infer a speaker from left/right placement or a phrase. Explicit speaker counts/ranges are validated against available evidence. The current worker supports 1–16 as an explicit count/range; bounded listening previews do not discard later valid speech.

PCM normalization uses mono 16 kHz PCM16 and retains actual-frame duration and trailing silence. Checkpoints preserve model/dependency identity, VAD, raw recognition, punctuation and actual timing precision. All domain times are milliseconds. Word timings are omitted when unavailable; no interpolation creates false precision. Legitimate overlap is retained, while negative, reversed, out-of-range or incomplete output is rejected.

The current local protocol is `mote.funasr/1`; native results use the versioned FunASR contracts. Generic text/image and the optional HTTP processor keep their declared transcript contracts. A custom HTTP endpoint receives raw bytes and returns bounded JSON transcript segments; it is not automatically compatible with arbitrary vendor ASR APIs. Adapt those through a registered processor. Remote processing needs explicit enablement and HTTPS.

The default recording-duration limit is 120 minutes, configurable from 1–1440; the original-byte and per-call budgets are independent. File processing starts its active timer after admission, with checkpoints between transcription and separation. Resource/missing-model waiting does not consume an inference attempt. The host and custom worker may have separate upper limits; raising one does not enlarge the other.

## Recovery and reading

Typed states distinguish unavailable input, missing installation, resource wait, failed inference, timeout, output rejection, confirmed cancellation and unknown response. Connection loss alone does not establish that inference stopped. Cancellation, source replacement, deletion or revoked background authority prevents late publication. Independent successful outputs remain usable and retryable without replaying the whole file.

Human corrections create new corresponding evidence and invalidate affected dependants; they do not overwrite raw originals. Summary, semantic grouping, review, Memory and Ask keep their selected model configuration and permissions. An index or summary does not prove full transcript coverage. Audio playback, exported text, exact citations and derived summaries are distinct evidence surfaces.

Implementation: [plugins](../apps/server/src/plugins), [imports.ts](../apps/server/src/imports.ts), [file-processing.ts](../apps/server/src/file-processing.ts), [image-processing.ts](../apps/server/src/image-processing.ts), [media-assets.ts](../apps/server/src/media-assets.ts) and [mote_funasr.py](../scripts/mote_funasr.py). Exact schemas and limits live in code. Generated checks verify scheduling, identity, geometry, lineage and failure handling; real OCR/ASR accuracy, target-platform installation and physical devices need separate evidence under [testing](testing.md).
