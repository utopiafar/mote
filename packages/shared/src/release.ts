import { constants, createHash, verify } from 'node:crypto';
import { open, link, rm, lstat } from 'node:fs/promises';
import { z } from 'zod';
import { RELEASE_KEY_ID, RELEASE_PUBLIC_KEY } from './release-key.js';

export { RELEASE_KEY_ID, RELEASE_PUBLIC_KEY };
export const RELEASE_REPOSITORY = 'utopiafar/mote';
export type ReleaseChannel = 'stable' | 'preview';
export class ReleaseError extends Error {
  constructor(public code: string) { super(code); this.name = 'ReleaseError'; }
}
const fail = (code: string): never => { throw new ReleaseError(code); };
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function validVersion(value: string): boolean {
  const match = value.length <= 80 && versionPattern.exec(value);
  return Boolean(match && (!match[4] || match[4].split('.').every(s => !/^\d+$/.test(s) || s === '0' || !s.startsWith('0'))));
}
export function compareVersions(a: string, b: string): number {
  if (!validVersion(a) || !validVersion(b)) return fail('invalid_version');
  const [ac, ap] = a.split('-'), [bc, bp] = b.split('-');
  const aa = ac.split('.').map(Number), bb = bc.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  // Preserve all hyphens inside prerelease identifiers.
  const preA = ap === undefined ? undefined : a.slice(ac.length + 1);
  const preB = bp === undefined ? undefined : b.slice(bc.length + 1);
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const pa = preA.split('.'), pb = preB.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined || pb[i] === undefined) return pa[i] === undefined ? -1 : 1;
    if (pa[i] === pb[i]) continue;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb) return BigInt(pa[i]) > BigInt(pb[i]) ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;
    return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}
const repositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const assetSchema = z.object({
  component: z.enum(['desktop', 'android', 'server']), platform: z.enum(['darwin', 'android', 'source']),
  arch: z.enum(['arm64', 'x64', 'all']), format: z.enum(['zip', 'apk', 'tar.gz']),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/), url: z.string().max(2000),
  size: z.number().int().positive().max(2_000_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  versionCode: z.number().int().positive().max(2_100_000_000).optional(), packageName: z.string().max(200).optional(),
  certificateSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), bundleId: z.string().max(200).optional(),
  signing: z.enum(['adhoc', 'developer-id']).optional(), teamId: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), version: z.string().refine(validVersion), channel: z.enum(['stable', 'preview']),
  repository: repositorySchema, tag: z.string().max(81), publishedAt: z.string().datetime({ offset: true }),
  notesUrl: z.string().max(2000), assets: z.array(assetSchema).min(1).max(20),
  images: z.array(z.object({ component: z.literal('server'), image: z.string().max(400) }).strict()).max(2).default([]),
}).strict();
export type ReleaseManifest = z.infer<typeof manifestSchema>;
export type ReleaseAsset = z.infer<typeof assetSchema>;
export type VerifyReleaseOptions = { repository?: string; channel?: ReleaseChannel; version?: string; publicKey?: string; keyId?: string };

