import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureSchema, noteSchema, FILE_PART_BYTES } from '@mote/shared';
import { buildApp } from '../../../src/app.ts';
import { feishuTranscript } from '../../../src/connectors/recording-formats.ts';
import { dingtalkTranscript } from '../../../src/connectors/dingtalk-recordings.ts';
import { loadDataset, hash } from './dataset.mjs';
import { persona, diary, id } from './story.mjs';
const pause = ms => new Promise(done => setTimeout(done, ms));
export function fixtureProviders(dataset) {
    return ['feishu', 'dingtalk'].map(provider => {
        const entries = dataset.manifest.recordings.filter(r => r.provider === provider), find = key => { const row = entries.find(r => r.key === key); if (!row)
            throw Error('Unknown generated recording'); return row; };
        return { id: provider, version: 'synthetic-persona@1', account: async () => ({ id: 'synthetic-linzhao-' + provider, name: '合成 · 林照' }), discover: async (_account, range) => range.cursor ? { ids: entries.slice(1).map(r => r.key) } : { ids: [entries[0].key, entries[0].key], next: 'synthetic-page-2' }, metadata: async (_account, key) => structuredClone(find(key).metadata), transcript: async (_account, metadata) => { const row = find(metadata.id), rawText = dataset.input(row.transcriptPath).bytes.toString('utf8'); return provider === 'feishu' ? { rawText, transcript: feishuTranscript(rawText, metadata.durationMs) } : dingtalkTranscript(JSON.parse(rawText), metadata.durationMs); }, media: async (_account, metadata) => ({ mimeType: 'audio/wav', bytes: dataset.input(find(metadata.id).audioPath).bytes }) };
    });
}
// Offline replay supplies an explicit model-result fixture for this generated
// story. The real generic import host still validates and saves the manifest.
async function fixtureImport({ workspace, inputPaths, hostMedia }) {
    const lines = [];
    for (const entry of diary) {
        const path = inputPaths.find(value => value.endsWith('/diary/' + entry.day + '.md'));
        assert.ok(path, 'Generated source document is present');
        const original = await readFile(path, 'utf8'), text = entry.day === '2025-03-07' ? entry.text.replaceAll('\n', '\r\n') : entry.text;
        const offset = original.indexOf(text);assert.notEqual(offset, -1);
        const start = Array.from(original.slice(0, offset)).length, end = start + Array.from(text).length;
        const image = entry.key === 'diary-photo' ? hostMedia.find(value => value.relativePath.endsWith('/diary/images/card.png')) : undefined;
        if (entry.key === 'diary-photo') assert.ok(image, 'Generated image is available as host media');
        lines.push(JSON.stringify({ item: { externalId: 'fixture:' + entry.key, revision: hash(Buffer.from(text)), observedAt: new Date().toISOString(), kind: 'file', layer: 'original', mimeType: 'text/markdown', title: entry.day + ' ' + entry.time, text, document: { recordedAt: `${entry.day}T${entry.time}+08:00`, timeBasis: 'recorded', contentRole: 'authored', originalMetadata: { sourceSlice: { unit: 'unicode_code_points', start, end, sha256: hash(Buffer.from(text)) } } } }, evidencePaths: [path], attachments: image ? [image.path] : [] }));
    }
    await writeFile(join(workspace, 'records.jsonl'), lines.join('\n') + '\n');
    await writeFile(join(workspace, 'dispositions.json'), JSON.stringify({ items: inputPaths.map(path => ({ path, status: diary.some(entry => path.endsWith('/diary/' + entry.day + '.md')) ? 'parsed' : 'excluded', reason: 'Generated story fixture' })) }));
    return { summary: 'Generated model-result fixture for the synthetic diary.', warnings: [] };
}
export async function replayDataset(directory, { runDirectory, liveModel = false, memory = false, questionIds = [], serve = false } = {}) {
    const dataset = await loadDataset(directory);
    if ((memory || questionIds.length) && !liveModel)
        throw Error('Memory and questions require explicit --live-model');
    const allQuestions = JSON.parse(dataset.files.get('evaluation/questions.json').bytes.toString('utf8'));
    for (const key of questionIds)
        if (!allQuestions.some(q => q.id === key))
            throw Error('Unknown question ID');
    let run;
    if (runDirectory) {
        run = resolve(runDirectory);
        await mkdir(run, { mode: 0o700 });
    }
    else
        run = await mkdtemp(join(tmpdir(), 'mote-persona-run-'));
    const token = randomBytes(32).toString('hex'), vault = join(run, 'vault'), report = { startedAt: new Date().toISOString(), fixture: dataset.manifest.fixtureId, syntheticOnly: true, modelCallsEnabled: liveModel, importAnalysis: liveModel ? 'live-model' : 'generated-model-result-fixture', model: liveModel ? 'gpt-6.1-terra' : null, reasoningEffort: liveModel ? 'high' : null, serviceTier: liveModel ? 'default' : null, transport: 'running', semanticVerdict: 'not-tested', physicalDevicesTested: false, realCloudAccountsTested: false, asrTested: false, diarizationTested: false, captures: [], files: [], connectors: {}, checks: [], questions: [], notTested: ['native Mac/Android permissions and capture', 'real cloud authentication', 'ASR and speaker identity', 'file interpretation (originals retained; automatic processing disabled)', 'heavy E2E and scale', 'semantic verdict requires human review'] };
    const save = () => writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    const config = { dataDir: vault, token, tokenPath: join(run, 'owner-token'), host: '127.0.0.1', port: 0, maxStorageBytes: 300000000, maxExportBytes: 50000000, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [], model: liveModel ? 'gpt-6.1-terra' : '', modelProvider: liveModel ? 'codex' : 'custom', modelProtocol: liveModel ? 'codex-app-server' : 'openai-completions', modelReasoningEffort: 'high', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', agentTimeoutMs: 300000, logLevel: 'warn', diagnosticsEnabled: true, agentTraceEnabled: liveModel, codexBin: process.env.MOTE_CODEX_BIN, codexHome: process.env.MOTE_CODEX_HOME };
    const deps = { backgroundWorker: false, connectorTesting: { recordings: fixtureProviders(dataset) }, ...(!liveModel ? { prepareImport: fixtureImport, agent: { configured: false, close: async () => { }, query: async () => { throw Error('Offline replay must never invoke a model'); } } } : {}) };
    let node;
    const keys = new Map();
    async function request(method, url, payload, expected) { const response = await node.app.inject({ method, url, headers: { authorization: 'Bearer ' + token, 'x-mote-ingress-version': '2', ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) }, ...(payload !== undefined ? { payload } : {}) }); if (expected !== undefined)
        assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body.slice(0, 400)}`);
    else
        assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body.slice(0, 400)}`); return response; }
    async function start() { node = await buildApp(config, deps); await node.app.ready(); const view = (await request('GET', '/api/file-processing')).json(); await request('PUT', '/api/file-processing', { revision: view.revision, settings: { ...view.settings, enabled: false }, policy: view.policy }); }
    async function sourceContext(sourceId, ownerRelation, description) { await request('PATCH', '/api/sources/' + encodeURIComponent(sourceId), { ownerRelation }); const context = (await request('GET', '/api/sources/' + encodeURIComponent(sourceId) + '/context')).json(); await request('PATCH', '/api/sources/' + encodeURIComponent(sourceId) + '/context', { expectedVersion: context.version, description }); }
    async function collectUsage() {
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: persona.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }), from = day.format(new Date(report.startedAt)), to = day.format(new Date()), usageItems = [];
        let usage, page = 1;
        do {
            usage = (await request('GET', '/api/usage?' + new URLSearchParams({ from, to, timeZone: persona.timeZone, pageSize: '100', groupBy: 'model', page: String(page++) }))).json();
            usageItems.push(...usage.items);
        } while (usageItems.length < usage.itemsTotal);
        usage.items = usageItems;
        report.usage = usage;
        return usage;
    }
    try {
        await writeFile(config.tokenPath, token, { mode: 0o600, flag: 'wx' });
        await save();
        await start();
        const denial = await node.app.inject({ method: 'POST', url: '/api/notes', payload: dataset.events[0].body });
        assert.equal(denial.statusCode, 401);
        report.checks.push('unauthenticated intake denied');
        for (const event of dataset.events) {
            const body = structuredClone(event.body);
            if (event.imagePath) {
                const f = dataset.input(event.imagePath);
                body.imageBase64 = f.bytes.toString('base64');
                body.imageMime = f.mimeType;
            }
            if (event.route === '/api/notes')
                noteSchema.parse(body);
            else
                captureSchema.parse(body);
            const ack = (await request('POST', event.route, body, 201)).json();
            assert.equal(ack.receipt.state, 'received');
            const replay = (await request('POST', event.route, body, 200)).json();
            assert.equal(replay.receipt.duplicate, true);
            assert.equal(replay.receipt.id, body.id);
            const saved = (await request('GET', '/api/captures/' + body.id)).json();
            if (event.route === '/api/notes')
                assert.equal(saved.ocrText, body.text);
            else
                assert.equal(saved.ocrText, body.ocrText);
            assert.equal(Date.parse(saved.capturedAt), Date.parse(body.capturedAt));
            if (event.imagePath) {
                const image = await request('GET', '/api/captures/' + body.id + '/image');
                assert.equal(hash(image.rawPayload), hash(dataset.input(event.imagePath).bytes));
            }
            report.captures.push({ key: event.key, id: body.id, receipt: ack.receipt });
            keys.set(event.key, [body.id]);
        }
        report.checks.push('current capture/note schemas; durable ACK; retry deduplication; exact original text, time and image bytes');
        const first = dataset.events[0];
        await request('POST', first.route, { ...first.body, text: 'Synthetic conflicting retry' }, 409);
        assert.equal((await request('GET', '/api/captures/' + first.body.id)).json().ocrText, first.body.text);
        report.checks.push('conflicting same-ID content rejected without rewriting original');
        const batch = dataset.manifest.imports.find(b => b.id === 'diary'), archive = dataset.input(batch.path), importRequest = { requestId: id('diary-import'), name: '合成 · 林照日记', instruction: batch.instruction, processing: 'preview', files: [{ name: 'diary-export.zip', mimeType: archive.mimeType, dataBase64: archive.bytes.toString('base64') }] };
        let imported = (await request('POST', '/api/imports', importRequest)).json();
        for (let attempt = 0; ['queued', 'preparing', 'importing'].includes(imported.status) && attempt < (liveModel ? 6000 : 200); attempt++) {
            await pause(50);
            imported = (await request('GET', '/api/imports/' + imported.id)).json();
        }
        report.importPreparation = imported;
        await save();
        assert.equal(imported.status, 'awaiting_confirmation', imported.error ?? 'Generated export metadata still requires a reviewed confirmation');
        report.diaryPreview = { id: imported.id, status: imported.status, warnings: imported.warnings, dispositions: imported.dispositions };
        assert.equal(imported.warnings.length, 0);
        await request('POST', '/api/imports/' + imported.id + '/confirm', {});
        for (let attempt = 0; imported.status !== 'completed' && attempt < 200; attempt++) {
            await pause(50);
            imported = (await request('GET', '/api/imports/' + imported.id)).json();
            if (['failed', 'cancelled'].includes(imported.status))
                break;
        }
        assert.equal(imported.status, 'completed', imported.error);
        const originals = new Map();
        for (const f of imported.files) {
            const response = await request('GET', '/api/archived-files/' + f.id + '/content');
            assert.equal(hash(response.rawPayload), f.hash);
            originals.set(f.id, response.rawPayload);
        }
        const records = node.store.evidence(imported.captureIds).filter(row => row.provenance?.mimeType === 'text/markdown');
        assert.equal(records.length, batch.expectedRecords);
        for (const entry of diary) {
            const text = entry.day === '2025-03-07' ? entry.text.replaceAll('\n', '\r\n') : entry.text, recordedAt = `${entry.day}T${entry.time}+08:00`, row = records.find(r => r.provenance?.document?.recordedAt === recordedAt && r.ocrText.replaceAll('\r\n', '\n').includes(entry.text.trim()));
            assert.ok(row, 'Diary content and recorded time must be retrievable');
            if (!liveModel) {
                assert.equal(row.ocrText, text);
                const doc = row.provenance.document, slice = doc.originalMetadata.sourceSlice, original = originals.get(doc.fileId).toString('utf8');
                assert.equal(slice.unit, 'unicode_code_points');
                assert.equal(Array.from(original).slice(slice.start, slice.end).join(''), row.ocrText);
                assert.equal(hash(Buffer.from(row.ocrText)), slice.sha256);
            }
            if (entry.key === 'diary-photo') assert.ok(row.provenance.document.attachments?.some(item => item.path.endsWith('/diary/images/card.png')));
            keys.set(entry.key, [row.id]);
        }
        await sourceContext(imported.sourceId, 'owner', persona.sourceContext);
        report.diary = { id: imported.id, captureIds: records.map(row => row.id), records: records.length, totalCaptures: imported.captureIds.length, originalFiles: imported.files.length };
        report.checks.push(liveModel ? 'ZIP generic model import; explicit timezone; preview/confirmation; diary content, image association and archived bytes' : 'ZIP generic import with generated model-result fixture; explicit timezone; preview/confirmation; exact Unicode blocks and archived bytes');
        const sourceId = 'synthetic-linzhao-files';
        await request('POST', '/api/sources', { id: sourceId, name: '合成 · 文件样本', kind: 'local-files', deviceId: persona.devices[0].id, platform: 'macos', retention: 'archive', ownerRelation: 'mixed' });
        await sourceContext(sourceId, 'mixed', persona.sourceContext + ' 计划文件是林照本人作品；无日期摘录和收藏文章是第三方；预算只是计划。');
        for (const f of dataset.manifest.sourceFiles) {
            const asset = dataset.input(f.path), begin = (await request('POST', '/api/file-sync/v1/uploads', { sourceId, previousRevision: f.previousRevision ?? null, sizeBytes: asset.bytes.length, sha256: asset.sha256, item: { externalId: f.externalId, revision: f.revision, observedAt: f.at, title: '合成 · ' + f.externalId, kind: 'file', layer: 'original', mimeType: asset.mimeType, text: '', deleted: false } })).json();
            if (begin.uploadId) {
                for (let i = 0; i < Math.ceil(asset.bytes.length / FILE_PART_BYTES); i++)
                    await request('PUT', `/api/file-sync/v1/uploads/${begin.uploadId}/parts/${i}`, asset.bytes.subarray(i * FILE_PART_BYTES, (i + 1) * FILE_PART_BYTES));
                const ack = (await request('POST', `/api/file-sync/v1/uploads/${begin.uploadId}/commit`, {})).json();
                assert.equal(ack.receipt.state, 'received');
                const bytes = (await request('GET', '/api/files/' + ack.id + '/content')).rawPayload;
                assert.equal(hash(bytes), asset.sha256);
                report.files.push({ key: f.key, id: ack.id, sha256: hash(bytes) });
            }
            else
                throw Error('Expected a fresh upload in the isolated replay');
        }
        const head = (await request('GET', '/api/file-sync/v1/head?' + new URLSearchParams({ sourceId, externalId: 'plan.md' }))).json();
        assert.equal(head.revision, '2');
        report.checks.push('real file upload parts/commit/readback; v2 head replaces v1');
        for (const provider of ['feishu', 'dingtalk']) {
            await request('POST', '/api/connectors/' + provider + '-recordings/connect');
            await request('PUT', '/api/connectors/' + provider + '-recordings/selection', { enabled: true, start: persona.period.start, end: persona.period.end, autoSync: false, backupAudio: true });
        }
        for (let round = 0; round < 30; round++) {
            const steps = node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'recording.%' AND state IN ('waiting','running') AND available_at<=? LIMIT 100").all(Date.now());
            if (!steps.length)
                break;
            await node.executor.drain(steps.map(s => s.id));
        }
        for (const provider of ['feishu', 'dingtalk']) {
            const status = (await request('GET', '/api/connectors/' + provider + '-recordings')).json();
            assert.equal(status.counts.transcripts, 1);
            assert.equal(status.counts.empty, 1);
            assert.equal(status.counts.audio, 2);
            assert.equal(status.counts.failed, 0);
            report.connectors[provider] = status;
            const items = (await request('GET', '/api/connectors/' + provider + '-recordings/items')).json(), exports = (await request('GET', '/api/connectors/' + provider + '-recordings/items?includeExports=true')).json();
            report.connectors[provider].items = items;
            for (const fixture of dataset.manifest.recordings.filter(r => r.provider === provider)) {
                const exported = exports.items.find(item => item.id === fixture.key);
                assert.ok(exported?.audio, 'Audio must be readable');
                const audio = (await request('GET', '/api/archived-files/' + exported.audio.id + '/content')).rawPayload;
                assert.equal(hash(audio), hash(dataset.input(fixture.audioPath).bytes));
                if (fixture.expectedEmpty) {
                    assert.equal(exported.empty, true);
                    assert.ok(exported.export);
                    const raw = (await request('GET', '/api/archived-files/' + exported.export.id + '/content')).rawPayload;
                    const expected = await fixtureProviders(dataset).find(p => p.id === provider).transcript({}, fixture.metadata);
                    assert.equal(raw.toString('utf8'), expected.rawText);
                }
                else {
                    const item = items.items.find(item => item.id === fixture.key);
                    assert.ok(item?.captureId);
                    const original = await request('GET', '/api/files/' + item.captureId + '/content');
                    const retained = JSON.parse(original.rawPayload.toString('utf8'));
                    assert.equal(retained.version, 1);
                    if (provider === 'feishu') assert.equal(retained.rawText, dataset.input(fixture.transcriptPath).bytes.toString('utf8'));
                    else assert.deepEqual(JSON.parse(retained.rawText), JSON.parse(dataset.input(fixture.transcriptPath).bytes.toString('utf8')));
                    const saved = (await request('GET', '/api/captures/' + item.captureId)).json(), parsed = await fixtureProviders(dataset).find(p => p.id === provider).transcript({}, fixture.metadata);
                    assert.deepEqual(retained.transcript, parsed.transcript);
                    const chunks = (await request('GET', '/api/files/' + item.captureId + '/chunks?offset=0')).json().items;
                    assert.deepEqual(chunks.map(c => c.ocrText), parsed.transcript.segments.map(s => (s.speaker ? `[${s.speaker}] ` : '') + s.text));
                    for (const [index, chunk] of chunks.entries()) {
                        assert.equal(chunk.fileEvidence.speaker, parsed.transcript.segments[index].speaker);
                        assert.equal(chunk.fileEvidence.speakerAttribution, undefined);
                        if (provider === 'dingtalk') assert.equal(chunk.fileEvidence.startMs, undefined);
                    }
                    assert.equal(saved.provenance.document.recordedAt, fixture.metadata.recordedAt);
                    keys.set(fixture.key, chunks.map(c => c.id));
                }
            }
        }
        report.checks.push('real recording orchestration with local Provider substitutes; native TXT/JSON parsers; duplicate discovery; empty transcripts; exact transcript/export/audio original readback');
        await node.materialOrganizer.tick(100);
        const before = node.store.db.prepare('SELECT count(*) n FROM captures').get().n;
        await node.app.close();
        node = undefined;
        await start();
        assert.equal(node.store.db.prepare('SELECT count(*) n FROM captures').get().n, before);
        for (const e of dataset.events)
            assert.equal((await request('GET', '/api/captures/' + e.body.id)).json().id, e.body.id);
        const duplicate = (await request('POST', '/api/imports', importRequest)).json();
        assert.equal(duplicate.id, imported.id);
        assert.deepEqual(duplicate.captureIds, imported.captureIds);
        report.checks.push('restart readback; completed import identity preserved');
        report.transport = 'passed';
        report.keyEvidence = Object.fromEntries(keys);
        if (liveModel) {
            if (memory || questionIds.includes('visual-original')) {
                const view = (await request('GET', '/api/perception')).json();
                await request('PUT', '/api/perception', { revision: view.revision, settings: { ...view.settings, enabled: false, understandingEnabled: false, allowQueryImages: true } });
            }
            const status = (await request('GET', '/api/status')).json();
            assert.equal(status.agent.model, 'gpt-6.1-terra');
            assert.equal(status.agent.reasoningEffort, 'high');
            report.modelSettings = (await request('GET', '/api/model-settings')).json();
            if (memory) {
                const evidenceIds = [...new Set([...report.captures.filter(r => !r.key.endsWith('-activity')).map(r => r.id), ...imported.captureIds])];
                const job = (await request('POST', '/api/memory-jobs', { evidenceIds, timeZone: persona.timeZone })).json();
                const done = await node.memoryPipeline.run(job.id);
                report.memory = done;
                await save();
                assert.equal(done.status, 'completed', 'Memory work did not complete; retain the report for investigation');
                report.memories = [];
                for (const memoryId of done.memoryIds)
                    report.memories.push((await request('GET', '/api/memories/' + memoryId)).json());
            }
            for (const q of allQuestions.filter(q => questionIds.includes(q.id))) {
                const evidenceIds = q.sources.flatMap(key => keys.get(key) ?? []);
                if (q.sources.some(key => !keys.has(key))) {
                    report.questions.push({ id: q.id, status: 'not-tested', reason: 'This source requires file processing or connector evidence selection; use the isolated UI and evaluation sheet.' });
                    continue;
                }
                const question = { id: q.id, selection: q.selection, status: 'running', semanticVerdict: 'not-reviewed' };
                report.questions.push(question);await save();
                try {
                    question.output = (await request('POST', '/api/query', { question: '本测试中的唯一 owner 是合成人物林照。' + q.question, after: null, before: null, deviceId: null, timeZone: persona.timeZone, ...(q.selection === 'reference' ? {anchorEvidenceIds: evidenceIds} : {evidenceIds}) })).json();
                    question.status = 'completed';
                } catch (error) {question.status = 'failed';question.failure = error.message;throw error;}
                finally {await save();}
            }
        }
        const usage = await collectUsage();
        assert.ok(liveModel || usage.total.runs === 0, 'Offline replay invoked a model');
        if (liveModel)
            assert.ok(usage.items.every(item => item.model === 'gpt-6.1-terra'));
        report.status = 'passed';
        await save();
        if (serve) {
            const url = await node.app.listen({ host: '127.0.0.1', port: 0 });
            await writeFile(join(run, 'connection.json'), JSON.stringify({ url, tokenFile: config.tokenPath }, null, 2), { mode: 0o600 });
            return { run, report, node, url, close: () => node.app.close() };
        }
        await node.app.close();
        node = undefined;
        return { run, report };
    }
    catch (error) {
        report.status = 'failed';
        report.failure = error instanceof Error ? error.message : String(error);
        if (node) try {await collectUsage();} catch {report.usageUnavailable = true;}
        await save();
        await node?.app.close();
        throw error;
    }
}
