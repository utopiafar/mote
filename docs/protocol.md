# Mote protocol v1

All `/api/*` routes except `/api/health` require `Authorization: Bearer <MOTE_TOKEN>`. Health contains no private data. Server default port 47832, bind 127.0.0.1. A single owner token is an MVP limitation. Android/emulators must use LAN host with TLS or explicitly enabled debug LAN HTTP; `localhost` on a phone means the phone.

## Capture upload

`POST /api/captures` JSON (max 12 MiB). One event per sampled interval, including unchanged screens; server deduplicates image bytes separately, preserving observations. Retry with the SAME event id, timestamp, metadata, and image to guarantee idempotency. Delete local queued image only after 200/201 acknowledgement.

```json
{
  "id": "uuid",
  "deviceId": "stable-device-uuid",
  "deviceName": "My Mac",
  "platform": "macos",
  "capturedAt": "2026-09-13T02:00:00.000Z",
  "durationMs": 15000,
  "appId": "com.example.app",
  "appName": "Example",
  "windowTitle": "Optional, omit under strict privacy",
  "imageBase64": "base64 JPEG/PNG/WebP, no data URL prefix",
  "imageMime": "image/jpeg",
  "ocrText": "optional locally extracted and sanitized text",
  "source": "screen",
  "privacy": { "excluded": false, "redacted": true, "mode": "local", "reason": "configured masks applied" }
}
```

`platform`: `macos|windows|linux|android|import`. `source`: `screen|file|note`. `imageBase64` and `imageMime` optional together for text/file imports. `durationMs` integer 0..300000, measures observed sampling exposure, NOT guaranteed attention. Response: `{id, duplicate, blobHash, indexingStatus}`. Same id with different content returns 409. Excluded events must never be queued; server rejects `privacy.excluded=true`.

Deleted event IDs have tombstones: later upload/import of that ID into the same vault returns 410 instead of resurrecting deleted private evidence. Restore a full backup into a fresh vault when intentional recovery is needed. Export limits account for repeated base64 image references, not only unique blob bytes.

`POST /api/devices/heartbeat`: `{deviceId,deviceName,platform,status,queueDepth,lastCaptureAt?,error?}`; status `capturing|paused|permission_required|error|offline`. Response `{ok:true}`. This route records status only and never starts capture.

## User notes / 随手记

Notes are ordinary capture events with `source: "note"`. The author's original words are stored in `ocrText` without rewriting, trimming, summarization or inferred tags. An optional `mood` is a **user-supplied free-text label**, at most 80 characters and not blank. The program never infers mood from the text, application or keywords. A note must have nonblank text, `durationMs: 0`, and no image; notes do not count toward sampled screen time. Other sources cannot supply `mood`.

Native clients can use their existing durable capture queue and `POST /api/captures`:

```json
{
  "id": "6b0908c9-4558-4798-8e9c-3d8913d7443d",
  "deviceId": "stable-device-uuid",
  "deviceName": "My phone",
  "platform": "android",
  "capturedAt": "2026-09-13T02:00:00.000Z",
  "durationMs": 0,
  "source": "note",
  "appId": "dev.mote.notes",
  "appName": "随手记",
  "windowTitle": "",
  "ocrText": "今天想留给自己的原文。\n空格和换行原样保存。",
  "mood": "松了一口气",
  "privacy": { "excluded": false, "redacted": false, "mode": "none" }
}
```

Use the above app identity/default fields when interoperating with the convenience endpoint. In TypeScript, `noteSchema` validates a convenience request and `noteCapture()` from `@mote/shared` creates the exact canonical capture payload. Omitting `mood` leaves it absent; it does not select a default emotion. Text is limited to 100,000 characters.

`POST /api/notes` accepts `{id,deviceId,deviceName,platform,capturedAt,text,mood?}` and maps it to that same capture, using `text` as `ocrText`. Its response is the same `{id,duplicate,blobHash,indexingStatus}` acknowledgement as `/api/captures`, with 201 on first insert and 200 for an identical retry. API list/detail responses remain `CaptureRecord` objects, including `ocrText`, optional `mood`, `source`, `receivedAt` and indexing status, rather than introducing a second stored note shape.

