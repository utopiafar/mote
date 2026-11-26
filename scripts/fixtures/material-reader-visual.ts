/** Disposable Central for visually checking the real owner readers. All content is generated. */
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {writeFile, mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import sharp from 'sharp';
import {buildApp} from '../../apps/server/src/app.js';
import {materialId} from '../../apps/server/src/materials.js';
import {sha256} from '../../apps/server/src/evidence-store.js';
import {captureSchema, uiPageText, type UiPageV3} from '@mote/shared';
import {structuredObject} from '../../apps/server/test/fixtures/structured-page.js';

const [output, webRoot, port] = process.argv.slice(2);
assert.ok(output && webRoot, 'An isolated output directory and Web build are required');
await mkdir(output, {recursive: true, mode: 0o700});
const token = randomBytes(32).toString('hex');
const deviceId = 'generated-visual-mac';
const deviceName = '验收用 Mac';
const baseTime = Date.now() - 120_000;
const at = (offset: number) => new Date(baseTime + offset * 1000).toISOString();
const range = {firstAt: at(0), lastAt: at(0)};
const config = {
  path: join(output, 'mote.yaml'),
  privateCredential: {token, tokenPath: join(output, 'owner.private')},
  initialDocument: {version: 1 as const, revision: 0, storage: {dataDir: join(output, 'data'), maxExportBytes: 2_000_000},
    server: {host: '127.0.0.1', port: 0, allowedOrigins: []},
    execution: {insightIntervalHours: 0},
    models: {
      deployment: {model: '', apiKey: '', allowUnauthenticatedLocal: false, protocol: 'deepseek' as const, reasoningEffort: 'high' as const},
      embedding: {model: '', baseUrl: '', apiKey: ''}
    }}
};
const node = await buildApp(config, {
  webRoot: resolve(webRoot), backgroundWorker: false,
  agent: {configured: false, close: async () => {}, query: async () => {throw Error('Visual checks use generated results');}}
});
const headers = {authorization: 'Bearer ' + token};
async function request(url: string, payload?: Record<string, unknown>) {
  const response = await node.app.inject({method: payload ? 'POST' : 'GET', url, headers, payload});
  assert.ok(response.statusCode < 300, url + ' ' + response.body);
  return response.json();
}

type Example = {key: string; title: string; marker: string; captureId?: string; materialRef?: string; listType?: string; route?: string};
const examples: Example[] = [];
const localCaptures: Record<string, unknown>[] = [];
const shapes = [
  {left: 0, top: 0, width: 760, height: 56, fill: '#324639'},
  {left: 32, top: 92, width: 352, height: 278, fill: '#bccaad'},
  {left: 47, top: 114, width: 306, height: 22, fill: '#eaf0dc'},
  {left: 47, top: 175, width: 292, height: 151, fill: '#8da9b2'},
  {left: 430, top: 104, width: 250, height: 20, fill: '#3c5147'},
  {left: 430, top: 161, width: 202, height: 10, fill: '#a1a89d'},
  {left: 430, top: 186, width: 255, height: 10, fill: '#a1a89d'},
  {left: 430, top: 211, width: 166, height: 10, fill: '#a1a89d'},
  {left: 430, top: 281, width: 128, height: 40, fill: '#697d5a'}
];
const image = await sharp({create: {width: 760, height: 440, channels: 3, background: '#f4f1e8'}}).composite(
  await Promise.all(shapes.map(async ({left, top, width, height, fill}) => ({
    left, top, input: await sharp({create: {width, height, channels: 3, background: fill}}).png().toBuffer()
  })))
).png().toBuffer();
await writeFile(join(output, 'generated-screen.png'), image);

async function capture(key: string, source: string, title: string, marker: string, offset: number, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const event = {id, deviceId, deviceName, platform: 'macos', appId: 'generated.visual.' + source, appName: title,
    windowTitle: title, source, capturedAt: at(offset), durationMs: 0, ocrText: marker,
    privacy: {excluded: false, redacted: false, mode: 'none', collection: 'content'}, ...extra};
  captureSchema.parse(event);
  await request('/api/captures', event);
  const example = {key, title, marker, captureId: id};
  examples.push(example);
  localCaptures.push(event);
  return example;
}
const noteMarker = '新版入口图把坡道和台阶分开标注，周六回到西入口再次确认。';
const noteId = randomUUID();
await request('/api/notes', {id: noteId, deviceId, deviceName, platform: 'macos', capturedAt: at(45),
  text: '步道走查记录\n\n' + noteMarker + '\n\n把原图和识别文字留在同一条记录。'});
examples.push({key: 'note', title: '步道走查记录', marker: noteMarker, captureId: noteId, listType: 'note'});
localCaptures.push({id: noteId, deviceId, deviceName, platform: 'macos', source: 'note', appName: 'Mote',
  capturedAt: at(45), durationMs: 0, ocrText: '步道走查记录\n\n' + noteMarker, privacy: {excluded: false, redacted: false, mode: 'none'}});

const imageFields = {imageMime: 'image/png', imageBase64: image.toString('base64'), ocr: {status: 'completed'}};
await capture('screenshot', 'screen', '步道路线图截图', '截图识别文字：从西入口到旧码头约 18 分钟。', 35, imageFields);
await request('/api/captures', {id: randomUUID(), deviceId, deviceName, platform: 'macos', appId: 'generated.visual.screen',
  appName: '步道路线图截图', windowTitle: '步道路线图截图', source: 'screen', capturedAt: at(33),
  durationMs: 0, ocrText: '路线图截图前一帧：无障碍入口。', privacy: {excluded: false, redacted: false, mode: 'none'}, ...imageFields});
const page: UiPageV3 = {version: 3, scope: 'visible_window', adapterId: 'generated.visual', adapterVersion: '1', appVersion: '1.0', activity: 'GeneratedArticleView',
  status: 'ok', truncated: false, observations: {firstAt: at(30), lastAt: at(30), count: 1},
  objects: [structuredObject({kind: 'article', title: '步道网页资料', author: '生成作者',
    body: [{text: '网页正文：坡道入口在公共洗手间东侧。'}]})]};
await capture('page', 'ui_page', '步道网页资料', '网页正文：坡道入口在公共洗手间东侧。', 30,
  {windowTitle: '', ocrText: uiPageText(page), metadata: {version: 1, observedAt: at(30), collector: {method: 'accessibility'}, uiPage: page}});
await capture('notification', 'notification', '步道校样通知', '周五下午五点前确认折页校样。', 28,
   {platform: 'android', windowTitle: '', ocrText: '', metadata: {version: 1, observedAt: at(28), collector: {method:'notification_listener'},
    observation: {sessionId:randomUUID(),elapsedRealtimeMs:1000},
    notification: {action: 'posted', notificationKey: 'ab'.repeat(32), postedAt: at(28),
    ongoing: false, groupSummary: false, title: '步道校样通知', text: '周五下午五点前确认折页校样。'}}});
await capture('device-event', 'device_event', '设备熄屏', '设备熄屏', 26,
   {platform: 'android', appId: '', appName: '', windowTitle: '', ocrText: '',
    metadata: {version: 1, observedAt: at(26), collector: {method:'notification_listener'},
      observation: {sessionId:randomUUID(),elapsedRealtimeMs:1000}, deviceEvent: {action: 'screen_off', keyguardLocked: false, screenInteractive: false}}});
await capture('activity', 'activity', '导览编辑器', '导览编辑器', 24,
  {durationMs: 67000, windowTitle: '', ocrText: '', privacy: {excluded: false, redacted: false, mode: 'none', collection: 'activity'}});
await capture('media', 'media', '步道录音播放器', '路线实地回听', 22, {durationMs: 9000, windowTitle: '', ocrText: '', metadata: {version: 1, observedAt: at(22),
  media: {status: 'available', sessions: [{sessionId: 'visual-playback', appId: 'generated.visual.media',
    appName: '步道录音播放器', playbackState: 'playing', appVisibility: 'background', playbackType: 'local', title: '路线实地回听'}]}}});

const fileSource = 'generated-visual-files';
node.sources.register({id: fileSource, name: '生成资料文件夹', kind: 'local-files', deviceId, platform: 'macos', retention: 'archive'});
async function archiveFile(name: string, mimeType: string, bytes: Buffer) {
  const upload = node.files.begin({sourceId: fileSource, item: {externalId: name, revision: '1', observedAt: at(19),
    kind: 'file', layer: 'original', mimeType, title: name}, sizeBytes: bytes.length, sha256: sha256(bytes)}, () => {});
  node.files.part(upload.uploadId, 0, bytes, () => {});
  return (await node.files.commit(upload.uploadId, () => {})).id;
}
function publish(example: Example, kind: string, sourceId: string, text: string, format: 'plain' | 'transcript' = 'plain') {
  const id = materialId(sourceId, example.key);
  assert.ok(example.captureId, 'Primary original is required');
  const member = example.captureId;
  const head = node.materials.publish({id, kind, schemaVersion: 2, title: example.title,
    origin: {sourceId, externalId: example.key, deviceId, ...range},
    members: [{id: member, kind: 'capture', ref: 'capture:' + member}],
    blocks: text ? [{id: 'body', kind: 'text', format, text, memberIds: [member]}] : [],
    coverage: {state: 'complete'}, fidelity: {state: 'lossless'}, retention: {original: 'retained', policy: 'keep'}});
  example.materialRef = head.ref;
  examples.push(example);
  return head;
}
const text = '文档提取文字：坡道连续通行，雨后在台阶口增设提示牌。';
const documentTitle = '步道维护手册.txt';
const fileId = await archiveFile(documentTitle, 'text/plain', Buffer.from(text));
publish({key: 'document', title: documentTitle, marker: text, captureId: fileId, listType: 'document'}, 'mote.file', fileSource, text);
const pictureTitle = '入口路线.png';
const pictureId = await archiveFile(pictureTitle, 'image/png', image);
publish({key: 'image', title: pictureTitle, marker: pictureTitle, captureId: pictureId, listType: 'image'}, 'mote.file', fileSource, '');

const sampleRate = 8000, duration = 6, samples = sampleRate * duration;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(Math.sin(index * Math.PI / 20) * 160), 44 + index * 2);
const recordingTitle = '步道复核录音.wav';
const recordingId = await archiveFile(recordingTitle, 'audio/wav', wav);
const segments = [{startMs: 0, endMs: 2100, text: '录音首段：坡道入口先放到首屏。', speaker: 'SPEAKER_0'},
  {startMs: 2300, endMs: 5700, text: '录音第二段：周六上午复走。', speaker: 'SPEAKER_1'}];
