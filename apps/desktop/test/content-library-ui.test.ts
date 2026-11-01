import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createContentLibraryUi} from '../src/content-library-ui';
import {createWorkbenchUi} from '../src/workbench-ui';
import {centralContentPage,type CentralContentPage,type ContentDetail,type ContentItem} from '../src/content-library';
import {defaultConfig} from '../src/config';
import type {DesktopApi,Status} from '../src/contracts';
import type {SyncContent} from '../src/sync-content';

vi.mock('../src/background',()=>({previewWork:{run:vi.fn()},sourceWork:{run:vi.fn()}}));
const id='11111111-1111-4111-8111-111111111111';
const item:ContentItem={key:`capture:${id}`,source:'note',title:'Generated note',observedAt:'2026-10-11T00:00:00Z',preview:'Generated preview'};
const remote:SyncContent={item:{key:id,source:'note',title:item.title,observedAt:item.observedAt,outcome:'received',firstReceipt:false},location:'central',captureId:id,text:'GENERATED PRIVATE BODY',metadata:'GENERATED PRIVATE METADATA',image:'data:image/jpeg;base64,Z2VuZXJhdGVk',hasImage:true,readiness:'ready'};
const status={authorizationGeneration:1,queueDepth:0,sync:{pendingRecords:0,state:'manual'},config:{tokenConfigured:true,serverUrl:'http://127.0.0.1:9999',deviceId:id}} as Status;
let dom:JSDOM,library:ReturnType<typeof createContentLibraryUi>,api:DesktopApi,page:CentralContentPage;
let dialog:HTMLDialogElement;
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const el=(id:string)=>document.getElementById(id)!;
beforeEach(()=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'));vi.stubGlobal('document',dom.window.document);
  dialog=el('content-detail-dialog') as HTMLDialogElement;
  dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};
  page={items:[item],total:1};
  api={localContent:vi.fn(async()=>({items:[],total:0})),centralContent:vi.fn(async()=>page),centralContentDetail:vi.fn(async()=>remote),localContentDetail:vi.fn(async()=>({text:'GENERATED LOCAL BODY',metadata:'GENERATED LOCAL METADATA',sourceName:'Generated Mac'}))} as unknown as DesktopApi;
  const workbench=createWorkbenchUi({...api,ask:vi.fn(async()=>({items:[]}))},{question:()=>true,conversation:()=>{}});
  workbench.update({...status,state:'stopped',running:false});
  library=createContentLibraryUi(api,undefined,value=>workbench.setHasContent(value));library.update(status);
});
afterEach(()=>{library.close();dom.window.close();vi.unstubAllGlobals();});
async function open(key=item.key){await flush();(document.querySelector(`[data-content-key="${key}"]`) as HTMLButtonElement).click();await flush();}
function expectCleared(){
  expect(dialog.open).toBe(false);
  for(const id of ['content-detail-title','content-detail-source','content-detail-body','content-detail-metadata'])expect(el(id).textContent).toBe('');
  expect(el('content-detail-image').getAttribute('src')).toBeNull();
}

it('withdraws an old empty claim while a new complete archive read is still pending',async()=>{
  page={items:[],total:0};await library.refresh();
  expect(el('content-feed').textContent).toContain('还没有内容');
  let finish!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=library.refresh();await flush();
  expect(el('content-status').getAttribute('aria-busy')).toBe('true');
  expect(el('content-status').classList.contains('visually-hidden')).toBe(false);
  expect(el('content-status').textContent).toBe('正在读取内容…');
  expect(el('content-feed').textContent).not.toContain('还没有内容');
  finish({items:[],total:0});await pending;
  expect(el('content-status').getAttribute('aria-busy')).toBe('false');
  expect(el('content-feed').textContent).toContain('还没有内容');
});

