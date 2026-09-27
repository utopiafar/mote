# Generated composed-image preflight

This harness prepares one fictional authored caption, a 900 × 2400 discussion image, and 28 known OCR lines with image coordinates. Six messages include named and unknown authors. The save date differs from the discussion date. Two visual outlines occur only in the image; neither the OCR nor the question supplies their answer. The external evaluator-only rubric was frozen before implementation and is never inserted into model context.

`scripts/test-composed-image-context.ts` defaults to offline preflight. An explicit new external output directory is required. It verifies the frozen manifest and every asset hash, rejects model queries, gives Codex an invalid offline executable, and denies fetch requests except its exact local read-only context bridge. The image processor is a bounded, once-only deterministic stub. This proves plumbing, not OCR accuracy, semantic quality, or model vision.

The preflight uses Source ingress and the normal file upload API for a donor image. The ordinary archive service retains its attachment bytes and links a new authored Source record. The normal attachment processing API reuses the donor's exact compatible OCR artifact. The caption stays available while the attachment is pending. Formal Material composition keeps both members and all 28 coordinates.

Normal read-only tools browse the material catalog, read 900-unit pages, expand the authored evidence, and return the exact attachment bytes through `read_image`. The harness compares their SHA-256 without recording duplicate base64 image bodies in its report. A close/reopen repeats these checks with no processor call. Separate SQLite backup clones test deletion of the parent and withdrawal of image disclosure after evidence expansion. Both reject the stale image grant. The independently retained donor survives parent deletion; the normal live seed remains unchanged. Image-disclosure revocation does not claim to revoke text access.

The final offline run `generated-composed-image-v1/preflight-003-final` passed seven grouped checks and 34 ordinary tool requests. There were **0 real model calls, 0 stub model queries, 1 OCR stub call, 0 real OCR/ASR calls, and 0 attempted outbound fetches**. Every terminal usage table was empty. The 29 formal anchors comprise the authored caption and 28 image text lines. The generated image was visually inspected and its six messages and outlines were readable. This is not a browser, physical-device, private-image, live-model, or quality acceptance result.

The failed `preflight-001` is retained: its harness mistakenly assumed that Material `originalRefs` contained all formal evidence anchor IDs. They contain the original parent/child members. The corrected check follows those real grants and verifies coordinates in the bounded Material pages. No production gate, generated input, rubric, or limit was changed. `preflight-002` and final `003` passed. Script TypeScript checking passed after the final change.

Optional live mode is implemented but **has not been run**. It requires an explicit passed offline seed and a new output directory, verifies the stored seed database hash, and makes an isolated backup. It permits one fresh ordinary Ask using `gpt-6-sol`, `max`, Codex App Server, and a 300-second call deadline. It passes only the frozen question, device scope, and an explicit frozen host time; it does not attach images directly, inject OCR/rubric/answers, start background processing, or generate Memory. Success requires a successful normal `read_image` trace for the exact attachment. Raw trace events, response/error, code hashes, source hashes, visible repair turns, and terminal usage after app close are retained. Outer automatic retries are forbidden; provider-internal requests and one possible output-validation repair are distinct and are not falsely reported as absent. The deadline is not a whole-process watchdog. A completed Ask still needs independent rubric review; `semanticQualityAccepted` stays false.

Offline invocation (placeholders must point to the generated frozen assets and a new external directory):

```sh
MOTE_COMPOSED_IMAGE_FIXTURE=/external/generated-composed-image-v1 \
MOTE_COMPOSED_IMAGE_OUTPUT=/external/new-preflight \
node --import tsx scripts/test-composed-image-context.ts
```

Live uses the same runner with `MOTE_COMPOSED_IMAGE_MODE=live` and `MOTE_COMPOSED_IMAGE_SEED=/external/passed-preflight`; execution is a separate decision. These instructions do not authorize a call or access to any private historical vault.
