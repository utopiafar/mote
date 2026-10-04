import { persistSession, clearSession } from './session';
import type { Connection } from './api';
const valid = (value:string|null):value is string => !!value&&/^[A-Za-z0-9_-]{43}$/.test(value);
export function loginRequestId():string|undefined{const value=new URLSearchParams(location.hash.split('?')[1]??'').get('loginRequest');return valid(value)?value:undefined;}
export function removeLoginParameter(key:string){const [route,query='']=location.hash.split('?'),params=new URLSearchParams(query);params.delete(key);history.replaceState(null,'',location.pathname+location.search+route+(params.size?'?'+params:''));}
/** Exchange before rendering private UI; failure never restores an unrelated old login. */
export async function consumeLoginTicket(active:()=>boolean=()=>true):Promise<void>{
  const value=new URLSearchParams(location.hash.split('?')[1]??'').get('loginTicket');if(value===null)return;
  removeLoginParameter('loginTicket');clearSession();if(!valid(value))throw Error('Invalid login link');
  const response=await fetch('/api/login/exchange',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({code:value})});
  if(!response.ok)throw Error('Login link expired');const result=await response.json() as Connection;
  if(typeof result.token!=='string'||result.token.length<32)throw Error('Invalid login response');
  if(!active())throw Error('Login changed');
  persistSession({...result,serverExpiresAt:result.expiresAt},result.expiresAt?'30d':'session');
}