it.each([401,403])('closes an open central reader on a feed HTTP %s, invalidating a late detail response',async code=>{
  await open();expect(el('content-detail-body').textContent).toBe(remote.text);expect(el('content-detail-image').getAttribute('src')).toBe(remote.image);
  let finish!:(value:SyncContent)=>void;
  vi.mocked(api.centralContentDetail).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  (el('content-detail-refresh') as HTMLButtonElement).click();await flush();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:code})));
  vi.mocked(api.centralContent).mockImplementationOnce(()=>centralContentPage({...defaultConfig(),serverUrl:status.config.serverUrl,token:'generated-token',deviceId:id}));
  await library.refresh();expectCleared();expect(document.querySelectorAll('#content-feed .content-row')).toHaveLength(0);
  finish({...remote,text:'GENERATED LATE PRIVATE BODY'});await flush();expectCleared();expect(el('content-feed').textContent).toBe('');
});

it('keeps an open local reader after the central feed denies access',async()=>{
  const local={...item,key:'queue:22222222-2222-4222-8222-222222222222'};vi.mocked(api.localContent).mockResolvedValue({items:[local],total:1});
  await library.refresh();await open(local.key);
  page={items:[],total:0,authorizationDenied:true};await library.refresh();
  expect(dialog.open).toBe(true);expect(el('content-detail-body').textContent).toBe('GENERATED LOCAL BODY');expect(el('content-detail-metadata').textContent).toBe('GENERATED LOCAL METADATA');
});

it('closes a late central receipt resolved from a local row after feed access was denied',async()=>{
  const local={...item,key:`source:local-${id}:generated-version`};vi.mocked(api.localContent).mockResolvedValue({items:[local],total:1});
  let finish!:(value:ContentDetail|SyncContent)=>void;vi.mocked(api.localContentDetail).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await library.refresh();await open(local.key);page={items:[],total:0,authorizationDenied:true};await library.refresh();
  expect(dialog.open).toBe(true);finish(remote);await flush();expectCleared();
});

it('preserves an open central reader on temporary network or server failure',async()=>{
  await open();vi.mocked(api.centralContent).mockRejectedValueOnce(Error('Generated temporary network failure'));
  await library.refresh();expect(dialog.open).toBe(true);expect(el('content-detail-body').textContent).toBe(remote.text);expect(el('content-detail-image').getAttribute('src')).toBe(remote.image);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:503})));
  await expect(centralContentPage({...defaultConfig(),serverUrl:status.config.serverUrl,token:'generated-token',deviceId:id})).rejects.toThrow();
});

it('clears private DOM and invalidates old requests when a credential changes within the same node',async()=>{
  await open();let finish!:(value:SyncContent)=>void;vi.mocked(api.centralContentDetail).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  (el('content-detail-refresh') as HTMLButtonElement).click();await flush();library.update({...status,authorizationGeneration:2});expectCleared();
  finish(remote);await flush();expectCleared();
});

