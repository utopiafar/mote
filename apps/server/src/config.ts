import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ConfigurationSource, ServerConfiguration } from '@mote/shared';
import { modelProvider } from '@mote/shared/models';
import { parseConfigDocument as parseYaml, readConfigDocument as readYaml, isConfigSecretPath, serializeConfigDocument } from '@mote/shared/config-file';
import { modelDomainSchema, defaultModelDomain, type ModelDomain } from './model-settings.js';
import { executionSettingsSchema, diagnosticsSettingsSchema } from './execution-settings.js';
import { DEFAULT_MEDIA_OCR_ENDPOINT, DEFAULT_MEDIA_ASR_ENDPOINT, type MediaConfiguration } from './media-configuration.js';
import { processingConfigurationSchema, defaultProcessingConfiguration } from './processing-configuration.js';
import { perceptionConfigurationSchema } from './perception-configuration.js';
import { lifecycleSettingsSchema } from './memory-configuration.js';
import { actionsRuntimeSettingsSchema } from './actions-configuration.js';
import { workflowConfigurationSchema } from './workflow-configuration.js';
import { activityConfigurationSchema } from './activity-configuration.js';
import type { ConfigDomainRegistration, ConfigService } from './config-service.js';
import { defaultLogMaxBytes, logRetentionFromDocument, LogRetentionError, MAX_LOG_FILE_BYTES, MiB } from './log-retention-config.mjs';

export const repositoryRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
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
const modules = z.array(line(2000).refine(value => value.length > 0)).max(30);

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
  dataDir: line(4096, 1).default('./data'), maxStorageBytes: z.number().min(1024 * 1024).max(1_000_000 * 1024 * 1024).default(10240 * 1024 * 1024),
  maxExportBytes: z.number().min(1).max(256 * 1024 * 1024).default(64 * 1024 * 1024), retentionDays: z.number().min(0).max(36500).default(0),
  dataKey: line().refine(value => !value || /^[0-9a-f]{64}$/i.test(value)).default(''), contentEncryptionEnabled: z.boolean().default(false),
  kind: z.enum(['local-directory', 'docker-volume', 'bind-mount', 'unknown']).default('unknown'), source: line().default(''), mount: line().default(''),
}).strict();
export const executionConfigSchema = executionSettingsSchema.extend({ insightIntervalHours: z.number().min(0).max(168).default(0) }).strict();
export const diagnosticsConfigSchema = diagnosticsSettingsSchema.extend({
  directory: line().default(''), maxBytes: z.number().min(Math.floor(0.1 * MiB)).max(MAX_LOG_FILE_BYTES).default(defaultLogMaxBytes()),
  maxFiles: z.number().int().min(1).max(10).default(3), maxEntries: z.number().int().min(100).max(5000).default(2000),
}).strict();
export const connectorsConfigSchema = z.object({
  directory: line().default(''), modules: modules.refine(values => values.every(value => !/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('file:'))).default([]),
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
  backendModules: modules.default([]), fileProcessorModules: modules.default([]), configuration: z.record(z.unknown()).default({}),
  importPythonPacks: z.array(importPythonPackSchema).max(16).refine(value => new Set(value.map(pack => pack.id)).size === value.length).default([]),
}).strict();
export const updatesConfigSchema = z.object({ repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/).default('utopiafar/mote'), channel: z.enum(['stable', 'preview']).default('stable') }).strict();
export const mediaConfigSchema = z.object({
  modelDirectory: line().default(''), ocrEndpoint: endpoint().default(DEFAULT_MEDIA_OCR_ENDPOINT), asrEndpoint: endpoint().default(DEFAULT_MEDIA_ASR_ENDPOINT),
  workerToken: line(8192).default(''), python: line(4096, 1).default('python3'), ocrPort: port.default(9010), asrPort: port.default(9009),
}).strict();

