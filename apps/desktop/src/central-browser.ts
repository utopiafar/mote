import { validateServerUrl } from './config';
import { deepLinkHash, formatEvidenceRef, parseEvidenceRef } from '@mote/shared';

export function validateCentralWorkId(value:unknown):string{
  if(typeof value!=='string'||!value.trim()||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw Error('Invalid work reference');
  return value;
}

/** Only short-lived login exchanges may enter a URL; bearer credentials never do. */
export async function openCentralBrowser(serverUrl: string, page: string | undefined, platform: string,
  launchChrome: (url: string) => Promise<unknown>, openDefault: (url: string) => Promise<unknown>, evidenceId?: string, loginTicket?: string, loginRequestId?:string,workId?:string,conversationId?:string): Promise<void> {
  const origin = validateServerUrl(serverUrl);
  let hash = page==='library'?'#/library':page==='models'?'#/system/models':page==='plugins'?'#/system/plugins':page==='sources'?'#/connections':page==='actions'?'#/actions':page === 'lark' ? '#/connections/lark' : ['ask', 'notes', 'vault'].includes(page ?? '') ? '#' + page : ['overview', 'about', 'guide', 'activity'].includes(page ?? '') ? '#/' + page : '';
  if(conversationId!==undefined&&(page!=='ask'||workId!==undefined||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationId)))throw Error('Invalid conversation destination');
  if(workId!==undefined){if(page!=='activity'||evidenceId!==undefined)throw Error('Invalid work destination');hash=deepLinkHash({kind:'run',id:validateCentralWorkId(workId)});}
  if (evidenceId !== undefined) {
    if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 4096 || /[\u0000-\u001f\u007f]/.test(evidenceId)) throw new Error('Invalid evidence reference');
    const bare=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidenceId);
    const parsed = bare?undefined:parseEvidenceRef(evidenceId);
    const material=/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/.test(evidenceId);
    if(!material&&!bare&&(!parsed||parsed.kind!=='capture'))throw Error('Invalid evidence reference');
    const reference = material?evidenceId:formatEvidenceRef('capture',bare?evidenceId:parsed!.id);
    // The reference is query data, never a destination URL or credential.
    hash = deepLinkHash({kind:'reference',ref:reference,conversation:conversationId});
  } else if(conversationId) hash=deepLinkHash({kind:'conversation',id:conversationId});
  if(loginTicket||loginRequestId){
    const [route,query='']=hash.split('?');const params=new URLSearchParams(query);
    if(loginTicket)params.set('loginTicket',loginTicket);if(loginRequestId)params.set('loginRequest',loginRequestId);
    hash=(route||'#/ask')+'?'+params;
  }
  const url = origin + '/' + hash;
  if (platform === 'darwin') {
    try { await launchChrome(url); return; } catch { /* Chrome may not be installed. */ }
  }
  await openDefault(url);
}