it('shows the final compact note title and reads the exact original before expandable source status',async()=>{
  const text='Generated first line\nGenerated second line';
  page={items:[{...item,title:'Generated first line',preview:text}],total:1};
  vi.mocked(api.centralContentDetail).mockResolvedValue({...remote,text});
  await library.refresh();
  const button=document.querySelector<HTMLButtonElement>('#content-feed .content-row')!;
  const copy=button.querySelector('.content-row-copy')!;
  expect(copy.querySelector('strong')!.textContent).toBe('Generated first line');expect(copy.textContent).not.toContain('Generated second line');
  button.click();await flush();
  expect(el('content-detail-title').textContent).toBe('Generated first line');
  expect(el('content-detail-body').textContent).toBe(text);
  const processing=el('content-processing') as HTMLDetailsElement;
  expect(processing.open).toBe(false);expect(processing.querySelector('summary')!.textContent!.trim()).not.toBe('');
  expect(el('content-detail-body').compareDocumentPosition(processing)&dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(el('content-detail-status').textContent).not.toBe('');
  processing.open=true;expect(processing.querySelectorAll('li')).toHaveLength(4);
  el('content-detail-close').click();expect(document.activeElement).toBe(button);
});

it('retains the authored title of a non-note source and resets process help for the next reader',async()=>{
  page={items:[{...item,source:'file',title:'Generated authored file name'}],total:1};
  await library.refresh();await open();
  expect(document.querySelector('#content-feed .content-row-copy strong')!.textContent).toBe('Generated authored file name');
  expect(el('content-detail-title').textContent).toBe('Generated authored file name');
  (el('content-processing') as HTMLDetailsElement).open=true;el('content-detail-close').click();await open();
  expect((el('content-processing') as HTMLDetailsElement).open).toBe(false);
});

it('keeps source time separate from the original and omits absent source separators',async()=>{
  page={items:[item],total:1};await library.refresh();await open();
  const time=document.querySelector<HTMLTimeElement>('#content-feed .content-row-copy time')!;
  expect(time.dateTime).toBe(item.observedAt);expect(time.textContent).not.toBe('');
  expect(document.querySelector('#content-feed .content-source-name')!.textContent).not.toBe('');
  expect(el('content-detail-source').textContent).not.toMatch(/^\s*·/);
  expect(el('content-detail-body').textContent).toBe(remote.text);
});

it('renders an owner description separately and clears it when the reader closes',async()=>{
  vi.mocked(api.centralContentDetail).mockResolvedValue({...remote,description:'Generated explanation <script>not executable</script>'});
  await library.refresh();await open();
  expect(el('content-detail-body').textContent).toBe(remote.text);
  expect(el('content-detail-description').textContent).toBe('Generated explanation <script>not executable</script>');
  expect(el('content-detail-description').querySelector('script')).toBeNull();expect(el('content-description-section').hidden).toBe(false);
  el('content-detail-close').click();expect(el('content-detail-description').textContent).toBe('');expect(el('content-description-section').hidden).toBe(true);
});

it('keeps recent content complete without changing the Content workspace filter',async()=>{
  document.querySelector<HTMLElement>('[data-page=overview]')!.hidden=false;
  const local={...item,key:'queue:22222222-2222-4222-8222-222222222222',title:'Generated local note'};
  vi.mocked(api.localContent).mockResolvedValue({items:[local],total:1});
  (el('content-scope') as HTMLSelectElement).value='received';
  await library.refresh();await flush();
  expect(document.querySelectorAll('#content-feed .content-row')).toHaveLength(1);
  expect(document.querySelectorAll('#home-recent .content-row')).toHaveLength(2);
  expect((el('content-scope') as HTMLSelectElement).value).toBe('received');
  let finish!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=library.refreshHome();await flush();library.update({...status,authorizationGeneration:2,config:{...status.config,tokenConfigured:false}});
  finish(page);await pending;await flush();
  expect(document.querySelector('#home-recent [data-content-key^="capture:"]')).toBeNull();
});

it('does not turn a local read failure into an empty first-use screen and still clears revoked central rows',async()=>{
  await flush();page={items:[],total:0};vi.mocked(api.localContent).mockRejectedValueOnce(Error('Generated local read failure'));
  await library.refreshHome();
  expect(el('home-recent').textContent).toContain('内容暂不可完整读取');
  expect(el('home-recent').textContent).not.toContain('还没有本机内容');
  expect(el('home-onboarding').hidden).toBe(true);
  const local={...item,key:'queue:22222222-2222-4222-8222-222222222222'};
  vi.mocked(api.localContent).mockResolvedValue({items:[local],total:1});page={items:[item],total:1};await library.refreshHome();
  vi.mocked(api.localContent).mockRejectedValueOnce(Error('Generated later local read failure'));page={items:[],total:0,authorizationDenied:true};await library.refreshHome();
  expect(el('home-recent').querySelector(`[data-content-key="${local.key}"]`)).not.toBeNull();
  expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();
  expect(el('home-onboarding').hidden).toBe(true);
  el('home-recent').querySelector<HTMLButtonElement>('button.text-button')!.click();await flush();
  expect(el('home-recent').textContent).not.toContain('内容暂不可完整读取');
});


it('keeps search results independent from Home and invalidates a late older query',async()=>{
  await flush();document.querySelector<HTMLElement>('[data-page=overview]')!.hidden=false;const search=el('content-search') as HTMLInputElement;
  let finish!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  search.value='older';const pending=library.refresh();await flush();
  search.value='newer';page={items:[{...item,title:'Newer match'}]};await library.refresh();
  finish({items:[{...item,title:'Stale old query'}]});await pending;await flush();
  expect(document.querySelector('#content-feed .content-row-copy strong')!.textContent).toBe('Newer match');
  expect(api.centralContent).toHaveBeenCalledWith(undefined,'newer');expect(api.localContent).toHaveBeenCalledWith(0,'newer');
  expect(api.centralContent).toHaveBeenCalledWith();expect(api.localContent).toHaveBeenCalledWith(0);
  expect(search.value).toBe('newer');
});
it('retains same-scope rows on temporary reads and never calls unavailable content empty',async()=>{
  const local={...item,key:'queue:22222222-2222-4222-8222-222222222222'};
  vi.mocked(api.localContent).mockResolvedValue({items:[local],total:1});await library.refresh();
  vi.mocked(api.localContent).mockRejectedValueOnce(Error("Error invoking remote method 'mote:local-content': generated private diagnostics"));
  page={items:[],authorizationDenied:true};await library.refresh();
  expect(el('content-feed').querySelector(`[data-content-key="${local.key}"]`)).not.toBeNull();
  expect(el('content-feed').querySelector('[data-content-key^="capture:"]')).toBeNull();
  (el('content-search') as HTMLInputElement).value='unavailable query';vi.mocked(api.localContent).mockRejectedValueOnce(Error('Generated failure'));page={items:[]};await library.refresh();
  expect(el('content-feed').textContent).toBe('');expect(el('content-status').textContent).toContain('内容暂不可完整读取');expect(el('content-status').textContent).not.toContain('generated');
});

it('propagates same-node archive denial to the first-note card before a held original can return',async()=>{
  await flush();page={items:[],total:0};
  api.ask=vi.fn(async()=>({items:[]}));api.noteDraft=vi.fn(async()=>({id,text:'',description:'',mood:'',revision:0}));
  const workbench=createWorkbenchUi(api,{question:()=>true,conversation:()=>{}});
  library=createContentLibraryUi(api,undefined,(has,rows,denied)=>{workbench.setArchiveAuthorizationDenied(denied);workbench.setHasContent(has);workbench.setHomeRows(rows);});
  document.querySelector<HTMLElement>('[data-page=overview]')!.hidden=false;
  library.update(status);workbench.update({...status,state:'stopped',running:false});await flush();
  el('note-action').click();await flush();
  let finish!:(value:ContentDetail)=>void;vi.mocked(api.localContentDetail).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  page={items:[item],total:1};await library.refreshHome();
  page={items:[],total:0,authorizationDenied:true};await library.refreshHome();
  finish(remote);await flush();
  expect(el('home-first-record-preview').textContent).toBe('');expect(el('home-first-record-state').textContent).toBe('中央已收到');
  expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();
});

it('does not let a pre-denial content read reauthorize Home after a newer Home denial',async()=>{
  await flush();const local={...item,key:'queue:22222222-2222-4222-8222-222222222222'};
  vi.mocked(api.localContent).mockResolvedValue({items:[local],total:1});
  let finish!:(value:CentralContentPage)=>void;vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=library.refresh();await flush();page={items:[],total:0,authorizationDenied:true};await library.refreshHome();
  finish({items:[item],total:1});await pending;await flush();
  expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();expect(el('content-feed').querySelector('[data-content-key^="capture:"]')).toBeNull();
  expect(el('home-recent').querySelector(`[data-content-key="${local.key}"]`)).not.toBeNull();
  page={items:[item],total:1};await library.refreshHome();expect(el('home-recent').querySelector(`[data-content-key="${item.key}"]`)).not.toBeNull();
});

it('does not let a pre-denial Home read reauthorize rows after a newer content denial',async()=>{
  await flush();let finish!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const pending=library.refreshHome();await flush();
  page={items:[],total:0,authorizationDenied:true};await library.refresh();finish({items:[item],total:1});await pending;await flush();
  expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();expect(el('content-feed').querySelector('[data-content-key^="capture:"]')).toBeNull();
});

it('does not restore retained central rows when a pre-denial content request fails late',async()=>{
  await flush();await library.refresh();let reject!:(reason:Error)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));const pending=library.refresh();await flush();
  page={items:[],total:0,authorizationDenied:true};await library.refreshHome();reject(Error('Generated delayed transport failure'));await pending;await flush();
  expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();expect(el('content-feed').querySelector('[data-content-key^="capture:"]')).toBeNull();
});

