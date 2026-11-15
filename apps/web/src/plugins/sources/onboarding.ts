import {queryScopeSchema,type FileCoverage,type QueryScope} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';

export type CoverageCounts={completed:number;total:number;partial?:number;pending?:number;failed?:number;unsupported?:number;reason?:string};
export type OnboardingItem={material:{ref:string;title:string;sourceId:string};state:'completed'|'cancelled'|'failed'|'pending';
 coverage:{sync:FileCoverage;extraction:FileCoverage;semantic:FileCoverage};reason?:string;
 memory?:{id:string;status:string;completedBatches:number;totalBatches:number}};
export type OnboardingView={id:string;revision:number;state:'cancelled'|'empty'|'completed'|'failed'|'pending';
 coverage:{sync:CoverageCounts;extraction:CoverageCounts;semantic:CoverageCounts};
 completed:number;pending:number;failed:number;cancelled:number;items:OnboardingItem[]};
export type StoredRun={id:string;scope:QueryScope};
export const onboardingCapabilities=['http:POST:/api/assistant/onboarding','http:GET:/api/assistant/onboarding/:id','http:POST:/api/assistant/onboarding/:id/cancel'];

export function readStoredOnboardingRun():StoredRun|undefined{
 if(typeof window==='undefined')return;
 try{const value=JSON.parse(window.localStorage.getItem(storageKey())??'null') as {id?:unknown;scope?:unknown}|null;
  if(!value||typeof value.id!=='string')return;
  const scope=queryScopeSchema.safeParse(value.scope);return scope.success?{id:value.id,scope:scope.data}:undefined;
 }catch{return}
}
export function writeStoredOnboardingRun(run:StoredRun|undefined){
 try{if(run)window.localStorage.setItem(storageKey(),JSON.stringify(run));else window.localStorage.removeItem(storageKey());}catch{/* local storage is optional */}
}
function storageKey(){return 'mote.assistant.onboarding.'+window.location.origin;}
export function parseOnboarding(value:unknown):OnboardingView{
 if(!value||typeof value!=='object')throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 const view=value as Partial<OnboardingView>;
 if(typeof view.id!=='string'||!Number.isSafeInteger(view.revision)||!['cancelled','empty','completed','failed','pending'].includes(view.state??'')||!view.coverage||!Array.isArray(view.items))throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 if(!view.coverage.sync||!view.coverage.extraction||!view.coverage.semantic)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 for(const stage of Object.values(view.coverage))if(!Number.isSafeInteger(stage.completed)||!Number.isSafeInteger(stage.total)||stage.completed<0||stage.total<stage.completed)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 if(!view.items.every(item=>item&&typeof item==='object'&&typeof (item as OnboardingItem).material?.ref==='string'&&typeof (item as OnboardingItem).material?.title==='string'&&typeof (item as OnboardingItem).material?.sourceId==='string'&&
  typeof (item as OnboardingItem).coverage?.sync?.status==='string'&&typeof (item as OnboardingItem).coverage?.extraction?.status==='string'&&typeof (item as OnboardingItem).coverage?.semantic?.status==='string'))throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 return view as OnboardingView;
}