Before enqueueing, Web clients atomically persist the exact prepared event (including UUID and timestamp) with the draft. A crash between enqueueing and clearing the draft reuses this prepared event, even if the central acknowledgement already removed its queue entry. Editing the draft invalidates its prepared event; a later intentionally identical note still gets a new UUID. Completion clears only the matching prepared draft.

Clients create the event UUID and original timestamp when saving locally, retain the exact payload on retries and remove it from their outbox only after an HTTP 200/201 acknowledgement whose `id` matches. A lost response can therefore retry across either route without a second record. 409 means the same UUID already has different content; 410 means it was deleted and must not be automatically recreated under another UUID. Keep the local error visible rather than reporting success. This MVP does not edit saved events; create a new note and explicitly delete an old one when a correction is needed.

- `GET /api/notes?after=<ISO>&before=<ISO>&deviceId=<id>&limit=30&cursor=<opaque>` lists only notes, newest first, with `{items,nextCursor}`. Bounds are inclusive `after`, exclusive `before`; default limit 50, maximum 200. Pagination includes UUID as the tie-breaker for equal timestamps.
- `GET /api/notes/:id` returns one note; missing/deleted records and IDs of other source types return 404.
- `DELETE /api/notes/:id` returns `{deleted:1}` or `{deleted:0}` if already absent. It cannot delete a screen/file record through this route. `DELETE /api/captures/:id` remains compatible.
- Note deletion removes retrieval evidence, writes the common tombstone, and invalidates saved derived insights, exactly like capture deletion. Notes and user-supplied mood labels are preserved by archive export/import and incremental `/api/updates`.
- The central Agent reads note text and explicitly supplied mood as **untrusted personal evidence**, using the same search/timeline/evidence tools. A note cannot modify the system prompt or enable execution tools. Text and mood enter generic full-text/embedding retrieval; there is no mood or task keyword classifier.

The Web/embedded console includes a separate 随手记 page. Drafts and immutable pending notes are saved in local application/browser storage under the selected central-node address. Failed delivery preserves the original event and displays pending/error state; returning to this page or restoring connectivity retries. Up to 100 pending notes / approximately 2 MB are allowed. Storage failure is reported instead of claiming a durable save. These local copies are not additionally encrypted by the Web layer and are removed by clearing its application data; the central export does not include unsynchronized local notes. Native Android/macOS entry points use their own client queues. A note does not require screen capture permission or a running vision model.

## Read API

- `GET /api/health` => `{ok,version}`
- `GET /api/status` => `{agent:{configured,provider,model},storage:{bytes,captures,blobs},...}`
- `GET /api/captures?limit=50&before=<ISO>&after=<ISO>&deviceId=<id>&source=<screen|file|note>` => `{items,nextCursor}`. Items include `id,deviceId,deviceName,platform,capturedAt,durationMs,appId,appName,windowTitle,ocrText,source,mood?,privacy,blobHash,indexingStatus,summary?`.
- `GET /api/captures/:id/image` authenticated image bytes.
- `GET /api/captures/:id` one complete evidence record; 404 if deleted or missing.
- `GET /api/devices` => `{items}`
- `GET /api/updates?cursor=0&limit=100` => `{items:[{seq,id,operation,changed_at,record}],nextCursor}`; arrival-ordered upsert/delete changes. `record` may be null when evidence was subsequently deleted.
- `GET /api/activity?after=<ISO>&before=<ISO>` => `{apps:[{appName,durationMs,captures}],devices:[...],totalDurationMs,captures}`. Overlapping devices count separately; UI must label this as sampled device time.
- `POST /api/query` `{question,after?,before?,deviceId?,timeZone?}` => `{answer,citations:[{id,capturedAt,appName,excerpt}],trace:[{tool,arguments,count}],runId}`. Unconfigured model responds 503; NEVER fabricate a keyword-based answer.
- `POST /api/insights` `{after?,before?,deviceId?,timeZone?}` => same evidence-linked Agent query response for a retrospective.
- `POST /api/index/retry` `{}` retries failed/pending records.
- `GET /api/export` => portable JSON archive with version, captures including base64 image, `receivedAt`, `blobHash` checksums. Secrets not included. Bounded by configured archive size; CLI backup is recommended for large vaults.
- `POST /api/import` archive JSON => `{imported,duplicates}` with all entries validated before ingestion.
- `DELETE /api/captures/:id` deletes record and unreferenced image.

