import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { conversationSettingsSchema } from '@mote/shared';
import { parseConfigDocument as parseYaml, readConfigDocument as readYaml, isConfigSecretPath, serializeConfigDocument } from '@mote/shared/config-file';
import { modelDomainSchema, modelsConfigDomain } from './model-settings.js';
import { executionConfigSchema, diagnosticsConfigSchema, executionConfigDomain, diagnosticsConfigDomain } from './execution-settings.js';
export { executionConfigSchema, diagnosticsConfigSchema, executionConfigDomain, diagnosticsConfigDomain } from './execution-settings.js';
import { DEFAULT_MEDIA_OCR_ENDPOINT, DEFAULT_MEDIA_ASR_ENDPOINT, DEFAULT_MEDIA_LOCAL_IMAGE_ENDPOINT, type MediaConfiguration } from './media-configuration.js';
import { processingConfigurationSchema, defaultProcessingConfiguration } from './processing-configuration.js';
import { perceptionConfigurationSchema } from './perception-configuration.js';
import { lifecycleSettingsSchema } from './memory-configuration.js';
import { actionsRuntimeSettingsSchema } from './actions-configuration.js';
import { workflowConfigurationSchema } from './workflow-configuration.js';
import { activityConfigurationSchema } from './activity-configuration.js';
import { notificationSettingsSchema } from './notification-configuration.js';
import { dshConfigurationSchema, validateDshModelProfiles } from './dsh-configuration.js';
import type { ConfigDomainReference, ConfigDomainRegistration, ConfigService } from './config-service.js';
import { defaultLogMaxBytes, logRetentionFromDocument, LogRetentionError, MAX_LOG_FILE_BYTES, DEFAULT_LOG_RETENTION, type LogRetention, MiB } from './log-retention-config.mjs';

export const repositoryRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export type {ConfigurationPlatformOptions} from './plugins/configuration-platform.js';
export type ConfigDocument = Record<string, unknown> & { version: 1; revision: number };
export class ConfigError extends Error {
  constructor(readonly field: string, message = 'The selected configuration is missing, unreadable or invalid') {
    super(message); this.name = 'ConfigError';
  }
}

const line = (max = 4096, min = 0) => z.string().min(min).max(max).refine(value => !/[\r\n\0]/.test(value));
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const endpoint = (publicAddress = false) => line().refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && (!publicAddress || ((url.protocol === 'https:' || loopback(url.hostname)) && url.pathname === '/'));
  } catch { return false; }
}, 'An absolute HTTP(S) URL without credentials, query or fragment is required');
const origin = endpoint().refine(value => {
  try { return Boolean(value) && new URL(value).pathname === '/'; } catch { return false; }
}, 'An HTTP(S) origin is required');
const port = z.number().int().min(1).max(65535);