it('reads local and central once for a search while the hidden Home is not refreshed',async()=>{
  await flush();
  const before={local:vi.mocked(api.localContent).mock.calls.length,central:vi.mocked(api.centralContent).mock.calls.length};
  (el('content-search') as HTMLInputElement).value='generated query';await library.refresh();
  expect(vi.mocked(api.localContent).mock.calls.length).toBe(before.local+1);
  expect(vi.mocked(api.centralContent).mock.calls.length).toBe(before.central+1);
  expect(vi.mocked(api.localContent).mock.calls.at(-1)).toEqual([0,'generated query']);
  expect(vi.mocked(api.centralContent).mock.calls.at(-1)).toEqual([undefined,'generated query']);
});

it('defers the Home read while hidden and catches up once the overview is visible again',async()=>{
  await flush();
  (el('content-scope') as HTMLSelectElement).value='local';
  const before={local:vi.mocked(api.localContent).mock.calls.length,central:vi.mocked(api.centralContent).mock.calls.length};
  await library.refresh();
  expect(vi.mocked(api.localContent).mock.calls.length).toBe(before.local+1);
  expect(vi.mocked(api.centralContent).mock.calls.length).toBe(before.central);
  document.querySelector<HTMLElement>('[data-page=overview]')!.hidden=false;
  library.update({...status});await flush();
  expect(vi.mocked(api.localContent).mock.calls.length).toBe(before.local+2);
  expect(vi.mocked(api.centralContent).mock.calls.length).toBe(before.central+1);
});