Data model is source-agnostic so NAS/files/hardware can implement the same ingestion protocol. No directory is watched without explicit configuration.

### Agent scope and source presentation

Query `after` is inclusive and `before` exclusive. An explicit `deviceId` cannot be broadened by a model tool call. `timeZone` accepts a valid IANA zone and defaults to UTC; the embedded UI supplies the browser zone. Original timestamps remain UTC in storage. Agent evidence includes an explicit display timestamp with offset, the optional measured `durationMs`, explicit `sampleInterval` start/end for positive-duration samples, and paged `textRange` metadata. Timeline returns an opaque continuation and scoped `totalCount`; the model must inspect subsequent pages for a complete review. Current device heartbeat is a client report, not proof of historical recording coverage.

Final answers must have a string body and declared retrieved citation IDs. Only successful tool responses authorize citations. Prose inline UUID citations must match the retrieved and declared IDs; code and authored Markdown links remain opaque. The UI presents verified inline sources as buttons opening the original record. Model-emitted literal JSON control characters are losslessly escaped; other malformed responses get at most one model-authored correction in the same read-only evidence session and original time budget. No semantic classifier or template fallback is used.

`MOTE_MODEL_REASONING_EFFORT` is `off|low|high|max` (default `high`); `MOTE_MODEL_MAX_TOKENS` defaults to 8192 and is bounded to 256–32768. Reasoning is performed by the configured model through the Harness; no reasoning transcript is exposed as a user-facing answer. [DeepSeek's official thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/) describes the provider controls and multi-round tool support. Higher effort can increase latency and usage.

## 版本化外部来源

客户端文件、日历和外部 Agent 使用来源接口，不覆盖不可变截图或笔记。

- `POST /api/sources`：注册 `{id,name,kind,deviceId,platform,retention,enabled}`。重复注册保持服务器已有的启停设置。
- `PATCH /api/sources/:id`：所有者编辑名称、保存策略或启停状态。
- `PUT /api/sources/:id/items`：提交 `externalId,revision,observedAt,title,text,kind,layer`，以及可选 `modifiedAt,uri,mimeType,calendar,deleted`。确认包含 `id,sourceId,externalId,revision,duplicate`，客户端必须逐一核对。
- `GET /api/source-items`：当前版本，支持 `sourceId,deviceId,kind,after,before,limit,cursor,includeDeleted`。日历按计划时间重叠匹配；其他记录按观察时间。
- `GET /api/sources/:id/history?externalId=...`：不可变版本历史。
- `GET /api/memories`：默认概要。`/:id` 展开模型陈述，`/:id/evidence` 读取原始证据。`POST /extract` 显式调用模型；`POST /:id/publish` 确认候选，`DELETE /:id` 删除记忆。

`calendar` 使用带时区的 `start/end`、`allDay`、`timeZone` 和 `status`。来源记录的 `durationMs` 固定为零，会议计划不能计入实际采样时长。正文可以为空；空文件不被改写成说明文本。`reference` 和删除版本只保存元数据，正文必须为空。

相同版本重复提交安全；相同版本但内容不同返回冲突。离线客户端需持久化版本与请求正文，严格确认后再移除。参考实现使用内容与前一版本的哈希链，支持“修改→删除→恢复相同内容”，而旧重试不会移动当前指针。

外部 Chatbot 接口另见 [MCP 与连接器](connectors.md)。内部查询 Agent 没有写入能力。