export const importPythonPackSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/), version: z.string().min(1).max(64), description: z.string().trim().min(1).max(200).optional(),
  packRoot: z.string().min(1).max(2000).refine(isAbsolute), script: z.string().min(1).max(500).refine(value => !isAbsolute(value) && !value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')),
  scriptSha256: z.string().regex(/^[a-f0-9]{64}$/), pythonExecutable: z.string().min(1).max(2000).refine(isAbsolute),
  timeoutMs: z.number().int().min(1).max(120000).optional(), maxInputFiles: z.number().int().min(1).max(4000).optional(), maxInputBytes: z.number().int().min(1).max(32 * 1024 * 1024).optional(), maxOutputBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional(),
  config: z.record(z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 8192, 'Parser configuration exceeds 8 KiB').optional(),
}).strict();
export type ImportPythonPackConfig = z.infer<typeof importPythonPackSchema>;
export const serverConfigSchema = z.object({
  host: line(255, 1).default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(47832),
  profile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default('default'),
  runtime: z.enum(['native', 'docker', 'unknown']).default('unknown'),
  publicUrl: endpoint(true).default(''), allowedOrigins: z.array(origin).max(100).default(['http://localhost:5173', 'http://127.0.0.1:5173']),
  token: line(8192).default(''), hostConfigFile: line().default(''),
  tunnelEnabled: z.boolean().default(false), tunnelProvider: line().default(''), tunnelProtocol: z.enum(['auto', 'http2', 'quic']).default('auto'),
  tls: z.object({ enabled: z.boolean().default(false), domain: line(255).default(''), httpPort: port.default(80), httpsPort: port.default(443) }).strict().default({}),
}).strict().superRefine((value, ctx) => {
  if (value.token && value.token.trim().length < 24) ctx.addIssue({ code: 'custom', path: ['token'], message: 'Owner token requires at least 24 characters' });
});
export const storageConfigSchema = z.object({
  dataDir: line(4096, 1).default('./data'),
  maxExportBytes: z.number().min(1).max(256 * 1024 * 1024).default(64 * 1024 * 1024),
  dataKey: line().refine(value => !value || /^[0-9a-f]{64}$/i.test(value)).default(''), contentEncryptionEnabled: z.boolean().default(false),
  kind: z.enum(['local-directory', 'docker-volume', 'bind-mount', 'unknown']).default('unknown'), source: line().default(''), mount: line().default(''),
}).strict();
export const connectorsConfigSchema = z.object({
  directory: line().default(''),
  mcpEnabled: z.boolean().default(false), mcpReadToken: line(8192).default(''), mcpWriteEnabled: z.boolean().default(false), mcpWriteToken: line(8192).default(''),
  mcpWriteSourceIds: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)).default([]), allowLocalMcp: z.boolean().default(false),
  googleClientId: line().default(''), googleClientSecret: line(8192).default(''), googleRedirectUri: endpoint().default(''),
  syncIntervalMs: z.number().int().min(60000).max(86400000).default(900000),
}).strict().superRefine((value, ctx) => {
  if (value.mcpEnabled && value.mcpReadToken.length < 32) ctx.addIssue({ code: 'custom', path: ['mcpReadToken'], message: 'Enabled MCP requires a read token of at least 32 characters' });
  if (value.mcpWriteEnabled && (!value.mcpEnabled || value.mcpWriteToken.length < 32 || value.mcpWriteToken === value.mcpReadToken)) ctx.addIssue({ code: 'custom', path: ['mcpWriteToken'], message: 'MCP write requires enabled MCP and a distinct write token' });
  if (value.mcpWriteEnabled && !value.mcpWriteSourceIds.length) ctx.addIssue({ code: 'custom', path: ['mcpWriteSourceIds'], message: 'MCP writes require exact source IDs' });
  if ([value.googleClientId, value.googleClientSecret, value.googleRedirectUri].some(Boolean) && ![value.googleClientId, value.googleClientSecret, value.googleRedirectUri].every(Boolean)) ctx.addIssue({ code: 'custom', path: ['googleClientId'], message: 'Google authorization requires client ID, secret and redirect URI' });
  if (value.googleRedirectUri) {
    const url = new URL(value.googleRedirectUri);
    if ((url.protocol !== 'https:' && !loopback(url.hostname)) || url.pathname !== '/oauth/google/callback') ctx.addIssue({ code: 'custom', path: ['googleRedirectUri'], message: 'Google redirect URI requires HTTPS outside loopback and the exact callback path' });
  }
});
export const pluginsConfigSchema = z.object({
  configuration: z.record(z.unknown()).default({}),
  importPythonPacks: z.array(importPythonPackSchema).max(16).refine(value => new Set(value.map(pack => pack.id)).size === value.length).default([]),
}).strict();
export const updatesConfigSchema = z.object({ repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/).default('utopiafar/mote'), channel: z.enum(['stable', 'preview']).default('stable') }).strict();
export const mediaConfigSchema = z.object({
  // Deployment-owned sidecars. Preparation and processing authorization remain separate.
  dockerWorkers:z.array(z.enum(['ocr','asr'])).max(2).refine(value=>new Set(value).size===value.length).default([]),
  modelDirectory: line().default(''), ocrEndpoint: endpoint().default(DEFAULT_MEDIA_OCR_ENDPOINT), asrEndpoint: endpoint().default(DEFAULT_MEDIA_ASR_ENDPOINT),
  workerToken: line(8192).default(''), python: line(4096, 1).default('python3'), ocrPort: port.default(9010), asrPort: port.default(9009),
  localImageEndpoint: endpoint().refine(value => {
    try { return Boolean(value) && loopback(new URL(value).hostname); } catch { return false; }
  }, 'Local image processing requires loopback').default(DEFAULT_MEDIA_LOCAL_IMAGE_ENDPOINT),
  localImagePort: port.default(9011),
}).strict();

