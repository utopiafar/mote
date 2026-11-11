import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, test } from 'vitest';
import { FILE_PART_BYTES } from '@mote/shared';
import {
  MeetingNoticeRequiredError, MeetingRecordingManager, type MeetingAudioBackend, type MeetingRecordingConnection,
  type MeetingRecordingPermissions,
} from '../src/meeting-recording';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'mote-meeting-')); roots.push(value); return value; }

class FakeAudio implements MeetingAudioBackend {
  starts = 0;
  stops = 0;
  constructor(private readonly bytes = Buffer.from('RIFF0000WAVEfmt data')) {}
  async start(input: { outputFile: string }): Promise<{ stop(): Promise<{ filePath: string; durationMs: number; microphone: boolean; systemAudio: boolean; warnings: string[] }> }> {
    this.starts++;
    const bytes = this.bytes;
    return {
      stop: async () => {
        this.stops++;
        await writeFile(input.outputFile, bytes);
        return { filePath: input.outputFile, durationMs: 60000, microphone: true, systemAudio: true, warnings: [] };
      },
    };
  }
}

const granted: MeetingRecordingPermissions = { microphone: 'granted', systemAudio: 'granted' };

function manager(directory: string, backend: MeetingAudioBackend, options: {
  permissions?: MeetingRecordingPermissions; connection?: MeetingRecordingConnection | (() => MeetingRecordingConnection); fetch?: typeof fetch;
} = {}) {
  return new MeetingRecordingManager({
    directory,
    backend,
    permissions: () => options.permissions ?? granted,
    connection: () => typeof options.connection === 'function' ? options.connection() : options.connection ?? { serverUrl: 'https://central.example', token: 'synthetic-token', deviceId: 'mac-generated' },
    fetch: options.fetch,
    now: () => new Date('2026-11-11T09:00:00Z'),
  });
}

