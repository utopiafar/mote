import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {defaultConfig} from '../src/config';
import type {DesktopApi,Status} from '../src/contracts';

const loader=vi.hoisted(()=>({load:vi.fn()}));
let dom:JSDOM,api:DesktopApi,state:Status,receiveStatus:(value:Status)=>void;
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const navigate=(page:string)=>document.querySelector<HTMLButtonElement>(`[data-nav="${page}"]:not([data-presentation-nav])`)!.click();
const input=(id:string,value:string)=>{const field=el<HTMLInputElement>(id);field.value=value;field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};

beforeEach(async()=>{
 vi.doUnmock('@mote/shared/ui-builtins');vi.resetModules();loader.load.mockReset();loader.load.mockImplementation(()=>vi.importActual('@mote/shared/ui-builtins'));vi.doMock('@mote/shared/ui-builtins',()=>loader.load());
 dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'),{url:'https://generated.invalid',pretendToBeVisual:true});
 for(const key of ['window','document','location','localStorage','sessionStorage','HTMLElement','HTMLDialogElement','HTMLDetailsElement','HTMLInputElement','HTMLSelectElement','HTMLTextAreaElement','HTMLFormElement','HTMLButtonElement','Element','Node','Option','Event','CustomEvent','AbortController','AbortSignal','getComputedStyle'])vi.stubGlobal(key,(dom.window as any)[key]);
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 dom.window.scrollTo=vi.fn();dom.window.HTMLElement.prototype.scrollIntoView=vi.fn();dom.window.confirm=vi.fn(()=>true);dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 state={authorizationGeneration:1,running:false,state:'stopped',message:'Generated stopped collector',queueDepth:0,queueRecords:0,queueBytes:0,screenPermission:'granted',platform:'macos',encryptedTokenStorage:false,sync:{state:'idle',mode:'manual',message:'Generated idle transport',pendingRecords:0},config:{...defaultConfig(),serverUrl:'http://127.0.0.1:1',tokenConfigured:true,authSourceBinding:'generated-owner-binding',uiPageRules:[]}};
 const methods={initialAppearance:{preference:'light',scheme:'light'},onAppearance:()=>()=>{},onNavigate:()=>()=>{},onStatus:(receive:typeof receiveStatus)=>{receiveStatus=receive;return()=>{};},status:vi.fn(async()=>state),configure:vi.fn(async()=>state),sources:vi.fn(async()=>[]),installedApplications:vi.fn(async()=>[])};
 api=new Proxy(methods,{get(target,key){return key in target?target[key as keyof typeof methods]:()=>new Promise(()=>{});}}) as unknown as DesktopApi;
 dom.window.mote=api;
 const {configureLocale}=await import('@mote/shared/i18n');configureLocale(()=>'zh-CN');
 const {mountSettingsWorkspace}=await import('../src/settings-workspace'),{mountCaptureWorkspace}=await import('../src/capture-workspace');mountSettingsWorkspace();mountCaptureWorkspace();
 await import('../src/ui');await flush();
 expect(el<HTMLFieldSetElement>('settings-fields').disabled).toBe(false);
 navigate('chrome');expect(document.querySelector<HTMLElement>('[data-page="chrome"]')!.hidden).toBe(false);
});
afterEach(()=>{dom.window.dispatchEvent(new dom.window.Event('beforeunload'));dom.window.close();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

it('loads the real 120-rule subpath only on the actual button click and keeps dirty/discard/save-failure behavior',async()=>{
 expect(loader.load).not.toHaveBeenCalled();expect(el<HTMLTextAreaElement>('ui-page-rules').value).toBe('[]');
 el<HTMLButtonElement>('ui-page-builtins').click();await vi.waitFor(()=>expect(JSON.parse(el<HTMLTextAreaElement>('ui-page-rules').value)).toHaveLength(120));
 expect(loader.load).toHaveBeenCalledTimes(1);const draft=el<HTMLTextAreaElement>('ui-page-rules').value;expect(el('settings-pending').hidden).toBe(false);expect(api.configure).not.toHaveBeenCalled();
 dom.window.confirm=vi.fn(()=>false);el<HTMLButtonElement>('chrome-back').click();expect(document.querySelector<HTMLElement>('[data-page="chrome"]')!.hidden).toBe(false);expect(el<HTMLTextAreaElement>('ui-page-rules').value).toBe(draft);
 dom.window.confirm=vi.fn(()=>true);el<HTMLButtonElement>('chrome-back').click();navigate('chrome');expect(el<HTMLTextAreaElement>('ui-page-rules').value).toBe('[]');
 el<HTMLButtonElement>('ui-page-builtins').click();await vi.waitFor(()=>expect(el<HTMLTextAreaElement>('ui-page-rules').value).toBe(draft));
 vi.mocked(api.configure).mockRejectedValueOnce(Error('Generated settings write failure'));el<HTMLFormElement>('settings').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
 await vi.waitFor(()=>expect(el('feedback').querySelector('.ui-diagnostic')).not.toBeNull());expect(el<HTMLTextAreaElement>('ui-page-rules').value).toBe(draft);expect(state.config.uiPageRules).toEqual([]);expect(el('settings-pending').hidden).toBe(false);
 el<HTMLButtonElement>('settings-reset').click();expect(el<HTMLTextAreaElement>('ui-page-rules').value).toBe('[]');expect(el('settings-pending').hidden).toBe(true);
});

it('keeps the current draft and dirty state when the rule import fails',async()=>{
 loader.load.mockRejectedValueOnce(Error('Generated rule module load failure'));const draft=el<HTMLTextAreaElement>('ui-page-rules').value;
 el<HTMLButtonElement>('ui-page-builtins').click();await vi.waitFor(()=>expect(el('feedback').querySelector('.ui-diagnostic')).not.toBeNull());
 expect(el('feedback').textContent).toContain('操作未完成');expect(el<HTMLTextAreaElement>('ui-page-rules').value).toBe(draft);expect(el('settings-pending').hidden).toBe(true);expect(el<HTMLButtonElement>('ui-page-builtins').disabled).toBe(false);expect(api.configure).not.toHaveBeenCalled();
});

for(const change of ['edit','reset','leave','owner'] as const)it(`discards a late rule import after ${change} without restoring an old draft or feedback`,async()=>{
 let finish!:()=>void;loader.load.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>finish=resolve);return vi.importActual('@mote/shared/ui-builtins');});
 if(change==='reset')input('device-name','Generated unsaved device name');
 el<HTMLButtonElement>('ui-page-builtins').click();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 if(change==='edit'){input('ui-page-rules','[');input('ui-page-rules','[]');}
 else if(change==='reset')el<HTMLButtonElement>('settings-reset').click();
 else if(change==='leave')el<HTMLButtonElement>('chrome-back').click();
 else{state={...state,authorizationGeneration:2,config:{...state.config,serverUrl:'http://127.0.0.1:2',authSourceBinding:'generated-other-owner'}};receiveStatus(state);}
 const feedback=el('feedback').textContent;finish();await flush();await flush();
 expect(el<HTMLTextAreaElement>('ui-page-rules').value).toBe('[]');expect(el('feedback').textContent).toBe(feedback);expect(el('settings-pending').hidden).toBe(change!=='edit');expect(api.configure).not.toHaveBeenCalled();
});
