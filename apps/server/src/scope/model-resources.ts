import {z, type ZodType} from 'zod';
import {createHash} from 'node:crypto';
import type {ConfigFieldMetadata} from '@mote/shared';
import {
  DEPLOYMENT_MODEL_PROFILE_ID, MODEL_FEATURES, modelProvider,
  type ModelFeature, type ModelProfile, type ModelSettings,
} from '@mote/shared/models';
import {ConfigService, ConfigServiceError} from '../config-service.js';
import {modelSettingsSchema,registerModelSettingsProvider, type ModelDomain} from '../model-settings.js';
import {moteText} from '../i18n.js';
import {ScopeError} from './baseline.js';

export interface UserModelReference {kind:'shared'|'personal';id:string}
export interface UserModelConfiguration {
  profiles:ModelProfile[];
  selections:Partial<Record<ModelFeature,UserModelReference>>;
}
export interface SharedModelResource {
  id:string;
  name:string;
  provider:string;
  model:string;
  readOnly:true;
}
export type ModelProviderValidator=(settings:Readonly<ModelSettings>)=>void|boolean;

/** Metadata is shared by file and page edits. Register the user domain with an
 * identity resolve function: personal fields must never resolve process.env. */
export const userModelFields:ConfigFieldMetadata[]=[
  {path:'profiles',effect:'next-request'},
  {path:'selections',effect:'next-request'},
  {path:'profiles.*.settings.apiKey',sensitive:true},
  {path:'profiles.*.settings.headers',sensitive:true},
  {path:'profiles.*.settings.extraBody',sensitive:true},
];

const invalid=()=>new ConfigServiceError('config_invalid','models');
const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const reference=z.object({
  kind:z.enum(['shared','personal']),
  id:z.union([identifier,z.literal(DEPLOYMENT_MODEL_PROFILE_ID)]),
}).strict();
const line=z.string().min(1).max(100).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));

function hasEnvironmentReference(value:unknown):boolean {
  if(typeof value==='string')return value.includes('${');
  if(Array.isArray(value))return value.some(hasEnvironmentReference);
  return Boolean(value&&typeof value==='object'&&Object.entries(value).some(([key,child])=>key.includes('${')||hasEnvironmentReference(child)));
}

function configured(settings:ModelSettings):boolean {
  if(!settings.model.trim())return false;
  if(settings.protocol==='codex-app-server')return true;
  if(!settings.baseUrl.trim())return false;
  if(settings.apiKey.trim())return true;
  if(!settings.allowUnauthenticatedLocal)return false;
  try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(settings.baseUrl).hostname);}
  catch{return false;}
}

/** Shared connections remain instance resources. Only this trusted resolver
 * combines their fixed endpoint and credentials; private documents contain refs. */
export class ModelResources {
  private readonly providers=new Map<string,{dispose:()=>void}>();
  private readonly generations=new Map<string,{generation:number;fingerprint:string|undefined}>();
  private readonly stopObserving:()=>void;
  private closed=false;
  constructor(private readonly instance:ConfigService){
    this.stopObserving=instance.onChange(()=>{try{this.reconcile();}catch{/* A failed instance projection cannot disclose callback or configuration values. */}});
  }

