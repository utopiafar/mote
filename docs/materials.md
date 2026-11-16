# Originals, materials and source pipelines

An upload receipt means that an input can be recovered. It does not mean that decoding, indexing, Memory or a model interpretation has finished. [Processing](processing.md) and [Memory](memory.md) run after durable intake; useful source material remains readable when either is unavailable.

## Data layers

| Layer | Responsibility |
| --- | --- |
| Original archive | Retain received bytes, source identities, versions, attribution and timestamps. Models do not overwrite originals. |
| Source snapshot | Record what a source reported at a particular revision. A source statement is evidence, not independently verified fact. |
| Material | Publish a stable logical document with immutable revisions, bounded blocks, member locators and explicit coverage/fidelity. |
| Processing and interpretation | Preserve separately versioned OCR, transcripts, summaries, work records and other derived products, with their original support. |
| Memory | Select useful attributed context through the current admission and publication contract. |
| Indexes | Rebuildable FTS5 and optional vector projections of authorized current content. |

`reference` sources contain locators without a body; queries do not open arbitrary URIs or wake offline devices. `snapshot` retains the received text; `original` identifies explicitly archived source text; `derived` identifies an external Agent's output. Offline sources leave unsynchronized changes unknown, while their retained Central copies remain usable.

Source identity, upstream revision, observed/received time and authored/occurred time are separate. Importing an old diary today does not make its events happen today. A repeated identical revision is idempotent; conflicting content under that revision is rejected. Late old observations remain historical rather than rolling back the current head. Upstream deletion records a new source state; it does not erase the Mote archive. Privacy erasure removes content and prevents retries from restoring it.

## Publication and extension

The host owns raw-file storage, receipts, durable work, publication, indexing, authorization and shared executors. A source plugin owns its workflow and representation. Register it through `ctx.sourcePipelines.context.plugin(plugin)` and dispose its Cordis scope on close; [coding-source-plugin.ts](../apps/server/src/coding-source-plugin.ts) is an installed example.

A source pipeline declares an explicit ID/version, source kinds, priority, `storage: records | archive`, a versioned recipe, `index: material | none` and `modelInput: material`. Equal-priority overlapping defaults are rejected. Existing bindings stay pinned. Changing physical storage requires a new source identity. An absent bound plugin blocks its source rather than falling through to a raw-record implementation. Reinstalling can resume pending work; replacing settings or upgrading can requeue organization.

Archive recipes compose trusted readers, grouping, organization, publication and exposure. Ordinary files continue using their own decoders. Raw Coding events stay in private immutable batches with manifests and durable group checkpoints; they are not copied into raw SQL/FTS or sent directly to a model. Clean conversation Material is the model boundary. See [Coding sources](coding-agent-memory.md) for admitted roles and coverage.

Material publication uses immutable revisions and exact input checkpoints. Replacing a revision invalidates dependent evidence and in-flight grants. Long documents remain complete logical documents with bounded physical blocks and paged reads; partial collection or interpretation stays explicit. Current-document indexing is separate from publication: index failure must not turn successful intake into data loss. `POST /api/materials/:id/index/retry` retries only indexing, without reorganizing the source or invoking a model.

## Processing authority

Automatic model permission is recorded in the receiving transaction for the exact new source input, independently of later processing readiness. Repeated delivery, publication, restart, a new default or deterministic rebuild cannot convert a denied receipt into a grant. Launch and publication also check current policy. Claiming a grant and assigning its job are atomic, and recovery retains that job identity.

Manual jobs freeze their selected inputs and recipe bindings. Explicit source/evidence selection cannot acquire future siblings. OCR completion can make a named output ready without becoming a new raw input or granting additional model work. A source description provides interpretation context for its stated scope; it is neither original evidence nor authority to publish personal facts.

For example, a note can be archived, organized and searchable without a Memory job. A recording can expose its retained original while transcription waits for a worker. An explicitly selected OCR result can enter Memory while an unrelated transcript is still pending. These are separate stages, not contradictory task states.

## Owner APIs

| API | Purpose |
| --- | --- |
| `GET /api/materials`, `/:id`, `/:id/read`, `/:id/members` | List, inspect and page published material and members; use pinned revisions for historical reads. |
| `GET /api/materials/status` | Inspect organization cursors, backlog and backfill. |
| `GET /api/source-pipelines`, `/:sourceId` | Inspect installed policies and effective source settings. |
| `PUT /api/source-pipelines/:sourceId` | Select an installed compatible pipeline and its index/settling settings. |
| `DELETE /api/source-pipelines/:sourceId` | Erase an archive-backed source and dependencies, pause it against queued restoration, and report retryable file-removal failures. |

Concrete schemas and routes live in [materials.ts](../apps/server/src/materials.ts), [evidence-archive.ts](../apps/server/src/evidence-archive.ts), [source-pipelines.ts](../apps/server/src/source-pipelines.ts) and [protocol](protocol.md). A missing search result can reflect scope, synchronization, confirmation, organization or index readiness; it is not proof that a device has no data.

## Storage, deletion and backup

Central's database is `MOTE_DATA_DIR/mote.sqlite`. AssetStore retains content-addressed originals under `files/objects/`; source archives and import workspaces are distinct. Hash deduplication preserves each source's references and provenance. Physical object removal waits until no retained reference needs it. Encryption is described in [content storage](content-storage.md).

Deleting a Memory removes a derived result; deleting an original retires its dependent evidence and derived products. Deleting an entire import also removes its workspace and unshared assets. A backup/export is a separate copy with its own lifecycle. The direction is long-term retention without artificial storage quotas; current quota and acknowledgement cleanup differences are listed in the [architecture map](architecture.md#product-direction-and-implementation-gaps).

Use a stopped, checksummed full backup for operational recovery, preserving keys separately. It includes the database, assets and `source-archive/`. Portable JSON is a bounded interchange format, not a complete running-system backup, and rejects unsupported source-pipeline/image state. See [deployment](deployment.md) and [updating](updating.md). MVP accepts one current format; future upgrades must preserve data, and startup never silently wipes an old profile.
