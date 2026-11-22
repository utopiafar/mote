import { persistSession, clearSession } from './session';
import type { Connection } from './api';
const valid = (value:string|null):value is string => !!value&&/^[A-Za-z0-9_-]{43}$/.test(value);
export function loginRequestId():string|undefined{const value=new URLSearchParams(location.hash.split('?')[1]??'').get('loginRequest');return valid(value)?value:undefined;}
export function removeLoginParameter(key:string){const [route,query='']=location.hash.split('?'),params=new URLSearchParams(query);params.delete(key);history.replaceState(null,'',location.pathname+location.search+route+(params.size?'?'+params:''));}

// Keep the marker and request channel in sync with the Desktop main window.
const desktopLoginParameter = 'desktopLogin';
async function takeDesktopLoginTicket(): Promise<string | null> {
  const { port1, port2 } = new MessageChannel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise(resolve => {
      timer = setTimeout(() => resolve(null), 15000);
      port1.onmessage = ({ data }) => resolve(typeof data === 'string' ? data : null);
      window.postMessage('mote:central:login-ticket', location.origin, [port2]);
    });
  } finally {
    clearTimeout(timer);
    port1.close();
    const url = new URL(location.href);
    const [route, query = ''] = url.hash.split('?');
    const params = new URLSearchParams(query);
    params.delete(desktopLoginParameter);
    url.hash = route + (params.size ? '?' + params : '');
    url.searchParams.delete(desktopLoginParameter);
    history.replaceState(history.state, '', url);
  }
}

/** Exchange before rendering private UI; failure never restores an unrelated old login. */
export async function consumeLoginTicket(active:()=>boolean=()=>true):Promise<void>{
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let value = params.get('loginTicket');
  if (value !== null) {
    removeLoginParameter('loginTicket');
    clearSession();
  } else {
    if (typeof window === 'undefined' || !window.moteDesktop || !params.has(desktopLoginParameter)) return;
    clearSession();
    value = await takeDesktopLoginTicket();
  }
  if (!valid(value)) throw Error('Invalid login link');
  const response=await fetch('/api/login/exchange',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({code:value})});
  if(!response.ok)throw Error('Login link expired');const result=await response.json() as Connection;
  if(typeof result.token!=='string'||result.token.length<32)throw Error('Invalid login response');
  if(!active())throw Error('Login changed');
  persistSession({...result,serverExpiresAt:result.expiresAt},result.expiresAt?'30d':'session');
}
