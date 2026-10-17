import { moteText } from './i18n.js';
import {providerModels,codexModels} from './model-catalog.js';
import { ConfigService, ConfigServiceError, type PreparedConfigChange } from './config-service.js';
import { z } from 'zod';
import { validateModelOptions } from '@mote/agent';
import {
  DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_MODEL_MAX_TOKENS, DEFAULT_MODEL_REQUEST_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS, MAX_MODEL_REQUEST_TIMEOUT_MS, MODEL_PROTOCOLS, MODEL_REASONING_EFFORTS, CODEX_SERVICE_TIERS, MODEL_FEATURES, modelProvider, DEPLOYMENT_MODEL_PROFILE_ID, DEFAULT_MODEL_PROFILE_ID,
  type ModelProfile, type ModelFeature, type ModelFeatureDefaults,
  type ModelSettings, type ModelSettingsInput, type ModelSettingsView, type ModelTestResult,
} from '@mote/shared/models';

const line = (max: number, min = 0) => z.string().min(min).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const registeredProviders=new Map<string,{validate:(settings:Readonly<ModelSettings>)=>void|boolean}>();
/** Trusted installed provider declarations extend the same model schema used
 * by instance YAML and personal configuration. Transport validation stays in
 * validateModelOptions; registration never grants a user host credentials. */
