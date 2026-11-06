/** Local, bounded diagnostics. Only fixed enums and numeric metadata cross this boundary. */
import {persistBrowserLog} from './browser-log-store';
const events = ['api.request_started','api.request_completed','api.request_failed','api.request_rejected','api.response_invalid','auth.session_started','auth.session_cleared','auth.session_rejected','ui.unhandled_error','ui.unhandled_rejection'] as const;
const routes = ['login','connections','configuration','status','captures','files','sources','devices','activity','query','insights','memories','plugins','models','other'] as const;
const methods = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'] as const;
const errorNames = ['Error','TypeError','RangeError','SyntaxError','DOMException','AbortError','TimeoutError','ApiError','OtherError'] as const;
const codes = ['unauthorized','connection_revoked','forbidden','invalid_response','invalid_request','not_found','conflict','rate_limited','provider_unavailable','model_unavailable','internal_error','request_timeout','provider_quota','provider_authentication','provider_configuration','provider_timeout','provider_failed','model_not_configured','request_path_too_long','validation'] as const;
export type LogLevel = 'debug'|'info'|'warn'|'error'|'off';
type EventName = typeof events[number];
type Fields = {method?:string;route?:string;errorName?:string;code?:string;status?:number;elapsedMs?:number;requestId?:string};
export type LogEntry = Fields & {atMs:number;level:Exclude<LogLevel,'off'>;event:EventName};
const priorities:Record<LogLevel,number> = {debug:0,info:1,warn:2,error:3,off:4};
const history:LogEntry[]=[];
let level:LogLevel='warn';
export type BrowserLogPolicy={enabled:boolean;level:Exclude<LogLevel,'off'>};
const preferenceKey='mote-browser-log-settings';
let browserPolicy:BrowserLogPolicy={enabled:true,level:'info'};
export function initializeBrowserLogging(profile?:string) {
  const defaults:BrowserLogPolicy={enabled:true,level:profile==='dev'?'debug':'info'};
  try {
    const stored=localStorage.getItem(preferenceKey);
    if(stored){const value=JSON.parse(stored) as BrowserLogPolicy;if(typeof value.enabled==='boolean'&&['debug','info','warn','error'].includes(value.level))browserPolicy=value;else browserPolicy=defaults;}
    else browserPolicy=defaults;
  } catch {browserPolicy={...defaults,enabled:false};}
  setLogLevel(browserPolicy.enabled?browserPolicy.level:'off');
  return {...browserPolicy};
}
export function readBrowserLogPolicy(){return {...browserPolicy};}
export function saveBrowserLogPolicy(value:BrowserLogPolicy){
  if(typeof value.enabled!=='boolean'||!['debug','info','warn','error'].includes(value.level))throw Error('Invalid log settings');
  localStorage.setItem(preferenceKey,JSON.stringify(value));browserPolicy={...value};setLogLevel(value.enabled?value.level:'off');return readBrowserLogPolicy();
}
export const logCapacity=200;
export function setLogLevel(value:LogLevel) { if(Object.hasOwn(priorities,value))level=value; }
export function clearLogs() { history.length=0; }
export function readLogs():LogEntry[] { return history.map(entry=>({...entry})); }
export function safeErrorName(error:unknown):string|undefined {
  if(!error || typeof error!=='object')return;
  try { const name=(error as {name?:unknown}).name; return typeof name==='string'&&(errorNames as readonly string[]).includes(name)?name:'OtherError'; }
  catch { return 'OtherError'; }
}
export function routeCategory(path:string):typeof routes[number] {
  const root=path.split(/[/?#]/)[2];
  return (routes as readonly string[]).includes(root)?root as typeof routes[number]:'other';
}
export function log(event:EventName,severity:Exclude<LogLevel,'off'>,fields:Fields={}) {
  if(!(events as readonly string[]).includes(event)||!['debug','info','warn','error'].includes(severity)||priorities[severity]<priorities[level])return;
  const entry:LogEntry={atMs:Date.now(),level:severity,event};
  if(fields.method&&(methods as readonly string[]).includes(fields.method))entry.method=fields.method;
  if(fields.route&&(routes as readonly string[]).includes(fields.route))entry.route=fields.route;
  if(fields.errorName&&(errorNames as readonly string[]).includes(fields.errorName))entry.errorName=fields.errorName;
  if(fields.code&&(codes as readonly string[]).includes(fields.code))entry.code=fields.code;
  if(Number.isInteger(fields.status)&&fields.status!>=100&&fields.status!<=599)entry.status=fields.status;
  if(typeof fields.elapsedMs==='number'&&Number.isFinite(fields.elapsedMs)&&fields.elapsedMs>=0&&fields.elapsedMs<=Number.MAX_SAFE_INTEGER)entry.elapsedMs=Math.round(fields.elapsedMs);
  if(fields.requestId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fields.requestId))entry.requestId=fields.requestId;
  history.push(entry);if(history.length>logCapacity)history.shift();
  persistBrowserLog(entry);
  // Logging cannot change API or UI outcomes, including when a console is unavailable.
  try { console[severity]('[mote]',{...entry}); } catch { /* local diagnostics only */ }
}
export function installGlobalErrorLogging(target:EventTarget):()=>void {
  const error=(event:Event)=>log('ui.unhandled_error','error',{errorName:safeErrorName((event as ErrorEvent).error)});
  const rejection=(event:Event)=>log('ui.unhandled_rejection','error',{errorName:safeErrorName((event as PromiseRejectionEvent).reason)});
  target.addEventListener('error',error);target.addEventListener('unhandledrejection',rejection);
  return ()=>{target.removeEventListener('error',error);target.removeEventListener('unhandledrejection',rejection);};
}