export interface ConfigurationContext {
  /** Compatibility projection; environment files are no longer read. */
  envFile: string | null;
  configFile: string | null;
  /** Internal original document, including unexpanded credential references. Never return in an API. */
  document?: ConfigDocument;
  baseDir: string; hostConfigFile: string | null;
  runtime: ServerConfiguration['runtime']; publicUrl: string | null;
  storageKind: ServerConfiguration['storage']['kind']; storageSource: string | null; storageMount: string | null;
  tunnelEnabled: boolean; tunnelProvider: string | null; tunnelProtocol: 'auto' | 'http2' | 'quic';
  sources: Record<string, ConfigurationSource>;
}
interface LoadedConfig {
  host: string; port: number; dataDir: string; profile: string; token: string; tokenPath: string; tokenFromEnvironment: boolean;
  dataKey?: string; contentEncryptionEnabled: boolean;
  modelProvider: string; modelProtocol: ModelDomain['deployment']['protocol']; modelHeaders: Record<string, string>; modelExtraBody: Record<string, unknown>;
  modelReasoningEffort: ModelDomain['deployment']['reasoningEffort']; modelMaxTokens: number; modelRequestTimeoutMs: number | null; agentTimeoutMs: number | null;
  model: string; modelBaseUrl: string; apiKey: string; allowUnauthenticatedLocal: boolean; codexBin?: string; codexHome?: string;
  embeddingModel: string; embeddingBaseUrl: string; embeddingApiKey: string;
  interactiveConcurrency: number; agentConcurrency: number; llmConcurrency: number; memoryConcurrency: number;
  maxStorageBytes: number; maxExportBytes: number; retentionDays: number; insightIntervalHours: number; allowedOrigins: string[];
  connectors: z.infer<typeof connectorsConfigSchema>;
  diagnosticsEnabled: boolean; diagnosticsDebug: boolean; agentTraceEnabled: boolean; logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  logDirectory: string; logMaxBytes: number; logMaxFiles: number; logMaxEntries: number;
  fileProcessorModules: string[]; backendPluginModules: string[]; importPythonPacks: ImportPythonPackConfig[];
  updateRepository: string; updateChannel: 'stable' | 'preview'; media: MediaConfiguration; configuration: ConfigurationContext;
}
type OptionalFields = 'interactiveConcurrency' | 'agentConcurrency' | 'llmConcurrency' | 'memoryConcurrency' | 'codexBin' | 'codexHome' | 'contentEncryptionEnabled' | 'fileProcessorModules' | 'backendPluginModules' | 'importPythonPacks' | 'modelProvider' | 'modelProtocol' | 'modelHeaders' | 'modelExtraBody' | 'updateRepository' | 'updateChannel' | 'connectors' | 'configuration' | 'modelReasoningEffort' | 'modelMaxTokens' | 'modelRequestTimeoutMs' | 'agentTimeoutMs' | 'profile' | 'tokenFromEnvironment' | 'diagnosticsEnabled' | 'diagnosticsDebug' | 'agentTraceEnabled' | 'logLevel' | 'logDirectory' | 'logMaxBytes' | 'logMaxFiles' | 'logMaxEntries' | 'media';
/** Existing buildApp fixtures can still supply a Config without writing configuration files. */
export type Config = Omit<LoadedConfig, OptionalFields> & Partial<Pick<LoadedConfig, OptionalFields>> & { configService?: ConfigService };

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
export function configDocumentDomains(config?: Config): ConfigDomainRegistration[] {
  const seed = config ? documentFromConfig(config) : undefined;
  const definition = (id: string, schema: z.ZodTypeAny, restartRequired: boolean, explicit: ConfigDomainRegistration['fields'] = []): ConfigDomainRegistration => {
    const defaultValue = seed?.[id] ?? (id === 'processing' ? defaultProcessingConfiguration(config?.media) : schema.parse({}));
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
      resolve: (value, document) => resolveDomainSecrets(id, id === 'processing' ? processingWithDefaults(value, config?.media)
        : id === 'diagnostics' && value && typeof value === 'object' ? { debug: ((document?.server as { profile?: string } | undefined)?.profile ?? config?.profile) === 'dev', traceEnabled: config?.agentTraceEnabled ?? config?.profile === 'dev', maxBytes: defaultLogMaxBytes((document?.server as { profile?: string } | undefined)?.profile ?? config?.profile), ...value } : value),
    };
  };
  return [
    definition('server', serverConfigSchema, true, [{ path: 'token', sensitive: true }, { path: 'hostConfigFile', effect: 'restart' }]),
    definition('storage', storageConfigSchema, true, [{ path: 'dataKey', sensitive: true, effect: 'migration' }, { path: 'dataDir', effect: 'migration' }, { path: 'contentEncryptionEnabled', effect: 'immediate' }]),
    definition('execution', executionConfigSchema, false, [
      { path: 'interactiveConcurrency', effect: 'next-admission' }, { path: 'agentConcurrency', effect: 'next-admission' }, { path: 'llmConcurrency', effect: 'next-admission' }, { path: 'memoryConcurrency', effect: 'next-admission' }, { path: 'insightIntervalHours', effect: 'restart' },
    ]),
    definition('diagnostics', diagnosticsConfigSchema, false, [
      { path: 'enabled', effect: 'immediate' }, { path: 'debug', effect: 'immediate' }, { path: 'traceEnabled', effect: 'immediate' }, { path: 'level', effect: 'immediate' },
      { path: 'directory', effect: 'restart' }, { path: 'maxBytes', effect: 'restart' }, { path: 'maxFiles', effect: 'restart' }, { path: 'maxEntries', effect: 'restart' },
    ]),
    definition('models', modelDomainSchema, false, [
      { path: 'deployment', effect: 'next-request' }, { path: 'profiles', effect: 'next-request' }, { path: 'defaults', effect: 'next-request' }, { path: 'defaultModels', effect: 'next-request' },
      { path: 'deployment.apiKey', sensitive: true }, { path: 'deployment.headers', sensitive: true }, { path: 'deployment.extraBody', sensitive: true },
      { path: 'profiles.*.settings.apiKey', sensitive: true }, { path: 'profiles.*.settings.headers', sensitive: true }, { path: 'profiles.*.settings.extraBody', sensitive: true },
      { path: 'embedding', effect: 'restart' }, { path: 'embedding.apiKey', sensitive: true }, { path: 'codex', effect: 'restart' },
    ]),
    definition('connectors', connectorsConfigSchema, false, [
      { path: 'syncIntervalMs', effect: 'immediate' }, ...['directory', 'modules', 'mcpEnabled', 'mcpReadToken', 'mcpWriteEnabled', 'mcpWriteToken', 'mcpWriteSourceIds', 'allowLocalMcp', 'googleClientId', 'googleClientSecret', 'googleRedirectUri'].map(path => ({ path, effect: 'restart' as const, ...(['mcpReadToken', 'mcpWriteToken', 'googleClientId', 'googleClientSecret'].includes(path) ? { sensitive: true } : {}) })),
    ]),
    definition('plugins', pluginsConfigSchema, false, [{ path: 'backendModules', effect: 'restart' }, { path: 'fileProcessorModules', effect: 'restart' }, { path: 'importPythonPacks', effect: 'restart' }, { path: 'configuration', sensitive: true }]), definition('updates', updatesConfigSchema, true),
    definition('media', mediaConfigSchema, true, [{ path: 'workerToken', sensitive: true }]),
    definition('processing', processingConfigurationSchema, false, [{ path: 'settings.apiKey', sensitive: true }, { path: 'settings.localWorkerApiKey', sensitive: true }, { path: 'policy.services.*.apiKey', sensitive: true }, { path: 'settings', effect: 'next-request' }, { path: 'policy', effect: 'next-request' }]),
    definition('perception', perceptionConfigurationSchema, false, [{ path: 'enabled', effect: 'immediate' }, { path: 'concurrency', effect: 'next-admission' }, { path: 'providerRevision', effect: 'next-request' }, { path: 'allowExternalProcessing', effect: 'next-request' }, { path: 'allowQueryImages', effect: 'next-request' }, { path: 'understandingEnabled', effect: 'next-request' }]),
    definition('memory', lifecycleSettingsSchema, false, Object.keys(lifecycleSettingsSchema.parse({})).map(path => ({ path, effect: 'next-admission' as const }))),
    definition('actions', actionsRuntimeSettingsSchema, false, [{ path: 'enabled', effect: 'immediate' }, { path: 'timeZone', effect: 'next-request' }]),
    definition('activity', activityConfigurationSchema, false, [{path:'enabled',effect:'immediate'},{path:'modelProfileId',effect:'next-request'}]),
    definition('workflows', workflowConfigurationSchema, false, Object.keys(workflowConfigurationSchema.parse({})).flatMap(path => [{ path: `${path}.enabled`, effect: 'immediate' as const }, { path: `${path}.concurrency`, effect: 'next-admission' as const }])),
  ];
}
export function registerBuiltinDomains(service: ConfigService, config?: Config): void {
  for (const domain of configDocumentDomains(config)) service.register(domain);
  service.setNormalizer(raw => parseConfigDocument(serializeConfigDocument(raw as ConfigDocument)));
  service.setValidator(document => validateResolvedConfigDocument(document, config?.token));
}

