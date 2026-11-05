import {DESKTOP_STORAGE_VERSION,RESET_REQUIRED} from './storage-format';
import { connectionToken, sourceConnectionBinding, validSourceBinding } from './login-session';
import {uiRulesSchema} from '@mote/shared';
import { uploadGateConfig } from './upload-gate';
import { moteText } from '@mote/shared/i18n';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFile, mkdir, open, rename, chmod } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeAppCollectionRules, normalizeCollectionMode } from './app-collection';
import type { Config, ConfigUpdate, PublicConfig, Rectangle } from './contracts';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export function defaultConfig(): Config {
  return {
    uiPageRules:[], structuredOcrEnabled:false, chromeOrigins:[],
    uploadGate: uploadGateConfig(undefined),
    serverUrl: 'http://127.0.0.1:47832', deviceId: randomUUID(), deviceName: hostname(),
    syncPaused:false, syncMode: 'batch', syncIntervalMinutes: 1, syncBatchSize: 100, packedUpload:true,
    intervalMs: 15000, maxQueueBytes: 512 * 1024 * 1024, maxQueueEvents: 10000, captureStorageDirectory: '', notificationCollectionEnabled: false,
    defaultCollection: {duration:true,screenshots:false,structured:false}, appCollectionRules: {}, masks: [], idlePauseSeconds: 300,
    openAtLogin: false,
    metadataEnabled: true, diagnosticsEnabled: false, diagnosticIntervalSeconds: 60, imageDedupeMode: 'off', jpegQuality: 75, captureMaxSide: 1600, pauseOnBattery: false, batteryPauseBelowPct: 0,
  };
}

/** Explicit origins grant only the exact HTTP(S) authority; no wildcard or path grants. */
export function normalizeChromeOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Expected at most 100 Chrome origins');
  return [...new Set(value.map(origin => {
    if (typeof origin !== 'string' || origin.length > 2048 || origin !== origin.trim() || !/^https?:\/\/[^/\\?#]+\/?$/i.test(origin)) throw new Error('Invalid Chrome origin');
    let url: URL; try { url = new URL(origin); } catch { throw new Error('Invalid Chrome origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || /[\s\x00-\x1f]/.test(origin) || origin.includes('*')) throw new Error('Chrome grants require exact HTTP(S) origins');
    return url.origin;
  }))];
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(moteText("{0} 必须为 {1}–{2} 之间的整数", name, min, max));
  return value;
}

export function validateRectangles(value: unknown): Rectangle[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(moteText("遮挡区域必须为数组，最多 100 个"));
  return value.map((rect: unknown) => {
    if (!rect || typeof rect !== 'object') throw new Error(moteText("遮挡区域格式不正确"));
    const { x, y, width, height } = rect as Rectangle;
    if (![x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n)) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
      throw new Error(moteText("遮挡区域使用 0–1 相对坐标，且不得超出画面"));
    }
    return { x, y, width, height };
  });
}

export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function validateServerUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error(moteText("中央地址不正确"));
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(moteText("中央需要完整的 http:// 或 https:// 地址")); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error(moteText("中央地址不能含账号、路径或查询参数"));
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) throw new Error(moteText("远程中央必须使用 HTTPS；HTTP 只允许本机回环地址"));
  return url.origin;
}