  /** Trusted provider plugins extend the existing ModelSettings wire contract.
   * Protocol and transport validation still runs through modelSettingsSchema. */
  registerProvider(id:string,validate?:ModelProviderValidator):()=>void {
    if(this.closed)throw new ConfigServiceError('config_unavailable');
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id)||modelProvider(id)||this.providers.has(id))throw invalid();
    const registration={dispose:registerModelSettingsProvider(id,validate)};
    this.providers.set(id,registration);
    try{this.reconcile();}catch{/* Registration also supports instance bootstrap before initialization. */}
    return ()=>{
      if(this.providers.get(id)!==registration)return;
      this.providers.delete(id);registration.dispose();
      try{this.reconcile();}catch{/* Effective configuration may already be unavailable during teardown. */}
    };
  }

  schema():ZodType<UserModelConfiguration,any,unknown> {
    if(this.closed)throw new ConfigServiceError('config_unavailable');
    const personalSettings=z.unknown().transform((raw,context):ModelSettings=>{
      try {
        if(this.closed||!raw||typeof raw!=='object'||Array.isArray(raw)||hasEnvironmentReference(raw))throw invalid();
        const input=raw as Record<string,unknown>;
        if(input.protocol==='codex-app-server'||typeof input.provider!=='string')throw invalid();
        const builtin=Boolean(modelProvider(input.provider));
        if(!builtin&&!this.providers.has(input.provider))throw invalid();
        return modelSettingsSchema.parse(raw);
      }catch{
        context.addIssue({code:'custom',message:'Invalid personal model configuration'});
        return z.NEVER;
      }
    });
    return z.object({
      profiles:z.array(z.object({
        id:identifier.refine(id=>id!=='default'),name:line,settings:personalSettings,
      }).strict()).max(30).default([]),
      selections:z.object(Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,reference.optional()])) as Record<ModelFeature,ReturnType<typeof reference.optional>>).strict().default({}),
    }).strict().superRefine((configuration,context)=>{
      const ids=new Set(configuration.profiles.map(profile=>profile.id));
      if(ids.size!==configuration.profiles.length||Object.values(configuration.selections).some(selection=>selection?.kind==='personal'&&!ids.has(selection.id))) {
        context.addIssue({code:'custom',message:'Invalid personal model references'});
      }
    });
  }

  private shared():ModelProfile[] {
    const domain=this.instance.current<ModelDomain>('models');
    return [{id:DEPLOYMENT_MODEL_PROFILE_ID,name:moteText("部署配置"),settings:domain.deployment},...domain.profiles]
      .filter(profile=>(modelProvider(profile.settings.provider)||this.providers.has(profile.settings.provider))&&configured(profile.settings));
  }

  private reconcile():ModelProfile[] {
    if(this.closed)throw new ConfigServiceError('config_unavailable');
    const profiles=this.shared(),present=new Set(profiles.map(profile=>profile.id));
    for(const [id,state] of this.generations)if(!present.has(id)&&state.fingerprint!==undefined){
      state.generation++;state.fingerprint=undefined;
    }
    for(const profile of profiles){
      const fingerprint=createHash('sha256').update(JSON.stringify(profile.settings,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)).digest('hex');
      const prior=this.generations.get(profile.id);
      if(!prior)this.generations.set(profile.id,{generation:1,fingerprint});
      else if(prior.fingerprint!==fingerprint){prior.generation++;prior.fingerprint=fingerprint;}
    }
    return profiles;
  }

  /** Monotonic during this host lifetime, including removal and republication of
   * identical settings. A prior lease must never regain authority by equality. */
  generation(id:string):number {
    this.reconcile();return this.generations.get(id)?.generation??0;
  }

  listShared():SharedModelResource[] {
    return this.reconcile().map(({id,name,settings})=>({id,name,provider:settings.provider,model:settings.model,readOnly:true}));
  }

  /** Missing or retired references explicitly fail. There is no implicit
   * deployment/default model and no caller-supplied endpoint or model override. */
  resolve(configuration:UserModelConfiguration,feature:ModelFeature):{reference:UserModelReference;settings:ModelSettings} {
    let parsed:UserModelConfiguration;
    try{parsed=this.schema().parse(configuration);}catch{throw invalid();}
    const selection=Object.hasOwn(parsed.selections,feature)?parsed.selections[feature]:undefined;
    if(!selection)throw new ScopeError('scope_unavailable',503);
    const profiles=selection.kind==='shared'?this.reconcile():parsed.profiles;
    const profile=profiles.find(candidate=>candidate.id===selection.id);
    if(!profile||!configured(profile.settings))throw new ScopeError('scope_unavailable',503);
    return {reference:structuredClone(selection),settings:structuredClone(profile.settings)};
  }

  close():void {
    if(this.closed)return;
    this.closed=true;this.stopObserving();
    for(const registration of this.providers.values())registration.dispose();
    this.providers.clear();
  }
}

/** Portable personal exports retain selection and transport parameters, while
 * requiring credentials to be supplied again after restore. */
export function removeCredentials(configuration:UserModelConfiguration):UserModelConfiguration {
  const copy=structuredClone(configuration);
  for(const profile of copy.profiles){profile.settings.apiKey='';profile.settings.headers={};profile.settings.extraBody={};}
  return copy;
}
