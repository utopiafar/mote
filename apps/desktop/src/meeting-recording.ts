import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { FILE_MAX_BYTES, FILE_PART_BYTES, filePartReceipts, meetingRecordingSessionSchema, type MeetingRecordingProvenance } from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import {validateServerUrl} from './config';
import { INGRESS_VERSION_HEADERS,requireIngressReceipt } from './ingress-protocol';

export type MeetingPermissionValue = 'granted' | 'denied' | 'not-determined' | 'unsupported';
export interface MeetingRecordingPermissions { microphone: MeetingPermissionValue; systemAudio: MeetingPermissionValue }
export interface MeetingCaptureResult { filePath: string; durationMs: number; microphone: boolean; systemAudio: boolean; warnings: string[] }
export interface MeetingAudioHandle { stop(): Promise<MeetingCaptureResult> }
export interface MeetingAudioBackend {
  start(input: { id: string; directory: string; outputFile: string; stopFile: string; maxDurationMs: number }): Promise<MeetingAudioHandle>;
}
export interface MeetingRecordingConnection { serverUrl?: string; token?: string; deviceId: string; syncPaused?: boolean;generation?:number }

interface StoredSession {
  id: string; startedAt: string; endedAt?: string; state: 'recording' | 'completed' | 'uploaded' | 'failed';
  durationMs: number; microphone: boolean; systemAudio: boolean; noticeAcknowledgedAt: string;
  platform: 'macos' | 'android'; warnings: string[]; audioFile?: string; mimeType?: string;
  uploadedAt?: string; captureId?: string; uploadOrigin?:string;deviceId?:string;localContentRelease?:{at:string;pending?:true};archiveReceipt?:{sourceId:string;externalId:string;revision:string;sha256:string;sizeBytes:number};error?: string;
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

const SESSION_VIEW_LIMIT = 200;
const DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000;

/** A meeting begins only from this owner action. There is deliberately no
 * calendar, timer or source-scan entry point and no central control route. */
export class MeetingRecordingManager {
  private state: StoredState = { version: 1, sessions: [] };
  private handle?: MeetingAudioHandle;
  private active?: StoredSession;
  private initialized = false;
  private uploading = false;
  private closed=false;
  private cancellation=new AbortController();
  private persistence:Promise<unknown>=Promise.resolve();
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

  private persist(authorize?:()=>void,update?:{session:StoredSession;next:StoredSession}):Promise<void>{
    const next=this.persistence.catch(()=>{}).then(async()=>{
      authorize?.();await mkdir(this.options.directory,{recursive:true,mode:0o700});authorize?.();
      const temporary=join(this.options.directory,`${randomUUID()}.tmp`);
      const snapshot=update?{...this.state,sessions:this.state.sessions.map(session=>session===update.session?update.next:session)}:this.state;
      try{
        const file=await open(temporary,'wx',0o600);
        try{await file.writeFile(JSON.stringify(snapshot));await file.sync();}finally{await file.close();}
        authorize?.();await rename(temporary,this.file);
        if(process.platform!=='win32'){const directory=await open(this.options.directory,'r');try{await directory.sync();}finally{await directory.close();}}
        if(update)Object.assign(update.session,update.next);
      }finally{await rm(temporary,{force:true});}
    });this.persistence=next;return next;
  }
  private current(connection:MeetingRecordingConnection){
    const selected=this.options.connection();
    if(this.closed||this.cancellation.signal.aborted||selected.serverUrl!==connection.serverUrl||selected.token!==connection.token||selected.deviceId!==connection.deviceId||selected.generation!==connection.generation||selected.syncPaused)throw Error('Meeting upload authorization changed');
  }

