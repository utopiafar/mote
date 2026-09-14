import { DEFAULT_REVIEW_POLICY } from '@mote/local-inference';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppCollectionRules, normalizeCollectionMode } from './app-collection';
import type { Config, ConfigUpdate, PublicConfig, Rectangle } from './contracts';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export function defaultConfig(): Config {
  return {
    serverUrl: 'http://127.0.0.1:47832', deviceId: randomUUID(), deviceName: hostname(),
    syncMode: 'realtime', syncIntervalMinutes: 15, syncBatchSize: 20,
    intervalMs: 15000, maxQueueBytes: 512 * 1024 * 1024, maxQueueEvents: 10000,
    excludedAppIds: [], defaultCollection: 'content', appCollectionRules: {}, masks: [], idlePauseSeconds: 300, ocrEnabled: true, ocrOnlyWhileCharging: false,
    privacyModelUrl: '', openAtLogin: false,
    metadataEnabled: true, diagnosticsEnabled: false, diagnosticIntervalSeconds: 60, jpegQuality: 75, captureMaxSide: 1600, pauseOnBattery: false, batteryPauseBelowPct: 0,
    nsfwEnabled: true, reviewPolicy: DEFAULT_REVIEW_POLICY, reviewMaxTokens: 256, reviewMaxSide: 512, nsfwThreads: 2, nsfwTimeoutMs: 60000, nsfwSource: 'auto', nsfwCustomUrl: '',
  };
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须为 ${min}–${max} 之间的整数`);
  return value;
}

export function validateRectangles(value: unknown): Rectangle[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('遮挡区域必须为数组，最多 100 个');
  return value.map((rect: unknown) => {
    if (!rect || typeof rect !== 'object') throw new Error('遮挡区域格式不正确');
    const { x, y, width, height } = rect as Rectangle;
    if (![x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n)) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
      throw new Error('遮挡区域使用 0–1 相对坐标，且不得超出画面');
    }
    return { x, y, width, height };
  });
}

export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function validateServerUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('中央节点地址不正确');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('中央节点需要完整的 http:// 或 https:// 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('中央节点地址不能含账号、路径或查询参数');
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) throw new Error('远程中央节点必须使用 HTTPS；HTTP 只允许本机回环地址');
  return url.origin;
}

export function validateLocalModelUrl(value: unknown): string {
  if (value === '') return '';
  if (typeof value !== 'string') throw new Error('本地隐私模型地址不正确');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('本地隐私模型需要完整 HTTP 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopback(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('隐私审查模型仅允许 localhost / 127.0.0.1 / ::1，且不能含账号或查询参数');
  return url.toString();
}

export function updateConfig(current: Config, input: ConfigUpdate, queuedEvents = 0, confirmedUnboundBacklog = false): Config {
  if (!input || typeof input !== 'object') throw new Error('配置格式不正确');
  if (typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 128) throw new Error('设备名需为 1–128 字符');
  if (!Array.isArray(input.excludedAppIds) || input.excludedAppIds.length > 500 || input.excludedAppIds.some(id => typeof id !== 'string' || id.length > 256 || !id.trim())) throw new Error('排除列表必须填写有效应用 ID');
  if (input.metadataEnabled !== undefined && typeof input.metadataEnabled !== 'boolean') throw new Error('设备元数据开关值无效');
  if (input.ocrOnlyWhileCharging !== undefined && typeof input.ocrOnlyWhileCharging !== 'boolean') throw new Error('OCR 电源策略开关值无效');
  if (typeof input.ocrEnabled !== 'boolean' || typeof input.openAtLogin !== 'boolean') throw new Error('开关值不正确');
  if (typeof input.diagnosticsEnabled !== 'boolean' || typeof input.pauseOnBattery !== 'boolean') throw new Error('诊断或电量策略开关值无效');
  if (typeof input.nsfwEnabled !== 'boolean') throw new Error('本地千问视觉审查开关值不正确');
  if (typeof input.reviewPolicy !== 'string' || !input.reviewPolicy.trim() || input.reviewPolicy.length > 8000) throw new Error('视觉审查策略需为 1–8000 字符');
  if (!['auto', 'mirror', 'official', 'custom'].includes(input.nsfwSource)) throw new Error('模型下载来源无效');
  if (typeof input.nsfwCustomUrl !== 'string' || input.nsfwCustomUrl.length > 2048) throw new Error('自定义模型地址无效');
  if (input.nsfwCustomUrl) {
    let url: URL;
    try { url = new URL(input.nsfwCustomUrl); } catch { throw new Error('自定义模型需要完整 HTTPS 目录地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('自定义模型地址必须为 HTTPS 且不能含账号、查询参数或锚点');
  }
  if (input.nsfwSource === 'custom' && !input.nsfwCustomUrl) throw new Error('选择自定义来源后，请填写模型目录 URL');
  if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 4096 || /[\r\n]/.test(input.token))) throw new Error('令牌格式不正确');
  const syncMode = input.syncMode ?? current.syncMode ?? 'realtime';
  if (!['realtime', 'interval', 'batch', 'manual'].includes(syncMode)) throw new Error('同步方式无效');
  const config: Config = {
    serverUrl: input.serverUrl === '' ? '' : validateServerUrl(input.serverUrl),
    syncMode, syncIntervalMinutes: integer(input.syncIntervalMinutes ?? current.syncIntervalMinutes ?? 15, 15, 1440, '同步间隔（分钟）'), syncBatchSize: integer(input.syncBatchSize ?? current.syncBatchSize ?? 20, 1, 500, '批量同步条数'), deviceId: current.deviceId, deviceName: input.deviceName.trim(),
    intervalMs: integer(input.intervalMs, 5000, 300000, '采样间隔（毫秒）'),
    maxQueueBytes: integer(input.maxQueueBytes, 1024 * 1024, 20 * 1024 * 1024 * 1024, '本地队列容量'),
    maxQueueEvents: integer(input.maxQueueEvents, 1, 1000000, '本地队列事件数'),
    idlePauseSeconds: integer(input.idlePauseSeconds, 0, 86400, '空闲暂停秒数'),
    defaultCollection: normalizeCollectionMode(input.defaultCollection ?? current.defaultCollection ?? 'content'),
    appCollectionRules: normalizeAppCollectionRules(input.appCollectionRules ?? current.appCollectionRules ?? {}),
    excludedAppIds: [...new Set(input.excludedAppIds.map(id => id.trim()))], masks: validateRectangles(input.masks),
    ocrEnabled: input.ocrEnabled, ocrOnlyWhileCharging: input.ocrOnlyWhileCharging ?? current.ocrOnlyWhileCharging ?? false, privacyModelUrl: validateLocalModelUrl(input.privacyModelUrl), openAtLogin: input.openAtLogin,
    metadataEnabled: input.metadataEnabled ?? current.metadataEnabled ?? true, diagnosticsEnabled: input.diagnosticsEnabled, diagnosticIntervalSeconds: integer(input.diagnosticIntervalSeconds, 15, 3600, '诊断采样秒数'),
    jpegQuality: integer(input.jpegQuality, 40, 95, 'JPEG 质量'), captureMaxSide: integer(input.captureMaxSide, 640, 2560, '截图最大边长'),
    pauseOnBattery: input.pauseOnBattery, batteryPauseBelowPct: integer(input.batteryPauseBelowPct, 0, 95, '低电量暂停百分比'),
    nsfwEnabled: input.nsfwEnabled, reviewPolicy: input.reviewPolicy.trim(),
    reviewMaxTokens: integer(input.reviewMaxTokens, 32, 1024, '最大生成 token 数'), reviewMaxSide: integer(input.reviewMaxSide, 256, 1024, '审查图片最大边长'),
    nsfwThreads: integer(input.nsfwThreads, 1, 8, '本地推理线程数'), nsfwTimeoutMs: integer(input.nsfwTimeoutMs, 5000, 180000, '本地推理超时（毫秒）'),
    nsfwSource: input.nsfwSource, nsfwCustomUrl: input.nsfwCustomUrl.trim(),
    token: input.token === undefined ? current.token : input.token.trim(),
  };
  if (config.serverUrl === current.serverUrl && config.token === current.token && ['owner', 'collector'].includes(current.credentialScope || '')) config.credentialScope = current.credentialScope;
  if ((config.serverUrl !== current.serverUrl || config.token !== current.token) && queuedEvents > 0 && !confirmedUnboundBacklog) throw new Error('还有待上传记录，不能切换节点或令牌；请先完成上传或备份处理旧队列');
  if (config.serverUrl !== current.serverUrl) {
    if (queuedEvents > 0 && !confirmedUnboundBacklog) throw new Error('还有待上传记录，不能切换中央节点；请先完成上传，或导出并移走旧队列后重启');
    if (config.serverUrl && (typeof input.token !== 'string' || !input.token.trim())) throw new Error('切换中央节点必须明确输入新节点令牌，不能复用已有令牌');
  }
  if (!config.serverUrl) config.token = undefined;
  if (config.serverUrl && !isLoopback(new URL(config.serverUrl).hostname) && (config.token?.length ?? 0) < 32) throw new Error('远程部署至少需要 32 字符访问令牌');
  return config;
}

export function publicConfig(config: Config): PublicConfig {
  const { token, ...rest } = config;
  return { ...rest, tokenConfigured: Boolean(token) };
}

export interface SecretStorage {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class ConfigStore {
  constructor(private readonly directory: string, private readonly secrets: SecretStorage, private readonly defaults: () => Config = defaultConfig, private readonly bootstrap: () => Config = defaults) {}
  async load(): Promise<Config> {
    try {
      const stored = JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8')) as { config: Config; encryptedToken?: string };
      if (!stored.config || typeof stored.config.deviceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(stored.config.deviceId)) throw new Error('设备标识无效');
      // Never accept a plaintext token from a tampered or legacy configuration.
      const current: Config = { ...this.defaults(), ...stored.config, token: undefined };
      if (stored.encryptedToken) {
        if (!this.secrets.available()) throw new Error('系统密钥存储不可用，无法解密令牌');
        current.token = this.secrets.decrypt(Buffer.from(stored.encryptedToken, 'base64'));
      }
      return updateConfig(current, { ...current, token: current.token });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.bootstrap();
      throw new Error('无法读取配置：请检查系统密钥存储或备份后修复配置文件');
    }
  }
  async save(config: Config): Promise<void> {
    const { token, ...rest } = config;
    if (token && !this.secrets.available()) throw new Error('系统加密存储不可用，拒绝保存明文令牌');
    const contents = JSON.stringify({ version: 1, config: rest, encryptedToken: token ? this.secrets.encrypt(token).toString('base64') : undefined }, null, 2);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `config.${randomUUID()}.tmp`);
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, join(this.directory, 'config.json'));
  }
}
