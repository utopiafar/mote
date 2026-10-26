import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {createMemoryTopicsUi} from '../src/memory-topics-ui';
import type {DesktopApi,Status} from '../src/contracts';
const id='11111111-1111-4111-8111-111111111111';
let dom:JSDOM,root:HTMLDialogElement,api:DesktopApi,ui:ReturnType<typeof createMemoryTopicsUi>;
const flush=()=>new Promise<void>(r=>setImmediate(r));
beforeEach(()=>{dom=new JSDOM('<dialog></dialog>');vi.stubGlobal('document',dom.window.document);root=document.querySelector('dialog')!;root.showModal=()=>{root.open=true;};root.close=()=>{root.open=false;};api={memoryTopics:vi.fn(async()=>({items:[{id:'auto.one',label:'One',nodes:[{id:'a',label:'<img src=x onerror=alert(1)>'}]}]})),memoryTopicPage:vi.fn(async()=>({items:[{id,title:'Memory',status:'published'}],nextCursor:null})),memoryTopicDetail:vi.fn(async()=>({id,title:'Memory',status:'published',statement:'GENERATED BODY',evidenceIds:[]}))} as unknown as DesktopApi;ui=createMemoryTopicsUi(api,root);});
afterEach(()=>{ui.close();dom.window.close();vi.unstubAllGlobals();});
function click(label:string){[...root.querySelectorAll('button')].find(b=>b.textContent===label)!.click();}
it('renders model labels as text, opens one stable Memory and returns to its selected node',async()=>{
 ui.open();await flush();expect(root.querySelector('img')).toBeNull();(root.querySelector('[data-topic]') as HTMLElement).click();await flush();(root.querySelector('[data-memory]') as HTMLElement).click();await flush();expect(api.memoryTopicDetail).toHaveBeenCalledWith(id);expect(root.textContent).toContain('GENERATED BODY');click('返回');await flush();expect(api.memoryTopicPage).toHaveBeenLastCalledWith({treeId:'auto.one',nodeId:'a',cursor:undefined});
});
it('clears an open body on connection epoch change and rejects its late pending response',async()=>{
 const status={authorizationGeneration:1,config:{serverUrl:'http://generated',tokenConfigured:true}} as Status;ui.update(status);ui.open();await flush();let resolve!:(value:unknown)=>void;vi.mocked(api.memoryTopicDetail).mockImplementation(()=>new Promise(r=>{resolve=r;}) as never);(root.querySelector('[data-memory]') as HTMLElement).click();await flush();ui.update({...status,authorizationGeneration:2});resolve({id,title:'LATE BODY',status:'published'});await flush();expect(root.open).toBe(false);expect(root.textContent).toBe('');
});
