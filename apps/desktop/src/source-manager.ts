import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicSourceJson, sourceHash, SourceSync } from './source-sync';
import { scanSourceFiles } from './source-files';
import { calendarHelper, CalendarPermissionError, decodeCalendarChoices, decodeCalendarScan } from './source-calendar';
import { normalizeSourceOptions, redactSourceText, type SourceStatus, type LocalSource, type CalendarChoice, type SourceDefinition, type SourceOptions, type SourceRequest } from './source-types';
import type { Config } from './contracts';
export function sourceDefinition(source: LocalSource): SourceDefinition {
  const { id, name, kind, deviceId, platform, retention, enabled } = source;
  return { id, name: redactSourceText(name, source.redactLiterals).slice(0, 200) || '本地来源', kind, deviceId, platform, retention, enabled };
}
export function sourcePolicy(options: SourceOptions): string { return sourceHash(JSON.stringify({ retention: options.retention, trackDeletions: options.trackDeletions, extensions: options.extensions, excludedPaths: options.excludedPaths, redactLiterals: options.redactLiterals })); }
export class LocalSourceManager {
  private sources: LocalSource[] = [];
  private metadataDirty = new Set<string>();
  private states = new Map<string, SourceStatus>();
  private engines = new Map<string, SourceSync>();
  private task?: Promise<void>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private connectionHeld = false;
  private choices: CalendarChoice[] = [];
  private permissionController?: AbortController;
  private permissionTask?: Promise<CalendarChoice[]>;
  private binding: string;
  constructor(private directory: string, private connection: Pick<Config, 'serverUrl' | 'token' | 'deviceId'>, private helperPath: string) { this.binding = this.connectionBinding(); }
  private connectionBinding(): string { return sourceHash(this.connection.serverUrl + ':' + (this.connection.token ?? '')); }
  async initialize(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'sources.json'), 'utf8')) as { version: number; sources: LocalSource[]; metadataDirty: string[] };
      if (saved.version !== 1 || !Array.isArray(saved.sources) || saved.sources.length > 40) throw new Error('本地来源配置无效');
      this.sources = saved.sources.map(s => {
        if (!/^local-[a-f0-9-]{36}$/.test(s.id) || typeof s.name !== 'string' || s.name.length > 200 || typeof s.enabled !== 'boolean' || !['local-files', 'local-calendar'].includes(s.kind) || (s.kind === 'local-files' ? typeof s.path !== 'string' : typeof s.calendarId !== 'string')) throw new Error('本地来源配置无效');
        return { ...s, ...normalizeSourceOptions(s), deviceId: this.connection.deviceId };
      });
      this.metadataDirty = new Set(saved.metadataDirty || []);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    // Include paused sources when guarding a node change: they can still own durable pending bodies.
    for (const source of this.sources) { const engine = new SourceSync(join(this.directory, 'nodes', this.binding, source.id + '.json')); await engine.initialize(); this.engines.set(source.id, engine); }
    this.timer = setInterval(() => { void this.sync(false); }, 5000); this.timer.unref();
    void this.sync(false);
  }
  status(): SourceStatus[] { return this.sources.map(source => ({ state: source.enabled ? 'idle' : 'paused', message: source.enabled ? '等待首次同步' : '本机已暂停', pending: 0, items: 0, skipped: 0, ...this.states.get(source.id), ...this.engines.get(source.id)?.status(), source: structuredClone(source), ...(!source.enabled ? { state: 'paused' as const, message: '本机已暂停' } : {}) })); }
  connectionActivity(): { pending: number; inFlight: boolean } { return { pending: [...this.engines.values()].reduce((sum, engine) => sum + engine.status().pending, 0), inFlight: Boolean(this.task || this.permissionTask) }; }
  async holdConnection(): Promise<() => void> {
    if (this.connectionHeld || this.permissionTask) throw new Error('本地来源授权尚未结束，请稍后重试连接');
    this.connectionHeld = true;
    try { await this.interrupt(); return () => { this.connectionHeld = false; }; }
    catch (error) { this.connectionHeld = false; throw error; }
  }
  async prepareReauthorization(connection: Pick<Config, 'serverUrl' | 'token' | 'deviceId'>): Promise<void> {
    if (!this.connectionHeld || this.task || this.permissionTask || connection.serverUrl !== this.connection.serverUrl || connection.deviceId !== this.connection.deviceId) throw new Error('仅允许已暂停同步的同一节点、同一设备重新授权');
    const binding = sourceHash(connection.serverUrl + ':' + (connection.token ?? ''));
    if (binding === this.binding) return;
    for (const [id, engine] of this.engines) await engine.checkpointTo(join(this.directory, 'nodes', binding, id + '.json'));
  }
  async authorizeCalendar(): Promise<CalendarChoice[]> {
    if (this.permissionTask) return this.permissionTask;
    if (this.stopped) throw new Error('应用正在退出');
    const controller = new AbortController(); this.permissionController = controller;
    this.permissionTask = calendarHelper(this.helperPath, 'calendar-permission', undefined, controller.signal).then(raw => { this.choices = decodeCalendarChoices(raw); return structuredClone(this.choices); }).finally(() => { this.permissionTask = undefined; this.permissionController = undefined; });
    return this.permissionTask;
  }
  async addCalendar(id: string, input: unknown): Promise<void> {
    const calendar = this.choices.find(c => c.id === id);
    if (!calendar) throw new Error('请先连接日历，再从已授权列表中选择');
    await this.add({ calendarId: calendar.id, name: calendar.title.slice(0, 200) || '本地日历', kind: 'local-calendar' }, input);
  }
  async addFiles(path: string, input: unknown): Promise<void> { await this.add({ path, name: basename(path).slice(0, 200) || '本地文件', kind: 'local-files' }, input); }
  private async add(fields: Pick<LocalSource, 'name' | 'kind'> & Partial<LocalSource>, input: unknown): Promise<void> {
    const options = normalizeSourceOptions(input);
    if (this.sources.length >= 40) throw new Error('本机最多连接 40 个本地来源');
    if (this.sources.some(s => s.kind === fields.kind && (fields.path ? s.path === fields.path : s.calendarId === fields.calendarId))) throw new Error('此来源已连接，请在列表中修改');
    await this.interrupt();
    const source: LocalSource = { ...fields, ...options, id: 'local-' + randomUUID(), deviceId: this.connection.deviceId, platform: 'macos', enabled: true } as LocalSource;
    this.sources.push(source); this.metadataDirty.add(source.id); await this.persist(); void this.sync(true);
  }
  async update(id: string, input: unknown): Promise<void> {
    const source = this.sources.find(s => s.id === id); if (!source) throw new Error('来源不存在');
    const value = input as SourceOptions & { enabled: boolean };
    const options = normalizeSourceOptions(value); if (typeof value.enabled !== 'boolean') throw new Error('启停选项无效');
    await this.interrupt();
    Object.assign(source, options, { enabled: value.enabled }); this.metadataDirty.add(id); this.states.delete(id);
    await this.persist(); void this.sync(true);
  }
  async changeConnection(connection: Pick<Config, 'serverUrl' | 'token' | 'deviceId'>): Promise<void> {
    await this.interrupt();
    const binding = sourceHash(connection.serverUrl + ':' + (connection.token ?? ''));
    if (binding !== this.binding) {
      const dirty = new Set(this.sources.map(s => s.id));
      // Persist before mutating the connection so an I/O failure can retain the old in-memory node.
      await atomicSourceJson(join(this.directory, 'sources.json'), { version: 1, sources: this.sources, metadataDirty: [...dirty] });
      const engines = new Map<string, SourceSync>();
      for (const source of this.sources) { const engine = new SourceSync(join(this.directory, 'nodes', binding, source.id + '.json')); await engine.initialize(); engines.set(source.id, engine); }
      this.binding = binding; this.engines = engines; this.states.clear(); this.metadataDirty = dirty;
    }
    this.connection = connection; void this.sync(true);
  }
  async sync(force = true): Promise<void> {
    if (this.stopped || this.connectionHeld) return;
    if (this.task) return this.task;
    const controller = new AbortController(); this.controller = controller;
    this.task = this.run(force, controller.signal).finally(() => { this.task = undefined; if (this.controller === controller) this.controller = undefined; });
    return this.task;
  }
  private async run(force: boolean, signal: AbortSignal): Promise<void> {
    for (const source of this.sources) {
      if (!source.enabled || signal.aborted) continue;
      const last = this.states.get(source.id);
      if (!force && last?.lastSyncAt && Date.now() - Date.parse(last.lastSyncAt) < source.intervalSeconds * 1000) continue;
      // Failed attempts use a bounded retry interval as well; a timer never floods an unavailable node.
      if (!force && last && (last as SourceStatus & { attemptAt?: number }).attemptAt && Date.now() - (last as SourceStatus & { attemptAt: number }).attemptAt < Math.max(30000, source.intervalSeconds * 1000)) continue;
      const status: SourceStatus & { attemptAt: number } = { source, state: 'syncing', message: '读取所选来源并同步', pending: 0, items: 0, skipped: 0, ...last, attemptAt: Date.now() }; status.state = 'syncing'; this.states.set(source.id, status);
      try {
        let engine = this.engines.get(source.id);
        if (!engine) { engine = new SourceSync(join(this.directory, 'nodes', this.binding, source.id + '.json')); await engine.initialize(); this.engines.set(source.id, engine); }
        await engine.ensurePolicy(sourcePolicy(source));
        // Stage locally even when offline; this same revision is retried after process restarts.
        const now = Date.now(); const scope = { start: new Date(now - 30 * 86400000).toISOString(), end: new Date(now + 90 * 86400000).toISOString() };
        const scan = source.kind === 'local-files' ? await scanSourceFiles(source.path!, source, signal, join(this.directory, 'access-markers', source.id + '.json')) : decodeCalendarScan(await calendarHelper(this.helperPath, 'calendar-scan', { calendarId: source.calendarId, ...scope, includeText: source.retention !== 'reference' }, signal), source, scope);
        status.skipped = scan.skipped;
        const request: SourceRequest = async (path, body, method, requestSignal) => {
          if (!this.connection.token) throw new Error('请先配置中央节点令牌');
          const response = await fetch(this.connection.serverUrl + path, { method, headers: { Authorization: 'Bearer ' + this.connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([requestSignal || signal, AbortSignal.timeout(20000)]), redirect: 'error' });
          if (!response.ok) throw new Error(response.status === 401 ? '中央认证失败，请检查令牌' : response.status === 409 ? '中央来源已暂停，请在中央来源页恢复' : '中央同步失败，已保留本地版本，稍后自动重试');
          const text = await response.text(); if (text.length > 1024 * 1024) throw new Error('中央响应超过上限'); return JSON.parse(text);
        };
        // Register without overriding an owner's central pause. Apply metadata only after an explicit local edit.
        const prepare = async () => { if (this.metadataDirty.has(source.id)) {
          const registered = await request('/api/sources', sourceDefinition(source), 'POST', signal) as { id?: string };
          if (registered?.id !== source.id) throw new Error('中央来源注册确认无效');
          const patched = await request('/api/sources/' + source.id, { retention: source.retention, name: sourceDefinition(source).name }, 'PATCH', signal) as { id?: string };
          if (patched?.id !== source.id) throw new Error('中央来源配置确认无效');
          this.metadataDirty.delete(source.id); await this.persist();
        } };
        const { state: ready } = await engine.syncScan(scan, source.trackDeletions, sourceDefinition(source), request, signal, prepare);
        Object.assign(status, engine.status(), { state: ready === 'paused' ? 'paused' : 'idle', message: ready === 'paused' ? '中央已暂停该来源；待上传版本保留在本机' : scan.complete ? '已同步；后台定时检查变化' : '已同步可读取项；扫描不完整，未判断删除' });
      } catch (e) {
        Object.assign(status, this.engines.get(source.id)?.status(), { state: e instanceof CalendarPermissionError ? 'permission_required' : 'error', message: signal.aborted ? '同步已取消，待传版本已保留' : e instanceof CalendarPermissionError ? e.message : '同步未完成：检查权限、网络或来源路径后重试；待传版本已保留' });
      }
    }
  }
  private async persist(): Promise<void> { await atomicSourceJson(join(this.directory, 'sources.json'), { version: 1, sources: this.sources, metadataDirty: [...this.metadataDirty] }); }
  private async interrupt(): Promise<void> { this.controller?.abort(); await this.task; }
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.permissionController?.abort(); await Promise.allSettled([this.interrupt(), this.permissionTask]); }
}