function uploadFetch(seen: { sources: unknown[]; manifests: unknown[]; parts: number; commits: number }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const contentType = new Headers(init?.headers).get('content-type') ?? '';
    const body = contentType === 'application/json' && init?.body instanceof Uint8Array ? JSON.parse(Buffer.from(init.body).toString('utf8')) : init?.body;
    if (url.endsWith('/api/sources')) { seen.sources.push(body); return new Response(JSON.stringify({ id: (body as { id: string }).id }), { status: 200 }); }
    if (url.endsWith('/api/file-sync/v1/uploads')) { seen.manifests.push(body); return new Response(JSON.stringify({ uploadId: 'generated-upload', partBytes: FILE_PART_BYTES, parts: [] }), { status: 200 }); }
    if (/\/parts\/\d+$/.test(url)) { seen.parts++; const part = Number(url.slice(url.lastIndexOf('/') + 1)); return new Response(JSON.stringify({ part, bytes: (body as Buffer).length }), { status: 200 }); }
    if (url.endsWith('/commit')) { seen.commits++; return new Response(JSON.stringify({ id: 'generated-capture', sourceId: 'generated-source' }), { status: 200 }); }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

describe('local meeting recording', () => {
  test('idle startup never opens a recording session or the microphone', async () => {
    const directory = await root(), backend = new FakeAudio(), instance = manager(directory, backend);
    await instance.initialize();
    const status = instance.status();
    expect(status.recording).toBe(false);
    expect(status.sessions).toEqual([]);
    expect(status.pendingUploads).toBe(0);
    expect(backend.starts).toBe(0);
    await instance.flushUploads();
    expect(backend.starts).toBe(0);
  });

  test('the first start requires the in-person notice acknowledgement, then persists it', async () => {
    const directory = await root(), backend = new FakeAudio(), instance = manager(directory, backend);
    await instance.initialize();
    await expect(instance.start()).rejects.toBeInstanceOf(MeetingNoticeRequiredError);
    expect(backend.starts).toBe(0);
    await instance.acknowledgeNotice();
    await instance.start();
    expect(backend.starts).toBe(1);
    await instance.stop();
    const resumed = manager(directory, new FakeAudio());
    await resumed.initialize();
    expect(resumed.status().noticeAcknowledged).toBe(true);
    await expect(resumed.start()).resolves.toMatchObject({ recording: true });
  });

  test('missing microphone or system-audio permission refuses to start instead of silently recording one side', async () => {
    const missingMic = manager(await root(), new FakeAudio(), { permissions: { microphone: 'denied', systemAudio: 'granted' } });
    await missingMic.initialize(); await missingMic.acknowledgeNotice();
    await expect(missingMic.start()).rejects.toThrow(/麦克风/);
    expect(missingMic.status().sessions).toEqual([]);
    const missingSystem = manager(await root(), new FakeAudio(), { permissions: { microphone: 'granted', systemAudio: 'denied' } });
    await missingSystem.initialize(); await missingSystem.acknowledgeNotice();
    await expect(missingSystem.start()).rejects.toThrow(/系统音频/);
    expect(missingSystem.status().sessions).toEqual([]);
  });

  test('start and stop produce exactly one audio revision in the existing central file pipeline', async () => {
    const directory = await root(), backend = new FakeAudio(), seen = { sources: [] as unknown[], manifests: [] as unknown[], parts: 0, commits: 0 };
    const instance = manager(directory, backend, { fetch: uploadFetch(seen) });
    await instance.initialize(); await instance.acknowledgeNotice();
    await instance.start();
    const started = instance.status();
    expect(started.recording).toBe(true);
    expect(started.sessions).toHaveLength(1);
    const stopped = await instance.stop();
    expect(stopped.recording).toBe(false);
    expect(stopped.lastSession).toMatchObject({ state: 'uploaded', microphone: true, systemAudio: true, durationMs: 60000 });
    expect(seen.sources).toHaveLength(1);
    expect(seen.sources[0]).toMatchObject({ kind: 'local-meeting-recording', retention: 'archive', platform: 'macos' });
    expect(seen.manifests).toHaveLength(1);
    const manifest = seen.manifests[0] as any;
    expect(manifest.item).toMatchObject({ kind: 'file', layer: 'original', mimeType: 'audio/mp4', text: '', document: { timeBasis: 'recorded', originalMetadata: { meeting: { microphone: true, systemAudio: true, platform: 'macos' } } } });
    expect(manifest.item.externalId).toMatch(/^meeting:[a-f0-9-]{36}$/);
    expect(seen.parts).toBe(1);
    expect(seen.commits).toBe(1);
    expect(instance.status().pendingUploads).toBe(0);
    await expect(stat(join(directory, stopped.lastSession!.id))).rejects.toThrow();
  });

  test('an offline stop keeps one local audio file and uploads it later without restarting the meeting', async () => {
    const directory = await root(), backend = new FakeAudio(), seen = { sources: [] as unknown[], manifests: [] as unknown[], parts: 0, commits: 0 };
    let connection: MeetingRecordingConnection = { serverUrl: '', token: '', deviceId: 'mac-generated' };
    const instance = manager(directory, backend, { fetch: uploadFetch(seen), connection: () => connection });
    await instance.initialize(); await instance.acknowledgeNotice(); await instance.start();
    const stopped = await instance.stop();
    expect(stopped.lastSession).toMatchObject({ state: 'completed' });
    expect(stopped.pendingUploads).toBe(1);
    expect((await stat(join(directory, stopped.lastSession!.id, 'meeting.m4a'))).size).toBeGreaterThan(0);
    connection = { serverUrl: 'https://central.example', token: 'synthetic-token', deviceId: 'mac-generated' };
    await instance.flushUploads();
    expect(instance.status().pendingUploads).toBe(0);
    expect(backend.starts).toBe(1);
    expect(seen.manifests).toHaveLength(1);
  });

  test('a crash-marked recording is not resumed automatically on the next launch', async () => {
    const directory = await root();
    const id = '11111111-1111-4111-8111-111111111111';
    await writeFile(join(directory, 'meetings.json'), JSON.stringify({
      version: 1, noticeAcknowledgedAt: '2026-11-10T09:00:00Z', sessions: [{
        id, startedAt: '2026-11-10T09:00:00Z', state: 'recording', durationMs: 0, microphone: false, systemAudio: false,
        noticeAcknowledgedAt: '2026-11-10T09:00:00Z', platform: 'macos', warnings: [],
      }],
    }));
    const backend = new FakeAudio(), instance = manager(directory, backend);
    await instance.initialize();
    expect(backend.starts).toBe(0);
    expect(instance.status().recording).toBe(false);
    expect(instance.status().sessions[0]).toMatchObject({ state: 'failed' });
  });

  test('no calendar event or passive refresh can start a session', async () => {
    const directory = await root(), backend = new FakeAudio(), instance = manager(directory, backend);
    await instance.initialize(); await instance.acknowledgeNotice();
    for (let index = 0; index < 5; index++) { instance.status(); await instance.flushUploads(); }
    expect(backend.starts).toBe(0);
    expect(instance.status().sessions).toEqual([]);
    expect(await readFile(join(directory, 'meetings.json'), 'utf8')).toContain('"sessions":[]');
  });

  test('the Mac source page puts local meeting recording beside screen recording, outside notes', () => {
    const dom = new JSDOM(readFileSync(new URL('../src/index.html', import.meta.url), 'utf8'));
    const document = dom.window.document;
    const section = document.querySelector('.source-screen-section')!;
    expect(section.querySelector('[data-nav="screen"]')).not.toBeNull();
    expect(section.querySelector('[data-nav="meeting"]')).not.toBeNull();
    expect(document.querySelector('[data-page="meeting"]')).not.toBeNull();
    expect(document.querySelector('[data-page="notes"] [data-nav="meeting"]')).toBeNull();
    expect(document.querySelector('#meeting-notice-dialog')).not.toBeNull();
    expect(document.querySelector('#meeting-start')).not.toBeNull();
    expect(document.querySelector('#meeting-stop')).not.toBeNull();
    dom.window.close();
  });
});
