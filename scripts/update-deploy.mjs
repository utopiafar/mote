import { rename, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compose, startNative, stopNative, nativeIdentity, execute, dockerContainer, backupProfile, restoreProfile, verifiedBackup, atomicJson } from './profile-lib.mjs';
import { preserveConnectorState, restoreConnectorState } from './update-private.mjs';

export async function startProfile(p) { return p.meta.runtime === 'docker' ? compose(p, ['up', '--detach', '--no-build', '--wait'], { timeoutMs: 120000 }).then(() => ({ started: true, project: p.project, url: p.url })) : startNative(p); }
export async function stopProfile(p) { return p.meta.runtime === 'docker' ? compose(p, ['stop'], { capture: true }).then(() => ({ stopped: true })) : stopNative(p); }
/** Caller holds the profile lifecycle lock. Prepared code is verified before this function stops the service. */
export async function changeProfileDeployment(p, options = {}) {
  const { rollback = false, prepared } = options;
  if (rollback && (!options.restoreData || !p.meta.previous?.backup)) throw Error('Rollback restores the pre-upgrade snapshot and preserves current data separately. Review profile.json previous.backup, then use --restore-data');
  let next;
  if (rollback) { next = p.meta.previous; await verifiedBackup(next.backup); }
  else if (prepared) next = prepared;
  else if (p.meta.runtime === 'native') {
    if (!options.release) throw Error('Native upgrade requires --release pointing to a separately built, immutable checkout');
    if (resolve(options.release) === resolve(p.meta.release)) throw Error('Use a separate release directory so the previous code remains available for rollback');
    await stat(join(resolve(options.release), 'apps/server/dist/index.js')); next = { release: resolve(options.release) };
  } else {
    if (!options.image) throw Error('Docker upgrade requires --image; build or pull it first');
    next = { image: await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', options.image], { capture: true }) };
  }
  let wasRunning;
  if (p.meta.runtime === 'docker') {
    const container = await dockerContainer(p);
    p.meta.image = await execute('docker', ['inspect', '--format', '{{.Image}}', container], { capture: true });
    wasRunning = await execute('docker', ['inspect', '--format', '{{.State.Running}}', container], { capture: true }) === 'true';
  } else wasRunning = (await nativeIdentity(p)).running;
  await stopProfile(p);
  let backup, privateConnectors;
  try {
    backup = await backupProfile(p, join(p.directory, 'backups', `${rollback ? 'pre-rollback' : 'pre-upgrade'}-${Date.now()}-${randomUUID().slice(0, 8)}`));
    privateConnectors = rollback ? await preserveConnectorState(p) : undefined;
  } catch (error) {
    // No selection or data directory has changed yet: the original program is still safe to run.
    // Preserve an intentionally stopped profile instead of starting it as a side effect of failure.
    if (wasRunning) {
      try { await startProfile(p); }
      catch { throw Error('Update preparation failed and the unchanged deployment could not restart; inspect profile status before retrying'); }
    }
    throw error;
  }
  try {
    const previous = { ...p.meta, backup }; delete previous.previous;
    let rollbackVolume, preservedData;
    if (rollback) {
      if (p.meta.runtime === 'native') { preservedData = `${p.dataDir}.before-rollback-${Date.now()}`; await rename(p.dataDir, preservedData); }
      else { await compose(p, ['down'], { capture: true }); rollbackVolume = `${p.project}-rollback-${Date.now()}`; }
    }
    p.meta = { ...p.meta, ...next, tunnel: p.meta.tunnel, previous, ...(rollbackVolume ? { volume: rollbackVolume } : {}) };
    delete p.meta.backup;
    if (!next.releaseVersion) delete p.meta.releaseVersion;
    if (!next.releaseTag) delete p.meta.releaseTag;
    await atomicJson(p.metaFile, p.meta);
    if (rollback) { await restoreProfile(p, next.backup); await restoreConnectorState(p, privateConnectors); }
    // Failure retains the snapshot and selection record. Never automatically run old code on migrated data.
    const started = await startProfile(p);
    if (prepared?.releaseVersion) {
      const response = await fetch(p.url + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.json()).version !== prepared.releaseVersion) throw Error('Updated process version did not match the signed release; snapshot retained for explicit rollback');
    }
    return { ...started, snapshot: backup, ...(preservedData ? { preservedData } : {}) };
  } finally { if (privateConnectors) await rm(privateConnectors, { recursive: true, force: true }); }
}