it('discards a delayed hidden-Home denial that lands after a newer filtered search succeeds',async()=>{
  await flush();
  document.querySelector<HTMLElement>('[data-page=overview]')!.hidden=false;
  let deny!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{deny=resolve;}));
  const home=library.refreshHome();await flush();
  document.querySelector<HTMLElement>('[data-page=overview]')!.hidden=true;
  (el('content-search') as HTMLInputElement).value='generated query';await library.refresh();await flush();
  await open(item.key);expect(dialog.open).toBe(true);
  deny({items:[],total:0,authorizationDenied:true});await home;await flush();
  expect(el('content-feed').querySelector(`[data-content-key="${item.key}"]`)).not.toBeNull();
  expect(dialog.open).toBe(true);expect(el('content-detail-body').textContent).toBe(remote.text);
});

it.each([401,403])('honors delayed Home HTTP %s after a local-only refresh with no newer Central authorization result',async code=>{
  await flush();await library.refreshHome();await open(item.key);
  expect(dialog.open).toBe(true);expect(el('home-recent').querySelector(`[data-content-key="${item.key}"]`)).not.toBeNull();
  let finish!:(value:Response)=>void;
  vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
  vi.mocked(api.centralContent).mockImplementationOnce(()=>centralContentPage({...defaultConfig(),serverUrl:status.config.serverUrl,token:'generated-token',deviceId:id}));
  const home=library.refreshHome();await flush();
  const centralReads=vi.mocked(api.centralContent).mock.calls.length;
  (el('content-scope') as HTMLSelectElement).value='local';await library.refresh();
  expect(api.centralContent).toHaveBeenCalledTimes(centralReads);
  finish(new Response('{}',{status:code}));await home;await flush();
  expectCleared();expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();
  expect(el('content-feed').querySelector('[data-content-key^="capture:"]')).toBeNull();
});

it('observes newer Central success before its held local read so an older Home denial cannot clear it',async()=>{
  await flush();await open(item.key);
  let deny!:(value:CentralContentPage)=>void,finishLocal!:(value:{items:ContentItem[];total:number})=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{deny=resolve;}));const home=library.refreshHome();await flush();
  (el('content-scope') as HTMLSelectElement).value='local';await library.refresh();
  (el('content-scope') as HTMLSelectElement).value='all';(el('content-search') as HTMLInputElement).value='newer';
  vi.mocked(api.localContent).mockImplementationOnce(()=>new Promise(resolve=>{finishLocal=resolve;}));
  vi.mocked(api.centralContent).mockResolvedValueOnce({items:[{...item,title:'Generated newer successful match'}]});const search=library.refresh();await flush();
  deny({items:[],authorizationDenied:true});await home;expect(dialog.open).toBe(true);
  finishLocal({items:[],total:0});await search;await flush();
  expect(el('content-feed').textContent).toContain('Generated newer successful match');expect(dialog.open).toBe(true);
});

