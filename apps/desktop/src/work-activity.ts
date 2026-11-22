import type { WorkActivityQuery } from './contracts/content';
export type { WorkActivityQuery } from './contracts/content';
import type {WorkActivityPage} from '@mote/shared';
import {getLocale,moteText} from '@mote/shared/i18n';
import type {Config} from './contracts';
import {validateServerUrl} from './config';
import {requireConnectionToken} from './login-session';
import {readResponseText} from './response-body';

/** A fixed, bounded owner read. The main-process connection fence rejects stale results. */
export async function centralWorkActivity(config:Config,input:WorkActivityQuery={}):Promise<WorkActivityPage>{
  if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['state','cursor'].includes(key))||input.state!==undefined&&!['active','attention','completed'].includes(input.state)||input.cursor!==undefined&&(!Number.isSafeInteger(input.cursor)||input.cursor<0))throw Error('Invalid work activity query');
  const query=new URLSearchParams({state:input.state??'active',limit:'10',...(input.cursor!==undefined?{cursor:String(input.cursor)}:{})});
  const response=await fetch(validateServerUrl(config.serverUrl)+'/api/work-activity?'+query,{headers:{Authorization:`Bearer ${requireConnectionToken(config)}`,'Accept-Language':getLocale()},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();throw Error(response.status===401||response.status===403?moteText('令牌无效或已失效，请检查后重新登录。'):moteText('读取活动失败，重试。'));}
  const result=JSON.parse(await readResponseText(response,2*1024*1024)) as WorkActivityPage;
  if(!Array.isArray(result.items)||result.items.length>10||result.items.some(row=>!row||typeof row.id!=='string'||typeof row.goal!=='string'||typeof row.updatedAt!=='string'||!['waiting','running','needs_input','completed','failed','cancelled','stale','excluded'].includes(row.state)||!row.progress||!['determinate','semantic'].includes(row.progress.mode)||!Array.isArray(row.artifacts))||result.nextCursor!==null&&(!Number.isSafeInteger(result.nextCursor)||result.nextCursor<0))throw Error('Invalid work activity response');
  return result;
}
