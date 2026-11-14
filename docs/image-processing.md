# Unified image processing

Accepted screenshot/UI-page originals, imported image files, synchronized image
files and retained image attachments use one durable intake ledger and the shared
ExecutionEngine. Import staging, thumbnail/region responses and references without
readable bytes are not successful original-image processing. PDF/Office embedded
images require a declared decoder and are outside this intake.

## AppleDouble original admission

AppleDouble filesystem sidecars are recognized by the binary magic, supported
version and bounded entry descriptors, never by a `._` name alone. Central import
retains the archived original and reports an `excluded` disposition before content
analysis. Synchronized files and accepted attachments use the same check before
OCR or visual calls. The existing declared MIME is retained in historical receipts.

Legacy failed image attempts remain historical; their current image and parent
file operations receive an optional blocked exclusion receipt, projected as
`skipped` with reason `appledouble_metadata`. File/image details show the reason
and retained original. Explicit retry and historical backfill do not send this
metadata to processors. This does not change normal image recipes, retry budgets,
original retention policies, or attribution invalidation behavior.

## Policy and execution

The selected image plan references the existing file-policy profiles, processors
and services. Precedence is item `processingProfileId`, import `imageProfileId`,
source/type override, then the global image default. Omission inherits the current
default when the original is accepted; its non-secret receipt is pinned in that
transaction. Attachment admission inherits its parent's import override. Editing
defaults affects future inputs. Existing inputs use explicit completion or
recomputation to adopt a new policy. Changing a pinned service blocks unfinished
work until explicit retry, rather than silently changing its destination.

The default versioned recipe runs OCR and visual understanding. Understanding
receives actual image pixels, OCR when available and declared source attribution.
It uses the file-analysis model, or the plan's model-service override. Successful
empty OCR is ready. Failed/unconfigured OCR can still be followed by visual
understanding; failed vision leaves OCR independently searchable. Visual output
is labeled as model interpretation and carries original hash, revision and pixel
coordinates. It never replaces OCR or claims an author's words as the owner's
experience. The scoped model harness exposes only read-only tools and requires a
verified pixel read before publishing an interpretation.

The optional local image service selects **InternVL3-14B-4bit** for intake
understanding only. An enabled selection remains local while the model is
missing, busy, stopped or failed; none of those states authorizes an automatic
cloud fallback. Disabling the plugin restores the configured intake model for
new work. Unfinished work keeps its admitted selection until an explicit retry
adopts the current configuration. Installing assets or enabling the plugin does
not rescan historical images.

Memory extraction, independent review and Ask continue to use their separately
selected models, including cloud models. They can still read the original image
or a permitted region. Local intake does not change those model settings, the
existing background-model authorization, source exclusions or `allowQueryImages`.
OCR, interpretation, retained original, Material/index and Memory keep their
independent readiness and failure states.

Pure OCR reuse requires both the OCR stage and processor to opt into content
reuse. Identity includes bytes, MIME, processor contract/version and settings.
Understanding and derived-stage identity additionally includes source observation,
recipe/dependency versions and the selected model. Identical originals keep
separate observations, attachment parents and evidence lineage. Issued OCR calls
retain the durable completion-unknown guard across cancellation/restart; their
late results cannot publish after deletion or replacement.

Expired temporary snapshot pixels use the existing source transport recovery
request. Resupply retains the original receipt and Memory grant; successful
completion releases temporary pixels and preserves the permitted text/index.

Each product is published separately. File and screenshot organizers incorporate
available OCR and interpretations into their Materials; screenshot Materials keep
their segment context, and attachments compose with their parent's authored body.
The existing MaterialMemoryWork and raw-input grants are the sole automatic
Memory authority for image evidence. Material rebuilds, plugin installation and
recomputation cannot mint a second automatic grant. No new memory is a successful
Memory outcome.

## Independent Memory image proof