export function verifyReleaseEnvelope(raw: Uint8Array | string, options: VerifyReleaseOptions = {}): ReleaseManifest {
  if (Buffer.byteLength(raw) > 262144) return fail('manifest_too_large');
  try {
    const envelope = z.object({ schemaVersion: z.literal(1), keyId: z.string(), payload: z.string().max(180000), signature: z.string().max(2000) }).strict().parse(JSON.parse(Buffer.from(raw).toString('utf8')));
    if (envelope.keyId !== (options.keyId ?? RELEASE_KEY_ID)) return fail('unknown_release_key');
    const bytes = Buffer.from(envelope.payload, 'base64'), signature = Buffer.from(envelope.signature, 'base64');
    if (bytes.toString('base64') !== envelope.payload || signature.toString('base64') !== envelope.signature) return fail('invalid_manifest_encoding');
    if (!verify('RSA-SHA256', bytes, { key: options.publicKey ?? RELEASE_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, signature)) return fail('invalid_manifest_signature');
    const manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const repository = options.repository ?? RELEASE_REPOSITORY;
    if (manifest.repository !== repository || manifest.tag !== `v${manifest.version}` || manifest.notesUrl !== `https://github.com/${repository}/releases/tag/${manifest.tag}`) return fail('release_identity_mismatch');
    if (options.version && options.version !== manifest.version) return fail('release_version_mismatch');
    if (options.channel && options.channel !== manifest.channel) return fail('release_channel_mismatch');
    if ((manifest.channel === 'stable') === manifest.version.includes('-')) return fail('release_channel_mismatch');
    if (Date.parse(manifest.publishedAt) > Date.now() + 86400000) return fail('release_timestamp_invalid');
    const names = new Set<string>(), identities = new Set<string>();
    for (const asset of manifest.assets) {
      if (asset.url !== `https://github.com/${repository}/releases/download/${manifest.tag}/${asset.name}` || names.has(asset.name)) return fail('invalid_release_asset');
      names.add(asset.name);
      const identity = JSON.stringify([asset.component, asset.platform, asset.arch, asset.packageName ?? '', asset.format]);
      if (identities.has(identity)) return fail('duplicate_release_asset'); identities.add(identity);
      if (asset.component === 'android' && (asset.platform !== 'android' || asset.format !== 'apk' || !asset.versionCode || !asset.packageName || !asset.certificateSha256)) return fail('invalid_android_asset');
      if (asset.component === 'desktop' && (asset.platform !== 'darwin' || asset.format !== 'zip' || !asset.bundleId || !asset.signing || (asset.signing === 'developer-id' && !asset.teamId))) return fail('invalid_desktop_asset');
      if (asset.component === 'server' && (asset.platform !== 'source' || asset.arch !== 'all' || asset.format !== 'tar.gz')) return fail('invalid_server_asset');
    }
    for (const image of manifest.images) if (!new RegExp(`^ghcr\\.io/${repository.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@sha256:[a-f0-9]{64}$`).test(image.image)) return fail('invalid_release_image');
    return manifest;
  } catch (error) { if (error instanceof ReleaseError) throw error; return fail('invalid_release_manifest'); }
}
export function selectReleaseAsset(manifest: ReleaseManifest, selector: Partial<Pick<ReleaseAsset, 'component' | 'platform' | 'arch' | 'format' | 'packageName'>>): ReleaseAsset | undefined {
  return manifest.assets.find(asset => Object.entries(selector).every(([key, value]) => asset[key as keyof ReleaseAsset] === value));
}

export type ReleaseNetworkOptions = { fetch?: typeof fetch; signal?: AbortSignal };
const allowedHost = (host: string) => ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(host);
async function responseFromGitHub(url: string, options: ReleaseNetworkOptions): Promise<Response> {
  const request = options.fetch ?? fetch;
  for (let redirect = 0; redirect < 6; redirect++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || !allowedHost(parsed.hostname)) return fail('update_host_rejected');
    const response = await request(url, { redirect: 'manual', headers: { Accept: 'application/octet-stream, application/json', 'User-Agent': 'Mote-Update/1' }, signal: options.signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location) return fail('update_redirect_invalid'); url = new URL(location, url).href; continue; }
    if (!response.ok) { await response.body?.cancel(); return fail(response.status === 404 ? 'release_not_found' : response.status === 403 || response.status === 429 ? 'release_rate_limited' : 'release_download_failed'); }
    return response;
  }
  return fail('update_redirect_limit');
}
async function boundedBytes(response: Response, max: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); return fail('release_response_too_large'); }
  const chunks: Buffer[] = []; let size = 0;
  if (!response.body) return fail('release_empty_response');
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > max) return fail('release_response_too_large'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export type CheckReleaseOptions = VerifyReleaseOptions & ReleaseNetworkOptions & { currentVersion?: string };
export async function checkRelease(options: CheckReleaseOptions = {}): Promise<{ manifest: ReleaseManifest; available: boolean }> {
  const repository = repositorySchema.parse(options.repository ?? RELEASE_REPOSITORY), channel = options.channel ?? 'stable';
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const network = { ...options, signal };
  let version = options.version;
  try {
    if (!version) {
      const data = JSON.parse((await boundedBytes(await responseFromGitHub(`https://api.github.com/repos/${repository}/releases${channel === 'stable' ? '/latest' : '?per_page=30'}`, network), 2_000_000)).toString());
      const releases = channel === 'stable' ? [data] : z.array(z.unknown()).parse(data);
      const tags = releases.flatMap((raw: unknown) => { const r = z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean() }).passthrough().safeParse(raw); if (!r.success || r.data.draft || r.data.prerelease !== (channel === 'preview') || !r.data.tag_name.startsWith('v') || !validVersion(r.data.tag_name.slice(1))) return []; return [r.data.tag_name.slice(1)]; });
      version = tags.sort((a, b) => compareVersions(b, a))[0];
      if (!version) return fail('release_not_found');
    }
    if (!validVersion(version)) return fail('invalid_version');
    const raw = await boundedBytes(await responseFromGitHub(`https://github.com/${repository}/releases/download/v${version}/mote-release.json`, network), 262144);
    const manifest = verifyReleaseEnvelope(raw, { ...options, repository, channel, version });
    return { manifest, available: !options.currentVersion || compareVersions(manifest.version, options.currentVersion) > 0 };
  } catch (error) { if (error instanceof ReleaseError) throw error; return fail(signal.aborted ? 'update_request_cancelled' : 'release_check_failed'); }
}
export async function downloadReleaseAsset(asset: ReleaseAsset, destination: string, options: ReleaseNetworkOptions & { onProgress?: (received: number, total: number) => void } = {}): Promise<string> {
  assetSchema.parse(asset);
  // Callers must only pass an asset from a verified manifest. Never overwrite arbitrary existing files.
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/v[^/]+\/[A-Za-z0-9._-]+$/.test(asset.url)) return fail('invalid_release_asset');
  try { await lstat(destination); return fail('update_destination_exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const partial = destination + '.partial';
  const file = await open(partial, 'wx', 0o600);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60 * 1000)]) : AbortSignal.timeout(30 * 60 * 1000);
  try {
    const response = await responseFromGitHub(asset.url, { ...options, signal });
    const length = response.headers.get('content-length');
    if (length && Number(length) !== asset.size) { await response.body?.cancel(); return fail('asset_size_mismatch'); }
    if (!response.body) return fail('release_empty_response');
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length; if (size > asset.size) return fail('asset_size_mismatch');
      hash.update(chunk); let offset = 0;
      while (offset < chunk.length) { const result = await file.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) return fail('update_write_failed'); offset += result.bytesWritten; }
      options.onProgress?.(size, asset.size);
    }
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) return fail('asset_checksum_mismatch');
    await file.sync(); await file.close();
    // Both paths are in the same directory. Link publishes atomically without
    // replacing a file that appeared after the initial existence check.
    try { await link(partial, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('update_destination_exists'); throw error; }
    await rm(partial); return destination;
  } catch (error) {
    await file.close().catch(() => {}); await rm(partial, { force: true }).catch(() => {});
    if (error instanceof ReleaseError) throw error; return fail(signal.aborted ? 'update_request_cancelled' : 'release_download_failed');
  }
}
