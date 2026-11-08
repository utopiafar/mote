import type {UiRule} from '@mote/shared';
import type {CollectionMode} from './contracts';
import {WECHAT_APP_ID,WECHAT_VERSION} from './wechat-page';

export interface CaptureApplication {appId:string;appName:string;appVersion?:string}
export interface CaptureRuleSummary {
  id:string;version:string;appVersion?:string;kind:string;fields:string[];
  source:'builtin'|'configured'|'browser';
  applicability:'available'|'version_unknown'|'version_mismatch'|'unused';
}
export interface CaptureAppRow extends CaptureApplication {
  installed:boolean;custom:boolean;selection:CollectionMode;rules:CaptureRuleSummary[];
}
export type CaptureAppFilter='all'|'custom'|'rules'|'attention';
export const captureChannelKeys=['duration','screenshots','structured'] as const;

function versionApplicability(required:string|undefined,installed:string|undefined):CaptureRuleSummary['applicability'] {
  return !required?'available':!installed?'version_unknown':required===installed?'available':'version_mismatch';
}
/** Describes the actual collector readers, not the mere presence of an imported rule. */
export function captureRulesForApp(app:CaptureApplication,rules:UiRule[]):CaptureRuleSummary[] {
  const summaries:CaptureRuleSummary[]=[];
  if(app.appId===WECHAT_APP_ID) summaries.push({id:'macos.wechat.message',version:'1',appVersion:WECHAT_VERSION,kind:'message',
    fields:['conversation','conversation_count','text','description','state'],source:'builtin',applicability:versionApplicability(WECHAT_VERSION,app.appVersion)});
  if(app.appId==='com.google.Chrome') summaries.push({id:'browser_dom',version:'1',kind:'visible_window',fields:[],source:'browser',applicability:'available'});
  for(const rule of rules.filter(rule=>rule.platform==='macos'&&rule.appId===app.appId)) {
    const used=app.appId!==WECHAT_APP_ID&&app.appId!=='com.google.Chrome'&&!rule.activity;
    summaries.push({id:rule.id,version:rule.version,appVersion:rule.appVersion,kind:'kind'in rule?rule.kind:'visible_text',
      fields:'fields'in rule?Object.keys(rule.fields):['text'],source:'configured',
      applicability:used?versionApplicability(rule.appVersion,app.appVersion):'unused'});
  }
  return summaries;
}

export function captureAppRows(installed:CaptureApplication[],overrides:Record<string,CollectionMode>,defaults:CollectionMode,rules:UiRule[]):CaptureAppRow[] {
  const applications=new Map(installed.map(app=>[app.appId,app]));
  const installedIds=new Set(applications.keys());
  for(const id of [...Object.keys(overrides),...rules.filter(rule=>rule.platform==='macos').map(rule=>rule.appId)])
    if(!applications.has(id))applications.set(id,{appId:id,appName:id});
  return [...applications.values()].map(app=>({...app,installed:installedIds.has(app.appId),custom:Object.hasOwn(overrides,app.appId),
    selection:{...(overrides[app.appId]??defaults)},rules:captureRulesForApp(app,rules)}))
    .sort((a,b)=>a.appName.localeCompare(b.appName)||a.appId.localeCompare(b.appId));
}

export function captureAppNeedsAttention(row:CaptureAppRow,screenPermission:string,platform:string,chromeOrigins:string[]):boolean {
  if(!captureChannelKeys.some(key=>row.selection[key]))return false;
  if(platform!=='macos'||!row.installed)return true;
  if(row.selection.screenshots&&screenPermission!=='granted')return true;
  if(!row.selection.structured)return false;
  if(row.appId==='com.google.Chrome')return chromeOrigins.length===0;
  return !row.rules.some(rule=>rule.applicability==='available');
}

export function captureRowsInFilter(rows:CaptureAppRow[],filter:CaptureAppFilter,query:string,screenPermission:string,platform:string,chromeOrigins:string[]):CaptureAppRow[] {
  const search=query.trim().toLocaleLowerCase();
  return rows.filter(row=>(!search||row.appName.toLocaleLowerCase().includes(search)||row.appId.toLocaleLowerCase().includes(search))&&
    (filter==='all'||filter==='custom'&&row.custom||filter==='rules'&&row.rules.length>0||filter==='attention'&&captureAppNeedsAttention(row,screenPermission,platform,chromeOrigins)));
}