/** Private process facts derived from the one initialized configuration owner. */
export interface ConfigurationBootstrap {
  readonly configFile:string;
  readonly baseDir:string;
  readonly dataDir:string;
  readonly owner:Readonly<{token:string;tokenPath:string;source:'configured-value'|'private-token-file'|'programmatic'}>;
}

/** Registered schema identities shared with typed domain consumers. */
export const serverConfigDomain = Object.freeze({id:'server',schema:serverConfigSchema}) satisfies ConfigDomainReference<typeof serverConfigSchema>;
export const storageConfigDomain = Object.freeze({id:'storage',schema:storageConfigSchema}) satisfies ConfigDomainReference<typeof storageConfigSchema>;
export {modelsConfigDomain} from './model-settings.js';
export const dshConfigDomain = Object.freeze({id:'dsh',schema:dshConfigurationSchema}) satisfies ConfigDomainReference<typeof dshConfigurationSchema>;
export const connectorsConfigDomain = Object.freeze({id:'connectors',schema:connectorsConfigSchema}) satisfies ConfigDomainReference<typeof connectorsConfigSchema>;
export const pluginsConfigDomain = Object.freeze({id:'plugins',schema:pluginsConfigSchema}) satisfies ConfigDomainReference<typeof pluginsConfigSchema>;
export const updatesConfigDomain = Object.freeze({id:'updates',schema:updatesConfigSchema}) satisfies ConfigDomainReference<typeof updatesConfigSchema>;
export const mediaConfigDomain = Object.freeze({id:'media',schema:mediaConfigSchema}) satisfies ConfigDomainReference<typeof mediaConfigSchema>;
/** Owner browser preferences kept apart from deployment settings. This domain
 * only carries the pages the owner pinned to the workspace sidebar. */
export const uiConfigSchema = z.object({
  pinnedPages: z.array(z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/)).max(64)
    .refine(value => new Set(value).size === value.length).default([]),
}).strict();
export const uiConfigDomain = Object.freeze({id:'ui',schema:uiConfigSchema}) satisfies ConfigDomainReference<typeof uiConfigSchema>;
export const conversationsConfigDomain = Object.freeze({id:'conversations',schema:conversationSettingsSchema}) satisfies ConfigDomainReference<typeof conversationSettingsSchema>;
export const notificationsConfigDomain = Object.freeze({id:'notifications',schema:notificationSettingsSchema}) satisfies ConfigDomainReference<typeof notificationSettingsSchema>;
export const actionsConfigDomain = Object.freeze({id:'actions',schema:actionsRuntimeSettingsSchema}) satisfies ConfigDomainReference<typeof actionsRuntimeSettingsSchema>;
export const perceptionConfigDomain = Object.freeze({id:'perception',schema:perceptionConfigurationSchema}) satisfies ConfigDomainReference<typeof perceptionConfigurationSchema>;
export const processingConfigDomain = Object.freeze({id:'processing',schema:processingConfigurationSchema}) satisfies ConfigDomainReference<typeof processingConfigurationSchema>;
export const workflowConfigDomain = Object.freeze({id:'workflows',schema:workflowConfigurationSchema}) satisfies ConfigDomainReference<typeof workflowConfigurationSchema>;
export const memoryConfigDomain = Object.freeze({id:'memory',schema:lifecycleSettingsSchema}) satisfies ConfigDomainReference<typeof lifecycleSettingsSchema>;

