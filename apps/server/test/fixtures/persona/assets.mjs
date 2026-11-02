import sharp from 'sharp';
import { zipSync } from 'fflate';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
export const zip = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, [Buffer.from(data), { mtime: new Date(2025, 2, 1, 12), level: 6 }]]))));
export async function card() {
    const glyphs = { '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'], '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'] };
    const pixels = [...'9B2Q'].flatMap((c, index) => glyphs[c].flatMap((line, y) => [...line].flatMap((bit, x) => bit === '1' ? [`<rect x="${630 + index * 48 + x * 8}" y="${490 + y * 8}" width="8" height="8"/>`] : []))).join('');
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#f4f1e8"/><rect x="55" y="55" width="850" height="45" fill="#263d49"/><rect x="70" y="180" width="240" height="120" fill="#e1393e"/><circle cx="480" cy="230" r="80" fill="#286bd1"/><path d="M770 140 L690 300 L850 300 Z" fill="#248853"/><rect x="740" y="390" width="70" height="70" fill="#e6bf18"/><rect x="605" y="475" width="230" height="90" fill="#263d49"/><g fill="white">${pixels}</g></svg>`)).png().toBuffer();
}
export function wav(pcm, sampleRate = 16000) { const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); }
function pcmFromWav(bytes) {
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
        throw Error('Speech renderer did not return WAV');
    let format, data;
    for (let at = 12; at + 8 <= bytes.length;) {
        const size = bytes.readUInt32LE(at + 4), chunk = bytes.toString('ascii', at, at + 4);
        if (at + 8 + size > bytes.length)
            throw Error('Truncated WAV');
        if (chunk === 'fmt ')
            format = bytes.subarray(at + 8, at + 8 + size);
        if (chunk === 'data')
            data = bytes.subarray(at + 8, at + 8 + size);
        at += 8 + size + (size % 2);
    }
    if (!format || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16 || !data)
        throw Error('Expected mono 16 kHz signed PCM speech');
    return data;
}
export async function recordingAudio(segments, { speech = false, voice = 'Tingting' } = {}) {
    if (!speech || !segments.length) {
        const durationMs = segments.length ? Math.max(3000, segments.length * 1800) : 1000, pcm = Buffer.alloc(durationMs * 32);
        if (segments.length)
            for (let sample = 0; sample < pcm.length / 2; sample++)
                pcm.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 440 / 16000) * 900), sample * 2);
        return { bytes: wav(pcm), durationMs, starts: segments.map((_, i) => i * 1800), mode: segments.length ? 'test-tone-not-speech' : 'silence' };
    }
    const root = await mkdtemp(join(tmpdir(), 'mote-persona-tts-'));
    try {
        const chunks = [], starts = [];
        let bytes = 0;
        for (const [i, segment] of segments.entries()) {
            const output = join(root, i + '.wav');
            await exec('/usr/bin/say', ['-v', voice, '-r', '180', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', output, segment.text], { timeout: 60000, maxBuffer: 100000 });
            const pcm = pcmFromWav(await readFile(output));
            starts.push(Math.floor(bytes / 32));
            chunks.push(pcm, Buffer.alloc(8000));
            bytes += pcm.length + 8000;
        }
        return { bytes: wav(Buffer.concat(chunks)), durationMs: Math.ceil(bytes / 32), starts, mode: 'synthetic-speech', voice };
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}
export function docx(text) { return zip({ '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</w:t></w:r></w:p></w:body></w:document>` }); }
export function pdf() {
    const text = 'BT /F1 14 Tf 45 740 Td (SYNTHETIC - Lin Zhao / Paper Bay) Tj 0 -30 Td (Prototype budget: 18 sheets, 24 binder clips.) Tj 0 -30 Td (A proposal only. No purchase or payment is recorded.) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`];
    let result = '%PDF-1.4\n', offsets = [0];
    for (const [i, o] of objects.entries()) {
        offsets.push(Buffer.byteLength(result));
        result += `${i + 1} 0 obj\n${o}\nendobj\n`;
    }
    const start = Buffer.byteLength(result);
    result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    return Buffer.from(result);
}
