import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import mammoth from 'mammoth';
import { captureSchema, noteSchema } from '@mote/shared';
import { generateDataset, loadDataset } from './fixtures/persona/dataset.mjs';
import { fixtureProviders, replayDataset } from './fixtures/persona/replay.mjs';
async function fixture(t: import('node:test').TestContext) { const root = await mkdtemp(join(tmpdir(), 'mote-persona-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('fictional inputs are reproducible and consumed by current device, document and recording readers', async (t) => {
    const root = await fixture(t), a = await generateDataset(join(root, 'a')), b = await generateDataset(join(root, 'b'));
    assert.deepEqual(a, b);
    const data = await loadDataset(join(root, 'a'));
    assert.equal(data.events.length, 12);
    for (const e of data.events) {
        const body = { ...e.body, ...(e.imagePath ? { imageBase64: data.input(e.imagePath).bytes.toString('base64'), imageMime: data.input(e.imagePath).mimeType } : {}) };
        (e.route === '/api/notes' ? noteSchema : captureSchema).parse(body);
    }
    const zip = unzipSync(data.input('imports/diary-export.zip').bytes);
    assert.ok(zip['diary/images/card.png']);
    assert.ok(zip['__MACOSX/._export']);
    assert.ok(Buffer.from(zip['diary/2025-03-08.md']).toString().includes('👩🏽‍💻'));
    assert.ok(Buffer.from(zip['diary/2025-03-07.md']).includes(Buffer.from('\r\n')));
    for (const path of ['assets/card.png', 'assets/card.jpg', 'assets/card.webp']) {
        const m = await sharp(data.input(path).bytes).metadata();
        assert.equal(m.width, 960);
        assert.equal(m.height, 600);
    }
    const doc = await mammoth.extractRawText({ buffer: data.input('files/project-note.docx').bytes });
    assert.match(doc.value, /第一版发送，反馈未知/);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await getDocument({ data: new Uint8Array(data.input('files/budget.pdf').bytes), useSystemFonts: true }).promise;
    try {
        const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i: any) => i.str ?? '').join(' ');
        assert.match(text, /18 sheets, 24 binder clips/);
        assert.match(text, /No purchase or payment/);
    }
    finally {
        await pdf.destroy();
    }
    for (const provider of fixtureProviders(data)) {
        const first = await provider.discover({}, {}), last = await provider.discover({}, { cursor: first.next });
        assert.equal(first.ids[0], first.ids[1]);
        assert.equal(last.ids.length, 1);
        for (const key of [first.ids[0], last.ids[0]]) {
            const metadata = await provider.metadata({}, key), result = await provider.transcript({}, metadata);
            if (key.endsWith('empty'))
                assert.equal(result.transcript, null);
            else {
                assert.equal(result.transcript.segments.length, 2);
                assert.ok(result.transcript.segments.every((s: any) => s.uncertain));
                if (provider.id === 'dingtalk')
                    assert.ok(result.transcript.segments.every((s: any) => s.untimed && s.startMs === 0 && s.endMs === 0));
            }
        }
    }
    // The oracle contains the visual answer. Source prose and names cannot reveal it.
    assert.ok(data.files.get('evaluation/questions.json').bytes.toString().includes('9B2Q'));
    for (const f of data.manifest.files.filter((f: any) => f.role === 'input' && /text|json/.test(f.mimeType)))
        assert.ok(!data.input(f.path).bytes.toString().includes('9B2Q'));
    assert.throws(() => data.input('evaluation/questions.json'), /Only declared input/);
});
test('dataset loading rejects changed bytes, out-of-root paths and symlinked input before replay', async (t) => {
    const root = await fixture(t);
    await generateDataset(join(root, 'a'));
    const p = join(root, 'a', 'assets/card.png'), original = await readFile(p);
    await writeFile(p, 'Changed synthetic bytes');
    await assert.rejects(loadDataset(join(root, 'a')), /differs/);
    await writeFile(p, original);
    const manifestPath = join(root, 'a', 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: '../outside' }] }));
    await assert.rejects(loadDataset(join(root, 'a')), /Unsafe/);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, 'outside'), original);
    await rm(p);
    await symlink(join(root, 'outside'), p);
    await assert.rejects(loadDataset(join(root, 'a')), /inside/);
});
test('offline persona replay uses real authenticated HTTP, SQLite, archive, file and connector boundaries', { skip: process.env.MOTE_PERSONA_REPLAY !== '1' }, async (t) => {
    const root = await fixture(t), dataset = join(root, 'dataset'), run = join(root, 'run');
    await generateDataset(dataset);
    const result = await replayDataset(dataset, { runDirectory: run });
    assert.equal(result.report.transport, 'passed');
    assert.equal(result.report.semanticVerdict, 'not-tested');
    assert.equal(result.report.usage.total.runs, 0);
    assert.equal(result.report.captures.length, 12);
    assert.equal(result.report.diary.records, 8);
    assert.equal(result.report.files.length, 10);
    for (const provider of ['feishu', 'dingtalk']) {
        const counts = result.report.connectors[provider].counts;
        assert.equal(counts.transcripts, 1);
        assert.equal(counts.empty, 1);
        assert.equal(counts.audio, 2);
        assert.equal(counts.failed, 0);
    }
    await assert.rejects(replayDataset(dataset, { runDirectory: run }), /EEXIST/);
    await assert.rejects(generateDataset(dataset), /EEXIST/);
    await assert.rejects(replayDataset(dataset, { memory: true }), /explicit/);
    assert.equal(JSON.parse(await readFile(join(run, 'report.json'), 'utf8')).transport, 'passed', 'refused replay must preserve the existing report');
});