it('keeps a newer successful Home snapshot when the older unfiltered Content request denies access',async()=>{
  await flush();let finish!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const content=library.refresh();await flush();
  page={items:[{...item,title:'Generated newer Home row'}]};await library.refreshHome();
  finish({items:[],authorizationDenied:true});await content;await flush();
  expect(el('home-recent').textContent).toContain('Generated newer Home row');expect(el('home-onboarding').hidden).toBe(true);
  expect(el('content-status').textContent).toContain('内容暂不可完整读取');
});

it.each(['central','local-receipt'])('keeps a newer successful %s reader when a superseded list denial arrives',async kind=>{
  await flush();let deny!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{deny=resolve;}));const home=library.refreshHome();await flush();
  (el('content-scope') as HTMLSelectElement).value='local';await library.refresh();
  if(kind==='local-receipt')vi.mocked(api.localContentDetail).mockResolvedValueOnce(remote);
  library.open({...item,key:kind==='central'?item.key:'queue:22222222-2222-4222-8222-222222222222'});await flush();
  expect(dialog.open).toBe(true);expect(el('content-detail-body').textContent).toBe(remote.text);
  deny({items:[],authorizationDenied:true});await home;await flush();
  expect(dialog.open).toBe(true);expect(el('content-detail-body').textContent).toBe(remote.text);
});

it('confirms an apparently older denial after a newer reader success and honors current remote revocation',async()=>{
  await flush();let deny!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{deny=resolve;}));const home=library.refreshHome();await flush();
  (el('content-scope') as HTMLSelectElement).value='local';await library.refresh();library.open(item);await flush();
  expect(dialog.open).toBe(true);
  vi.mocked(api.centralContent).mockResolvedValueOnce({items:[],authorizationDenied:true});
  const reads=vi.mocked(api.centralContent).mock.calls.length;deny({items:[],authorizationDenied:true});await home;await flush();
  expect(api.centralContent).toHaveBeenCalledTimes(reads+1);expectCleared();
  expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();
});

it('withdraws private rows when confirmation of an ambiguous denial fails',async()=>{
  await flush();let deny!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{deny=resolve;}));const home=library.refreshHome();await flush();
  (el('content-scope') as HTMLSelectElement).value='local';await library.refresh();library.open(item);await flush();
  vi.mocked(api.centralContent).mockRejectedValueOnce(Error('Generated confirmation transport failure'));
  deny({items:[],authorizationDenied:true});await home;await flush();expectCleared();
  expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();expect(el('home-onboarding').hidden).toBe(true);
});

it('does not apply an old node confirmation denial after a new node reader succeeds',async()=>{
  await flush();let deny!:(value:CentralContentPage)=>void,confirm!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{deny=resolve;}));const home=library.refreshHome();await flush();
  (el('content-scope') as HTMLSelectElement).value='local';await library.refresh();library.open(item);await flush();
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{confirm=resolve;}));deny({items:[],authorizationDenied:true});await home;await flush();
  library.update({...status,authorizationGeneration:2,config:{...status.config,serverUrl:'http://127.0.0.1:9998'}});await flush();
  library.open({...item,title:'Generated new node reader'});await flush();confirm({items:[],authorizationDenied:true});await flush();
  expect(dialog.open).toBe(true);expect(el('content-detail-title').textContent).toBe('Generated new node reader');expect(el('content-detail-body').textContent).toBe(remote.text);
});