/** Rules involving multiple domains must also run for API saves and external file reloads. */
export function validateResolvedConfigDocument(document: ConfigDocument, privateOwnerToken?: string): void {
  try { logRetentionFromDocument(document); }
  catch (error) { if (error instanceof LogRetentionError) throw new ConfigError(error.field, 'Configuration validation failed; values are suppressed'); throw error; }
  const server = document.server as z.infer<typeof serverConfigSchema>;
  const connectors = document.connectors as z.infer<typeof connectorsConfigSchema>;
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
  if (!diagnostics || typeof diagnostics === 'object' && !Array.isArray(diagnostics)) resolved = { ...resolved, diagnostics: { debug: (resolved.server as { profile?: string } | undefined)?.profile === 'dev', traceEnabled: (resolved.server as { profile?: string } | undefined)?.profile === 'dev', maxBytes: defaultLogMaxBytes((resolved.server as { profile?: string } | undefined)?.profile), ...(diagnostics as object | undefined) } };
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

/** The YAML document is the only source of ordinary server settings. */
export interface ConfigLoadOptions { initializeCredentials?: boolean; resolvedDocument?: boolean }
export function configFromFile(file?: string, options: ConfigLoadOptions = {}): LoadedConfig {
  if (file === undefined && !process.env.MOTE_CONFIG_FILE && process.env.MOTE_ENV_FILE !== undefined) throw new ConfigError('MOTE_ENV_FILE', 'Legacy environment-file selection is unsupported; select mote.yaml with MOTE_CONFIG_FILE');
  const selected = file ?? (process.env.MOTE_CONFIG_FILE || resolve(process.cwd(), 'mote.yaml'));
  return configFromDocument(readConfigDocument(selected), selected, undefined, options);
}
/** Reproject the exact initialized configuration before constructing resources, without rewriting credentials. */
export function configFromDocument(document: ConfigDocument, file: string, privateCredential?: { token: string; tokenPath: string }, options: ConfigLoadOptions = {}): LoadedConfig {
  const configFile = resolve(file), baseDir = dirname(configFile);
  // Service.current() already contains effective credentials. Environment values remain literal after one expansion.
  const effective = options.resolvedDocument ? normalizedDocument(structuredClone(document), structuredClone(document)) : resolveConfigDocument(document);
  const server = serverConfigSchema.parse(effective.server), storage = storageConfigSchema.parse(effective.storage), execution = executionConfigSchema.parse(effective.execution);
  const diagnostics = diagnosticsConfigSchema.parse({ debug: server.profile === 'dev', ...(effective.diagnostics as object), maxBytes: logRetentionFromDocument(effective).maxBytes });
  const models = modelDomainSchema.parse(effective.models), plugins = pluginsConfigSchema.parse(effective.plugins), updates = updatesConfigSchema.parse(effective.updates);
  const connectors = connectorsConfigSchema.parse(effective.connectors), media = mediaConfigSchema.parse(effective.media), model = models.deployment;
  const initializeCredentials = options.initializeCredentials !== false;
  const dataDir = resolve(baseDir, storage.dataDir), tokenPath = initializeCredentials && privateCredential ? privateCredential.tokenPath : join(dataDir, 'access-token');
  const suppliedToken = server.token.trim();
  let token = suppliedToken || (initializeCredentials ? privateCredential?.token : undefined) || '';
  // Check credential conflicts before creating storage.
  if (token && [connectors.mcpReadToken, connectors.mcpWriteToken].filter(Boolean).includes(token)) throw new ConfigError('connectors.mcpReadToken');
  if (initializeCredentials && !token && existsSync(tokenPath)) {
    try { token = readFileSync(tokenPath, 'utf8').trim(); } catch { throw new ConfigError('server.token'); }
    if (token.length < 24 || /[\r\n\0]/.test(token)) throw new ConfigError('server.token');
    if ([connectors.mcpReadToken, connectors.mcpWriteToken].filter(Boolean).includes(token)) throw new ConfigError('connectors.mcpReadToken');
  }
  if (initializeCredentials && !privateCredential) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (initializeCredentials && !token) { token = randomBytes(32).toString('hex'); writeFileSync(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' }); }
  const configuration: ConfigurationContext = {
    configFile, envFile: null, baseDir, hostConfigFile: server.hostConfigFile || null, runtime: server.runtime,
    publicUrl: server.publicUrl || null, storageKind: storage.kind === 'unknown' && server.runtime === 'native' ? 'local-directory' : storage.kind,
    storageSource: storage.source || null, storageMount: storage.mount || null, tunnelEnabled: server.tunnelEnabled, tunnelProvider: server.tunnelProvider || null, tunnelProtocol: server.tunnelProtocol,
    sources: Object.fromEntries(configDocumentDomains().map(domain => [domain.id, 'config-file'])) as Record<string, ConfigurationSource>,
  };
  Object.defineProperty(configuration, 'document', { value: document, enumerable: false });
  return {
    host: server.host, port: server.port, dataDir, profile: server.profile, token, tokenPath, tokenFromEnvironment: Boolean(suppliedToken), configuration,
    dataKey: storage.dataKey || undefined, contentEncryptionEnabled: storage.contentEncryptionEnabled,
    maxStorageBytes: storage.maxStorageBytes, maxExportBytes: storage.maxExportBytes, retentionDays: storage.retentionDays, allowedOrigins: server.allowedOrigins,
    interactiveConcurrency: execution.interactiveConcurrency, agentConcurrency: execution.agentConcurrency, llmConcurrency: execution.llmConcurrency, memoryConcurrency: execution.memoryConcurrency, insightIntervalHours: execution.insightIntervalHours,
    modelProvider: model.provider, modelProtocol: model.protocol, model: model.model, modelBaseUrl: model.baseUrl, apiKey: model.apiKey, allowUnauthenticatedLocal: model.allowUnauthenticatedLocal,
    modelHeaders: model.headers, modelExtraBody: model.extraBody, modelReasoningEffort: model.reasoningEffort, modelMaxTokens: model.maxTokens, modelRequestTimeoutMs: model.modelRequestTimeoutMs, agentTimeoutMs: model.agentTimeoutMs,
    codexBin: models.codex.executable, codexHome: models.codex.home ? resolve(baseDir, models.codex.home) : undefined,
    embeddingModel: models.embedding.model, embeddingBaseUrl: models.embedding.baseUrl, embeddingApiKey: models.embedding.apiKey,
    connectors: { ...connectors, directory: connectors.directory ? resolve(baseDir, connectors.directory) : join(dataDir, 'connectors') },
    diagnosticsEnabled: diagnostics.enabled, diagnosticsDebug: diagnostics.debug, agentTraceEnabled: diagnostics.traceEnabled,
    logLevel: diagnostics.level, logDirectory: diagnostics.directory ? resolve(baseDir, diagnostics.directory) : join(dataDir, 'logs'), logMaxBytes: diagnostics.maxBytes, logMaxFiles: diagnostics.maxFiles, logMaxEntries: diagnostics.maxEntries,
    fileProcessorModules: plugins.fileProcessorModules, backendPluginModules: plugins.backendModules, importPythonPacks: plugins.importPythonPacks,
    updateRepository: updates.repository, updateChannel: updates.channel,
    media: { ...media, modelDirectory: media.modelDirectory ? resolve(baseDir, media.modelDirectory) : join(dataDir, 'media-models') },
  };
}
/** Legacy function name retained for callers; ordinary environment settings are not read. */
export const configFromEnv = configFromFile;

/** Synthetic/programmatic callers seed the same document without reading deployment files. */
export function documentFromConfig(config: Config): ConfigDocument {
  const models = defaultModelDomain(), defaults = models.deployment;
  return {
    version: 1, revision: 0,
    server: serverConfigSchema.parse({ host: config.host, port: config.port, profile: config.profile ?? 'default', token: config.token.length >= 24 ? config.token : '', allowedOrigins: config.allowedOrigins,
      runtime: config.configuration?.runtime ?? 'unknown', publicUrl: config.configuration?.publicUrl ?? '', hostConfigFile: config.configuration?.hostConfigFile ?? '',
      tunnelEnabled: config.configuration?.tunnelEnabled ?? false, tunnelProvider: config.configuration?.tunnelProvider ?? '', tunnelProtocol: config.configuration?.tunnelProtocol ?? 'auto' }),
    storage: storageConfigSchema.parse({ dataDir: config.dataDir, maxStorageBytes: config.maxStorageBytes, maxExportBytes: config.maxExportBytes, retentionDays: config.retentionDays, dataKey: config.dataKey ?? '', contentEncryptionEnabled: config.contentEncryptionEnabled ?? false,
      kind: config.configuration?.storageKind ?? 'unknown', source: config.configuration?.storageSource ?? '', mount: config.configuration?.storageMount ?? '' }),
    execution: executionConfigSchema.parse({ interactiveConcurrency: config.interactiveConcurrency, agentConcurrency: config.agentConcurrency, llmConcurrency: config.llmConcurrency, memoryConcurrency: config.memoryConcurrency, insightIntervalHours: config.insightIntervalHours }),
    diagnostics: diagnosticsConfigSchema.parse({ enabled: config.diagnosticsEnabled, debug: config.diagnosticsDebug ?? config.profile === 'dev', traceEnabled: config.agentTraceEnabled ?? config.profile === 'dev', level: config.logLevel,
      directory: config.logDirectory ?? '', maxBytes: config.logMaxBytes ?? defaultLogMaxBytes(config.profile), maxFiles: config.logMaxFiles, maxEntries: config.logMaxEntries }),
    models: modelDomainSchema.parse({ ...models, deployment: { ...defaults, provider: config.modelProvider ?? defaults.provider, protocol: config.modelProtocol ?? defaults.protocol, baseUrl: config.modelBaseUrl || (config.modelProtocol === 'codex-app-server' ? '' : modelProvider(config.modelProvider ?? defaults.provider)?.baseUrl) || '', model: config.model, apiKey: config.apiKey,
      reasoningEffort: config.modelReasoningEffort ?? defaults.reasoningEffort, maxTokens: config.modelMaxTokens ?? defaults.maxTokens, modelRequestTimeoutMs: config.modelRequestTimeoutMs === undefined ? config.modelProtocol === 'codex-app-server' ? null : defaults.modelRequestTimeoutMs : config.modelRequestTimeoutMs,
      agentTimeoutMs: config.agentTimeoutMs === undefined ? config.modelProtocol === 'codex-app-server' ? null : defaults.agentTimeoutMs : config.agentTimeoutMs, allowUnauthenticatedLocal: config.allowUnauthenticatedLocal,
      headers: config.modelHeaders ?? {}, extraBody: config.modelExtraBody ?? {}, ...(config.modelProtocol === 'codex-app-server' ? { serviceTier: 'default' } : {}) },
      embedding: { model: config.embeddingModel, baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey }, codex: { executable: config.codexBin, home: config.codexHome } }),
    connectors: connectorsConfigSchema.parse(config.connectors ?? {}),
    plugins: pluginsConfigSchema.parse({ backendModules: config.backendPluginModules, fileProcessorModules: config.fileProcessorModules, importPythonPacks: config.importPythonPacks }),
    updates: updatesConfigSchema.parse({ repository: config.updateRepository, channel: config.updateChannel }), media: mediaConfigSchema.parse(config.media ?? {}),
    processing: defaultProcessingConfiguration(config.media), perception: perceptionConfigurationSchema.parse({}), memory: lifecycleSettingsSchema.parse({}),
    actions: actionsRuntimeSettingsSchema.parse({}), activity: activityConfigurationSchema.parse({}), workflows: workflowConfigurationSchema.parse({}),
  };
}
