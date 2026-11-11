import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { FILE_MAX_BYTES, FILE_PART_BYTES, meetingRecordingSessionSchema, type MeetingRecordingProvenance } from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import { INGRESS_VERSION_HEADERS } from './ingress-protocol';

export type MeetingPermissionValue = 'granted' | 'denied' | 'not-determined' | 'unsupported';
export interface MeetingRecordingPermissions { microphone: MeetingPermissionValue; systemAudio: MeetingPermissionValue }
export interface MeetingCaptureResult { filePath: string; durationMs: number; microphone: boolean; systemAudio: boolean; warnings: string[] }
export interface MeetingAudioHandle { stop(): Promise<MeetingCaptureResult> }
export interface MeetingAudioBackend {
  start(input: { id: string; directory: string; outputFile: string; stopFile: string; maxDurationMs: number }): Promise<MeetingAudioHandle>;
}
export interface MeetingRecordingConnection { serverUrl?: string; token?: string; deviceId: string; syncPaused?: boolean }

interface StoredSession {
  id: string; startedAt: string; endedAt?: string; state: 'recording' | 'completed' | 'uploaded' | 'failed';
  durationMs: number; microphone: boolean; systemAudio: boolean; noticeAcknowledgedAt: string;
  platform: 'macos' | 'android'; warnings: string[]; audioFile?: string; mimeType?: string;
  uploadedAt?: string; captureId?: string; error?: string;
}
interface StoredState { version: 1; noticeAcknowledgedAt?: string; sessions: StoredSession[] }

export interface MeetingRecordingStatus {
  noticeAcknowledged: boolean;
  recording: boolean;
  startedAt?: string;
  permissions: MeetingRecordingPermissions;
  pendingUploads: number;
  lastSession?: StoredSession;
  sessions: StoredSession[];
  error?: string;
}

export class MeetingNoticeRequiredError extends Error {
  readonly code = 'meeting_notice_required';
  constructor() { super(moteText('开始前请先确认已告知在场的人。')); }
}

export interface MeetingRecordingManagerOptions {
  directory: string;
  connection: () => MeetingRecordingConnection;
  backend: MeetingAudioBackend;
  permissions: () => MeetingRecordingPermissions;
  platform?: 'macos' | 'android';
  fetch?: typeof fetch;
  now?: () => Date;
  maxDurationMs?: number;
}

const SESSION_LIMIT = 200;
const DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000;

/** A meeting begins only from this owner action. There is deliberately no
 * calendar, timer or source-scan entry point and no central control route. */
export class MeetingRecordingManager {
  private state: StoredState = { version: 1, sessions: [] };
  private handle?: MeetingAudioHandle;
  private active?: StoredSession;
  private initialized = false;
  private uploading = false;
  private error?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly platform: 'macos' | 'android';
  private readonly maxDurationMs: number;

  constructor(private readonly options: MeetingRecordingManagerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? 'macos';
    this.maxDurationMs = Math.min(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS, 24 * 60 * 60 * 1000);
  }

