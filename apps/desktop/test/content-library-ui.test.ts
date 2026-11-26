import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createContentLibraryUi} from '../src/content-library-ui';
import type {ContentDetail,ContentItem} from '../src/content-library';
import type {DesktopApi,Status} from '../src/contracts';

vi.mock('../src/background',()=>({previewWork:{run:vi.fn()},sourceWork:{run:vi.fn()}}));
const id='11111111-1111-4111-8111-111111111111';
const item:ContentItem={key:`queue:${id}`,source:'note',title:'Generated note',observedAt:'2026-10-11T00:00:00Z',preview:'Generated preview'};
const localDetail:ContentDetail={text:'GENERATED LOCAL BODY',metadata:'GENERATED LOCAL METADATA',sourceName:'Generated Mac'};
const status={authorizationGeneration:1,queueDepth:0,sync:{pendingRecords:0,state:'manual'},config:{tokenConfigured:true,serverUrl:'http://127.0.0.1:9999',deviceId:id}} as Status;
let dom:JSDOM,library:ReturnType<typeof createContentLibraryUi>,api:DesktopApi;
let dialog:HTMLDialogElement;
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const el=(id:string)=>document.getElementById(id)!;
beforeEach(()=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'),{pretendToBeVisual:true});vi.stubGlobal('document',dom.window.document);
  dialog=el('content-detail-dialog') as HTMLDialogElement;
  dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};
  api={localContent:vi.fn(async()=>({items:[],total:0})),localContentDetail:vi.fn(async()=>localDetail)} as unknown as DesktopApi;
  library=createContentLibraryUi(api);library.update(status);
});
afterEach(()=>{library.close();dom.window.close();vi.unstubAllGlobals();});
async function open(key=item.key){await flush();(document.querySelector(`[data-content-key="${key}"]`) as HTMLButtonElement).click();await flush();}
function expectCleared(){
  expect(dialog.open).toBe(false);
  for(const id of ['content-detail-title','content-detail-source','content-detail-body','content-detail-metadata'])expect(el(id).textContent).toBe('');
  expect(el('content-detail-image').getAttribute('src')).toBeNull();
}

