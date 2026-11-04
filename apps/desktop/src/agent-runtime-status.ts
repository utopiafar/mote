import {agentRuntimeStatusReceiptSchema,agentRuntimeReadiness,type AgentRuntimeStatusReceipt,type AgentRuntimeReadiness} from '@mote/shared/agent-runtime-status';
import {httpFailureMessage,responseFailureCode} from '@mote/shared';
import {getLocale,moteText} from '@mote/shared/i18n';
import {MOTE_PROTOCOL_HEADERS} from '@mote/shared/protocol';
import type {Config} from './contracts';
import {validateServerUrl} from './config';
import {ConnectionError} from './connection';

const invalid=()=>new ConnectionError('INVALID_RESPONSE',moteText('中央响应格式无效，请刷新后重试。'));
const LIMIT=512*1024;
async function responseJson(response:Response):Promise<unknown>{
  if(Number(response.headers.get('content-length'))>LIMIT||!response.body){await response.body?.cancel();throw invalid();}
  const chunks:Uint8Array[]=[];let length=0;
  for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){length+=chunk.length;if(length>LIMIT)throw invalid();chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw invalid();}
}
/** Shared agent-runtime status receipt from the configured central node. A
 * malformed, secret- or path-shaped, or bad-revision body fails closed. */
export async function readAgentRuntimeStatus(config:Pick<Config,'serverUrl'|'token'>,fetcher:typeof fetch=fetch):Promise<AgentRuntimeStatusReceipt>{
  let response:Response;
  try{response=await fetcher(validateServerUrl(config.serverUrl)+'/api/agent-runtime-settings',{headers:{...MOTE_PROTOCOL_HEADERS,'Accept-Language':getLocale(),Authorization:'Bearer '+config.token},redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch{throw new ConnectionError('NETWORK',moteText('连接失败或超时；请检查中央地址、HTTPS 证书和网络，不接受重定向'));}
  if(!response.ok){let reason:string|undefined;try{reason=responseFailureCode(await responseJson(response));}catch{}throw new ConnectionError([401,403].includes(response.status)?'AUTH':'HTTP',httpFailureMessage(response.status,reason),response.status,reason);}
  const parsed=agentRuntimeStatusReceiptSchema.safeParse(await responseJson(response));
  if(!parsed.success)throw invalid();
  return parsed.data;
}
export function agentRuntimeReadinessLabel(state:AgentRuntimeReadiness):string{
  return state==='ready'?moteText('已就绪'):state==='restart-pending'?moteText('重启后生效'):state==='unconfigured'?moteText('未配置'):state==='failed'?moteText('失败'):moteText('已关闭');
}
/** One-line central selection + readiness; unknown feature or provider
 * identifiers render verbatim instead of failing the summary. */
export function agentRuntimeStatusSummary(receipt:AgentRuntimeStatusReceipt):string{
  const chat=receipt.features['chat'],name=chat?receipt.saved.profiles.find(profile=>profile.id===chat.profileId)?.name??chat.profileId:moteText('未配置');
  const selection=name+(chat?.model?' · '+chat.model:'');
  return moteText('当前生效值')+'：'+selection+' · '+agentRuntimeReadinessLabel(agentRuntimeReadiness(receipt));
}