  private get file(): string { return join(this.options.directory, 'meetings.json'); }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as StoredState;
      if (raw?.version !== 1 || !Array.isArray(raw.sessions)) throw new Error('Invalid meeting store');
      this.state = { version: 1, ...(typeof raw.noticeAcknowledgedAt === 'string' ? { noticeAcknowledgedAt: raw.noticeAcknowledgedAt } : {}), sessions: raw.sessions.filter(this.validStored) };
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    }
    // A process can stop while the helper is writing. Never resume a microphone
    // on launch; keep any finished bytes and mark the interrupted session.
    for (const session of this.state.sessions) {
      if (session.state !== 'recording') continue;
      session.state = 'failed';
      session.error = moteText('上一次会议录音因应用退出而中断，未自动续录。');
    }
    await this.persist();
    this.initialized = true;
    await this.flushUploads().catch(() => undefined);
  }

  private validStored(value: unknown): value is StoredSession {
    if (!value || typeof value !== 'object') return false;
    const row = value as StoredSession;
    return typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id) && typeof row.startedAt === 'string'
      && ['recording', 'completed', 'uploaded', 'failed'].includes(row.state) && typeof row.noticeAcknowledgedAt === 'string'
      && Array.isArray(row.warnings) && (row.platform === 'macos' || row.platform === 'android');
  }

  private async persist(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.options.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }

  status(): MeetingRecordingStatus {
    const lastSession = [...this.state.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return {
      noticeAcknowledged: Boolean(this.state.noticeAcknowledgedAt),
      recording: Boolean(this.handle && this.active),
      ...(this.active ? { startedAt: this.active.startedAt } : {}),
      permissions: this.options.permissions(),
      pendingUploads: this.state.sessions.filter(session => session.state === 'completed').length,
      ...(lastSession ? { lastSession: structuredClone(lastSession) } : {}),
      sessions: structuredClone(this.state.sessions.slice(-SESSION_LIMIT)),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async acknowledgeNotice(): Promise<MeetingRecordingStatus> {
    await this.ensureInitialized();
    if (!this.state.noticeAcknowledgedAt) {
      this.state.noticeAcknowledgedAt = this.now().toISOString();
      await this.persist();
    }
    return this.status();
  }

  async start(): Promise<MeetingRecordingStatus> {
    await this.ensureInitialized();
    if (this.handle || this.active) throw new Error(moteText('一场会议录音正在进行。请先结束当前会议。'));
    if (!this.state.noticeAcknowledgedAt) throw new MeetingNoticeRequiredError();
    const permissions = this.options.permissions();
    if (permissions.microphone !== 'granted') throw new Error(moteText('麦克风权限未授予，会议录音没有开始。请在系统设置中允许麦克风后重试。'));
    if (permissions.systemAudio !== 'granted') throw new Error(moteText('系统音频权限未授予，会议录音没有开始。请允许屏幕与系统音频录制后重试；不会在缺少系统声时只录麦克风。'));
    const id = randomUUID(), directory = join(this.options.directory, id);
    const startedAt = this.now();
    const session: StoredSession = {
      id, startedAt: startedAt.toISOString(), state: 'recording', durationMs: 0,
      microphone: false, systemAudio: false, noticeAcknowledgedAt: this.state.noticeAcknowledgedAt,
      platform: this.platform, warnings: [],
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      this.handle = await this.options.backend.start({
        id, directory, outputFile: join(directory, this.platform === 'macos' ? 'meeting.m4a' : 'meeting.wav'),
        stopFile: join(directory, 'stop.request'), maxDurationMs: this.maxDurationMs,
      });
      this.active = session;
      this.state.sessions.push(session);
      if (this.state.sessions.length > SESSION_LIMIT) this.state.sessions = this.state.sessions.slice(-SESSION_LIMIT);
      this.error = undefined;
      await this.persist();
      return this.status();
    } catch (failure) {
      this.handle = undefined; this.active = undefined;
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw failure;
    }
  }

  async stop(): Promise<MeetingRecordingStatus> {
    await this.ensureInitialized();
    const handle = this.handle, session = this.active;
    if (!handle || !session) throw new Error(moteText('当前没有正在进行的会议录音。'));
    this.handle = undefined; this.active = undefined;
    try {
      const result = await handle.stop();
      const file = await stat(result.filePath).catch(() => undefined);
      if (!file?.isFile() || file.size < 1) throw new Error(moteText('会议录音没有生成可上传的音频，请检查麦克风与系统音频权限。'));
      const endedAt = this.now();
      session.endedAt = endedAt.toISOString();
      session.durationMs = Math.max(0, Math.min(Math.round(result.durationMs), this.maxDurationMs));
      session.microphone = result.microphone;
      session.systemAudio = result.systemAudio;
      session.warnings = result.warnings.slice(0, 20).map(value => value.slice(0, 500));
      session.audioFile = basename(result.filePath);
      session.mimeType = this.platform === 'macos' ? 'audio/mp4' : 'audio/wav';
      session.state = 'completed';
      try { meetingRecordingSessionSchema.parse({ version: 1, id: session.id, startedAt: session.startedAt, endedAt: session.endedAt, durationMs: session.durationMs, microphone: session.microphone, systemAudio: session.systemAudio, noticeAcknowledgedAt: session.noticeAcknowledgedAt, platform: session.platform, warnings: session.warnings }); }
      catch { session.state = 'failed'; session.error = moteText('会议录音的本地记录无效，未上传。'); await this.persist(); throw new Error(session.error); }
      this.error = undefined;
      await this.persist();
    } catch (failure) {
      if (session.state === 'recording') { session.state = 'failed'; session.error = failure instanceof Error ? failure.message : moteText('会议录音未完成。'); await this.persist(); }
      throw failure;
    }
    await this.flushUploads().catch(() => undefined);
    return this.status();
  }

  async flushUploads(): Promise<void> {
    await this.ensureInitialized();
    if (this.uploading) return;
    const connection = this.options.connection();
    const pending = this.state.sessions.filter(session => session.state === 'completed');
    if (!pending.length) return;
    if (!connection.serverUrl || !connection.token || connection.syncPaused) {
      this.error = moteText('会议录音已保存在本机，连接中央后自动上传。');
      return;
    }
    this.uploading = true;
    try {
      await this.registerSource(connection);
      for (const session of pending) {
        try { await this.uploadSession(connection, session); }
        catch (failure) { session.error = failure instanceof Error ? failure.message : moteText('会议录音上传未完成，原音频保留在本机。'); this.error = session.error; await this.persist(); break; }
      }
      if (!this.state.sessions.some(session => session.state === 'completed')) this.error = undefined;
    } finally { this.uploading = false; await this.persist(); }
  }

  private sourceId(connection: MeetingRecordingConnection): string {
    return 'local-meeting-' + createHash('sha256').update(connection.deviceId).digest('hex').slice(0, 24);
  }

  private async registerSource(connection: MeetingRecordingConnection): Promise<void> {
    const response = await this.request(connection, '/api/sources', 'POST', {
      id: this.sourceId(connection), name: moteText('本机会议录音'), kind: 'local-meeting-recording',
      deviceId: connection.deviceId, platform: this.platform, retention: 'archive', enabled: true,
    });
    if (response?.id !== this.sourceId(connection)) throw new Error(moteText('中央未确认本机会议录音来源。'));
  }

  private async uploadSession(connection: MeetingRecordingConnection, session: StoredSession): Promise<void> {
    if (!session.audioFile || !session.endedAt) throw new Error(moteText('会议录音缺少本地音频或结束时间。'));
    const directory = join(this.options.directory, session.id), path = join(directory, session.audioFile);
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > FILE_MAX_BYTES) throw new Error(moteText('会议录音音频超出中央单文件上限或不可读。'));
    const digest = await this.digest(path);
    const sourceId = this.sourceId(connection);
    const manifest = {
      sourceId, previousRevision: null, sha256: digest.hash, sizeBytes: info.size,
      relativePath: `meetings/${session.id}.${session.mimeType === 'audio/wav' ? 'wav' : 'm4a'}`,
      item: {
        externalId: `meeting:${session.id}`, revision: digest.hash, observedAt: session.endedAt,
        title: moteText('本机会议录音') + ' · ' + session.startedAt.slice(0, 16).replace('T', ' '),
        kind: 'file', layer: 'original', text: '', mimeType: session.mimeType ?? 'audio/mp4', deleted: false,
        document: {
          recordedAt: session.startedAt, timeBasis: 'recorded', contentRole: 'other',
          originalMetadata: { meeting: this.provenance(session) },
        },
      },
    };
    const begun = await this.request(connection, '/api/file-sync/v1/uploads', 'POST', manifest);
    if (begun?.ack?.id) { await this.complete(connection, session, String(begun.ack.id), path, directory); return; }
    if (typeof begun?.uploadId !== 'string' || !Array.isArray(begun.parts) || begun.partBytes !== FILE_PART_BYTES) throw new Error(moteText('中央文件上传会话无效。'));
    const received = new Set<number>(begun.parts.map((part: { part: number }) => part.part));
    const total = Math.ceil(info.size / FILE_PART_BYTES);
    const file = await open(path, 'r');
    try {
      for (let part = 0; part < total; part++) {
        if (received.has(part)) continue;
        const length = Math.min(FILE_PART_BYTES, info.size - part * FILE_PART_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const read = await file.read(buffer, 0, length, part * FILE_PART_BYTES);
        if (read.bytesRead !== length) throw new Error(moteText('会议录音音频读取不完整。'));
        const response = await this.request(connection, `/api/file-sync/v1/uploads/${begun.uploadId}/parts/${part}`, 'PUT', buffer, 'application/octet-stream');
        if (response?.part !== part || response?.bytes !== length) throw new Error(moteText('中央未确认会议录音分块。'));
      }
    } finally { await file.close(); }
    const committed = await this.request(connection, `/api/file-sync/v1/uploads/${begun.uploadId}/commit`, 'POST', {});
    if (typeof committed?.id !== 'string') throw new Error(moteText('中央未确认会议录音入库。'));
    await this.complete(connection, session, committed.id, path, directory);
  }

  private provenance(session: StoredSession): MeetingRecordingProvenance {
    return {
      version: 1, startedAt: session.startedAt, endedAt: session.endedAt!, durationMs: session.durationMs,
      microphone: session.microphone, systemAudio: session.systemAudio, noticeAcknowledgedAt: session.noticeAcknowledgedAt,
      platform: session.platform, warnings: session.warnings,
    };
  }

  private async complete(_connection: MeetingRecordingConnection, session: StoredSession, captureId: string, path: string, directory: string): Promise<void> {
    session.state = 'uploaded'; session.captureId = captureId; session.uploadedAt = this.now().toISOString(); session.error = undefined;
    await this.persist();
    await rm(path, { force: true });
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async digest(path: string): Promise<{ hash: string }> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return { hash: hash.digest('hex') };
  }

  private async request(connection: MeetingRecordingConnection, path: string, method: string, body: unknown, contentType = 'application/json'): Promise<any> {
    if (!connection.serverUrl || !connection.token) throw new Error(moteText('尚未连接中央。'));
    const payload = body instanceof Buffer ? body : Buffer.from(JSON.stringify(body));
    const response = await this.fetchImpl(connection.serverUrl + path, {
      method, body: payload, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { ...INGRESS_VERSION_HEADERS, Authorization: 'Bearer ' + connection.token, 'Content-Type': contentType },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(response.status === 401 ? moteText('中央认证失败，请重新连接后再上传会议录音。') : moteText('中央未接收会议录音（HTTP {0}），原音频保留在本机。', String(response.status)));
    }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error(moteText('中央响应超过大小限制。'));
    return text ? JSON.parse(text) : {};
  }

  async close(): Promise<void> {
    if (this.handle) await this.stop().catch(() => undefined);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) throw new Error('Meeting recording manager is not initialized');
  }
}
