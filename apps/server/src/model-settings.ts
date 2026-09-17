import { moteText } from './i18n.js';
import {providerModels} from './model-catalog.js';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { validateModelOptions } from '@mote/agent';
import {
  MODEL_PROTOCOLS, MODEL_REASONING_EFFORTS, MODEL_FEATURES, modelProvider,
  type ModelProfile, type ModelFeature, type ModelFeatureDefaults,
  type ModelSettings, type ModelSettingsInput, type ModelSettingsView, type ModelTestResult,
} from '@mote/shared/models';

const line = (max: number, min = 0) => z.string().min(min).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const parameters = {
  provider: line(128, 1).refine(value => modelProvider(value) !== undefined),
  protocol: z.enum(MODEL_PROTOCOLS),
  baseUrl: line(4096),
  model: line(512),
  reasoningEffort: z.enum(MODEL_REASONING_EFFORTS),
  maxTokens: z.number().int().min(1).max(128_000),
  timeoutMs: z.number().int().min(5000).max(600_000),
  allowUnauthenticatedLocal: z.boolean(),
};
const apiKey = line(8192);
const headers = z.record(z.string().max(8192));
const extraBody = z.record(z.unknown());
const settingsSchema = z.object({ ...parameters, apiKey, headers, extraBody }).strict();
const inputSchema = z.object({
  ...parameters, apiKey: apiKey.nullable().optional(),
  headers: headers.nullable().optional(), extraBody: extraBody.nullable().optional(),
}).strict();
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const updateSchema = z.object({
  revision: revisionSchema, settings: inputSchema, allowCredentialReuse: z.boolean().optional(),
}).strict();
const resetSchema = z.object({ revision: revisionSchema }).strict();
export const modelProfileIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const profileSchema = z.object({id:modelProfileIdSchema.refine(id=>id!=='default'),name:line(100,1),settings:settingsSchema}).strict();
const defaultsSchema = z.object(Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,modelProfileIdSchema])) as Record<ModelFeature, typeof modelProfileIdSchema>).strict();
const savedSchema = z.object({ version: z.literal(1), revision: revisionSchema, settings: settingsSchema.nullable(),
  profiles:z.array(profileSchema).max(30).optional(), defaults:defaultsSchema.optional(),
}).strict().superRefine((state,ctx)=>{
  const ids=['default',...(state.profiles??[]).map(p=>p.id)];
  if(new Set(ids).size!==ids.length||Object.values(state.defaults??{}).some(id=>!ids.includes(id)))ctx.addIssue({code:'custom',message:'Invalid model references'});
});
const defaultAssignments=():ModelFeatureDefaults=>({chat:'default',memory:'default',insight:'default',import:'default',file:'default'});
type SavedState = z.infer<typeof savedSchema>;
type FileSystem = Pick<typeof fs, 'open' | 'mkdir' | 'rename' | 'unlink'>;
const MAX_FILE_BYTES = 512 * 1024;

const errors = {
  model_profile_missing: [400, "所选模型配置不存在，请重新选择。"],
  model_profile_in_use: [409, "该配置仍是某项功能的默认模型，请先修改功能默认值。"],
  model_settings_invalid: [400, "模型配置无效，请检查填写的参数。"],
  model_settings_conflict: [409, "模型设置已发生变化，请刷新后重试。"],
  model_settings_credential_reuse: [409, "服务商、协议或地址已改变，请确认复用已有凭据，或替换、清除已有凭据。"],
  model_settings_unavailable: [503, "模型设置暂不可用，请检查服务状态后重试。"],
  model_settings_prepare_failed: [503, "无法准备新的模型配置，原配置保持使用。"],
  model_settings_save_failed: [503, "模型设置未能保存，原配置保持使用。"],
  model_settings_commit_uncertain: [503, "模型设置保存结果需要重新确认，请刷新设置后重试。"],
} as const;
export class ModelSettingsError extends Error {
  readonly statusCode: 400 | 409 | 503;
  constructor(readonly code: keyof typeof errors) {
    super(moteText(errors[code][1])); this.name = 'ModelSettingsError'; this.statusCode = errors[code][0];
  }
}

