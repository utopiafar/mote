# Scoped file-processing page: limited interface checkpoint

This document freezes only the interfaces below for client implementation at
`277068047bae5e21c533f528ea3d512d4f098e74`. It is not a whole M06 or final joint
runtime freeze. The previous Files/Imports consumer candidate remains2528;
configuration relogin fix fda6 and parser producer692→caf are independently
composable. Do not use a later arbitrary HEAD as a final test dependency.

The original file-processing page, names, source/MIME rules, explicit preview
and explicit reprocessing are retained. The same M04 configuration transaction,
M03 originals, shared processor registries and M05 executor remain authoritative.
There is no second endpoint/key store or per-account runtime.

## Read and save

`GET /api/file-processing` returns:

- `revision`: decimal string for the same personal M04 revision.
- `settings`: complete scoped processing settings, including enabled/automatic,
  timeout/audio limits, summarization/turn/understanding defaults and speaker
  settings. Endpoint and key fields are absent.
- `policy`, `policyConfigured`: the original version1 graph, or an unsaved
  preview derived from actual current selections when no graph was saved.
- `models`: `{personal,shared,selections}` from M04. Personal profiles contain
  redacted settings; shared connection metadata is read-only.
- `processors`, `execution:'central'`, `runtime:'cordis'` and `capabilities`.
  Existing file recipe capabilities remain at their original keys; image recipe
  capabilities are separate under `capabilities.image`.

`policy.services` contains only
`{id,name,kind:'asr'|'image'|'file'|'model',reference:{kind:'personal'|'shared',id}}`.
A service never contains endpoint/key/model copies. Profiles retain the existing
processing-profile schema: id/name/processorId/parameters, optional serviceId and
modelServiceId, diarizationProcessor/summarize and optional imageRecipe. Rule
shape is `{sourceId?,type,profileId}`; a source-independent `*/*` fallback is
required. Existing source/MIME specificity and processor parameter validation
are reused. Missing connections remain explicit blocked work, never a fallback
to another account or a global model.

`PUT /api/file-processing` accepts
`{revision,settings,policy,models?}`. Optional models is a complete personal M04
`{profiles,selections}` value. All provided domains replace together at one CAS
revision; a no-op need not increment it. The existing M04 stable-profile-ID
masked-secret booleans retain their exact saved secret. Invalid values reject
before publication; stale revision409. Shared connections cannot be edited here.
The return value is the current redacted GET shape. Never place a display boolean
into a different profile or synthesize a new endpoint/key pair.

`POST /api/file-processing/match` accepts `{sourceId,mimeType}` and returns
`{rule,profile,services,fingerprint,archiveOnly}` for the current saved/default
graph. Matching does not admit work or grant model access.

## Preview and explicit reprocessing

`POST /api/file-processing/preview` accepts
`{revision,sourceId?,type?,profileId?}` (`type` defaults to `*/*`). It returns
`{token,revision,count,skipped,bounded,items:[{id,title,profileName,rule}]}`.
The same Files owner/head/enabled-source/attachment projection is used, with
source/MIME filters before LIMIT. Original limits are retained:1000 scanned,
100 selected,20 live previews per account,10-minute expiry. Archive-only,
unavailable-original and physically running files are skipped. Capacity/expiry
stress and complete rendered integration remain unverified at this checkpoint.

`POST /api/file-processing/reprocess` accepts only `{token}`. It checks owner,
account epoch, configuration revision and current file proofs before any mutation.
It returns `{queued}` after one synchronous existing SQLite transaction admits
all selected work. Changed/expired/foreign/consumed preview409. A failed batch
rolls back every admission and keeps the preview retryable. Successful reprocess
consumes the preview; a lost successful ACK requires a new preview rather than
silently replaying an old operation. The original explicit reprocess action
acknowledges unknown old outcomes through the existing file retry mechanism;
it does not settle earlier external facts. A still-live request remains blocked.

## Processing and lifecycle boundaries

Named source/MIME/default rules and original-only archive apply at new trusted
admission. Completed results and per-file cancellation are retained across saves.
Changed unfinished work receives a fresh existing M05 coordinator/grant. Global
disabled work stays genuinely blocked with `processing_disabled` and zero
attempts, including newly accepted automatic originals; restart/enable does not
revive per-file cancellation. No model child executes while disabled.

These retained capabilities are still OPEN and must not be represented as ready:

- Saved-service `test-local` health endpoint; arbitrary endpoint/key request
  bodies are not a replacement.
- Explicit root/source/import image/attachment profile overrides. Imports with
  imageProfileId and attachment processingProfileId remain unavailable; clients
  must not treat a root override as an implemented selection.
- Non-default image-recipe execution, shared-instance/default-model change
  observation and component-version startup reconciliation.
- Complete downstream-only stage reuse and applied-plan personal export/merge/
  restore. Current policy metadata needs its own native/container recovery tests.
- Whole affected gate, current three-client UI/native journeys, compiled final
  chain, final same-SHA backup/Hindsight and final joint PR.

The source later develops stage-specific reuse without changing these wire
shapes. Its separate execution receipts must not be attributed to27706804.
Current bounded evidence and historical failures are recorded in
[the joint validation ledger](../validation/multiuser-joint-validation.md).