const raw = randomUUID(), dialogue = randomUUID(), diarization = randomUUID();
for (const [artifact, kind, value] of [
  [raw, 'transcript', {complete: true, transcript: {durationMs: 6000, segments}}],
  [dialogue, 'dialogue', {complete: true, transcript: {durationMs: 6000, segments}, inputArtifacts: [raw]}],
  [diarization, 'diarization', {durationMs: 6000, segments, samples: [], warnings: [], observedSpeakers: 2}]
] as const) node.store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)')
  .run(artifact, recordingId, kind, at(18), 'generated-visual', JSON.stringify(value));
for (const [index, segment] of segments.entries()) node.store.db
  .prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata,ordinal) VALUES(?,?,?,?,?,?,?,?)')
  .run(randomUUID(), dialogue, recordingId, segment.startMs, segment.endMs, segment.text, JSON.stringify({speaker: segment.speaker}), index);
node.store.db.prepare("UPDATE file_jobs SET state='succeeded',summary_state='skipped',error=NULL WHERE capture_id=?").run(recordingId);
publish({key: 'recording', title: recordingTitle, marker: segments[0].text, captureId: recordingId, listType: 'transcript'},
  'mote.file', fileSource, segments.map(segment => segment.text).join('\n\n'), 'transcript');

