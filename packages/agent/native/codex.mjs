#!/usr/bin/env node
// The private native dependency implements the normal Codex App Server protocol.
// Keep the CLI-shaped entrypoint used by Mote's import and query adapters.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
if (args[0] === 'app-server') args.shift();
const child = spawn(fileURLToPath(new URL('./bin/codex-app-server', import.meta.url)), args, {stdio: 'inherit'});
child.on('error', () => {process.stderr.write('Mote native App Server is unavailable. Run npm run native:prepare -w @mote/agent.\n'); process.exitCode = 1;});
child.on('exit', code => {process.exitCode = code ?? 1;});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