export interface PreparedModelSettings {
  /** A synchronous, non-throwing swap. Existing requests retain their old runtime. */
  activate(): void;
  /** Dispose only an unactivated candidate; active runtime retirement belongs to the caller. */
  dispose(): Promise<void>;
}
export interface ModelSettingsStoreOptions {
  directory: string;
  environment: ModelSettings;
  prepare(settings: ModelSettings, profiles: ModelProfile[]): Promise<PreparedModelSettings>;
  probe(settings: ModelSettings): Promise<ModelTestResult>;
  /** Filesystem operations can be fault-injected without model or network access. */
  fileSystem?: Partial<FileSystem>;
}

function validSettings(value: unknown): ModelSettings {
  try {
    const parsed = settingsSchema.parse(value);
    // Validate the original advanced objects as well: parsing must not hide protected keys.
    validateModelOptions(value as ModelSettings);
    validateModelOptions(parsed);
    if(parsed.protocol==='codex-app-server'&&parsed.apiKey)throw new Error('Codex uses local login credentials');
    if (parsed.protocol !== 'codex-app-server' && !parsed.baseUrl.trim() && parsed.model.trim()) throw new Error('Configured models need an endpoint');
    return structuredClone(parsed);
  } catch { throw new ModelSettingsError('model_settings_invalid'); }
}
const same = (a: SavedState | null, b: SavedState | null) => JSON.stringify(a) === JSON.stringify(b);
const testMessages: Record<ModelTestResult['code'], string> = {
  get ok() { return moteText("模型连接及工具调用测试通过。"); },
  get not_configured() { return moteText("请先填写模型和所需凭据。"); },
  get timeout() { return moteText("模型测试超时，请检查服务后重试。"); },
  get provider_error() { return moteText("模型服务未能完成测试，请检查地址、凭据及模型配置。"); },
  get invalid_response() { return moteText("模型返回格式或工具调用能力未通过测试。"); },
};

/** Owner-only configuration transactions. HTTP authentication belongs to the app. */
export class ModelSettingsStore {
  private readonly environment: ModelSettings;
  private readonly io: FileSystem;
  private readonly path: string;
  private tail: Promise<void> = Promise.resolve();
  private state?: SavedState;
  private diskState: SavedState | null = null;
  private closing = false;
  private closed = false;
  private unavailable = false;

  constructor(private readonly options: ModelSettingsStoreOptions) {
    this.environment = validSettings(options.environment);
    this.io = { open: fs.open, mkdir: fs.mkdir, rename: fs.rename, unlink: fs.unlink, ...options.fileSystem };
    this.path = join(options.directory, 'model-settings.json');
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ModelSettingsError('model_settings_unavailable'));
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private requireState(): SavedState {
    if (!this.state || this.unavailable || this.closed) throw new ModelSettingsError('model_settings_unavailable');
    return this.state;
  }

