# Reusing one composed image with bounded views

`scripts/test-image-context-live.ts` accepts `manifest.imageDisclosureProtocol` as `one-original` (the default) or `bounded-views`. Existing manifests retain the one unchanged original payload contract. Bounded views require a 300-second deadline, keep one ordinary fresh Ask and zero outer retries, and allow one to four unique payloads across all original/region/alias reads. Metadata and already-disclosed results do not count as payloads. The original private-access, live-authorization and private-transmission consent switches remain before source path resolution or cloning.

The reuse harness now shares `ComposedImageDisclosure` with the generated harness. It checks every successful `read_image` response before adapter delivery, then reconciles every successful result and query trace, including child reads without `attachmentId` and raw/formal aliases. Original bytes must match the manifest hash. The reader remains restricted to the frozen parent, selected formal anchor, child and attachment. Source attribution, original raster dimensions/orientation/pages, transform, view hash, crop geometry, exact output bytes/hash/MIME, duplicate lineage, adapter preparation and budgets are checked. Original PNG/JPEG/WebP bytes retain their actual format; region output is PNG. Unknown formats, originals, transformations or unclassified successful reads fail accounting and abort the active Ask. No region is chosen for the model.

Offline checks use generated material only. A separate preflight bridge checks metadata, a fixed top-left geometric region, repetition and original bytes, then closes. Generated preflight also exercises the separate authenticated Agent callback route without invoking an adapter or model. Private and live paths do not perform the generated geometric probe. The ordinary live Ask, if separately executed, starts with a fresh bridge and audit and does not inherit preflight reads. Preflight reports correctly leave `adapterPreparationVerified=false`; helper fixtures test adapter reconciliation independently.

Validation at `image-reuse-bounded-adaptation-002` used the unchanged generated seed `generated-composed-image-protocol-006`. Default reuse produced one original payload. Bounded reuse produced two unique payloads, one metadata read and two repeat results. Both also passed the separate callback-route check and retained the source report/database hashes and original bytes. All new terminal usage tables were empty. The helper suite passed 12 tests, including generated PNG/JPEG/WebP original/region/repeat and MIME-substitution rejection; six subprocess admission tests rejected before source resolution. These checks used zero real models, zero model stubs, zero processors/OCR/ASR and no private or held-out data. Previous plans, supervisors and reports were not changed.

Use a new external output directory for every run. The generated-only preflight command is:

```sh
MOTE_IMAGE_CONTEXT_MODE=preflight \
MOTE_IMAGE_CONTEXT_MANIFEST=/external/new-generated-reuse-manifest.json \
/Users/utopiafar/.nvm/versions/node/v24.15.0/bin/node --import tsx scripts/test-image-context-live.ts
```

Mechanical tests:

```sh
/Users/utopiafar/.nvm/versions/node/v24.15.0/bin/node --import tsx --test scripts/composed-image-disclosure.test.ts
MOTE_IMAGE_REUSE_TEST_OUTPUT=/external/new-generated-guard-tests \
/Users/utopiafar/.nvm/versions/node/v24.15.0/bin/node --import tsx --test scripts/test-image-context-live.test.ts
```

This is harness transport validation, not semantic assessment, provider efficiency or live-model validation. The subsequent pagination fix in `a69afb0` passed `check-local-008`; its authorization regression also verifies that discarded page candidates cannot expose evidence through tools or citations.

After that fix, the external `run-image-reuse-bounded-supervised.py` was frozen at SHA-256 `27b56925696ecb8e691bd7f816f1a8926c4be3680901efab4e92ef19235535ed`. It uses explicit validation that survives Python optimization, strict integer/boolean checks, a clean environment before every subprocess, exact Node/Codex pins and an exact 985-file runtime scope. Signal, deadline, orphan-child and exception paths clean up the dedicated process group and verify closure. It cannot establish cancellation of remote provider work or descendants that deliberately leave that process group.

Independent validation passed 56 mechanical cases across 9 tests, plus the 18 existing image/permission checks. The root separately repeated the 56 cases and actual supervised generated bounded-view preflight in `image-reuse-supervisor-root-review-001`: zero model/stub/processor calls and unchanged runtime/source pins. The fixed private request and execution plan were prepared separately and rejected without access switches; user consent for that one private transmission was requested but had not been received at this checkpoint. No private image or caption content entered the implementation review. Local private-source metadata checks established the frozen hashes and one in-scope Material without exposing text or pixels. Prior visual failures and the generated live004 usage of 1,103,451 reported tokens remain unresolved efficiency evidence; these zero-model checks do not show a reduction in live usage.