/** One schema identity for Activity registration and its typed runtime consumer. */
export const activityConfigDomain = Object.freeze({id:'activity',schema:activityConfigurationSchema}) satisfies ConfigDomainReference<typeof activityConfigurationSchema>;

function resolveDomainSecrets(id: string, value: unknown): unknown {
  return parseYaml(serializeConfigDocument({ version: 1, revision: 0, [id]: value })).document[id];
}
function processingWithDefaults(value: unknown, media?: Partial<MediaConfiguration>): unknown {
  const defaults = defaultProcessingConfiguration(media);
  if (value === undefined) return defaults;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const supplied = value as Record<string, unknown>, settings = supplied.settings;
  return { ...defaults, ...supplied, ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? { settings: { ...defaults.settings, ...settings } } : {}) };
}
export function configDocumentDomains(): ConfigDomainRegistration[] {
  const definition = (id: string, schema: z.ZodTypeAny, restartRequired: boolean, explicit: ConfigDomainRegistration['fields'] = []): ConfigDomainRegistration => {
    const defaultValue = id === 'processing' ? defaultProcessingConfiguration() : schema.parse({});
    const fields = explicit.map(field => {
      const parent = explicit.filter(candidate => candidate.effect && field.path.startsWith(candidate.path + '.')).sort((a, b) => b.path.length - a.path.length)[0];
      return { ...field, effect: field.effect ?? parent?.effect ?? (restartRequired ? 'restart' : 'immediate') };
    });
    function metadata(value: unknown, path: string): void {
      if (explicit.some(field => field.sensitive && (field.path === path || path.startsWith(field.path + '.')))) return;
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
        for (const [key, child] of Object.entries(value)) metadata(child, path ? `${path}.${key}` : key);
        return;
      }
      if (!path || fields.some(field => field.path === path)) return;
      const parent = explicit.filter(field => path.startsWith(field.path + '.')).sort((a, b) => b.path.length - a.path.length)[0];
      fields.push({ path, effect: parent?.effect ?? (restartRequired ? 'restart' : 'immediate'), ...(parent?.sensitive ? { sensitive: true } : {}) });
    }
    metadata(defaultValue, '');
    return { id, schema, defaultValue, restartRequired, fields,
      resolve: (value, document) => resolveDomainSecrets(id, id === 'processing' ? processingWithDefaults(value, mediaConfigSchema.parse(document?.media ?? {}))
        : id === 'diagnostics' && value && typeof value === 'object' ? { debug:false, traceEnabled: false, maxBytes: defaultLogMaxBytes((document?.server as { profile?: string } | undefined)?.profile), ...value } : value),
    };
  };
  return [
    definition(serverConfigDomain.id, serverConfigDomain.schema, true, [{ path: 'token', sensitive: true }, { path: 'hostConfigFile', effect: 'restart' }]),
    definition(storageConfigDomain.id, storageConfigDomain.schema, true, [{ path: 'dataKey', sensitive: true, effect: 'migration' }, { path: 'dataDir', effect: 'migration' }, { path: 'contentEncryptionEnabled', effect: 'immediate' }]),
    definition(executionConfigDomain.id, executionConfigDomain.schema, false, [
      { path: 'interactiveConcurrency', effect: 'next-admission' }, { path: 'agentConcurrency', effect: 'next-admission' }, { path: 'llmConcurrency', effect: 'next-admission' }, { path: 'memoryConcurrency', effect: 'next-admission' }, { path: 'insightIntervalHours', effect: 'restart' },
    ]),
    definition(diagnosticsConfigDomain.id, diagnosticsConfigDomain.schema, false, [
      { path: 'enabled', effect: 'immediate' }, { path: 'debug', effect: 'immediate' }, { path: 'traceEnabled', effect: 'immediate' }, {path:'traceExpiresAt',effect:'immediate'}, { path: 'level', effect: 'immediate' },
      { path: 'directory', effect: 'restart' }, { path: 'maxBytes', effect: 'restart' }, {path:'maxTotalBytes',effect:'restart'},{path:'retention',effect:'restart'}, { path: 'maxEntries', effect: 'restart' },
    ]),
    definition(modelsConfigDomain.id, modelsConfigDomain.schema, false, [
      { path: 'deployment', effect: 'next-request' }, { path: 'profiles', effect: 'next-request' }, { path: 'defaults', effect: 'next-request' }, { path: 'defaultModels', effect: 'next-request' },
      { path: 'deployment.apiKey', sensitive: true }, { path: 'deployment.headers', sensitive: true }, { path: 'deployment.extraBody', sensitive: true },
      { path: 'profiles.*.settings.apiKey', sensitive: true }, { path: 'profiles.*.settings.headers', sensitive: true }, { path: 'profiles.*.settings.extraBody', sensitive: true },
      { path: 'embedding', effect: 'restart' }, { path: 'embedding.apiKey', sensitive: true }, { path: 'codex', effect: 'restart' },
    ]),
    definition(dshConfigDomain.id, dshConfigDomain.schema, true, [{path: 'profiles', effect: 'restart'}]),
    definition(connectorsConfigDomain.id, connectorsConfigDomain.schema, false, [
      { path: 'syncIntervalMs', effect: 'immediate' }, ...['directory', 'mcpEnabled', 'mcpReadToken', 'mcpWriteEnabled', 'mcpWriteToken', 'mcpWriteSourceIds', 'allowLocalMcp', 'googleClientId', 'googleClientSecret', 'googleRedirectUri'].map(path => ({ path, effect: 'restart' as const, ...(['mcpReadToken', 'mcpWriteToken', 'googleClientId', 'googleClientSecret'].includes(path) ? { sensitive: true } : {}) })),
    ]),
    definition(pluginsConfigDomain.id, pluginsConfigDomain.schema, false, [{ path: 'importPythonPacks', effect: 'restart' }, { path: 'configuration', sensitive: true }]), definition(updatesConfigDomain.id, updatesConfigDomain.schema, true),
    definition(mediaConfigDomain.id, mediaConfigDomain.schema, true, [{ path: 'workerToken', sensitive: true }]),
    definition(processingConfigDomain.id, processingConfigDomain.schema, false, [{ path: 'settings.apiKey', sensitive: true }, { path: 'settings.localWorkerApiKey', sensitive: true }, { path: 'policy.services.*.apiKey', sensitive: true }, { path: 'settings', effect: 'next-request' }, { path: 'policy', effect: 'next-request' }]),
    definition(perceptionConfigDomain.id, perceptionConfigDomain.schema, false, [{ path: 'enabled', effect: 'immediate' }, { path: 'concurrency', effect: 'next-admission' }, { path: 'providerRevision', effect: 'next-request' }, { path: 'allowExternalProcessing', effect: 'next-request' }, { path: 'allowQueryImages', effect: 'next-request' }, { path: 'understandingEnabled', effect: 'next-request' }]),
    definition(memoryConfigDomain.id, memoryConfigDomain.schema, false, Object.keys(lifecycleSettingsSchema.parse({})).map(path => ({ path, effect: 'next-admission' as const }))),
    definition(conversationsConfigDomain.id, conversationsConfigDomain.schema, false, [{path:'multipleConversations',effect:'immediate'},{path:'context',effect:'next-request'}]),
    definition(uiConfigDomain.id, uiConfigDomain.schema, false, [{path:'pinnedPages',effect:'immediate'}]),
    definition(actionsConfigDomain.id, actionsConfigDomain.schema, false, [{ path: 'enabled', effect: 'immediate' }, { path: 'timeZone', effect: 'next-request' }]),
    definition(activityConfigDomain.id, activityConfigDomain.schema, false, [{path:'enabled',effect:'immediate'},{path:'modelProfileId',effect:'next-request'}]),
    definition(notificationsConfigDomain.id, notificationsConfigDomain.schema, false, [{path:'enabled',effect:'immediate'},{path:'timeZone',effect:'immediate'},{path:'quietHours',effect:'immediate'},{path:'minIntervalMinutes',effect:'immediate'}]),
    definition(workflowConfigDomain.id, workflowConfigDomain.schema, false, Object.keys(workflowConfigurationSchema.parse({})).flatMap(path => [{ path: `${path}.enabled`, effect: 'immediate' as const }, { path: `${path}.concurrency`, effect: 'next-admission' as const }])),
  ];
}
export function registerBuiltinDomains(service: ConfigService, privateOwnerToken?: string): void {
  for (const domain of configDocumentDomains()) service.register(domain);
  service.setNormalizer((raw, previous) => {
    const document = parseConfigDocument(serializeConfigDocument(raw as ConfigDocument));
    const diagnostics = document.diagnostics as z.infer<typeof diagnosticsConfigSchema>;
    const before = previous?.diagnostics as z.infer<typeof diagnosticsConfigSchema> | undefined;
    // A live YAML activation needs the same persisted deadline as an API save.
    // Keep existing (including expired) deadlines across unrelated saves/restarts.
    if (before) {
      if (!diagnostics.traceEnabled) diagnostics.traceExpiresAt = 0;
      else if (diagnostics.traceExpiresAt === 0) diagnostics.traceExpiresAt = before.traceEnabled ? before.traceExpiresAt : Date.now() + 86400000;
    }
    return document;
  });
  service.setValidator(document => validateResolvedConfigDocument(document, privateOwnerToken));
}

