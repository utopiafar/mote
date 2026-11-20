import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DeviceRecord, Heartbeat } from '@mote/shared';
import { buildApp } from '../../src/app.js';
import { connectorsConfigSchema, type ConfigurationPlatformOptions } from '../../src/config.js';
import { materialId } from '../../src/materials.js';

type Central = Awaited<ReturnType<typeof buildApp>>;
const mac = { deviceId: 'lb1-mac', deviceName: 'Generated Mac', platform: 'macos' } as const;
const phone = { deviceId: 'lb1-paused', deviceName: 'Generated paused phone', platform: 'android' } as const;
const timed = { deviceId: 'lb1-timed', deviceName: 'Generated timed phone', platform: 'android' } as const;
const external = { id: 'lb1-service', deviceId: 'lb1-provider', name: 'Generated service', platform: 'import', kind: 'custom' };
const deadlineMs = 30 * 60_000;
const advancePath = '/api/fixture/lb1/advance-contact';

export async function seedSourceBar(node: Central, headers: { authorization: string }) {
    const at = new Date().toISOString();
    const sync = { state: 'idle', intervalMinutes: 15, batchSize: 20, pendingRecords: 0 } as const;
    for (const beat of [
        { ...mac, status: 'capturing', sync: { ...sync, mode: 'manual' } },
        { ...phone, status: 'paused', sync: { ...sync, mode: 'manual' } },
        { ...timed, status: 'capturing', sync: { ...sync, mode: 'realtime' } },
    ] satisfies Omit<Heartbeat, 'queueDepth'>[]) {
        const report = await node.app.inject({
            method: 'POST', url: '/api/devices/heartbeat', headers, payload: { ...beat, queueDepth: 0 },
        });
        assert.equal(report.statusCode, 200, report.body);
    }
    const notes = new Map<string, string>();
    for (const [device, text] of [[mac, 'Generated Mac note'], [phone, 'Generated phone note']] as const) {
        const id = randomUUID();
        const note = await node.app.inject({
            method: 'POST', url: '/api/notes', headers: { ...headers, 'x-mote-ingress-version': '2' },
            payload: { ...device, id, capturedAt: at, text },
        });
        assert.equal(note.statusCode, 201, note.body);
        notes.set(device.deviceId, 'capture:' + id);
    }
    node.sources.register(external);
    const externalId = 'generated-document';
    const text = 'Generated service document';
    const original = await node.sources.upsert(external.id, {
        externalId, revision: 'generated-v1', observedAt: at, title: text, kind: 'message', layer: 'snapshot', text, deleted: false,
    });
    const material = node.materials.publish({
        id: materialId(external.id, externalId), kind: 'mote.message', schemaVersion: 1, title: text,
        origin: { sourceId: external.id, externalId, deviceId: external.deviceId, lastAt: at },
        members: [{ id: 'original', kind: 'capture', ref: 'capture:' + original.id }],
        blocks: [{ id: 'body', kind: 'text', format: 'plain', text, memberIds: ['original'] }],
        coverage: { state: 'complete' }, fidelity: { state: 'derived' }, retention: { original: 'retained', policy: 'keep' },
    });
    return { notes, sourceId: external.id, sourceRef: material.ref };
}

async function buildPage(directory: string, token: string) {
    const { build } = await import('vite');
    const webRoot = join(directory, 'web');
    await build({
        configFile: false,
        envFile: false,
        root: fileURLToPath(new URL('../../../web/', import.meta.url)),
        publicDir: false,
        logLevel: 'warn',
        esbuild: { jsx: 'automatic' },
        build: {
            outDir: webRoot, emptyOutDir: false,
            lib: {
                entry: fileURLToPath(new URL('./source-bar-emulator-page.tsx', import.meta.url)),
                formats: ['es'], fileName: () => 'source-bar.js', cssFileName: 'source-bar',
            },
        },
    });
    await writeFile(join(webRoot, 'build-info.json'), await readFile(new URL('../../package.json', import.meta.url)));
    await writeFile(join(webRoot, 'index.html'), `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="lb1-test-token" content="${token}"><title>LB1 来源栏夹具</title>
<link rel="stylesheet" href="/source-bar.css"><div id="root"></div><script type="module" src="/source-bar.js"></script>`, { mode: 0o600 });
    return webRoot;
}

