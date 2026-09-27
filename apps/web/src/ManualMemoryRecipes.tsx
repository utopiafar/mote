import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {memoryRecipeKey,memoryRecipeLabel,type MemoryRecipeRef} from './memory-recipes';

type Choice=MemoryRecipeRef&{available:boolean;requires?:string[]};
export function ManualMemoryRecipes({api,value,onChange,disabled=false}:{api:Api;value:MemoryRecipeRef[];onChange:(value:MemoryRecipeRef[])=>void;disabled?:boolean}){
  const catalog=useResource<{items:Choice[]}>(api,'/api/memory-recipes');
  const choices=new Map((catalog.data?.items??[]).map(choice=>[memoryRecipeKey(choice),choice]));
  for(const ref of value)if(!choices.has(memoryRecipeKey(ref)))choices.set(memoryRecipeKey(ref),{...ref,available:false});
  return <details className="manual-memory-recipes"><summary>{moteText('本次提取方案')} · {value.length?moteText('已选 {0} 项',value.length):moteText('默认提取方式')}</summary>
    <p className="muted">{moteText('选择仅用于本次提取。各方案会等待自己需要的资料，已完成的结果可立即查看；不选择时使用默认提取方式。')}</p>
    {Boolean(catalog.error)&&<p className="error-banner" role="alert">{errorMessage(catalog.error)} <button className="button subtle" type="button" onClick={catalog.refresh}>{moteText('重新读取')}</button></p>}
    {catalog.loading&&!catalog.data&&<p role="status">{moteText('正在读取…')}</p>}
    <fieldset disabled={disabled}><legend>{moteText('选择本次记忆方案')}</legend>
      {[...choices.values()].map(choice=>{const key=memoryRecipeKey(choice),checked=value.some(ref=>memoryRecipeKey(ref)===key);return <label key={key} className="manual-memory-choice"><input type="checkbox" checked={checked} disabled={!checked&&(!choice.available||value.length>=8)} onChange={event=>onChange(event.target.checked?[...value,{id:choice.id,version:choice.version}]:value.filter(ref=>memoryRecipeKey(ref)!==key))}/><span>{memoryRecipeLabel(choice)}{!choice.available&&<small>{moteText('组件暂不可用')}</small>}</span></label>;})}
      {!!value.length&&<button type="button" className="button subtle" onClick={()=>onChange([])}>{moteText('恢复默认提取方式')}</button>}
    </fieldset>
    {value.length>=8&&<p className="muted">{moteText('每次最多选择 8 项方案。')}</p>}
  </details>;
}