const snapshots = 'generated-visual-snapshots';
node.sources.register({id: snapshots, name: '生成的连接资料', kind: 'custom', deviceId, platform: 'macos', retention: 'snapshot'});
const connected = [
  {key: 'email', title: '步道印刷确认邮件', marker: '邮件正文：请在周五下午确认导览标注。', kind: 'message', materialKind: 'mote.message',
    listType: 'email', document: {contentRole: 'authored', originalMetadata: {provider: 'gmail', from: 'editor@example.invalid', to: ['review@example.invalid']}}},
  {key: 'calendar', title: '步道实地复走', marker: '日程说明：周六上午在西入口集合。', kind: 'calendar', materialKind: 'mote.calendar',
    listType: 'calendar', calendar: {start: at(0), end: at(3600), allDay: false, timeZone: 'Asia/Shanghai', status: 'confirmed'}},
  {key: 'reference', title: '步道开放时间引用', marker: '', kind: 'file', materialKind: 'mote.file',
    listType: 'reference', layer: 'reference', uri: 'https://fixture.invalid/north-bank'},
  {key: 'message', title: '步道群消息', marker: '消息正文：胶印前再核一遍入口图例。', kind: 'message', materialKind: 'mote.message'},
  {key: 'event', title: '步道临时封闭事件', marker: '北侧入口在施工期间暂时关闭。', kind: 'event', materialKind: 'mote.event'},
  {key: 'metric', title: '步道通行计数', marker: '西入口当天记录 38 次通行。', kind: 'metric', materialKind: 'mote.metric'},
  {key: 'memory-source', title: '步道巡检归档', marker: '每次雨后复查木栈道防滑条。', kind: 'memory', materialKind: 'mote.memory'},
  {key: 'generic', title: '步道维护插件记录', marker: '维护记录：观景台护栏检查完成。', kind: 'file', materialKind: 'fixture.maintenance'}
] as const;
for (const row of connected) {
  const record = await node.sources.upsert(snapshots, {externalId: row.key, revision: '1', observedAt: at(16),
    title: row.title, text: row.marker, kind: row.kind, layer: 'layer' in row ? row.layer : 'snapshot',
    ...('uri' in row ? {uri: row.uri} : {}), ...('calendar' in row ? {calendar: row.calendar} : {}),
    ...('document' in row ? {document: row.document} : {})});
  assert.ok(record?.id);
  publish({key: row.key, title: row.title, marker: row.marker, captureId: record.id, listType: 'listType' in row ? row.listType : undefined},
    row.materialKind, snapshots, row.marker);
}