New image-bearing Materials can expose an optional `image-original` output. Its
text is a host locator, not a description of the pixels. It binds a current
Material anchor to its exact original member and SHA256. Retained original
readiness is independent of OCR and visual-understanding completion. Available
OCR remains a separate text output; model interpretation remains navigation.
Late OCR or understanding cannot replace the frozen selection of already
admitted Memory work, consume another automatic input grant, or upgrade an old
interpretation-only task into an image-reading task. No organizer-version
backfill or historical model replay is added by installing this capability.

A new or explicitly selected task pins its named outputs and may receive an
exact read-only image grant for those original-image anchors. This permits
neither raw capture text nor archive discovery. The existing owner image-access
setting still applies. Metadata exposes the original hash and dimensions without
pixels; the model can request the original or a needed region using the existing
encoded-raster coordinate and size contract. Each read rechecks the current
Material pin, original membership, source permissions and original hash. Model
requests and publication recheck the same authority after deletion, replacement,
attribution changes, restart and late delivery.

Sufficient delivered OCR can support exact text quotations without an image
request. An unread pure-image locator cannot support a successful assessment:
missing necessary pixels or same-original OCR must remain incomplete. OCR from
another member in the same Material is not proof of that image. Visual claims
select a successfully delivered `imageView`; the host saves its original hash,
coordinates, transform and output identity as `MemoryEvidence.image`. A model's
JSON, interpretation, metadata response or prepared-but-unconfirmed payload
cannot supply that delivery receipt. Interpretation JSON and locator JSON cannot
be quoted as original image contents.

Independent review receives the same frozen read grant, but no inherited pixel
delivery. A retained visual claim requires the reviewer's own current image or a
region covering its required original proof. The reviewer can discard an
image's visual claims without making a needless image request. Bounded deletion
review and consolidation can reuse the same scoped read contract; consolidation
derives it only from the exact selected cards' current saved visual proofs.

Coverage identity is the evidence anchor and original hash, independent of
statement wording, titles or candidate order. While a reviewed result still
cites that visual group, every draft view actually cited for the group needs a
covering view cited by the reviewer. Separate reviewer views can cover separate
draft crops; partial views are not geometrically stitched to cover one larger
proof. Extra uncited extraction reads add no requirement. Dropping the entire
group's visual citations removes its coverage requirement. This conservative
grouping avoids inferring claim identity from prose when candidates are edited,
split or merged.

The current external full-engine native integration protocol accepts exact text
ranges, not visual Memory proofs. It rejects a selected visual parent with
`memory_provider_unsupported_input` before initializing a remote bank or issuing
retain/consolidate calls. OCR-supported text remains supported. There is no
automatic retry, silent engine switch or conversion of a locator to a text quotation. Restored
owner archives retain their existing stale state; importing view metadata does
not create a new current image grant or a runtime pixel receipt.

Native extraction likewise receives text ranges, including a locator when it is
selected; the external engine does not thereby receive pixels. Its empty draft
still goes through Mote's independent review. That reviewer can inspect the
frozen original grant, or use sufficient delivered OCR from the same original.
Without either, the target remains unfinished rather than becoming a successful
empty result. A successful host review with its own visual proof is not evidence
of native visual-extraction support in that engine.

When this selected visual scope is present, other search results do not acquire
image access from it. Consolidation without selected visual proofs retains its
existing open-query image permissions; this capability adds no blanket image
ban or broader archive grant.

## Owner controls and history

Settings → Images selects the shared default and processing permissions. Import
uses that default with an optional batch override. Original details show original,
OCR, understanding, Material/index and Memory readiness independently.

`POST /api/perception/ocr/historical-preview` accepts optional `after`, `before`,
`sourceId` and `mode` (`complete` or `recompute`). Its token binds the query and
intake watermark. One `historical-process` request persists a cursor and schedules
the whole range in bounded batches, including ranges larger than 100 images.
Installed/upgraded plugins and restored portable records do not automatically
process historical originals. Completion reuses retained valid products;
recomputation publishes new versions. Unknown issued-call completion still needs
the existing explicit retry acknowledgment.