it('withdraws an old empty claim while a new complete local read is still pending',async()=>{
  await library.refresh();
  expect(el('content-feed').textContent).toContain('还没有内容');
  let finish!:(value:{items:ContentItem[];total:number})=>void;
  vi.mocked(api.localContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=library.refresh();await flush();
  expect(el('content-status').getAttribute('aria-busy')).toBe('true');
  expect(el('content-status').classList.contains('visually-hidden')).toBe(false);
  expect(el('content-status').textContent).toBe('正在读取内容…');
  expect(el('content-feed').textContent).not.toContain('还没有内容');
  finish({items:[item],total:1});await pending;
  expect(el('content-status').getAttribute('aria-busy')).toBe('false');
  expect(document.querySelectorAll('#content-feed .content-row')).toHaveLength(1);
});

it('lists pending local notes and screenshots without a central filter',async()=>{
  const screen={...item,key:`queue:${id}-screen`,source:'screen' as const,title:'Generated screenshot'};
  vi.mocked(api.localContent).mockResolvedValue({items:[item,screen],total:2});
  await library.refresh();
  expect(document.querySelectorAll('#content-feed .content-row')).toHaveLength(2);
  expect(el('content-feed').textContent).toContain('Generated note');
  expect(el('content-feed').textContent).toContain('Generated screenshot');
  expect(el('content-feed').querySelector('[data-content-key^="capture:"]')).toBeNull();
});

it('lists a local row and reads its exact original',async()=>{
  vi.mocked(api.localContent).mockResolvedValue({items:[item],total:1});
  await library.refresh();await open();
  expect(el('content-detail-body').textContent).toBe(localDetail.text);
  expect(el('content-detail-metadata').textContent).toBe(localDetail.metadata);
  expect(api.localContentDetail).toHaveBeenCalledWith(item.key,false);
});

it('opens a local screenshot above its OCR and keeps its upload receipt on demand',async()=>{
  const screen:ContentItem={...item,source:'screen',title:'Generated local screenshot'};
  const png='data:image/png;base64,iVBORw0KGgo=';
  vi.mocked(api.localContent).mockResolvedValue({items:[screen],total:1});
  vi.mocked(api.localContentDetail).mockResolvedValue({...localDetail,hasImage:true,image:png});
  await library.refresh();await open();
  const picture=el('content-original') as HTMLDetailsElement,processing=el('content-processing') as HTMLDetailsElement;
  expect(picture.open).toBe(true);
  expect(picture.hidden).toBe(false);
  expect(el('content-detail-image').getAttribute('src')).toBe(png);
  expect(picture.compareDocumentPosition(el('content-detail-body')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(processing.open).toBe(false);
  expect(el('content-detail-status').textContent).toBe('等待上传');
  el('content-detail-inspect').click();
  expect(processing.open).toBe(true);
  expect(document.activeElement).toBe(processing.querySelector('summary'));
  expect(el('content-detail-body').textContent).toBe(localDetail.text);
  expect(api.localContentDetail).toHaveBeenCalledTimes(1);
  expect(api.localContentDetail).toHaveBeenCalledWith(screen.key,true);
});

it('renders an owner description separately and clears it when the reader closes',async()=>{
  vi.mocked(api.localContent).mockResolvedValue({items:[item],total:1});
  vi.mocked(api.localContentDetail).mockResolvedValue({...localDetail,description:'Generated explanation <script>not executable</script>'});
  await library.refresh();await open();
  expect(el('content-detail-body').textContent).toBe(localDetail.text);
  expect(el('content-detail-description').textContent).toBe('Generated explanation <script>not executable</script>');
  expect(el('content-detail-description').querySelector('script')).toBeNull();expect(el('content-description-section').hidden).toBe(false);
  el('content-detail-close').click();expect(el('content-detail-description').textContent).toBe('');expect(el('content-description-section').hidden).toBe(true);
});

it('retains same-scope rows on temporary reads and never calls unavailable content empty',async()=>{
  vi.mocked(api.localContent).mockResolvedValue({items:[item],total:1});await library.refresh();
  vi.mocked(api.localContent).mockRejectedValueOnce(Error("Error invoking remote method 'mote:local-content': generated private diagnostics"));
  await library.refresh();
  expect(el('content-feed').querySelector(`[data-content-key="${item.key}"]`)).not.toBeNull();
  (el('content-search') as HTMLInputElement).value='unavailable query';vi.mocked(api.localContent).mockRejectedValueOnce(Error('Generated failure'));await library.refresh();
  expect(el('content-feed').textContent).toBe('');expect(el('content-status').textContent).toContain('内容暂不可完整读取');expect(el('content-status').textContent).not.toContain('generated');
});

it('invalidates a late older search response',async()=>{
  const search=el('content-search') as HTMLInputElement;
  let finish!:(value:{items:ContentItem[];total:number})=>void;
  vi.mocked(api.localContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  search.value='older';const pending=library.refresh();await flush();
  search.value='newer';vi.mocked(api.localContent).mockResolvedValueOnce({items:[{...item,title:'Newer match'}],total:1});await library.refresh();
  finish({items:[{...item,title:'Stale old query'}],total:1});await pending;await flush();
  expect(document.querySelector('#content-feed .content-row-copy strong')!.textContent).toBe('Newer match');
  expect(api.localContent).toHaveBeenCalledWith(0,'older');expect(api.localContent).toHaveBeenCalledWith(0,'newer');
  expect(search.value).toBe('newer');
});

it('stops reading while the window is hidden and catches up once after it returns',async()=>{
  document.querySelector<HTMLElement>('[data-page=records]')!.hidden=false;
  await flush();
  const before=vi.mocked(api.localContent).mock.calls.length;
  const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true);
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await library.refresh();await flush();
  expect(vi.mocked(api.localContent).mock.calls.length).toBe(before);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new dom.window.Event('visibilitychange'));await flush();
  expect(vi.mocked(api.localContent).mock.calls.length).toBe(before+1);
  await flush();
  expect(vi.mocked(api.localContent).mock.calls.length).toBe(before+1);
});

it('clears private DOM and invalidates old requests when a credential changes within the same node',async()=>{
  vi.mocked(api.localContent).mockResolvedValue({items:[item],total:1});
  await library.refresh();await open();
  let finish!:(value:ContentDetail)=>void;vi.mocked(api.localContentDetail).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  (el('content-detail-refresh') as HTMLButtonElement).click();await flush();library.update({...status,authorizationGeneration:2});expectCleared();
  finish(localDetail);await flush();expectCleared();
});

it('keeps an open local reader after a later local feed failure',async()=>{
  vi.mocked(api.localContent).mockResolvedValue({items:[item],total:1});
  await library.refresh();await open();
  vi.mocked(api.localContent).mockRejectedValueOnce(Error('Generated temporary network failure'));
  await library.refresh();
  expect(dialog.open).toBe(true);expect(el('content-detail-body').textContent).toBe(localDetail.text);
});

it('opens a chosen local item from another page without a feed read',async()=>{
  library.open(item);await flush();
  expect(dialog.open).toBe(true);expect(el('content-detail-title').textContent).toBe(item.title);
  expect(el('content-detail-body').textContent).toBe(localDetail.text);
});
