# Unified image processing

Accepted screenshot/UI-page originals, imported image files, synchronized image
files and retained image attachments use one durable intake ledger and the shared
ExecutionEngine. Import staging, thumbnail/region responses and references without
readable bytes are not successful original-image processing. PDF/Office embedded
images require a declared decoder and are outside this intake.

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