async function run(arg: string | undefined) {
    const smoke = arg === '--smoke';
    const port = smoke ? 0 : Number(arg);
    assert.ok(smoke || (Number.isInteger(port) && port >= 1024 && port < 65536 && ![47862, 47852, 59599].includes(port)),
        'Pass an unused fixture port, such as 46281, or --smoke');
    const directory = await mkdtemp(join(tmpdir(), 'mote-lb1-emulator-'));
    const token = 'generated-lb1-' + randomUUID();
    const webRoot = await buildPage(directory, token);
    const config: ConfigurationPlatformOptions = {
        path: join(directory, 'mote.yaml'),
        privateCredential: { token, tokenPath: join(directory, 'owner-token') },
        initialDocument: {
            version: 1, revision: 0,
            storage: { dataDir: join(directory, 'data'), maxExportBytes: 1_000_000 },
            server: { host: '127.0.0.1', port, profile: 'test', allowedOrigins: [] },
            execution: { insightIntervalHours: 0 },
            models: {
                deployment: { model: '', apiKey: '', allowUnauthenticatedLocal: false, protocol: 'deepseek', reasoningEffort: 'high' },
                embedding: { model: '', baseUrl: '', apiKey: '' },
            },
            diagnostics: { level: 'silent' },
            connectors: connectorsConfigSchema.parse({ directory: join(directory, 'connectors'), mcpEnabled: false }),
        },
    };
    const node = await buildApp(config, {
        webRoot, backgroundWorker: false,
        agent: { configured: false, async query() { throw Error('No model calls in the LB1 fixture'); }, async close() {} },
    });
    const headers = { authorization: 'Bearer ' + token };
    const deadline = Date.now() - 1;
    mock.timers.enable({ apis: ['Date'], now: deadline - deadlineMs });
    try {
        await node.materialOrganizer.close();
        node.app.post(advancePath, async () => {
            mock.timers.reset();
            return { elapsedMs: Date.now() - (deadline - deadlineMs) };
        });
        await seedSourceBar(node, headers);
        mock.timers.setTime(deadline);
        if (smoke) {
            const page = await node.app.inject('/');
            assert.equal(page.statusCode, 200);
            assert.match(page.body, /src="\/source-bar\.js"/);
            for (const [asset, mime] of [['source-bar.js', /javascript/], ['source-bar.css', /text\/css/]] as const) {
                const response = await node.app.inject('/' + asset);
                assert.equal(response.statusCode, 200);
                assert.match(String(response.headers['content-type']), mime);
            }
            const devices = async () => {
                const response = await node.app.inject({ url: '/api/devices', headers });
                assert.equal(response.statusCode, 200);
                return response.json<{ items: DeviceRecord[]; disconnectedDeviceIds: string[] }>();
            };
            const before = await devices();
            assert.deepEqual(before.disconnectedDeviceIds, []);
            const advanced = await node.app.inject({ method: 'POST', url: advancePath, headers });
            assert.equal(advanced.statusCode, 200);
            const after = await devices();
            assert.deepEqual(after.items, before.items);
            assert.deepEqual(after.disconnectedDeviceIds, [timed.deviceId]);
            console.log('LB1 fixture bundle, static page and Central contact boundary passed');
            await node.app.close();
            return;
        }
        const url = await node.app.listen({ host: '127.0.0.1', port });
        console.log(JSON.stringify({ generatedOnly: true, url, profile: directory }));
        await new Promise<void>(resolve => {
            process.once('SIGINT', resolve);
            process.once('SIGTERM', resolve);
        });
        await node.app.close();
    } catch (error) {
        await node.app.close();
        throw error;
    } finally {
        mock.timers.reset();
    }
}

if (import.meta.main) await run(process.argv[2]);