  /** Missing files mean environment configuration; malformed/unreadable files never silently fall back. */
  private async readSaved(): Promise<SavedState | null> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await this.io.open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid settings file');
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      const state = savedSchema.parse(value);
      if (state.settings) state.settings = validSettings((value as SavedState).settings);
      for(const profile of state.profiles??[])profile.settings=validSettings(profile.settings);
      return state;
    } finally { await handle.close(); }
  }

  initialize(): Promise<ModelSettingsView> {
    return this.serialize(async () => {
      if (this.state) return this.view();
      let state: SavedState | null;
      try {
        await this.io.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
        state = await this.readSaved();
      } catch { throw new ModelSettingsError('model_settings_unavailable'); }
      const candidate = await this.prepare(state?.settings ?? this.environment, state?.profiles ?? []);
      this.state = state ?? { version: 1, revision: 0, settings: null };
      this.diskState = state;
      this.activate(candidate);
      return this.view();
    });
  }

  view(): ModelSettingsView {
    const state = this.requireState(), settings = state.settings ?? this.environment;
    return {
      version: 1, revision: state.revision, source: state.settings ? 'saved' : 'environment',
      profiles:this.profiles().map(p=>({...p,settings:publicSettings(p.settings)})), defaults:{...defaultAssignments(),...state.defaults},
      settings: publicSettings(settings),
    };
  }

  /** Internal use only. HTTP routes must return view(), never current(). */
  current(): ModelSettings { return structuredClone(this.requireState().settings ?? this.environment); }

  profiles(): ModelProfile[] {
    return [{id:'default',name:moteText("默认配置"),settings:this.current()},...structuredClone(this.requireState().profiles??[])];
  }
  select(feature:ModelFeature, override?:string):ModelProfile {
    const id=override??this.requireState().defaults?.[feature]??'default';
    const profile=this.profiles().find(p=>p.id===id);
    if(!profile)throw new ModelSettingsError('model_profile_missing');
    return profile;
  }

  private expectedRevision(revision: number): void {
    if (revision !== this.requireState().revision) throw new ModelSettingsError('model_settings_conflict');
  }

  private draft(body: unknown, profileId = 'default'): ModelSettings {
    let update: z.infer<typeof updateSchema>;
    try {
      update = updateSchema.parse(body);
      const original = (body as {settings: ModelSettingsInput}).settings;
      validateModelOptions({ ...update.settings, headers: original.headers ?? undefined, extraBody: original.extraBody ?? undefined });
      if (update.settings.protocol !== 'codex-app-server' && !update.settings.baseUrl.trim() && update.settings.model.trim()) throw new Error('Configured models need an endpoint');
    } catch { throw new ModelSettingsError('model_settings_invalid'); }
    this.expectedRevision(update.revision);
    const input = update.settings;
    // New profiles never inherit another profile's credentials.
    const current = this.profiles().find(p=>p.id===profileId)?.settings ?? {...input,apiKey:'',headers:{},extraBody:{}};
    const changed = input.provider !== current.provider || input.protocol !== current.protocol || input.baseUrl !== current.baseUrl;
    const retained = (input.apiKey === undefined && Boolean(current.apiKey))
      || (input.headers === undefined && Object.keys(current.headers).length > 0)
      || (input.extraBody === undefined && Object.keys(current.extraBody).length > 0);
    if (changed && retained && update.allowCredentialReuse !== true) throw new ModelSettingsError('model_settings_credential_reuse');
    return validSettings({
      ...input,
      apiKey: input.apiKey === undefined ? current.apiKey : input.apiKey ?? '',
      headers: input.headers === undefined ? current.headers : input.headers ?? {},
      extraBody: input.extraBody === undefined ? current.extraBody : input.extraBody ?? {},
    });
  }

  private async prepare(settings: ModelSettings, profiles: ModelProfile[]): Promise<PreparedModelSettings> {
    try { return await this.options.prepare(structuredClone(settings), structuredClone(profiles)); }
    catch { throw new ModelSettingsError('model_settings_prepare_failed'); }
  }

  private activate(candidate: PreparedModelSettings): void {
    try { candidate.activate(); }
    catch {
      // A throwing swap may already have activated. Never dispose a possibly active runtime.
      this.unavailable = true;
      throw new ModelSettingsError('model_settings_unavailable');
    }
  }

  /** True means the new file is authoritative, but the write's durability acknowledgement failed. */
  private async persist(next: SavedState): Promise<boolean> {
    const temporary = join(this.options.directory, `.model-settings-${randomUUID()}.tmp`);
    let renameAttempted = false;
    try {
      const handle = await this.io.open(temporary, 'wx', 0o600);
      try {
        const serialized = JSON.stringify(next) + '\n';
        if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error('Settings file too large');
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      renameAttempted = true;
      await this.io.rename(temporary, this.path);
      const directory = await this.io.open(this.options.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return false;
    } catch {
      if (renameAttempted) {
        let observed: SavedState | null;
        try { observed = await this.readSaved(); }
        catch {
          this.unavailable = true;
          throw new ModelSettingsError('model_settings_commit_uncertain');
        }
        if (same(observed, next)) return true;
        if (!same(observed, this.diskState)) {
          this.unavailable = true;
          throw new ModelSettingsError('model_settings_commit_uncertain');
        }
      }
      throw new ModelSettingsError('model_settings_save_failed');
    } finally {
      await this.io.unlink(temporary).catch(() => {});
    }
  }

  private async commit(settings: ModelSettings | null, registry: Pick<SavedState,'profiles'|'defaults'> = this.requireState()): Promise<ModelSettingsView> {
    const state = this.requireState();
    if (state.revision === Number.MAX_SAFE_INTEGER) throw new ModelSettingsError('model_settings_unavailable');
    const next: SavedState = { version: 1, revision: state.revision + 1, settings,
      ...(registry.profiles?.length?{profiles:registry.profiles}:{}), ...(registry.defaults?{defaults:registry.defaults}:{}) };
    if(!savedSchema.safeParse(next).success)throw new ModelSettingsError('model_settings_invalid');
    const candidate = await this.prepare(settings ?? this.environment, next.profiles??[]);
    let activated = false;
    try {
      const uncertain = await this.persist(next);
      this.state = next;
      this.diskState = next;
      activated = true;
      this.activate(candidate);
      if (uncertain) throw new ModelSettingsError('model_settings_commit_uncertain');
      return this.view();
    } finally {
      if (!activated) await candidate.dispose().catch(() => {});
    }
  }

  update(body: unknown): Promise<ModelSettingsView> {
    return this.serialize(() => this.commit(this.draft(body)));
  }

  reset(body: unknown): Promise<ModelSettingsView> {
    return this.serialize(() => {
      const parsed = resetSchema.safeParse(body);
      if (!parsed.success) throw new ModelSettingsError('model_settings_invalid');
      this.expectedRevision(parsed.data.revision);
      return this.commit(null);
    });
  }

  models(body: unknown) {
    return this.serialize(async () => this.draft(body)).then(settings => providerModels(settings));
  }

  updateProfile(id:string, body:unknown):Promise<ModelSettingsView> {
    return this.serialize(()=>{
      const parsed=z.object({revision:revisionSchema,name:line(100,1),settings:inputSchema,allowCredentialReuse:z.boolean().optional()}).strict().safeParse(body);
      if(!parsed.success||!modelProfileIdSchema.safeParse(id).success||id==='default')throw new ModelSettingsError('model_settings_invalid');
      const {name,...update}=parsed.data;
      const settings=this.draft({...update,settings:(body as {settings:unknown}).settings},id);
      const state=this.requireState(),profiles=structuredClone(state.profiles??[]),index=profiles.findIndex(p=>p.id===id);
      const profile={id,name,settings};
      if(index<0)profiles.push(profile);else profiles[index]=profile;
      return this.commit(state.settings,{profiles,defaults:state.defaults});
    });
  }
  deleteProfile(id:string,body:unknown):Promise<ModelSettingsView> {
    return this.serialize(()=>{
      const parsed=resetSchema.safeParse(body);
      if(!parsed.success||id==='default')throw new ModelSettingsError('model_settings_invalid');
      this.expectedRevision(parsed.data.revision);
      const state=this.requireState();
      this.select('chat',id);
      if(Object.values(state.defaults??{}).includes(id))throw new ModelSettingsError('model_profile_in_use');
      return this.commit(state.settings,{profiles:state.profiles?.filter(p=>p.id!==id),defaults:state.defaults});
    });
  }
  updateDefaults(body:unknown):Promise<ModelSettingsView> {
    return this.serialize(()=>{
      const parsed=z.object({revision:revisionSchema,defaults:defaultsSchema}).strict().safeParse(body);
      if(!parsed.success)throw new ModelSettingsError('model_settings_invalid');
      this.expectedRevision(parsed.data.revision);
      for(const feature of MODEL_FEATURES)this.select(feature,parsed.data.defaults[feature]);
      const state=this.requireState();
      return this.commit(state.settings,{profiles:state.profiles,defaults:parsed.data.defaults});
    });
  }

  test(body: unknown, profileId='default'): Promise<ModelTestResult> {
    return this.serialize(async () => {
      const settings = this.draft(body,profileId), started = Date.now();
      try {
        const result = await this.options.probe(settings);
        if (!result || !Object.hasOwn(testMessages, result.code) || typeof result.ok !== 'boolean'
          || result.ok !== (result.code === 'ok') || !Number.isFinite(result.durationMs) || result.durationMs < 0) {
          return { ok: false, code: 'invalid_response', message: testMessages.invalid_response, durationMs: Date.now() - started };
        }
        // Provider/callback messages can contain URLs, keys or raw error text. Return fixed messages only.
        return { ok: result.ok, code: result.code, message: testMessages[result.code], durationMs: Math.round(result.durationMs) };
      } catch {
        return { ok: false, code: 'provider_error', message: testMessages.provider_error, durationMs: Date.now() - started };
      }
    });
  }

  /** Drains configuration work. The app owns active and retired runtime lifetimes. */
  async close(): Promise<void> { this.closing = true; await this.tail; this.closed = true; }
}

function publicSettings(settings:ModelSettings) {
  const {apiKey,headers,extraBody,...parameters}=settings;
  return {...parameters,apiKeyConfigured:Boolean(apiKey),headersConfigured:Object.keys(headers).length>0,extraBodyConfigured:Object.keys(extraBody).length>0};
}