const retiredModelKeys = ['privacyModelUrl','nsfwEnabled','reviewPolicy','reviewMaxTokens','reviewMaxSide','nsfwThreads','nsfwTimeoutMs','nsfwSource','nsfwCustomUrl'];
export function updateConfig(current: Config, input: ConfigUpdate, queuedEvents = 0, confirmedUnboundBacklog = false): Config {
  if(['excludedAppIds','localContentEncryption','ocrEnabled','ocrOnlyWhileCharging','uiPageMode'].some(key=>input&&Object.hasOwn(input,key)))throw Error(RESET_REQUIRED);
  if ((current.credentialScope!==undefined&&current.credentialScope!=='owner')||(input?.credentialScope!==undefined&&input.credentialScope!=='owner'))throw Error(RESET_REQUIRED);
  if (retiredModelKeys.some(key => input && Object.hasOwn(input,key))) throw new Error(moteText("配置包含已停用的本机模型设置，请移除后导入"));
  if (!input || typeof input !== 'object') throw new Error(moteText("配置格式不正确"));
  if (typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 128) throw new Error(moteText("设备名需为 1–128 字符"));
  if (input.metadataEnabled !== undefined && typeof input.metadataEnabled !== 'boolean') throw new Error(moteText("设备元数据开关值无效"));
  if (input.structuredOcrEnabled !== undefined && typeof input.structuredOcrEnabled !== 'boolean') throw new Error('Invalid structured OCR setting');
  if (input.notificationCollectionEnabled !== undefined && typeof input.notificationCollectionEnabled !== 'boolean') throw new Error('Invalid notification setting');
  const imageDedupeMode = input.imageDedupeMode ?? current.imageDedupeMode;
  if (!['off', 'exact', 'conservative', 'balanced', 'aggressive'].includes(imageDedupeMode)) throw new Error('Invalid image deduplication mode');
  const captureStorageDirectory = input.captureStorageDirectory ?? current.captureStorageDirectory;
  if (typeof captureStorageDirectory !== 'string' || captureStorageDirectory.length > 2048 || /[\x00-\x1f]/.test(captureStorageDirectory) || (captureStorageDirectory && (!isAbsolute(captureStorageDirectory) || resolve(captureStorageDirectory) !== captureStorageDirectory))) throw new Error(moteText("请通过文件夹选择器选择截图保存位置"));
  if (typeof input.openAtLogin !== 'boolean') throw new Error(moteText("开关值不正确"));
  if (typeof input.diagnosticsEnabled !== 'boolean' || typeof input.pauseOnBattery !== 'boolean') throw new Error(moteText("诊断或电量策略开关值无效"));
  if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 4096 || /[\r\n]/.test(input.token))) throw new Error(moteText("令牌格式不正确"));
  if(input.syncPaused!==undefined&&typeof input.syncPaused!=='boolean')throw new Error('Invalid paused sync setting');
  const syncMode = input.syncMode ?? current.syncMode;
  if (!['realtime', 'interval', 'batch', 'manual'].includes(syncMode)) throw new Error(moteText("同步方式无效"));
  const serverUrl = input.serverUrl === '' ? '' : validateServerUrl(input.serverUrl);
  const config: Config = {
    authSourceBinding: serverUrl === current.serverUrl && current.authSourceBinding ? validSourceBinding(current.authSourceBinding) : undefined,
    authSignedOut: current.authSignedOut, authExpiresAt: current.authExpiresAt, authSessionOnly: current.authSessionOnly,
    structuredOcrEnabled:input.structuredOcrEnabled??current.structuredOcrEnabled,
    chromeOrigins:normalizeChromeOrigins(input.chromeOrigins===undefined?current.chromeOrigins:input.chromeOrigins),
    uiPageRules:uiRulesSchema.parse(input.uiPageRules??current.uiPageRules),
    uploadGate: uploadGateConfig(input.uploadGate ?? current.uploadGate),
    serverUrl,
    syncPaused: input.syncPaused ?? current.syncPaused ?? false, syncMode, syncIntervalMinutes: integer(input.syncIntervalMinutes ?? current.syncIntervalMinutes, 1, 1440, moteText("同步间隔（分钟）")), syncBatchSize: integer(input.syncBatchSize ?? current.syncBatchSize, 1, 500, moteText("批量同步条数")), deviceId: current.deviceId, deviceName: input.deviceName.trim(),
    intervalMs: integer(input.intervalMs, 5000, 300000, moteText("采样间隔（毫秒）")),
    maxQueueBytes: integer(input.maxQueueBytes, 1024 * 1024, 20 * 1024 * 1024 * 1024, moteText("本地队列容量")),
    maxQueueEvents: integer(input.maxQueueEvents, 1, 1000000, moteText("本地队列事件数")),
    captureStorageDirectory, imageDedupeMode, packedUpload: input.packedUpload === undefined ? (current.packedUpload) : input.packedUpload === true,
    notificationCollectionEnabled: input.notificationCollectionEnabled ?? current.notificationCollectionEnabled,
    idlePauseSeconds: integer(input.idlePauseSeconds, 0, 86400, moteText("空闲暂停秒数")),
    defaultCollection: normalizeCollectionMode(input.defaultCollection===undefined?current.defaultCollection:input.defaultCollection),
    appCollectionRules: normalizeAppCollectionRules(input.appCollectionRules===undefined?current.appCollectionRules:input.appCollectionRules),
    masks: validateRectangles(input.masks),
    openAtLogin: input.openAtLogin,
    metadataEnabled: input.metadataEnabled ?? current.metadataEnabled, diagnosticsEnabled: input.diagnosticsEnabled, diagnosticIntervalSeconds: integer(input.diagnosticIntervalSeconds, 15, 3600, moteText("诊断采样秒数")),
    jpegQuality: integer(input.jpegQuality, 40, 95, moteText("JPEG 质量")), captureMaxSide: integer(input.captureMaxSide, 640, 2560, moteText("截图最大边长")),
    pauseOnBattery: input.pauseOnBattery, batteryPauseBelowPct: integer(input.batteryPauseBelowPct, 0, 95, moteText("低电量暂停百分比")),
    token: input.token === undefined ? current.token : input.token.trim() || undefined,
  };
  if (config.serverUrl === current.serverUrl && config.token === current.token && current.credentialScope === 'owner') config.credentialScope = current.credentialScope;
  if ((config.serverUrl !== current.serverUrl || config.token !== current.token) && queuedEvents > 0 && !confirmedUnboundBacklog) throw new Error(moteText("还有待上传记录，不能切换节点或令牌；请先完成上传或备份处理旧队列"));
  if (config.serverUrl !== current.serverUrl) {
    if (queuedEvents > 0 && !confirmedUnboundBacklog) throw new Error(moteText("还有待上传记录，不能切换中央；先完成上传，或导出并移走旧队列后重启"));
    if (config.serverUrl && (typeof input.token !== 'string')) throw new Error(moteText("切换中央必须明确输入新节点令牌，不能复用已有令牌"));
  }
  if (!config.serverUrl) config.token = undefined;
  if (config.serverUrl && config.token && !isLoopback(new URL(config.serverUrl).hostname) && (config.token?.length ?? 0) < 32) throw new Error(moteText("远程部署至少需要 32 字符访问令牌"));
  return config;
}

