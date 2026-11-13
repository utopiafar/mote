import {moteText} from '@mote/shared/i18n';
import {sourcePolicySignature,sourceSyncScope,type SourceOptions,type SourceStatus} from './source-types';
import type {Status} from './contracts';

/** Preview the effect of saving local rules, using the same fields as sync. */
export function renderSourceMaintenancePreview(element:HTMLElement,row:SourceStatus|undefined,options:SourceOptions|undefined):void {
  if(!row||row.source.kind!=='local-files'){element.hidden=true;element.textContent='';return;}
  // An invalid draft may still alter the scope; keep the warning visible.
  const changed=!options||sourcePolicySignature(row.source)!==sourcePolicySignature(options);
  element.hidden=!changed;
  element.textContent=changed?moteText('本机当前清单 {0} 项；重新扫描结果可能不同，符合新规则的文件可能再次发送到中央。',row.items):'';
}

/** The existing manual sync also flushes other pending capture records. Preview
 * that complete scope before invoking it, and recheck if the target changed. */
export function createSourceSyncPreview(elements:{panel:HTMLElement;destination:HTMLElement;items:HTMLElement;confirm:HTMLButtonElement;cancel:HTMLButtonElement},getRows:()=>readonly SourceStatus[],getStatus:()=>Status|undefined,start:(scope:string)=>void){
  let selected:string|undefined;
  const snapshot=()=>{
    const rows=getRows().filter(row=>row.source.enabled),status=getStatus();
    const fingerprint=status?sourceSyncScope(rows,status.config):undefined;
    return {rows,status,fingerprint};
  };
  const close=()=>{selected=undefined;elements.panel.hidden=true;elements.items.replaceChildren();elements.destination.textContent='';};
  const open=()=>{
    const value=snapshot();selected=value.fingerprint;elements.confirm.disabled=selected===undefined;elements.items.replaceChildren();
    for(const row of value.rows){
      const item=document.createElement('li');
      item.textContent=[row.source.name,row.source.path,moteText('已清点')+' '+row.items,moteText('待发送')+' '+row.pending,row.source.syncContinuously===false&&row.source.importCompletedAt?moteText('单次导入已保存在本机；不会检查后续修改'):undefined].filter(Boolean).join(' · ');
      elements.items.append(item);
    }
    elements.destination.textContent=moteText('发送到')+'：'+(value.status?.config.serverUrl||moteText('未连接'))+' · '+moteText('待发送')+'：'+(value.status?.sync?.pendingRecords??'—');
    elements.panel.hidden=false;
  };
  elements.cancel.addEventListener('click',close);
  elements.confirm.addEventListener('click',()=>{if(selected===undefined)return;if(snapshot().fingerprint!==selected){open();return;}const scope=selected;close();start(scope);});
  return {open,close,revalidate:()=>{if(selected!==undefined&&snapshot().fingerprint!==selected)close();}};
}
