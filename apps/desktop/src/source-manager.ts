import { meteredBody } from './upload-meter';
import { moteText, statusMessage } from '@mote/shared/i18n';
import { type EventJournal, failureCode, httpFailure, TransportFailure } from './support';
import { randomUUID } from 'node:crypto';
import { join, basename, isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { atomicSourceJson, sourceHash, SourceSync } from './source-sync';
import { readLocalContent } from './local-content';
import { codingRoot, codingProviders, type CodingProvider } from './coding-agents';
import { sourceWork } from './background';
import {readSourceEvidence} from './file-evidence';
import { scanSourceFiles } from './source-files';
import { calendarHelper, CalendarPermissionError, decodeCalendarChoices, decodeCalendarScan } from './source-calendar';
import { normalizeSourceOptions, redactSourceText, type SourceStatus, type LocalSource, type CalendarChoice, type SourceDefinition, type SourceOptions, type SourceRequest, type LocalFileCheckpoint } from './source-types';
import type { Config } from './contracts';
import { readResponseText } from './response-body';
import { ConnectionBindingStore } from './connection-binding';
import { decideSync } from './sync-policy';
import { FileWatcher, type FileWatchEvent } from './file-watcher';
type SourceConnection = Pick<Config, 'serverUrl' | 'token' | 'deviceId'> & Partial<Pick<Config, 'syncMode' | 'syncIntervalMinutes' | 'syncBatchSize'>>;
export function sourceDefinition(source: LocalSource): SourceDefinition {
  const { id, name, kind, deviceId, platform, retention, enabled, initialSync } = source;
  return { id, name: redactSourceText(name, source.redactLiterals).slice(0, 200) || moteText("本地来源"), kind, deviceId, platform, retention, enabled, initialSync };
}
export function sourcePolicy(options: SourceOptions): string { return sourceHash(JSON.stringify({ indexMode:options.indexMode,allowRead:options.allowRead,retention: options.retention, trackDeletions: options.trackDeletions, extensions: options.extensions, excludedPaths: options.excludedPaths, redactLiterals: options.redactLiterals })); }
export class LocalSourceManager {
  private fileLocations=new Map<string,Map<string,string>>();
  private sources: LocalSource[] = [];
  private metadataDirty = new Set<string>();
  private metadataDirtyAt?: string;
  private states = new Map<string, SourceStatus>();
  private engines = new Map<string, SourceSync>();
  private task?: Promise<void>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private readonly watcher: FileWatcher;
  private readonly dirtySources = new Set<string>();
  private readonly dirtyPathVersions = new Map<string, Map<string, number>>();
  private readonly sourceWakeVersions = new Map<string, number>();
  private rerunRequested = false;
  private stopped = false;
  private connectionHeld = false;
  private choices: CalendarChoice[] = [];
  private permissionController?: AbortController;
  private permissionTask?: Promise<CalendarChoice[]>;
  private binding: string;
  readonly nodeBinding: ConnectionBindingStore;
  private readable = new Set<string>();
  constructor(private directory: string, private connection: SourceConnection, private helperPath: string, private managedUploads = false, private events?: EventJournal) { this.binding = this.connectionBinding(); this.nodeBinding = new ConnectionBindingStore(join(directory, 'connection-binding.json')); this.watcher = new FileWatcher(event => this.onFileWatchEvent(event)); }
  private connectionBinding(): string { return sourceHash(this.connection.serverUrl + ':' + (this.connection.token ?? '')); }
  async initialize(): Promise<void> {
    try {
      const saved = JSON.parse((await readLocalContent(join(this.directory, 'sources.json'))).toString('utf8')) as { version: number; sources: LocalSource[]; metadataDirty: string[]; metadataDirtyAt?: string };
      if (saved.version !== 1 || !Array.isArray(saved.sources) || saved.sources.length > 40) throw new Error(moteText("本地来源配置无效"));
      this.sources = saved.sources.map(s => {
        if (!/^local-[a-f0-9-]{36}$/.test(s.id) || typeof s.name !== 'string' || s.name.length > 200 || typeof s.enabled !== 'boolean' || !['local-files', 'local-calendar', 'coding-agent'].includes(s.kind) || (s.kind === 'local-calendar' ? typeof s.calendarId !== 'string' : typeof s.path !== 'string') || (s.kind === 'coding-agent' && !['claude','codex','kimi'].includes(s.agent ?? ''))) throw new Error(moteText("本地来源配置无效"));
        return { ...s, ...normalizeSourceOptions(s), deviceId: this.connection.deviceId };
      });
      this.metadataDirty = new Set(saved.metadataDirty || []);
      if (this.metadataDirty.size) this.metadataDirtyAt = saved.metadataDirtyAt ?? (await stat(join(this.directory, 'sources.json'))).mtime.toISOString();
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await this.nodeBinding.initialize(this.connection, this.sources.length > 0);
    // Include paused sources when guarding a node change: they can still own durable pending bodies.
    for (const source of this.sources) { const engine = new SourceSync(join(this.directory, 'nodes', this.binding, source.id + '.json')); await engine.initialize(); this.engines.set(source.id, engine); }
    await this.refreshWatchers();
    this.timer = setInterval(() => { void this.refreshWatchers(); void this.sync(false); }, 5000); this.timer.unref();
    void this.sync(false);
  }
  status(): SourceStatus[] { return this.sources.map<SourceStatus>(source => ({ state: source.enabled ? 'idle' : 'paused', message: source.enabled ? moteText("等待首次同步") : moteText("本机已暂停"), pending: 0, items: 0, skipped: 0, ...this.states.get(source.id), ...this.engines.get(source.id)?.status(), source: structuredClone(source), ...(!source.enabled ? { state: 'paused' as const, message: moteText("本机已暂停") } : {}) })).map(row => ({...row, message: statusMessage(row.message)})); }
  connectionActivity(): { pending: number; inFlight: boolean } { return { pending: [...this.engines.values()].reduce((sum, engine) => sum + engine.status().pending, 0), inFlight: Boolean(this.task || this.permissionTask) }; }
  async holdConnection(): Promise<() => void> {
    if (this.connectionHeld || this.permissionTask) throw new Error(moteText("本地来源授权尚未结束，请稍后重试连接"));
    this.connectionHeld = true;
    try { await this.interrupt(); return () => { this.connectionHeld = false; }; }
    catch (error) { this.connectionHeld = false; throw error; }
  }
  async prepareReauthorization(connection: Pick<Config, 'serverUrl' | 'token' | 'deviceId'>): Promise<void> {
    if (!this.connectionHeld || this.task || this.permissionTask || connection.serverUrl !== this.connection.serverUrl || connection.deviceId !== this.connection.deviceId) throw new Error(moteText("仅允许已暂停同步的同一节点、同一设备重新授权"));
    const binding = sourceHash(connection.serverUrl + ':' + (connection.token ?? ''));
    if (binding === this.binding) return;
    for (const [id, engine] of this.engines) await engine.checkpointTo(join(this.directory, 'nodes', binding, id + '.json'));
    await this.nodeBinding.commit(connection, this.connectionActivity().pending > 0, false, true);
  }
  async prepareInitialConnection(connection: SourceConnection): Promise<void> {
    if (!this.connectionHeld || !this.nodeBinding.unbound() || this.task || this.permissionTask || connection.deviceId !== this.connection.deviceId) throw new Error(moteText("仅允许为未绑定的本地来源确认首次连接"));
    const binding = sourceHash(connection.serverUrl + ':' + (connection.token ?? ''));
    for (const [id, engine] of this.engines) await engine.checkpointTo(join(this.directory, 'nodes', binding, id + '.json'));
  }
  pendingStats(): { pendingRecords: number; eligibleRecords: number; heldRecords: number; oldestPendingAt?: string; oldestEligibleAt?: string; hasUpdates: boolean; pendingUpdates: number; eligibleUpdates: number; heldUpdates: number; oldestUpdateAt?: string; heldReason?: string } {
    const rows = this.sources.map(source => ({ source, status: this.engines.get(source.id)?.status(), eligible: source.enabled && this.readable.has(source.id) && this.states.get(source.id)?.state !== 'paused' }));
    const pendingRecords = rows.reduce((sum, row) => sum + (row.status?.pending ?? 0), 0);
    const eligibleRecords = rows.filter(row => row.eligible).reduce((sum, row) => sum + (row.status?.pending ?? 0), 0);
    const pendingUpdates = rows.filter(row => row.source.enabled && this.metadataDirty.has(row.source.id)).length;
    const eligibleUpdates = rows.filter(row => row.eligible && this.metadataDirty.has(row.source.id)).length;
    const held = rows.find(row => !row.eligible && ((row.status?.pending ?? 0) > 0 || (row.source.enabled && this.metadataDirty.has(row.source.id))));
    const heldReason = held ? !held.source.enabled ? moteText("本地来源已暂停，待传版本保留在本机") : this.states.get(held.source.id)?.state === 'paused' ? moteText("中央已暂停来源，待传版本保留在本机") : moteText("等待来源权限或恢复可读取状态，待传版本保留在本机") : undefined;
    const oldestPendingAt = rows.flatMap(row => row.status?.oldestPendingAt ? [row.status.oldestPendingAt] : []).sort()[0];
    const oldestEligibleAt = rows.filter(row => row.eligible).flatMap(row => row.status?.oldestPendingAt ? [row.status.oldestPendingAt] : []).sort()[0];
    return { pendingRecords, eligibleRecords, heldRecords: pendingRecords - eligibleRecords, oldestPendingAt, oldestEligibleAt, pendingUpdates, eligibleUpdates, heldUpdates: pendingUpdates - eligibleUpdates, hasUpdates: pendingUpdates > 0, oldestUpdateAt: eligibleUpdates ? this.metadataDirtyAt : undefined, heldReason };
  }
  async authorizeCalendar(): Promise<CalendarChoice[]> {
    if (this.permissionTask) return this.permissionTask;
    if (this.stopped) throw new Error(moteText("应用正在退出"));
    const controller = new AbortController(); this.permissionController = controller;
    this.permissionTask = calendarHelper(this.helperPath, 'calendar-permission', undefined, controller.signal).then(raw => { this.choices = decodeCalendarChoices(raw); return structuredClone(this.choices); }).finally(() => { this.permissionTask = undefined; this.permissionController = undefined; });
    return this.permissionTask;
  }
  async addCalendar(id: string, input: unknown): Promise<void> {
    const calendar = this.choices.find(c => c.id === id);
    if (!calendar) throw new Error(moteText("请先连接日历，再从已授权列表中选择"));
    await this.add({ calendarId: calendar.id, name: calendar.title.slice(0, 200) || moteText("本地日历"), kind: 'local-calendar' }, input);
  }
  async addFiles(path: string, input: unknown): Promise<void> { await this.add({ path, name: basename(path).slice(0, 200) || moteText("本地文件"), kind: 'local-files' }, input); }
  async addCodingAgent(provider: CodingProvider, input: unknown): Promise<void> {
    if (!Object.hasOwn(codingProviders, provider)) throw new Error(moteText("不支持的 Coding Agent"));
    await this.add({ path: codingRoot(provider), name: codingProviders[provider], kind: 'coding-agent', agent: provider }, { ...normalizeSourceOptions(input), trackDeletions: false });
  }
  private async add(fields: Pick<LocalSource, 'name' | 'kind'> & Partial<LocalSource>, input: unknown): Promise<void> {
    const options = normalizeSourceOptions(input);
    if(fields.kind!=='local-files'&&options.retention==='archive')options.retention='snapshot';
    if (this.sources.length >= 40) throw new Error(moteText("本机最多连接 40 个本地来源"));
    if (this.sources.some(s => s.kind === fields.kind && (fields.path ? s.path === fields.path : s.calendarId === fields.calendarId))) throw new Error(moteText("此来源已连接，请在列表中修改"));
    await this.interrupt();
    const source: LocalSource = { ...fields, ...options, id: 'local-' + randomUUID(), deviceId: this.connection.deviceId, platform: 'macos', enabled: true } as LocalSource;
    this.sources.push(source); this.markMetadataDirty(source.id); await this.persist(); await this.refreshWatchers(); void this.sync(true);
  }
  async update(id: string, input: unknown): Promise<void> {
    const source = this.sources.find(s => s.id === id); if (!source) throw new Error(moteText("来源不存在"));
    const value = input as SourceOptions & { enabled: boolean };
    const options = normalizeSourceOptions(value);if(source.kind!=='local-files'&&options.retention==='archive')options.retention='snapshot'; if (typeof value.enabled !== 'boolean') throw new Error(moteText("启停选项无效"));
    await this.interrupt();
    Object.assign(source, options, { enabled: value.enabled }); this.markMetadataDirty(id); this.states.delete(id);
    await this.persist(); await this.refreshWatchers(); void this.sync(true);
  }
  async changeConnection(connection: SourceConnection): Promise<void> {
    await this.interrupt();
    const binding = sourceHash(connection.serverUrl + ':' + (connection.token ?? ''));
    const switchingBucket = binding !== this.binding;
    if (!switchingBucket) this.nodeBinding.assertChange(connection, this.connectionActivity().pending > 0);
    if (switchingBucket) {
      const dirty = new Set(this.sources.map(s => s.id));
      // Persist before mutating the connection so an I/O failure can retain the old in-memory node.
      await atomicSourceJson(join(this.directory, 'sources.json'), { version: 1, sources: this.sources, metadataDirty: [...dirty], metadataDirtyAt: this.metadataDirtyAt ?? new Date().toISOString() });
      const engines = new Map<string, SourceSync>();
      for (const source of this.sources) { const engine = new SourceSync(join(this.directory, 'nodes', binding, source.id + '.json')); await engine.initialize(); engines.set(source.id, engine); }
      this.binding = binding; this.engines = engines; this.states.clear(); this.readable.clear(); this.metadataDirty = dirty; this.metadataDirtyAt ??= new Date().toISOString();
    }
    await this.nodeBinding.commit(connection, !switchingBucket && this.connectionActivity().pending > 0);
    this.connection = connection; void this.sync(true);
  }
  async sync(force = true): Promise<void> {
    if (this.stopped || this.connectionHeld) return;
    if (this.task) return this.task;
    const controller = new AbortController(); this.controller = controller;
    this.task = this.run(force, controller.signal).finally(() => { this.task = undefined; if (this.controller === controller) this.controller = undefined; if (this.rerunRequested && !this.stopped) { this.rerunRequested = false; void this.sync(false); } });
    return this.task;
  }
  private async run(force: boolean, signal: AbortSignal): Promise<void> {
    if(this.connection.serverUrl&&this.connection.token&&this.nodeBinding.matches(this.connection))for(const source of this.sources.filter(s=>s.enabled&&s.kind==='local-files'&&s.allowRead&&s.retention==='snapshot')){
      try{const request=this.request(signal),pending=await request('/api/sources/'+source.id+'/read-requests',undefined,'GET',signal) as {items:import('@mote/shared').FileReadRequest[]};
        for(const read of pending.items){const result=await readSourceEvidence(source,read,this.fileLocations.get(source.id)??new Map(),signal);await request('/api/sources/'+source.id+'/read-requests/'+read.id,result,'PUT',signal);}
      }catch{signal.throwIfAborted();}
    }
    for (const source of this.sources) {
      if (!source.enabled || signal.aborted) continue;
      const last = this.states.get(source.id);
      if (!force && !this.dirtySources.has(source.id) && last?.lastSyncAt && Date.now() - Date.parse(last.lastSyncAt) < source.intervalSeconds * 1000) continue;
      // Failed attempts use a bounded retry interval as well; a timer never floods an unavailable node.
      if (!force && !this.dirtySources.has(source.id) && last?.state === 'error' && (last as SourceStatus & { attemptAt?: number }).attemptAt && Date.now() - (last as SourceStatus & { attemptAt: number }).attemptAt < Math.max(30000, source.intervalSeconds * 1000)) continue;
      const status: SourceStatus & { attemptAt: number } = { source, state: 'syncing', message: moteText("读取所选来源并同步"), pending: 0, items: 0, skipped: 0, ...last, attemptAt: Date.now() }; status.state = 'syncing'; this.states.set(source.id, status);
      const started = Date.now(); void this.events?.record('SOURCE', 'STARTED');
      const wakeVersion = this.sourceWakeVersions.get(source.id) ?? 0;
      this.readable.delete(source.id);
      try {
        let engine = this.engines.get(source.id);
        if (!engine) { engine = new SourceSync(join(this.directory, 'nodes', this.binding, source.id + '.json')); await engine.initialize(); this.engines.set(source.id, engine); }
        await engine.ensurePolicy(sourcePolicy(source));
        // Stage locally even when offline; this same revision is retried after process restarts.
        const now = Date.now(); const scope = { start: new Date(now - 30 * 86400000).toISOString(), end: new Date(now + 90 * 86400000).toISOString() };
        if(source.kind==='local-files')this.fileLocations.set(source.id,new Map());
        const priorityVersions = new Map(this.dirtyPathVersions.get(source.id) ?? []);
        const scan = source.kind === 'coding-agent' ? await sourceWork.run<import('./source-types').SourceScan>({kind:'coding-scan', root:source.path!, provider:source.agent!, options:source, checkpoint:engine.checkpoint() as import('./coding-agents').CodingCheckpoint | undefined}) : source.kind === 'local-files' ? await scanSourceFiles(source.path!, source, signal, join(this.directory, 'access-markers', source.id + '.json'), this.fileLocations.get(source.id), engine.checkpoint() as LocalFileCheckpoint | undefined, [...priorityVersions.keys()]) : decodeCalendarScan(await calendarHelper(this.helperPath, 'calendar-scan', { calendarId: source.calendarId, ...scope, includeText: source.retention !== 'reference' }, signal), source, scope);
        if (!scan.queue) scan.queue = source.initialSync === 'all' && !engine.initialized() ? 'history' : 'realtime';
        signal.throwIfAborted(); status.skipped = scan.skipped;
        if (source.kind === 'coding-agent' && scan.skipped) status.message = moteText("部分会话无法读取或格式不支持；保留游标，下次重试");
        this.readable.add(source.id);
        if (this.managedUploads) {
          await engine.stage(scan, source.kind !== 'coding-agent' && source.trackDeletions,undefined,source.initialSync);
          Object.assign(status, engine.status(), { state: 'idle', message: !this.connection.serverUrl || !this.connection.token ? moteText("已保存在本机；尚未配置中央同步") : moteText("已检查本地变化，按同步设置等待上传") });
        } else {
          const pending = this.pendingStats();
          const policy = decideSync({ ...this.connection, syncMode: this.connection.syncMode ?? 'realtime', syncIntervalMinutes: this.connection.syncIntervalMinutes ?? 15, syncBatchSize: this.connection.syncBatchSize ?? 20 }, pending, Date.now(), force);
          if (!policy.ready) { await engine.stage(scan, source.kind !== 'coding-agent' && source.trackDeletions,undefined,source.initialSync); Object.assign(status, engine.status(), { state: 'idle', message: policy.message }); }
          else {
            const request = this.request(signal);
            const { state: ready } = await engine.syncScan(scan, source.kind !== 'coding-agent' && source.trackDeletions, sourceDefinition(source), request, signal, () => this.prepareSource(source, request, signal));
            Object.assign(status, engine.status(), { state: ready === 'paused' ? 'paused' : 'idle', message: ready === 'paused' ? moteText("中央已暂停该来源；待上传版本保留在本机") : scan.complete ? moteText("已同步；后台定时检查变化") : moteText("已同步可读取项；扫描不完整，未判断删除") });
          }
        }
        if (source.kind === 'coding-agent' && !scan.complete) status.message = scan.skipped ? moteText("部分会话无法读取或单条事件超过限制；已保留进度，下次重试") : moteText("已保存当前批次；其余会话或未写完的尾行将在后续扫描继续");
        // Do not clear a notification that arrived while the reconciliation
        // scan was running; it must trigger another scan after this one.
        if ((this.sourceWakeVersions.get(source.id) ?? 0) === wakeVersion) this.dirtySources.delete(source.id);
        const paths = this.dirtyPathVersions.get(source.id);
        if (paths) { for (const [path, version] of priorityVersions) if (paths.get(path) === version) paths.delete(path); if (!paths.size) this.dirtyPathVersions.delete(source.id); }
        void this.events?.record('SOURCE', scan.complete ? 'OK' : 'SCHEDULER', { elapsedMs: Date.now() - started });
      } catch (e) {
        void this.events?.record('SOURCE', signal.aborted ? 'CANCELLED' : e instanceof CalendarPermissionError ? 'PERMISSION' : failureCode(e, 'SOURCE'), { elapsedMs: Date.now() - started });
        Object.assign(status, this.engines.get(source.id)?.status(), { state: e instanceof CalendarPermissionError ? 'permission_required' : 'error', message: signal.aborted ? moteText("同步已取消，待传版本已保留") : e instanceof CalendarPermissionError ? e.message : moteText("同步未完成：检查权限、网络或来源路径后重试；待传版本已保留") });
      }
    }
  }
  private request(signal: AbortSignal): SourceRequest {
    return async (path, body, method, requestSignal) => {
      if (!this.connection.serverUrl || !this.connection.token || !this.nodeBinding.matches(this.connection)) throw new Error(moteText("本地来源没有匹配的中央连接"));
      const response = await fetch(this.connection.serverUrl + path, { method, headers: { Authorization: 'Bearer ' + this.connection.token, 'Content-Type': body instanceof Uint8Array?'application/octet-stream':'application/json' }, body: method==='GET'?undefined:meteredBody(body instanceof Uint8Array?body:JSON.stringify(body)), ...({duplex:'half'} as object), signal: AbortSignal.any([requestSignal || signal, AbortSignal.timeout(20000)]), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new TransportFailure(response.status === 401 ? moteText("中央认证失败，请检查令牌") : response.status === 409 ? moteText("中央来源已暂停，请在中央来源页恢复") : moteText("中央同步失败，已保留本地版本，稍后重试"), httpFailure(response.status), response.status); }
      return JSON.parse(await readResponseText(response, 1024 * 1024));
    };
  }
  private async prepareSource(source: LocalSource, request: SourceRequest, signal: AbortSignal): Promise<void> {
    if (!this.metadataDirty.has(source.id)) return;
    const registered = await request('/api/sources', sourceDefinition(source), 'POST', signal) as { id?: string };
    if (registered?.id !== source.id) throw new Error(moteText("中央来源注册确认无效"));
    const patched = await request('/api/sources/' + source.id, { retention: source.retention, initialSync: source.initialSync, name: sourceDefinition(source).name }, 'PATCH', signal) as { id?: string };
    if (patched?.id !== source.id) throw new Error(moteText("中央来源配置确认无效"));
    this.metadataDirty.delete(source.id); if (!this.metadataDirty.size) this.metadataDirtyAt = undefined; await this.persist();
  }
  private onFileWatchEvent(event: FileWatchEvent): void {
    if (!this.sources.some(source => source.id === event.sourceId && source.enabled)) return;
    this.dirtySources.add(event.sourceId);
    this.sourceWakeVersions.set(event.sourceId, (this.sourceWakeVersions.get(event.sourceId) ?? 0) + 1);
    if (event.path) { const path = isAbsolute(event.path) ? event.path : join(event.root, event.path); const paths = this.dirtyPathVersions.get(event.sourceId) ?? new Map<string, number>(); paths.set(path, (paths.get(path) ?? 0) + 1); this.dirtyPathVersions.set(event.sourceId, paths); }
    if (this.task) this.rerunRequested = true;
    void this.events?.record('SOURCE', 'SCHEDULER');
    void this.sync(false);
  }
  private async refreshWatchers(): Promise<void> {
    await this.watcher.setTargets(this.sources.filter(source => source.enabled && (source.kind === 'local-files' || source.kind === 'coding-agent') && source.path).map(source => ({ sourceId: source.id, path: source.path! })));
  }
  /** Managed by the collector's one sync decision across screenshots, notes and source versions. */
  async flushPending(signal: AbortSignal): Promise<void> {
    if (this.stopped || this.connectionHeld) return;
    await this.task;
    const controller = new AbortController(); this.controller = controller;
    const combined = AbortSignal.any([signal, controller.signal]);
    const run = async () => {
      combined.throwIfAborted();
      for (const source of this.sources) {
        if (!source.enabled || !this.readable.has(source.id) || this.states.get(source.id)?.state === 'paused') continue;
        const engine = this.engines.get(source.id)!;
        if (!engine.status().pending && !this.metadataDirty.has(source.id)) continue;
        const request = this.request(combined);
        await this.prepareSource(source, request, combined);
        const ready = await engine.flush(sourceDefinition(source), request, combined);
        const previous = this.states.get(source.id);
        this.states.set(source.id, { source, skipped: 0, ...previous, ...engine.status(), state: ready === 'paused' ? 'paused' : 'idle', message: ready === 'paused' ? moteText("中央已暂停，待传版本保留在本机") : moteText("已同步；后台继续检查本地变化") });
      }
    };
    // A hold/update can abort and await this network work, just like local scans.
    this.task = run();
    try { await this.task; } finally { this.task = undefined; if (this.controller === controller) this.controller = undefined; }
  }
  private markMetadataDirty(id: string): void { if (!this.metadataDirty.size) this.metadataDirtyAt = new Date().toISOString(); this.metadataDirty.add(id); }
  private async persist(): Promise<void> { await atomicSourceJson(join(this.directory, 'sources.json'), { version: 1, sources: this.sources, metadataDirty: [...this.metadataDirty], metadataDirtyAt: this.metadataDirtyAt }); }
  private async interrupt(): Promise<void> { this.controller?.abort(); await this.task; }
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.watcher.close(); this.permissionController?.abort(); await Promise.allSettled([this.interrupt(), this.permissionTask]); }
}