  connectionActivity(){return {pending:this.state.sessions.filter(session=>session.state==='completed').length,inFlight:this.uploading};}
  status(): MeetingRecordingStatus {
    const lastSession = [...this.state.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return {
      noticeAcknowledged: Boolean(this.state.noticeAcknowledgedAt),
      recording: Boolean(this.handle && this.active),
      ...(this.active ? { startedAt: this.active.startedAt } : {}),
      permissions: this.options.permissions(),
      pendingUploads: this.state.sessions.filter(session => session.state === 'completed').length,
      ...(lastSession ? { lastSession: structuredClone(lastSession) } : {}),
      sessions: structuredClone(this.state.sessions.slice(-SESSION_VIEW_LIMIT)),
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
    if(this.closed)throw Error('Meeting recordings are closed');
    const id = randomUUID(), directory = join(this.options.directory, id);
    const startedAt = this.now();
    const session: StoredSession = {
      id, startedAt: startedAt.toISOString(), state: 'recording', durationMs: 0,
      microphone: false, systemAudio: false, noticeAcknowledgedAt: this.state.noticeAcknowledgedAt,
      platform: this.platform,deviceId:this.options.connection().deviceId, warnings: [],
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      this.handle = await this.options.backend.start({
        id, directory, outputFile: join(directory, this.platform === 'macos' ? 'meeting.m4a' : 'meeting.wav'),
        stopFile: join(directory, 'stop.request'), maxDurationMs: this.maxDurationMs,
      });
      this.active = session;
      this.state.sessions.push(session);
      this.error = undefined;
      await this.persist();
      return this.status();
    } catch (failure) {
      await this.handle?.stop().catch(()=>undefined);this.handle=undefined;this.active=undefined;
      session.state='failed';session.error=failure instanceof Error?failure.message:String(failure);
      if(!this.state.sessions.includes(session))this.state.sessions.push(session);
      await this.persist().catch(()=>undefined);
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
    if (this.uploading||this.closed) return;
    const connection = {...this.options.connection()};
    const pending = this.state.sessions.filter(session => session.state === 'completed');
    if (!pending.length) return;
    if (!connection.serverUrl || !connection.token || connection.syncPaused) {
      this.error = moteText('会议录音已保存在本机，连接中央后自动上传。');
      return;
    }
    this.uploading = true;
    try {
      for (const session of pending) {
        try { await this.uploadSession(connection, session); }
        catch (failure) {if(!this.closed){session.error = failure instanceof Error ? failure.message : moteText('会议录音上传未完成，原音频保留在本机。'); this.error = session.error; await this.persist();}break; }
      }
      if (!this.state.sessions.some(session => session.state === 'completed')) this.error = undefined;
    } finally { this.uploading = false; if(!this.closed)await this.persist(); }
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
    this.current(connection);
    if(session.uploadOrigin&&session.uploadOrigin!==connection.serverUrl)throw Error(moteText('本地待上传记录已绑定原节点或凭据，不能重新归属；请恢复原连接完成同步'));
    if(!session.uploadOrigin){session.uploadOrigin=connection.serverUrl;await this.persist(()=>this.current(connection));}
    await this.registerSource(connection);
    const directory = join(this.options.directory, session.id), path = join(directory, session.audioFile);
    const info = await stat(path);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > FILE_MAX_BYTES) throw new Error(moteText('会议录音音频超出中央单文件上限或不可读。'));
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
    if (begun?.ack?.id) { await this.complete(connection, session, begun.ack, manifest); return; }
    if (typeof begun?.uploadId !== 'string' || !Array.isArray(begun.parts) || begun.partBytes !== FILE_PART_BYTES) throw new Error(moteText('中央文件上传会话无效。'));
    const receipts=filePartReceipts(begun,async after=>{const page=await this.request(connection,`/api/file-sync/v1/uploads/${begun.uploadId}?afterPart=${after}`,'GET',undefined);if(page.uploadId!==begun.uploadId||page.partBytes!==FILE_PART_BYTES)throw Error('Upload receipt identity changed');return page;},info.size);let receipt=await receipts.next();
    const total = Math.ceil(info.size / FILE_PART_BYTES);
    const file = await open(path, 'r');
    try {
      for (let part = 0; part < total; part++) {
        const length = Math.min(FILE_PART_BYTES, info.size - part * FILE_PART_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const read = await file.read(buffer, 0, length, part * FILE_PART_BYTES);
        if (read.bytesRead !== length) throw new Error(moteText('会议录音音频读取不完整。'));
        const existing=!receipt.done&&receipt.value.part===part?receipt.value:undefined,hash=createHash('sha256').update(buffer).digest('hex');if(existing)receipt=await receipts.next();
        if(existing?.hash!==hash||existing.bytes!==length){const response = await this.request(connection, `/api/file-sync/v1/uploads/${begun.uploadId}/parts/${part}`, 'PUT', buffer, 'application/octet-stream');
        if (response?.part !== part || response?.bytes !== length || response?.hash!==hash) throw new Error(moteText('中央未确认会议录音分块。'));}
      }
      if(!receipt.done)throw Error('Incomplete upload receipt traversal');
    } finally { await file.close(); }
    const committed = await this.request(connection, `/api/file-sync/v1/uploads/${begun.uploadId}/commit`, 'POST', {});
    if (typeof committed?.id !== 'string') throw new Error(moteText('中央未确认会议录音入库。'));
    await this.complete(connection, session, committed, manifest);
  }

  private provenance(session: StoredSession): MeetingRecordingProvenance {
    return {
      version: 1, startedAt: session.startedAt, endedAt: session.endedAt!, durationMs: session.durationMs,
      microphone: session.microphone, systemAudio: session.systemAudio, noticeAcknowledgedAt: session.noticeAcknowledgedAt,
      platform: session.platform, warnings: session.warnings,
    };
  }

  private async complete(connection:MeetingRecordingConnection,session:StoredSession,value:unknown,manifest:{sourceId:string;sha256:string;sizeBytes:number;item:{externalId:string;revision:string}}):Promise<void>{
    this.current(connection);
    const ack=requireIngressReceipt(value,{kind:'file-revision',sourceId:manifest.sourceId,externalId:manifest.item.externalId,revision:manifest.item.revision});
    const bytes=value as {sha256?:unknown;sizeBytes?:unknown};if(bytes.sha256!==manifest.sha256||bytes.sizeBytes!==manifest.sizeBytes)throw Error('Meeting archive receipt does not match the saved audio');
    const next:StoredSession={...session,deviceId:connection.deviceId,archiveReceipt:{sourceId:manifest.sourceId,externalId:manifest.item.externalId,revision:manifest.item.revision,sha256:manifest.sha256,sizeBytes:manifest.sizeBytes},state:'uploaded',captureId:ack.id,uploadedAt:this.now().toISOString(),error:undefined};
    await this.persist(()=>this.current(connection),{session,next});
    // This is a formally saved local recording, not a source-file transport copy.
  }

  record(id:string):StoredSession|undefined {const value=this.state.sessions.find(session=>session.id===id);return value?structuredClone(value):undefined;}
  contentRecords():StoredSession[]{return structuredClone(this.state.sessions.filter(session=>session.state!=='recording'));}
  async releaseContent(id:string,authorize:()=>void=()=>{}):Promise<void>{
    await this.ensureInitialized();authorize();const session=this.state.sessions.find(value=>value.id===id);
    if(!session||session.state!=='uploaded'||!session.captureId||!/^[a-f0-9-]{36}$/i.test(session.captureId)||!session.uploadOrigin||validateServerUrl(session.uploadOrigin)!==session.uploadOrigin||!session.uploadedAt||!Number.isFinite(Date.parse(session.uploadedAt)))throw Error(moteText('本机副本已变化；尚无可读取的中央接收凭据。'));
    if(session.localContentRelease&&!session.localContentRelease.pending)return;
    const at=session.localContentRelease?.at??this.now().toISOString();
    const next:StoredSession={...session,localContentRelease:{at,pending:true},warnings:[],error:undefined};
    await this.persist(authorize,{session,next});authorize();
    // Session IDs are host-generated UUIDs and this directory contains only
    // this app's recording outputs, never a selected source file.
    if(!/^[a-f0-9-]{36}$/i.test(session.id))throw Error('Invalid recording identity');
    await rm(join(this.options.directory,session.id),{recursive:true,force:true});
    if(process.platform!=='win32'){const directory=await open(this.options.directory,'r');try{await directory.sync();}finally{await directory.close();}}
    await this.persist(authorize,{session,next:{...next,audioFile:undefined,localContentRelease:{at}}});
  }
  async readOriginal(id:string,authorize:()=>void):Promise<{bytes:AsyncIterable<Buffer>;sizeBytes:number;sha256?:string;close:()=>void}>{
    await this.ensureInitialized();authorize();const session=this.state.sessions.find(value=>value.id===id);
    if(!session?.audioFile||session.localContentRelease)throw Error(moteText('本机原件不在此设备，连接原中央后可按当前权限读取。'));
    if(!/^[a-f0-9-]{36}$/i.test(session.id)||basename(session.audioFile)!==session.audioFile)throw Error('Invalid recording identity');
    const selected=session.localContentRelease,path=join(this.options.directory,session.id,session.audioFile);
    const info=await stat(path);if(!info.isFile())throw Error('Invalid recording file');const stream=createReadStream(path,{highWaterMark:1024*1024});
    const close=()=>{stream.destroy();};
    return {sizeBytes:info.size,sha256:session.archiveReceipt?.sha256,close,bytes:(async function*(){try{for await(const part of stream){authorize();if(session.localContentRelease!==selected)throw Error('Local original changed');yield Buffer.from(part);}}finally{close();}})()};
  }
  private async digest(path: string): Promise<{ hash: string }> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return { hash: hash.digest('hex') };
  }

  private async request(connection: MeetingRecordingConnection, path: string, method: string, body: unknown, contentType = 'application/json'): Promise<any> {
    this.current(connection);
    if (!connection.serverUrl || !connection.token) throw new Error(moteText('尚未连接中央。'));
    const payload = body===undefined?undefined:body instanceof Buffer ? body : Buffer.from(JSON.stringify(body));
    const response = await this.fetchImpl(connection.serverUrl + path, {
      method, body: payload, redirect: 'error', signal: AbortSignal.any([this.cancellation.signal,AbortSignal.timeout(30000)]),
      headers: { ...INGRESS_VERSION_HEADERS, Authorization: 'Bearer ' + connection.token, 'Content-Type': contentType },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(response.status === 401 ? moteText('中央认证失败，请重新连接后再上传会议录音。') : moteText('中央未接收会议录音（HTTP {0}），原音频保留在本机。', String(response.status)));
    }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error(moteText('中央响应超过大小限制。'));
    this.current(connection);return text ? JSON.parse(text) : {};
  }

  async close(): Promise<void> {
    this.closed=true;this.cancellation.abort();
    if (this.handle) await this.stop().catch(() => undefined);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) throw new Error('Meeting recording manager is not initialized');
  }
}