export function publicConfig(config: Config): PublicConfig {
  const { token, ...rest } = config;
  return { ...rest, tokenConfigured: Boolean(connectionToken(config)) };
}

export interface SecretStorage {
  readonly mode?: 'system' | 'json';
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class ConfigStore {
  constructor(private readonly directory: string, private readonly secrets: SecretStorage, private readonly defaults: () => Config = defaultConfig, private readonly bootstrap: () => Config = defaults) {}
  async load(): Promise<Config> {
    try {
      const stored = JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8')) as { version:number; config: Config; encryptedToken?: string; developmentToken?: string };
      if(stored.version!==DESKTOP_STORAGE_VERSION)throw Error(RESET_REQUIRED);
      if (!stored.config || typeof stored.config.deviceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(stored.config.deviceId)) throw new Error(moteText("设备标识无效"));
      // A profile never converts another credential format or consults the OS store to adopt it.
      if ((this.secrets.mode === 'json' && stored.encryptedToken !== undefined) || (this.secrets.mode !== 'json' && stored.developmentToken !== undefined)) throw new CredentialStorageMismatch();
      if (stored.developmentToken !== undefined && (typeof stored.developmentToken !== 'string' || !stored.developmentToken)) throw new CredentialStorageMismatch();
      const required=Object.keys(defaultConfig());
      if(required.some(key=>!Object.hasOwn(stored.config,key))||['excludedAppIds','localContentEncryption','ocrEnabled','ocrOnlyWhileCharging','uiPageMode'].some(key=>Object.hasOwn(stored.config,key)))throw Error(RESET_REQUIRED);
      const current: Config = { ...Object.fromEntries(Object.entries(stored.config).filter(([key]) => !retiredModelKeys.includes(key))), token: undefined } as Config;
      if (this.secrets.mode === 'json' && !current.authSignedOut) current.token = stored.developmentToken;
      if (stored.encryptedToken && !current.authSignedOut) {
        if (!this.secrets.available()) throw new Error(moteText("系统密钥存储不可用，无法解密令牌"));
        current.token = this.secrets.decrypt(Buffer.from(stored.encryptedToken, 'base64'));
      }
      const normalized = updateConfig(current, { ...current, token: current.token });
      if (retiredModelKeys.some(key => Object.hasOwn(stored.config,key))) await this.save(normalized);
      return normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.bootstrap();
      if(error instanceof CredentialStorageMismatch || error instanceof Error&&error.message===RESET_REQUIRED)throw error;
      throw new Error(moteText("无法读取配置：请检查系统密钥存储或备份后修复配置文件"));
    }
  }
  async save(config: Config): Promise<void> {
    if(config.credentialScope!==undefined&&config.credentialScope!=='owner')throw Error(RESET_REQUIRED);
    const { token, ...rest } = config;
    const persistentToken = !config.authSignedOut && !config.authSessionOnly ? token : undefined;
    if (persistentToken && !this.secrets.available()) throw new Error(moteText("系统加密存储不可用，拒绝保存明文令牌"));
    const contents = JSON.stringify({ version: DESKTOP_STORAGE_VERSION, config: {...rest,authSourceBinding:config.authSessionOnly||config.authSignedOut?sourceConnectionBinding(config):config.authSourceBinding},
      ...(this.secrets.mode === 'json' ? { developmentToken: persistentToken } : { encryptedToken: persistentToken ? this.secrets.encrypt(persistentToken).toString('base64') : undefined }),
    }, null, 2);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `config.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(this.directory, 'config.json'));
    if (process.platform !== 'win32') {
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
}

/** Retain the previous source checkpoint identity before removing its bearer credential. */
export function signedOutConfig(config: Config): Config {
  return {...config,authSourceBinding:sourceConnectionBinding(config),token:undefined,credentialScope:undefined,authExpiresAt:undefined,authSessionOnly:undefined,authSignedOut:true};
}

export class CredentialStorageMismatch extends Error {
  constructor() { super(moteText("凭据存储方式与当前 Profile 不匹配；请保留原目录并使用新的 Profile 重新登录。")); }
}