export function registerModelSettingsProvider(id:string,validate:(settings:Readonly<ModelSettings>)=>void|boolean=()=>true){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id)||modelProvider(id)||registeredProviders.has(id))throw new ConfigServiceError('config_invalid','models');
  const registration={validate};registeredProviders.set(id,registration);
  return ()=>{if(registeredProviders.get(id)===registration)registeredProviders.delete(id);};
}
const parameters = {
  provider: line(128, 1).refine(value => modelProvider(value) !== undefined||registeredProviders.has(value)),
  protocol: z.enum(MODEL_PROTOCOLS),
  baseUrl: line(4096),
  model: line(512),
  reasoningEffort: z.enum(MODEL_REASONING_EFFORTS),
  serviceTier: z.enum(CODEX_SERVICE_TIERS).optional(),
  maxTokens: z.number().int().min(1).max(128_000),
  modelRequestTimeoutMs: z.number().int().min(5000).max(MAX_MODEL_REQUEST_TIMEOUT_MS).nullable(),
  agentTimeoutMs: z.number().int().min(5000).max(MAX_AGENT_TIMEOUT_MS).nullable(),
  allowUnauthenticatedLocal: z.boolean(),
};
const apiKey = line(8192);
const headers = z.record(z.string().max(8192));
const extraBody = z.record(z.unknown());
const validateTimeouts = (value: {protocol: string; reasoningEffort:string; modelRequestTimeoutMs: number | null; agentTimeoutMs: number | null}, ctx: z.RefinementCtx) => {
  if (value.protocol === 'codex-app-server' && (value as {serviceTier?:string}).serviceTier===undefined)ctx.addIssue({code:'custom',path:['serviceTier'],message:'Codex service tier is required'});
  if (value.protocol === 'codex-app-server' && value.modelRequestTimeoutMs !== null) ctx.addIssue({ code: 'custom', path: ['modelRequestTimeoutMs'], message: 'Model request timeout is not applicable to Codex App Server' });
  if (value.protocol !== 'codex-app-server' && value.modelRequestTimeoutMs === null) ctx.addIssue({ code: 'custom', path: ['modelRequestTimeoutMs'], message: 'Model request timeout is required for HTTP providers' });
  if (value.protocol !== 'codex-app-server' && ['minimal', 'medium', 'xhigh', 'ultra'].includes(value.reasoningEffort)) ctx.addIssue({code:'custom',path:['reasoningEffort'],message:'This reasoning effort requires Codex App Server'});
};
const modelSettingsObjectSchema = z.object({ ...parameters, apiKey, headers, extraBody }).strict().superRefine((value,ctx)=>{
  validateTimeouts(value,ctx);
  try {
    validateModelOptions(value);
    const result=registeredProviders.get(value.provider)?.validate(structuredClone(value)) as unknown;
    if(result&&typeof (result as {then?:unknown}).then==='function'){void Promise.resolve(result).catch(()=>{});throw Error();}
    if(result===false)throw Error();
    if(value.protocol==='codex-app-server'&&value.apiKey)throw Error();
    if(value.protocol!=='codex-app-server'&&!value.baseUrl.trim()&&value.model.trim())throw Error();
  } catch {ctx.addIssue({code:'custom',message:'Invalid model parameters'});}
});
export const modelSettingsSchema=z.preprocess((value,ctx)=>{
  // Zod records may omit special object keys while parsing. Validate the original
  // advanced objects before parsing so file edits cannot hide protected keys.
  try{validateModelOptions(value as ModelSettings);}
  catch{ctx.addIssue({code:'custom',message:'Invalid model parameters'});}
  return value;
},modelSettingsObjectSchema);
const settingsSchema=modelSettingsSchema;
const inputSchema = z.object({
  ...parameters, apiKey: apiKey.nullable().optional(),
  headers: headers.nullable().optional(), extraBody: extraBody.nullable().optional(),
}).strict().superRefine(validateTimeouts);
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const updateSchema = z.object({
  revision: revisionSchema, settings: inputSchema, allowCredentialReuse: z.boolean().optional(),
}).strict();
const resetSchema = z.object({ revision: revisionSchema }).strict();
export const modelProfileIdSchema = z.union([z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),z.literal(DEPLOYMENT_MODEL_PROFILE_ID)]);
const profileSchema = z.object({id:modelProfileIdSchema.refine(id=>!['default',DEPLOYMENT_MODEL_PROFILE_ID].includes(id)),name:line(100,1),settings:settingsSchema}).strict();
const defaultsSchema = z.object(Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,feature==='ocr'||feature==='asr'?modelProfileIdSchema.default(DEPLOYMENT_MODEL_PROFILE_ID):modelProfileIdSchema])) as Record<ModelFeature, typeof modelProfileIdSchema>).strict();
const defaultModelsSchema = z.object(Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,line(512,1)])) as Record<ModelFeature, ReturnType<typeof line>>).partial().strict();
export const defaultModelAssignments=():ModelFeatureDefaults=>Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,DEPLOYMENT_MODEL_PROFILE_ID])) as ModelFeatureDefaults;
export function defaultModelSettings():ModelSettings {
  const preset=modelProvider('deepseek')!;
  return {provider:'deepseek',protocol:preset.protocol,baseUrl:preset.baseUrl,model:'',reasoningEffort:'high',maxTokens:DEFAULT_MODEL_MAX_TOKENS,
    modelRequestTimeoutMs:DEFAULT_MODEL_REQUEST_TIMEOUT_MS,agentTimeoutMs:DEFAULT_AGENT_TIMEOUT_MS,allowUnauthenticatedLocal:false,apiKey:'',headers:{},extraBody:{}};
}
export const deploymentModelSettingsSchema=z.preprocess(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
  const value=raw as Partial<ModelSettings>,provider=value.provider??'deepseek',preset=modelProvider(provider),protocol=value.protocol??preset?.protocol??'deepseek';
  return {...defaultModelSettings(),baseUrl:preset?.baseUrl??'',reasoningEffort:protocol==='deepseek'?'high':'auto',
    modelRequestTimeoutMs:protocol==='codex-app-server'?null:DEFAULT_MODEL_REQUEST_TIMEOUT_MS,agentTimeoutMs:protocol==='codex-app-server'?null:DEFAULT_AGENT_TIMEOUT_MS,
    ...(protocol==='codex-app-server'?{serviceTier:'default'}:{}),allowUnauthenticatedLocal:preset?.allowUnauthenticatedLocal??false,...value,provider,protocol};
},settingsSchema);
export const modelDomainSchema = z.object({
  deployment:deploymentModelSettingsSchema.default({}),profiles:z.array(profileSchema).max(30).default([]),defaults:defaultsSchema.default(defaultModelAssignments),defaultModels:defaultModelsSchema.default({}),
  embedding:z.object({model:line(512).default(''),baseUrl:line(4096).default(''),apiKey:apiKey.default('')}).strict().default({}),
  codex:z.object({executable:line(4096,1).optional(),home:line(4096,1).optional()}).strict().default({}),
}).strict().superRefine((state,ctx)=>{
  const ids=[DEPLOYMENT_MODEL_PROFILE_ID,...state.profiles.map(p=>p.id)];
  if(new Set(ids).size!==ids.length||Object.values(state.defaults).some(id=>!ids.includes(id)))ctx.addIssue({code:'custom',message:'Invalid model references'});
  const embedding=state.embedding;
  if(embedding.model&&!embedding.baseUrl)ctx.addIssue({code:'custom',path:['embedding','baseUrl'],message:'Embedding endpoint is required'});
  if(embedding.baseUrl)try{const u=new URL(embedding.baseUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();}catch{ctx.addIssue({code:'custom',path:['embedding','baseUrl'],message:'Invalid embedding endpoint'});}
});
export type ModelDomain=z.infer<typeof modelDomainSchema>;
export const defaultModelDomain=():ModelDomain=>modelDomainSchema.parse({});

const errors = {
  model_profile_missing: [400, "所选模型配置不存在，请重新选择。"],
  model_profile_read_only: [409, "部署配置为只读，请复制为新预设后编辑。"],
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
  /** Restore the previous generation if another domain fails to apply. */
  rollback?(): void;
  /** Retire the old generation only after the complete configuration transaction succeeds. */
  complete?(): void;
  /** Dispose only an unactivated candidate; active runtime retirement belongs to the caller. */
  dispose(): Promise<void>;
}
export interface ModelSettingsStoreOptions {
  configService: ConfigService;
  prepare(settings: ModelSettings, profiles: ModelProfile[], defaultProfileId:string, previousSettings?:ModelSettings): Promise<PreparedModelSettings>;
  probe(settings: ModelSettings): Promise<ModelTestResult>;
  codex?: {executable?:string;home?:string};
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
const testMessages: Record<ModelTestResult['code'], string> = {
  get ok() { return moteText("模型连接及工具调用测试通过。"); },
  get not_configured() { return moteText("请先填写模型和所需凭据。"); },
  get timeout() { return moteText("模型测试超时，请检查服务后重试。"); },
  get provider_error() { return moteText("模型服务未能完成测试，请检查地址、凭据及模型配置。"); },
  get invalid_response() { return moteText("模型返回格式或工具调用能力未通过测试。"); },
};
export const modelTestMessage=(code:ModelTestResult['code'])=>testMessages[code];

/** Owner-only configuration transactions. HTTP authentication belongs to the app. */
export class ModelSettingsStore {
  private tail: Promise<void> = Promise.resolve();
  private initialized=false;
  private closing=false;
  private closed=false;
  constructor(private readonly options: ModelSettingsStoreOptions) {
    options.configService.setHandler<ModelDomain>('models',async (next,previous)=>this.prepareDomain(next,previous));
  }

  private async prepareDomain(state:ModelDomain,previous:ModelDomain):Promise<PreparedConfigChange> {
    if(this.closed)throw new ModelSettingsError('model_settings_unavailable');
    const wasInitialized=this.initialized;
    const candidate=await this.prepare(state,previous);
    return {applyOrder:1000,apply:()=>{},publish:()=>{candidate.activate();this.initialized=true;},
      ...(candidate.rollback?{rollback:()=>{candidate.rollback!();this.initialized=wasInitialized;}}:{}),
      ...(candidate.complete?{complete:()=>candidate.complete!()}:{}),dispose:()=>candidate.dispose()};
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ModelSettingsError('model_settings_unavailable'));
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private requireState(): ModelDomain {
    if (!this.initialized || this.closed) throw new ModelSettingsError('model_settings_unavailable');
    try{return this.options.configService.current<ModelDomain>('models');}
    catch{throw new ModelSettingsError('model_settings_unavailable');}
  }

  initialize(): Promise<ModelSettingsView> {
    return this.serialize(async () => {
      if(this.initialized)return this.view();
      try {await this.options.configService.initialize();}
      catch(error){throw this.configurationError(error);}
      if(!this.initialized){const candidate=await this.prepare(this.options.configService.current<ModelDomain>('models'));candidate.activate();candidate.complete?.();this.initialized=true;}
      return this.view();
    });
  }

  private configurationError(error:unknown):Error {
    if(error instanceof ConfigServiceError){
      const code=({config_invalid:'model_settings_invalid',config_conflict:'model_settings_conflict',config_unavailable:'model_settings_unavailable',config_prepare_failed:'model_settings_prepare_failed',config_apply_failed:'model_settings_unavailable',config_save_failed:'model_settings_save_failed',config_commit_uncertain:'model_settings_commit_uncertain'} as const)[error.code];
      return new ModelSettingsError(code);
    }
    return error instanceof ModelSettingsError?error:new ModelSettingsError('model_settings_unavailable');
  }

  view(): ModelSettingsView {
    const state = this.requireState(), settings = this.current();
    const defaults = {...defaultModelAssignments(),...state.defaults};
    return {
      version: 1, revision: this.options.configService.revision, source: 'file',
      profiles:this.profiles().map(p=>({...p,settings:publicSettings(p.settings),readOnly:p.id===DEPLOYMENT_MODEL_PROFILE_ID,source:'file' as const})), defaults,
      defaultModels:{...state.defaultModels},
      settings: publicSettings(settings),
    };
  }

  /** Internal use only. HTTP routes must return view(), never current(). */
  current(): ModelSettings { return structuredClone(this.select('chat').settings); }

  profiles(): ModelProfile[] {
    return [{id:DEPLOYMENT_MODEL_PROFILE_ID,name:moteText("部署配置"),settings:structuredClone(this.requireState().deployment)},...structuredClone(this.requireState().profiles??[])];
  }
  select(feature:ModelFeature, override?:string):ModelProfile {
    const id=override??this.requireState().defaults[feature];
    const profile=this.profiles().find(p=>p.id===id);
    if(!profile)throw new ModelSettingsError('model_profile_missing');
    const model = override === undefined ? this.requireState().defaultModels?.[feature] : undefined;
    return model ? {...profile, settings:{...profile.settings,model}} : profile;
  }

  private expectedRevision(revision: number): void {
    if (revision !== this.options.configService.revision) throw new ModelSettingsError('model_settings_conflict');
  }

  private draft(body: unknown, profileId = DEFAULT_MODEL_PROFILE_ID): ModelSettings {
    let update: z.infer<typeof updateSchema>;
    try {
      const normalized = body;
      update = updateSchema.parse(normalized);
      const original = (normalized as {settings: ModelSettingsInput}).settings;
      validateModelOptions({ ...update.settings, headers: original.headers ?? undefined, extraBody: original.extraBody ?? undefined });
      if (update.settings.protocol !== 'codex-app-server' && !update.settings.baseUrl.trim() && update.settings.model.trim()) throw new Error('Configured models need an endpoint');
    } catch { throw new ModelSettingsError('model_settings_invalid'); }
    this.expectedRevision(update.revision);
    const input = update.settings;
    // New profiles never inherit another profile's credentials.
    const current = this.profiles().find(p=>p.id===profileId)?.settings ?? (profileId===DEFAULT_MODEL_PROFILE_ID?this.current():{...input,apiKey:'',headers:{},extraBody:{}});
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

  private async prepare(state:ModelDomain,previous=state): Promise<PreparedModelSettings> {
    const selected=state.profiles.find(profile=>profile.id===state.defaults.chat)?.settings??state.deployment;
    const previousSettings=previous.profiles.find(profile=>profile.id===previous.defaults.chat)?.settings??previous.deployment;
    try {return await this.options.prepare(structuredClone(selected),[{id:DEPLOYMENT_MODEL_PROFILE_ID,name:moteText("部署配置"),settings:structuredClone(state.deployment)},...structuredClone(state.profiles)],state.defaults.chat,structuredClone(previousSettings));}
    catch{throw new ModelSettingsError('model_settings_prepare_failed');}
  }

  private async commit(registry: Pick<ModelDomain,'profiles'|'defaults'|'defaultModels'>): Promise<ModelSettingsView> {
    this.requireState();
    const revision=this.options.configService.revision,saved=this.options.configService.saved<ModelDomain>('models');
    const next={...saved,profiles:registry.profiles,defaults:registry.defaults,defaultModels:registry.defaultModels};
    if(!modelDomainSchema.safeParse(next).success)throw new ModelSettingsError('model_settings_invalid');
    try{await this.options.configService.replace('models',next,revision);}
    catch(error){throw this.configurationError(error);}
    return this.view();
  }

  private rawProfileSettings(id:string):ModelSettings|undefined {
    const raw=this.options.configService.document().models as ModelDomain;
    return id===DEPLOYMENT_MODEL_PROFILE_ID?raw.deployment:raw.profiles.find(profile=>profile.id===id)?.settings;
  }

  update(body: unknown): Promise<ModelSettingsView> {
    return this.serialize(()=>{
      const settings=this.draft(body),state=this.requireState();
      if(!state.profiles.some(profile=>profile.id===DEFAULT_MODEL_PROFILE_ID)) {
        const original=this.rawProfileSettings(this.select('chat').id),input=(body as {settings:ModelSettingsInput}).settings;
        if(original){if(input.apiKey===undefined)settings.apiKey=original.apiKey;if(input.headers===undefined)settings.headers=structuredClone(original.headers);if(input.extraBody===undefined)settings.extraBody=structuredClone(original.extraBody);}
      }
      return this.commit({profiles:[...state.profiles.filter(p=>p.id!==DEFAULT_MODEL_PROFILE_ID),{id:DEFAULT_MODEL_PROFILE_ID,name:moteText("部署配置"),settings}],defaults:Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,state.defaults[feature]===DEPLOYMENT_MODEL_PROFILE_ID?DEFAULT_MODEL_PROFILE_ID:state.defaults[feature]])) as ModelFeatureDefaults,defaultModels:state.defaultModels});
    });
  }

  reset(body: unknown): Promise<ModelSettingsView> {
    return this.serialize(() => {
      const parsed = resetSchema.safeParse(body);
      if (!parsed.success) throw new ModelSettingsError('model_settings_invalid');
      this.expectedRevision(parsed.data.revision);
      const state=this.requireState();return this.commit({profiles:state.profiles.filter(p=>p.id!==DEFAULT_MODEL_PROFILE_ID),defaults:Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,state.defaults[feature]===DEFAULT_MODEL_PROFILE_ID?DEPLOYMENT_MODEL_PROFILE_ID:state.defaults[feature]])) as ModelFeatureDefaults,defaultModels:state.defaultModels});
    });
  }

  models(body: unknown, profileId = DEFAULT_MODEL_PROFILE_ID) {
    return this.serialize(async () => this.draft(body,profileId)).then(settings => settings.protocol==='codex-app-server'?codexModels(undefined,this.options.codex):providerModels(settings));
  }

  updateProfile(id:string, body:unknown):Promise<ModelSettingsView> {
    return this.serialize(()=>{
      if(id===DEPLOYMENT_MODEL_PROFILE_ID)throw new ModelSettingsError('model_profile_read_only');
      const normalized = body;
      const parsed=z.object({revision:revisionSchema,name:line(100,1),settings:inputSchema,allowCredentialReuse:z.boolean().optional()}).strict().safeParse(normalized);
      if(!parsed.success||!modelProfileIdSchema.safeParse(id).success||id==='default')throw new ModelSettingsError('model_settings_invalid');
      const {name,...update}=parsed.data;
      const settings=this.draft({...update,settings:(normalized as {settings:unknown}).settings},id);
      const state=this.requireState(),profiles=structuredClone(state.profiles??[]),index=profiles.findIndex(p=>p.id===id);
      const profile={id,name,settings};
      if(index<0)profiles.push(profile);else profiles[index]=profile;
      return this.commit({...state,profiles});
    });
  }
  copyProfile(id:string,body:unknown):Promise<ModelSettingsView> {
    return this.serialize(()=>{
      const parsed=z.object({revision:revisionSchema,id:modelProfileIdSchema,name:line(100,1),includeCredentials:z.boolean().default(true)}).strict().safeParse(body);
      if(!parsed.success||['default',DEPLOYMENT_MODEL_PROFILE_ID].includes(parsed.data.id))throw new ModelSettingsError('model_settings_invalid');
      this.expectedRevision(parsed.data.revision);
      if(this.profiles().some(p=>p.id===parsed.data.id))throw new ModelSettingsError('model_settings_conflict');
      const source=this.select('chat',id),state=this.requireState();
      const settings=structuredClone(source.settings);
      if(!parsed.data.includeCredentials){settings.apiKey='';settings.headers={};settings.extraBody={};}
      else {
        // A new profile has no same-id reference mapping. Copy the original
        // expressions, so literal ${...} inside an expanded credential is not
        // interpreted a second time or written into the file as a new secret.
        const original=this.rawProfileSettings(source.id);
        if(original){settings.apiKey=original.apiKey;settings.headers=structuredClone(original.headers);settings.extraBody=structuredClone(original.extraBody);}
      }
      return this.commit({...state,profiles:[...(state.profiles??[]),{id:parsed.data.id,name:parsed.data.name,settings}]});
    });
  }
  deleteProfile(id:string,body:unknown):Promise<ModelSettingsView> {
    return this.serialize(()=>{
      if(id===DEPLOYMENT_MODEL_PROFILE_ID)throw new ModelSettingsError('model_profile_read_only');
      const parsed=resetSchema.safeParse(body);
      if(!parsed.success||id==='default')throw new ModelSettingsError('model_settings_invalid');
      this.expectedRevision(parsed.data.revision);
      const state=this.requireState();
      this.select('chat',id);
      if(Object.values(state.defaults??{}).includes(id))throw new ModelSettingsError('model_profile_in_use');
      return this.commit({...state,profiles:state.profiles?.filter(p=>p.id!==id)});
    });
  }
  updateDefaults(body:unknown):Promise<ModelSettingsView> {
    return this.serialize(()=>{
      const parsed=z.object({revision:revisionSchema,defaults:defaultsSchema,defaultModels:defaultModelsSchema}).strict().safeParse(body);
      if(!parsed.success)throw new ModelSettingsError('model_settings_invalid');
      this.expectedRevision(parsed.data.revision);
      for(const feature of MODEL_FEATURES)this.select(feature,parsed.data.defaults[feature]);
      const state=this.requireState();
      const defaultModels=parsed.data.defaultModels;
      return this.commit({profiles:state.profiles,defaults:parsed.data.defaults,defaultModels});
    });
  }

  test(body: unknown, profileId=DEFAULT_MODEL_PROFILE_ID): Promise<ModelTestResult> {
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
