import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import type {OwnerRelation,AttributionContext} from '@mote/shared';
export type {OwnerRelation,AttributionContext} from '@mote/shared';
export const relationLabel=(value:OwnerRelation)=>({owner:moteText('我的表达或经历'),third_party:moteText('第三方内容'),mixed:moteText('混合内容'),unknown:moteText('归属未知')})[value];
export function AttributionSummary({context}:{context?:AttributionContext}){
 if(!context)return null;
 const basis={owner_material:moteText('你对这份资料的声明'),owner_source:moteText('你对来源的声明'),connector:moteText('来源提供的上下文'),default:moteText('尚无归属声明')};
 return <dl><dt>{moteText('内容与我的关系')}</dt><dd>{relationLabel(context.ownerRelation)}</dd><dt>{moteText('归属依据')}</dt><dd>{basis[context.basis]}</dd>{context.sourceDeclaration&&<><dt>{moteText('来源声明')}</dt><dd>{context.sourceDeclaration.ownerRelation===null?moteText('不声明'):relationLabel(context.sourceDeclaration.ownerRelation)} · {moteText('版本 {0}',context.sourceDeclaration.version)}</dd></>}{context.correction&&<><dt>{moteText('资料声明版本')}</dt><dd>{context.correction.version}</dd></>}</dl>;
}
/** These declarations inform interpretation; they never gate archive reads or extraction. */
export function AttributionEditor({api,path,revision,value,onSaved,source=false}:{api:Api;path:string;revision?:string;value?:OwnerRelation|null;onSaved:(result:any)=>void;source?:boolean}){
 const [choice,setChoice]=useState<OwnerRelation|''>(value??''),[busy,setBusy]=useState(false),[error,setError]=useState(''),controller=useRef<AbortController|null>(null);
 useEffect(()=>{setChoice(value??'');setError('');setBusy(false);return()=>controller.current?.abort();},[api,path,revision,value]);
 async function save(){if(busy)return;const request=new AbortController();controller.current=request;setBusy(true);setError('');try{const result=await api.request(path,{method:'PATCH',signal:request.signal,body:JSON.stringify({ownerRelation:choice||null,...(revision?{expectedRevision:revision}:{})})});if(!request.signal.aborted)onSaved(result);}catch(error){if(!request.signal.aborted)setError(errorMessage(error));}finally{if(!request.signal.aborted)setBusy(false);}}
 return <section className="source-item"><h3>{moteText(source?'来源内容归属（可选）':'纠正内容归属（可选）')}</h3><p className="muted">{moteText('声明帮助模型区分你的表达、第三方内容和混合引用；归属未知也能查询和整理。')}</p>{source&&<p className="muted">{moteText('来源声明应用于已有和新资料；单份资料的声明优先。')}</p>}<label>{moteText('内容与我的关系')}<select aria-label={moteText('内容与我的关系')} value={choice} disabled={busy} onChange={event=>setChoice(event.target.value as OwnerRelation|'')}><option value="">{moteText(source?'不声明':'跟随来源')}</option>{(['owner','third_party','mixed','unknown'] as const).map(relation=><option key={relation} value={relation}>{relationLabel(relation)}</option>)}</select></label><button className="button" disabled={busy||choice===(value??'')} onClick={()=>void save()}>{busy?moteText('正在保存…'):moteText('保存归属声明')}</button>{error&&<p role="alert">{error}</p>}</section>;
}