const coding = 'generated-visual-coding';
node.sources.register({id: coding, name: '生成 Coding 来源', kind: 'coding-agent', deviceId, platform: 'macos'});
const codingText = 'Coding 会话原文：把无障碍入口移到路线图上方，并保留桌面布局。';
await node.sources.upsert(coding,{externalId:'turn-1',revision:'1',observedAt:at(12),kind:'message',layer:'snapshot',text:codingText,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-visual-session',projectKey:'generated-visual',
    eventId:'turn-1',role:'user',attribution:'human',part:0,parts:1}}});
await node.sourcePipelines.tick();
const codingBrowse = await request('/api/library/browse?sourceId='+coding+'&type=coding');
const codingHead = codingBrowse.items[0]?.material ?? codingBrowse.items[0];
assert.ok(codingHead?.ref, 'The coding source publishes its actual reader');
examples.push({key:'coding', title:codingHead.title, marker:codingText, materialRef:codingHead.ref, listType:'coding'});

const origin = await node.app.listen({host: '127.0.0.1', port: Number(port || 0)});
const inviteResponse = await request('/api/connections/invitations', {serverUrl: origin, label: '生成验收设备'});
const invite = inviteResponse.invitation;
await writeFile(join(output,'fixture.json'), JSON.stringify({generatedOnly: true, origin, token, deviceId, examples, localCaptures, invite}, null, 2) + '\n', {mode: 0o600});
console.log('Generated visual fixture listening on ' + origin + ' with ' + examples.length + ' examples');
async function close() {await node.app.close(); process.exit(0);}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