`GET /api/images/:id` reports independent readiness. `POST /api/images/:id/retry`
accepts `mode` and optional `confirmUnknown`; `/cancel` stops unfinished work.
Image products and intake receipts count toward vault quota. Use `npm run backup`
for a complete backup: portable JSON deliberately refuses to omit retained image
product versions. Shared policy receipts contain no credentials; restored service
credentials must be configured separately.

## Extensions and validation

Trusted Cordis plugins can register `moteImageInputs` adapters and versioned
`moteImageRecipes` stages/recipes alongside `moteFileProcessors`. Intake authority
remains the host's accepted-original receipt. Installing a capability schedules no
history. The generated-fixture extension test installs a scanner source and a
receipt-derived recipe through Cordis without adding a source/stage branch to the
coordinator.

Generated-fixture tests cover all four entry paths, shared OCR with independent
visual context, successful empty OCR, partial failures, missing/deleted originals,
policy precedence, snapshot expiration/recovery, more than 100 historical images, read-only model scoping and
pixel-read enforcement, independent Memory grants, and UI readiness. These are
fixture and harness checks. They do not constitute a live VLM/local-worker or
physical Android device acceptance run.

## Local image candidate checks

The manual entry below previews and runs the existing narrow image assemblies.
It accepts only generated inputs. With no arguments it prints help; it never
attaches to an existing Central or reads a user profile, image folder or model
credential. The ordinary argument/material tests do not run its contract mode.

```sh
node --import tsx scripts/journeys/local-image-plugin.ts --dry-run
node --import tsx scripts/journeys/local-image-plugin.ts --fixtures-only
node --import tsx --test --test-concurrency=4 --test-timeout=120000 scripts/journeys/local-image-plugin.test.ts
# Explicit narrow module assemblies, when this validation is requested:
node --import tsx scripts/journeys/local-image-plugin.ts --run-contracts
```

`--fixtures-only` reuses the six procedural specimens from the image contract:
a wordless scene, small text, a long image, a region, successful empty OCR and
untrusted depicted instructions. It verifies unchanged original bytes, actual
crop pixels, metadata without pixel delivery and the current request/response
parsers. It writes PNGs, serialized transport examples, a manifest and a report
in a new private temporary directory. Optional `--output` selects a new absolute
directory outside all repository worktrees; its parent must already exist.
Existing destinations and symlink paths into a worktree are rejected. No input
path, endpoint, profile, dependency installer or live-model option is accepted.
The generated model revision and `elapsedMs:17` in the transport examples are
fixture constants, and do not measure inference quality, latency or memory.

`--run-contracts` runs the IMG-03/04/05/06 fixture files with the existing four
test workers and 120-second per-test limit, once per file. It retains TAP output
and propagates failures. Missing summaries, skipped/cancelled tests and unknown
counts cannot become a passing result. Old `MOTE_*` deployment and example-output
variables are removed from the test subprocess environment. This mode exercises
the real module stores, routes, publishers and consumers used by those tests;
their generated model/control boundaries remain explicitly fixture evidence.

Reports record the actual Git candidate. Both complete paths—default Central
startup through Ask, and the same original through Memory extraction, independent
review, publication and deletion—remain `not_run` in this narrow entry. Every
release-matrix row also remains `not_run`; real model identity/revision, cold/hot
latency and memory measurements remain null until measured separately. A passing
fixture/material report does not certify the default distribution or release.

The current candidate still needs the shared owner to register the optional
local-image build in the default Central, bind its intake adapter before
admission, expose its state in the shared controls and mount the dedicated
settings component. The VLM health producer's `localImage` field and the shared
consumer's `ready` check also need to agree. These are outstanding default
assembly boundaries; this entry does not register a second control platform or
replace them with a test-only success path. Full A/B journeys, supported-platform
installation/restart, hidden Web/Android/Mac UI, OCR/ASR/VLM coexistence, real
models and physical devices require their separate stage evidence.
