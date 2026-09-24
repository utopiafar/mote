import { mkdir, open, rm, readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { hostname } from 'node:os';
import { apiClient, resolvedConnection } from './client.js';
import { SourceSync, sourceHash } from '../apps/desktop/src/source-sync.js';
import { scanSourceFiles } from '../apps/desktop/src/source-files.js';
import { DEFAULT_SOURCE_OPTIONS, normalizeSourceOptions, redactSourceText, type SourceDefinition, type SourceRequest } from '../apps/desktop/src/source-types.js';
import {initializeCliIngressState} from './cli-ingress-state.js';
const args = process.argv.slice(2);
const usage = 'Usage: npm run import:files -- --root /explicit/folder-or-file [--extensions .md,.txt,.json,.csv,.ics] [--retention snapshot|reference|archive] [--initial-sync all|new_only] [--exclude relative/path,...] [--redact-literal exact-text] [--track-deletions] [--dry-run] [--watch]\nOnly explicitly selected files; no symlinks or hidden traversal. Reference sends metadata only, archive sends originals. Deletion tracking is opt-in; historical versions remain. Select a node with MOTE_ENV_FILE or the profile CLI.';
if (args.includes('--help')) { console.info(usage); process.exit(0); }
const values = new Map<string, string[]>();
const flags = new Set(['--dry-run', '--watch', '--track-deletions']);
const valued = new Set(['--root', '--extensions', '--retention', '--initial-sync', '--exclude', '--redact-literal']);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (flags.has(arg)) { values.set(arg, []); continue; }
  if (!valued.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(usage);
  const list = values.get(arg) || []; list.push(args[++i]!); values.set(arg, list);
}
const get = (name: string) => values.get(name)?.at(-1);
if (!get('--root')) throw new Error(usage);
const selectedPath = resolve(get('--root')!);
if ((await lstat(selectedPath)).isSymbolicLink()) throw new Error('Selected root must not be a symlink');
const root = await realpath(selectedPath);
const options = normalizeSourceOptions({ ...DEFAULT_SOURCE_OPTIONS,
  extensions: (get('--extensions') || DEFAULT_SOURCE_OPTIONS.extensions.join(',')).split(',').map(s => s.trim()),
  retention: get('--retention') || 'snapshot', initialSync:get('--initial-sync')||'all', trackDeletions: values.has('--track-deletions'),
  excludedPaths: (get('--exclude') || '').split(',').filter(Boolean), redactLiterals: values.get('--redact-literal') || [],
});
const deviceId = 'files-' + sourceHash(hostname() + ':' + resolvedConnection.profile).slice(0, 24);
const id = 'files-' + sourceHash(deviceId + ':' + root).slice(0, 32);
const source: SourceDefinition = { id, deviceId, name: redactSourceText(basename(root), options.redactLiterals).slice(0, 200) || '本地文件', kind: 'local-files', platform: 'import', retention: options.retention, initialSync:options.initialSync, enabled: true };
const stateDirectory = resolvedConnection.profileDirectory ? join(resolvedConnection.profileDirectory, 'file-sync') : resolve(resolvedConnection.baseDir, '.mote/file-sync');
const client = values.has('--dry-run') ? undefined : apiClient();
const statePath = join(stateDirectory, id + '-' + (client?.binding.slice(0, 16) || 'dry-run') + '.json');
const policy = sourceHash(JSON.stringify({ retention: options.retention, trackDeletions: options.trackDeletions, extensions: options.extensions, excludedPaths: options.excludedPaths, redactLiterals: options.redactLiterals }));
const request: SourceRequest | undefined = client;
let lock: Awaited<ReturnType<typeof open>> | undefined;
let stopped = false;
const controller = new AbortController();
const stop = () => { stopped = true; controller.abort(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  let engine: SourceSync | undefined;
  if (request) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const lockPath = statePath + '.lock';
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let recovery: Awaited<ReturnType<typeof open>> | undefined;
      try {
        recovery = await open(lockPath + '.recovery', 'wx', 0o600);
        const pid = Number(await readFile(lockPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Importer lock is invalid; preserve state and inspect its owner before recovery');
        try { process.kill(pid, 0); throw new Error('Another importer owns this source state'); }
        catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
        await rm(lockPath); lock = await open(lockPath, 'wx', 0o600);
      } finally { if (recovery) { await recovery.close(); await rm(lockPath + '.recovery', { force: true }); } }
    }
    await lock.writeFile(String(process.pid)); await lock.sync();
    engine = new SourceSync(statePath);
    const ingress=await initializeCliIngressState(statePath,engine);
    if(ingress.reset)console.info('Legacy source receipts and staged originals were reset for ingress v2; scanning this source again.');
    await engine.ensurePolicy(policy);
  }
  async function scan(): Promise<void> {
    const result = await scanSourceFiles(root, options, controller.signal, request ? statePath + '.atime.json' : undefined);
    let count = result.items.length;
    if (request && engine) {
      const prepare = async () => {
      const registered = await request('/api/sources', source, 'POST', controller.signal) as { id?: unknown };
      if (registered?.id !== id) throw new Error('Source registration ACK mismatch');
      // Explicit CLI options are the local owner's desired retention. Never override central enabled/pause.
      const patched = await request('/api/sources/' + id, { retention: options.retention, initialSync:options.initialSync, name: source.name }, 'PATCH', controller.signal) as { id?: unknown };
      if (patched?.id !== id) throw new Error('Source configuration ACK mismatch');
      };
      // SourceSync checks every v2 receipt before removing a pending revision.
      const synced = await engine.syncScan(result, options.trackDeletions, source, request, controller.signal, prepare);
      count = synced.changes; const state = synced.state;
      if (state === 'paused') { console.info('Central source is paused; pending revisions retained locally.'); return; }
    }
    console.info(`${request ? 'Received' : 'Would send'} ${count} changed UTF-8 text files; skipped ${result.skipped}; deletion scan ${result.complete && options.trackDeletions ? 'enabled' : 'not applied'}.`);
  }
  do {
    try { await scan(); }
    catch (error) { if (!values.has('--watch')) throw error; console.error('Source sync incomplete; pending revisions retained. Check the selected path, permissions, node and authentication.'); }
    if (!values.has('--watch') || stopped) break;
    await new Promise<void>(resolve => { const timer = setTimeout(done, 30000); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); } controller.signal.addEventListener('abort', done, { once: true }); if (controller.signal.aborted) done(); });
  } while (!stopped);
} finally {
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  if (lock) { await lock.close(); await rm(statePath + '.lock', { force: true }); }
}
