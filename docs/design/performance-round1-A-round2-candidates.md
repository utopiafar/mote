# A round 2 candidates: investigation only

Frozen baseline `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`. These candidates
are outside round 1 implementation approval. No second-round code is changed;
each needs a bounded technical plan and independent approval before work.

## FTS identity to rowid

Current `private-data-schema.ts` indexes capture and material-version insertions
and removes FTS rows from deletion triggers by owner/kind/entity/revision.
`rebuildPrivateIndex` clears and repopulates the full index with current source,
account, attachment and material visibility. `index-maintenance.ts` owns the
lease-fenced commit. Portable merge/restore in `private-data-lifecycle.ts`
inserts canonical rows through those triggers; account deletion also removes
FTS rows explicitly. Instance backup has a separate schema contract in
`scripts/scoped-backup-schema.mjs`, owned by the controller.

KEEP indexed text, search candidate completeness, filters, owner, revision,
sorting and rollback/rebuild semantics. CHANGE candidate: transactional
identity-to-FTS-rowid bookkeeping for exact deletes. REMOVE candidate: identity
scans during deletion only after mapping completeness is proved. EXCEPTION:
none. UNKNOWN: material/capture revision mapping multiplicity, rowid reuse after
rebuild, update handling (`PrivateData.insertCapture` state-series extension),
and backup contract implications. No legacy migration is proposed.

Minimum owners would include A schema/private-data changes, lifecycle code's
assigned owner and controller backup-contract changes. Future validation must
cover same identity across accounts, material revisions, deletion/cascade,
rebuild with cancellation/revocation, portable merge/repeated restore, rollback,
backup/restore and complete same-query search responses. Generated 1k/10k data,
EXPLAIN and exclusive timing would establish benefit; SQL counts alone cannot.

## Import, Perception and speaker reads

`processing-imports.ts` lists at most 100 jobs through individual detail reads.
`processing-import-progress.ts` follows each capture through originals, receipt,
current recursive materials, Memory jobs/tasks and media processing state.
Successful import does not imply successful Memory; missing selected recipe
admissions remain pending. Perception history (`processing-perception.ts`)
loads candidates and complete image readers; preview checks completeness in
200-item groups. Speaker names (`processing.ts`) validate full input/snapshot
before annotations; chunks (`processing-files.ts`) also read full artifacts.

KEEP all counts, recent-40 selection, watermark, selected recipe completeness,
state priorities, current revision/permission, refresh latency, snapshot proof,
failure recovery and owner. CHANGE candidate: minimal metadata projections and
same-call bulk reads. REMOVE candidate: repeated full artifact hydration only
after consumer requirements are enumerated. EXCEPTION: none. UNKNOWN: whether
a purpose-limited internal Memory read API is necessary and which validations
can be shared without caching authority. Persistent caches are not proposed.

Minimum owners include A processing readers, the owner of `processing.ts` and
possibly Memory service. Requests outside the campaign manifest go through the
controller. Future validation compares full HTTP responses over multi-recipe,
unadmitted sibling, blocked/model-waiting, failed, paused, cancelled, revoked,
historical-head, archive-only, corrected-artifact and restart states, with equal
IDs across accounts. Measure all candidates, not only the output page.

## Capture originals and materials

`ingress.ts` and `processing-images.ts` already use owner/capture SQL. The
originals uniqueness index has source_id between user_id and capture_id; query
plans must establish any owner-prefix scan. This is not an EvidenceStore scan.
Material reverse reads in `private-data.ts` and import progress must retain
current revision, min-visible sequence and exact recursive input membership.

KEEP attachment binding, source incarnation/enabled state, original retention,
current visibility, existing result order and the explicit Files historical
original exception in `processing.ts`. CHANGE candidate: matching physical
reverse indexes or narrow exact lookup SQL. REMOVE candidate: only proved
redundant scans. EXCEPTION: the existing historical Files behavior remains;
no new product exception. UNKNOWN: lookup multiplicity and all lifecycle write
costs. Coordinate schema and query ownership with C/controller before changes.

Future validation: equal capture identity across accounts, source deletion and
recreation, old revision, hidden/retired material, attachment rebinding,
snapshot release, current/historical Files access, rollback and reopen. Compare
all response fields and order; inspect EXPLAIN with generated current/history
mixes and exclusive read/write timings. No implementation is authorized here.