/** Rules involving multiple domains must also run for API saves and external file reloads. */
export function validateResolvedConfigDocument(document: ConfigDocument, privateOwnerToken?: string): void {
  try { logRetentionFromDocument(document); }
  catch (error) { if (error instanceof LogRetentionError) throw new ConfigError(error.field, 'Configuration validation failed; values are suppressed'); throw error; }
  const server = document.server as z.infer<typeof serverConfigSchema>;
  const connectors = document.connectors as z.infer<typeof connectorsConfigSchema>;
  try { validateDshModelProfiles(dshConfigurationSchema.parse(document.dsh ?? {}), modelDomainSchema.parse(document.models ?? {})); }
  catch { throw new ConfigError('dsh.profiles'); }
  const ownerTokens = [server.token.trim(), privateOwnerToken].filter((value): value is string => Boolean(value));
  if (connectors.mcpReadToken && ownerTokens.includes(connectors.mcpReadToken)) throw new ConfigError('connectors.mcpReadToken');
  if (connectors.mcpWriteToken && ownerTokens.includes(connectors.mcpWriteToken)) throw new ConfigError('connectors.mcpWriteToken');
}

function normalizedDocument(saved: Record<string, unknown>, resolved: Record<string, unknown>): ConfigDocument {
  const root = z.object({ version: z.literal(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).passthrough().safeParse(saved);
  if (!root.success) throw new ConfigError(root.error.issues[0]?.path.join('.') || 'configuration');
  const result: ConfigDocument = { ...root.data };
  const domains = configDocumentDomains();
  if (Object.keys(saved).some(key => !['version', 'revision'].includes(key) && !domains.some(domain => domain.id === key))) throw new ConfigError('configuration');
  const diagnostics = resolved.diagnostics;
  if (!diagnostics || typeof diagnostics === 'object' && !Array.isArray(diagnostics)) resolved = { ...resolved, diagnostics: { debug:false, traceEnabled: false, maxBytes: defaultLogMaxBytes((resolved.server as { profile?: string } | undefined)?.profile), ...(diagnostics as object | undefined) } };
  for (const domain of domains) {
    try { result[domain.id] = domain.schema.parse(domain.id === 'processing' ? processingWithDefaults(resolved.processing, mediaConfigSchema.parse(resolved.media ?? {})) : resolved[domain.id] ?? {}); }
    catch (error) { throw new ConfigError([domain.id, ...(error instanceof z.ZodError ? error.issues[0]?.path ?? [] : [])].join('.'), 'Configuration validation failed; values are suppressed'); }
  }
  validateResolvedConfigDocument(result);
  // Keep original credential references in the saved document, alongside normalized defaults.
  function restore(source: unknown, target: unknown, path: (string | number)[] = []): void {
    if (!source || typeof source !== 'object' || !target || typeof target !== 'object') return;
    for (const [key, value] of Object.entries(source)) {
      const child = [...path, Array.isArray(source) ? Number(key) : key];
      if (isConfigSecretPath(child)) (target as Record<string, unknown>)[key] = structuredClone(value);
      else restore(value, (target as Record<string, unknown>)[key], child);
    }
  }
  restore(saved, result);
  // Keep profile defaults derived, so unrelated saves do not turn them into overrides.
  for (const field of ['debug', 'maxBytes']) if (!Object.hasOwn((saved.diagnostics ?? {}) as object, field)) delete (result.diagnostics as Record<string, unknown>)[field];
  return result;
}
export function parseConfigDocument(raw: string, env: NodeJS.ProcessEnv = process.env): ConfigDocument {
  let pair: ReturnType<typeof parseYaml>;
  try { pair = parseYaml(raw, env); } catch { throw new ConfigError('configuration'); }
  return normalizedDocument(pair.savedDocument, pair.document);
}
export function readConfigDocument(file: string, env: NodeJS.ProcessEnv = process.env): ConfigDocument {
  try { const pair = readYaml(file, env); return normalizedDocument(pair.savedDocument, pair.document); }
  catch (error) { if (error instanceof ConfigError) throw error; throw new ConfigError('MOTE_CONFIG_FILE'); }
}
export function resolveConfigDocument(document: ConfigDocument, env: NodeJS.ProcessEnv = process.env): ConfigDocument {
  const pair = parseYaml(serializeConfigDocument(document), env);
  const saved = normalizedDocument(pair.savedDocument, pair.document);
  return parseYaml(serializeConfigDocument(saved), env).document as ConfigDocument;
}

/** Select a real YAML source; ordinary environment values never override its domains. */
export function configurationFromFile(file?:string):{path:string} {
  const path=resolve(file ?? (process.env.MOTE_CONFIG_FILE || resolve(process.cwd(),'mote.yaml')));
  // Retain explicit selection/file safety and validation before acquiring resources.
  readConfigDocument(path);
  return {path};
}

/** Resolve only bootstrap paths/owner identity, never project domain settings into a second store. */
export function configurationBootstrap(service:ConfigService,privateCredential?:Readonly<{token:string;tokenPath:string;source?:ConfigurationBootstrap['owner']['source']}>):ConfigurationBootstrap {
  const configFile=service.path,baseDir=dirname(configFile),server=service.current(serverConfigDomain),storage=service.current(storageConfigDomain),connectors=service.current(connectorsConfigDomain);
  const dataDir=resolve(baseDir,storage.dataDir),tokenPath=privateCredential?.tokenPath??join(dataDir,'access-token');
  const suppliedToken=server.token.trim();
  let token=suppliedToken||privateCredential?.token||'';
  const source=suppliedToken?'configured-value':privateCredential?.source??(privateCredential?'programmatic':'private-token-file');
  const check=()=>{if(token&&[connectors.mcpReadToken,connectors.mcpWriteToken].filter(Boolean).includes(token))throw new ConfigError('connectors.mcpReadToken');};
  check();
  if(!token&&existsSync(tokenPath)) {
    try{token=readFileSync(tokenPath,'utf8').trim();}catch{throw new ConfigError('server.token');}
    if(token.length<24||/[\r\n\0]/.test(token))throw new ConfigError('server.token');
    check();
  }
  if(!privateCredential)mkdirSync(dataDir,{recursive:true,mode:0o700});
  if(!token){token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token+'\n',{mode:0o600,flag:'wx'});}
  service.setValidator(document=>validateResolvedConfigDocument(document,token));
  return Object.freeze({configFile,baseDir,dataDir,owner:Object.freeze({token,tokenPath,source})});
}
