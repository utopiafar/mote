#!/usr/bin/env node
/** Explicit, isolated synthetic-fixture tooling; never discovers a user's profile. */
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { generateDataset } from '../test/fixtures/persona/dataset.mjs';
const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, dataset: { type: 'string' }, run: { type: 'string' }, python: { type: 'string' }, speech: { type: 'boolean' }, voice: { type: 'string' }, 'live-model': { type: 'boolean' }, memory: { type: 'boolean' }, questions: { type: 'string' }, serve: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
    console.log('generate --output NEW_DIRECTORY [--speech --voice Tingting]\nreplay --dataset DIRECTORY [--run NEW_DIRECTORY] [--python /usr/bin/python3]\n       [--live-model [--memory] [--questions current-arrangement,visual-original]] [--serve]\nReplay always creates its own vault. No --url, --profile, existing-vault, reset or overwrite option.');
}
else if (positionals[0] === 'generate') {
    if (!values.output)
        throw Error('--output must name a new directory');
    await mkdir(dirname(resolve(values.output)), { recursive: true, mode: 0o700 });
    const manifest = await generateDataset(values.output, { speech: values.speech, voice: values.voice });
    console.log(JSON.stringify({ dataset: resolve(values.output), fixture: manifest.fixtureId, files: manifest.files.length + 1, audioMode: manifest.audioMode }));
}
else if (positionals[0] === 'replay') {
    if (!values.dataset)
        throw Error('--dataset is required');
    if (values.run)
        await mkdir(dirname(resolve(values.run)), { recursive: true, mode: 0o700 });
    const { replayDataset } = await import('../test/fixtures/persona/replay.mjs');
    const result = await replayDataset(values.dataset, { runDirectory: values.run, python: values.python, liveModel: values['live-model'], memory: values.memory, questionIds: values.questions?.split(',').filter(Boolean) ?? [], serve: values.serve });
    console.log(JSON.stringify({ run: result.run, status: result.report.status, transport: result.report.transport, semanticVerdict: result.report.semanticVerdict, ...(result.url ? { url: result.url, credentials: 'Private owner-token and connection.json in the run directory' } : {}) }));
    if (result.close) {
        let closing = false;
        const close = () => { if (!closing) {
            closing = true;
            void result.close().then(() => process.exit(0));
        } };
        process.once('SIGINT', close);
        process.once('SIGTERM', close);
    }
}
else
    throw Error('Use generate or replay; --help lists options');