it('checks again when a second delayed denial arrives after the in-flight confirmation was authorized',async()=>{
  await flush();let denyHome!:(value:CentralContentPage)=>void,denyContent!:(value:CentralContentPage)=>void,confirm!:(value:CentralContentPage)=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{denyHome=resolve;}));const home=library.refreshHome();await flush();
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{denyContent=resolve;}));const content=library.refresh();await flush();
  (el('content-scope') as HTMLSelectElement).value='local';await library.refresh();library.open(item);await flush();expect(dialog.open).toBe(true);
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{confirm=resolve;}));denyHome({items:[],authorizationDenied:true});await home;await flush();
  const reads=vi.mocked(api.centralContent).mock.calls.length;denyContent({items:[],authorizationDenied:true});await content;await flush();expect(api.centralContent).toHaveBeenCalledTimes(reads);
  vi.mocked(api.centralContent).mockResolvedValueOnce({items:[],authorizationDenied:true});confirm({items:[item]});await flush();
  expect(api.centralContent).toHaveBeenCalledTimes(reads+1);expectCleared();
});

it('shows a confirmed denial and hides obsolete Central pagination while preserving local rows',async()=>{
  await flush();const local={...item,key:'queue:22222222-2222-4222-8222-222222222222',title:'Generated safe local row'};
  vi.mocked(api.localContent).mockResolvedValue({items:[local],total:1});
  let deny!:(value:CentralContentPage)=>void;vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{deny=resolve;}));const home=library.refreshHome();await flush();
  (el('content-search') as HTMLInputElement).value='newer';vi.mocked(api.centralContent).mockResolvedValueOnce({items:[item],nextCursor:'generated-obsolete-next'});await library.refresh();
  library.open(item);await flush();expect(el('content-more').hidden).toBe(false);
  vi.mocked(api.centralContent).mockResolvedValueOnce({items:[],authorizationDenied:true});deny({items:[],authorizationDenied:true});await home;await flush();
  expectCleared();expect(el('content-status').textContent).toContain('无法访问采集记录');expect(el('content-status').classList.contains('visually-hidden')).toBe(false);
  expect(el('content-more').hidden).toBe(true);expect(el('content-feed').querySelector(`[data-content-key="${local.key}"]`)).not.toBeNull();
});

it.each(['all','search'])('marks an invalidated successful %s page incomplete after a Home denial whose local read is held',async scope=>{
  await flush();let finish!:(value:CentralContentPage)=>void,finishLocal!:(value:{items:ContentItem[];total:number})=>void;
  if(scope==='search')(el('content-search') as HTMLInputElement).value='generated';
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const content=library.refresh();await flush();
  vi.mocked(api.localContent).mockImplementationOnce(()=>new Promise(resolve=>{finishLocal=resolve;}));
  vi.mocked(api.centralContent).mockResolvedValueOnce({items:[],authorizationDenied:true});const home=library.refreshHome();await flush();
  finish({items:[item]});await content;await flush();
  expect(el('content-status').textContent).toContain('无法访问采集记录');expect(el('content-feed').textContent).not.toContain('没有符合');
  expect(el('home-onboarding').hidden).toBe(true);
  finishLocal({items:[],total:0});await home;await flush();expect(el('home-onboarding').hidden).toBe(true);
  expect(el('home-recent').textContent).toContain('内容暂不可完整读取');
});

it('does not call a held Home read complete when its successful Central page was invalidated by confirmed revocation',async()=>{
  await flush();let deny!:(value:CentralContentPage)=>void,finishLocal!:(value:{items:ContentItem[];total:number})=>void;
  vi.mocked(api.centralContent).mockImplementationOnce(()=>new Promise(resolve=>{deny=resolve;}));const content=library.refresh();await flush();
  vi.mocked(api.localContent).mockImplementationOnce(()=>new Promise(resolve=>{finishLocal=resolve;}));const home=library.refreshHome();await flush();
  vi.mocked(api.centralContent).mockResolvedValueOnce({items:[],authorizationDenied:true});deny({items:[],authorizationDenied:true});await content;await flush();
  finishLocal({items:[],total:0});await home;await flush();
  expect(el('home-onboarding').hidden).toBe(true);expect(el('home-recent').textContent).toContain('内容暂不可完整读取');
  expect(el('home-recent').querySelector('[data-content-key^="capture:"]')).toBeNull();
});
