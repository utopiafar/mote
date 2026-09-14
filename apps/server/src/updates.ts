import type { FastifyInstance } from 'fastify';
import { checkRelease, ReleaseError, type ReleaseChannel } from '@mote/shared/release';

type ReleaseCheck = typeof checkRelease;
export interface UpdateContext { currentVersion: string; profile?: string; runtime?: 'native' | 'docker' | 'unknown'; profileHome?: string; repository?: string; channel?: ReleaseChannel }
export interface UpdateStatus {
  repository: string; channel: ReleaseChannel; currentVersion: string; latestVersion: string | null;
  available: boolean; verified: boolean; checkedAt: string | null;
  state: 'idle' | 'checking' | 'ready' | 'error'; error?: string;
  releaseUrl: string | null; runtime: 'native' | 'docker' | 'unknown';
  commands: { check: string; update: string; rollback: string } | null;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
/** Read-only release checks. The HTTP surface never selects a repository, path, command or signing key. */
export function createUpdateService(context: UpdateContext, dependencies: { checkRelease?: ReleaseCheck; clock?: () => number } = {}) {
  const check = dependencies.checkRelease ?? checkRelease, clock = dependencies.clock ?? Date.now;
  const runtime = context.runtime ?? 'unknown';
  const supported = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(context.profile ?? '') && context.profile !== 'legacy' && runtime !== 'unknown';
  const repository = context.repository ?? 'utopiafar/mote', channel = context.channel ?? 'stable';
  const controller = new AbortController(); let closed = false;
  let result: UpdateStatus = { repository, channel, currentVersion: context.currentVersion, latestVersion: null, available: false, verified: false, checkedAt: null, state: 'idle', releaseUrl: null, runtime, commands: null };
  let pending: Promise<UpdateStatus> | undefined; let previousAttempt = -Infinity;
  const status = () => structuredClone(result);
  async function perform() {
    result = { ...result, state: 'checking' }; delete result.error;
    try {
      const checked = await check({ repository, channel, currentVersion: context.currentVersion, signal: controller.signal });
      const manifest = checked.manifest;
      const suffix = ` --profile ${context.profile}${context.profileHome ? ` --home ${quote(context.profileHome)}` : ''}`;
      result = { ...result, latestVersion: manifest.version, available: checked.available, verified: true, checkedAt: new Date(clock()).toISOString(), state: 'ready', releaseUrl: manifest.notesUrl,
        commands: supported ? { check: `node scripts/mote.mjs check-update${suffix}`, update: `node scripts/mote.mjs update${suffix} --version ${quote(manifest.version)}`, rollback: `node scripts/mote.mjs rollback${suffix} --restore-data` } : null };
    } catch (error) {
      const codes = ['release_not_found', 'release_rate_limited', 'invalid_manifest_signature', 'unknown_release_key', 'release_channel_mismatch', 'release_identity_mismatch', 'update_request_cancelled'];
      const code = error instanceof ReleaseError && codes.includes(error.code) ? error.code : 'release_check_failed';
      result = { ...result, latestVersion: null, available: false, verified: false, checkedAt: new Date(clock()).toISOString(), state: 'error', error: code, releaseUrl: null, commands: null };
    }
    return status();
  }
  return { status, check: () => {
    if (closed) return Promise.resolve(status());
    if (pending) return pending;
    if (clock() - previousAttempt < 60000) return Promise.resolve(status());
    previousAttempt = clock(); pending = perform().finally(() => { pending = undefined; }); return pending;
  }, close: async () => { closed = true; controller.abort(); await pending; } };
}
/** Register beneath the central owner's existing /api authentication hook. No updater process is spawned here. */
export function registerUpdateRoutes(app: FastifyInstance, service: ReturnType<typeof createUpdateService>) {
  app.get('/api/software-update', async () => service.status());
  app.post('/api/software-update/check', async (request, reply) => {
    if (request.body !== undefined && request.body !== null && (typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length)) return reply.code(400).send({ error: 'update_check_parameters_not_allowed', requestId: request.id });
    return service.check();
  });
}
