import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSourceWorkspaceUi} from '../src/source-workspace-ui';
import {SourceSync,sourceHash} from '../src/source-sync';
import type {DesktopApi,Status} from '../src/contracts';
import type {SourceStatus} from '../src/contracts/sources';
import type {SourceContextState} from '../src/source-context-outbox';

const id='generated-same-local-source';
const status=(generation:number)=>({authorizationGeneration:generation,config:{serverUrl:`http://127.0.0.1:${8000+generation}`,tokenConfigured:true}} as Status);
const context=(description:string):SourceContextState=>({snapshot:{sourceId:id,version:0,description}});
const source:SourceStatus={source:{id,name:'Generated folder',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'snapshot',enabled:true,intervalSeconds:60,trackDeletions:false,extensions:[],excludedPaths:[],redactLiterals:[]},state:'idle',message:'Generated status',items:1,skipped:0,pending:0,scanComplete:true};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
let dom:JSDOM,api:DesktopApi,ui:ReturnType<typeof createSourceWorkspaceUi>,toggle:ReturnType<typeof vi.fn>;
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const openDescription=()=>document.querySelector<HTMLButtonElement>('#source-detail-body .source-detail-context button')!.click();
beforeEach(()=>{
 dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'),{pretendToBeVisual:true});vi.stubGlobal('document',dom.window.document);
 const dialog=el<HTMLDialogElement>('source-context-dialog');dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};
 api={sourcePendingContent:vi.fn(async()=>({items:[],total:0})),sourceArchivedContent:vi.fn(async()=>({items:[]})),sourceContext:vi.fn(async()=>context('New node description')),saveSourceContext:vi.fn(async(_id,write)=>({...context('New node description'),pending:write})),openCentral:vi.fn(async()=>{})} as unknown as DesktopApi;
 toggle=vi.fn(async()=>{});
 ui=createSourceWorkspaceUi(api,{openDetail:()=>true,edit:()=>{},toggle,content:()=>{},read:()=>{}});ui.status(status(1));ui.update([structuredClone(source)]);ui.open(id);
 document.querySelector<HTMLElement>('[data-page=source-detail]')!.hidden=false;
});
const detailPage=()=>document.querySelector<HTMLElement>('[data-page=source-detail]')!;
function timedUi(){
 ui.clear();vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});
 vi.mocked(api.sourcePendingContent).mockClear();vi.mocked(api.sourceArchivedContent).mockClear();
 ui=createSourceWorkspaceUi(api,{openDetail:()=>true,edit:()=>{},toggle,content:()=>{},read:()=>{}});ui.status(status(1));ui.update([structuredClone(source)]);ui.open(id);
}
afterEach(()=>{ui.clear();dom.window.close();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

it.each([undefined,'2026-10-30T23:59:59.000Z'])('does not present upload time %s as the time of a completed local scan',lastSyncAt=>{
 ui.update([{...structuredClone(source),scanComplete:true,lastSyncAt}]);
 const scan=Array.from(el('source-detail-body').querySelectorAll('dt')).find(node=>node.textContent==='上次清点')!.nextElementSibling!;
 expect(scan.textContent).toContain('已完成');expect(scan.textContent).toContain('未知');
 expect(scan.textContent).not.toContain('尚未开始');expect(scan.textContent).not.toMatch(/2026|23:59/);
});

it('keeps the first-scan state unstarted even when an unrelated upload timestamp exists',()=>{
 ui.update([{...structuredClone(source),scanComplete:false,lastSyncAt:'2026-10-30T23:59:59.000Z'}]);
 const scan=Array.from(el('source-detail-body').querySelectorAll('dt')).find(node=>node.textContent==='上次清点')!.nextElementSibling!;
 expect(scan.textContent).toBe('尚未开始');
});

it.each(['load','refresh','save'] as const)('does not apply a late %s to the same source ID reopened on another node',async operation=>{
 let finish!:(value:SourceContextState)=>void;const deferred=new Promise<SourceContextState>(resolve=>{finish=resolve;});
 if(operation==='load')vi.mocked(api.sourceContext).mockReturnValueOnce(deferred);
 openDescription();await flush();
 if(operation==='refresh'){vi.mocked(api.sourceContext).mockReturnValueOnce(deferred);el<HTMLButtonElement>('source-context-refresh').click();}
 if(operation==='save'){vi.mocked(api.saveSourceContext).mockReturnValueOnce(deferred);el<HTMLTextAreaElement>('source-context-description').value='Old node draft';el<HTMLButtonElement>('source-context-save').click();}
 await flush();ui.clear();ui.status(status(2));ui.update([structuredClone(source)]);ui.open(id);openDescription();await flush();
 el<HTMLTextAreaElement>('source-context-description').value='New node unsaved draft';
 finish({...context('Old node secret'),pending:{expectedVersion:0,description:'Old node pending secret'}});await flush();
 expect(el<HTMLDialogElement>('source-context-dialog').open).toBe(true);
 expect(el<HTMLTextAreaElement>('source-context-description').value).toBe('New node unsaved draft');
 expect(el('source-detail-body').textContent).not.toContain('Old node');
 expect(el('source-context-current-text').textContent).not.toContain('Old node');
 el<HTMLButtonElement>('source-context-save').click();await flush();
 expect(api.saveSourceContext).toHaveBeenLastCalledWith(id,{expectedVersion:0,description:'New node unsaved draft'});
});

it('invalidates a late load when closed and reopened without changing the node',async()=>{
 let finish!:(value:SourceContextState)=>void;vi.mocked(api.sourceContext).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));openDescription();await flush();
 el<HTMLButtonElement>('source-context-cancel').click();openDescription();await flush();el<HTMLTextAreaElement>('source-context-description').value='Reopened draft';
 finish(context('Closed editor response'));await flush();expect(el<HTMLTextAreaElement>('source-context-description').value).toBe('Reopened draft');
});

it('shows an enabled but centrally paused source as paused in the list and detail',()=>{
 ui.update([{...structuredClone(source),state:'paused',message:'Generated Central pause'}]);
 expect(el('source-list').querySelector('.source-state')?.textContent).toBe('已暂停');
 expect(el('source-detail-body').querySelector('.source-state')?.textContent).toBe('已暂停');
 expect(el('source-detail-body').textContent).toContain('Generated Central pause');
 expect(el('source-detail-body').textContent).not.toContain('持续同步');
});

it('keeps rejected files visible as attention items instead of claiming they are waiting to send',()=>{
 ui.update([{...structuredClone(source),pending:0,blocked:1,failures:[{externalId:'generated-blocked',title:'Generated <script>literal</script>.txt',status:410}]}]);
 const detail=el('source-detail-body'),failure=detail.querySelector('.source-failures')!;expect(failure.textContent).toContain('本机待处理 1 项');expect(failure.textContent).toContain('中央已删除此文件');expect(failure.textContent).toContain('<script>literal</script>');expect(failure.querySelector('script')).toBeNull();expect(detail.textContent).toContain('本机待发送 · 0');expect(detail.textContent).not.toContain('本机待发送 · 1');
});

it('updates only the status card when non-content fields change, without rereading lists',async()=>{
 await flush();expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 const pendingList=el('source-detail-body').querySelector('.source-detail-section .source-list')!;
 ui.update([{...structuredClone(source),lastSyncAt:'2026-11-01T05:00:00.000Z',message:'Generated newer status',items:42,skipped:3}]);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 expect(el('source-detail-body').querySelector('.source-detail-section .source-list')).toBe(pendingList);
 const card=el('source-detail-body').querySelector('.source-state-card')!;
 expect(card.textContent).toContain('Generated newer status');expect(card.textContent).not.toContain('Generated status');
 const facts=Array.from(el('source-detail-body').querySelectorAll('dt'));
 expect(facts.find(node=>node.textContent==='已清点')!.nextElementSibling!.textContent).toBe('42');
 expect(facts.find(node=>node.textContent==='已跳过')!.nextElementSibling!.textContent).toBe('3');
 expect(el('source-detail-body').textContent).toContain('本机待发送 · 0');
});

it('rereads local pending and central archive once when content fields change',()=>{
 ui.update([{...structuredClone(source),pending:2}]);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);
 expect(el('source-detail-body').textContent).toContain('本机待发送 · 2');
});

it('does not read while the detail page is hidden and rereads once when reopened',()=>{
 detailPage().hidden=true;
 for(let index=0;index<5;index++)ui.update([{...structuredClone(source),pending:index,message:`Generated status ${index}`}]);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 ui.open(id);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);
 expect(el('source-detail-body').textContent).toContain('本机待发送 · 4');expect(el('source-detail-body').textContent).toContain('Generated status 4');
});

it('catches up once when the detail becomes visible again after hidden updates',()=>{
 detailPage().hidden=true;
 ui.update([{...structuredClone(source),pending:7,message:'Generated while hidden'}]);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 detailPage().hidden=false;ui.update([{...structuredClone(source),pending:7,message:'Generated while hidden'}]);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);
 expect(el('source-detail-body').textContent).toContain('本机待发送 · 7');expect(el('source-detail-body').textContent).toContain('Generated while hidden');
});

it('rereads both lists when an upload acknowledgement advances without a count change',async()=>{
 await flush();expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 ui.update([{...structuredClone(source),lastAcknowledgedAt:'2026-11-01T05:30:00.000Z'}]);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);
 ui.update([{...structuredClone(source),pending:1,lastAcknowledgedAt:'2026-11-01T05:31:00.000Z'}]);
 ui.update([{...structuredClone(source),pending:1,lastAcknowledgedAt:'2026-11-01T05:32:00.000Z'}]);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(4);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(4);
 expect(el('source-detail-body').textContent).toContain('本机待发送 · 1');
});

it('acts on the current source options when a privacy option changed without a visible update',()=>{
 const edited={...structuredClone(source),source:{...source.source,excludedPaths:['generated-secret'],redactLiterals:['generated-redact'],allowRead:true}};
 ui.update([edited]);
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='暂停这个来源')!.click();
 expect(toggle).toHaveBeenCalledTimes(1);
 const acted=toggle.mock.calls[0][0] as SourceStatus;
 expect(acted.source.excludedPaths).toEqual(['generated-secret']);expect(acted.source.redactLiterals).toEqual(['generated-redact']);expect(acted.source.allowRead).toBe(true);expect(acted.source.enabled).toBe(true);
});

it('rereads a policy-restaged revision with unchanged count and ACK using the real outbox status',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-source-ui-revision-'));
 try{
  const engine=new SourceSync(join(directory,'outbox.json'));await engine.initialize();
  const item={externalId:'generated-policy-file',title:'Generated private title',text:'Generated private body',kind:'file' as const,layer:'snapshot' as const};
  const scan=(value:typeof item)=>({items:[value],seen:[value.externalId],complete:true,skipped:0});
  await engine.stage(scan(item),false);
  vi.mocked(api.sourcePendingContent).mockImplementation(async()=>({items:engine.pendingContent().map(value=>({key:`source:${id}:${sourceHash(`${value.externalId}\0${value.revision}`)}`,source:'file' as const,title:value.title,observedAt:value.observedAt,preview:value.text})),total:engine.status().pending}));
  const edited={...structuredClone(source),source:{...source.source,redactLiterals:['Generated private']}};
  ui.update([{...edited,...engine.status()}]);ui.open(id);await flush();
  expect(el('source-detail-body').textContent).toContain(item.title);
  const reads=vi.mocked(api.sourcePendingContent).mock.calls.length,ack=engine.status().lastAcknowledgedAt;
  await engine.ensurePolicy('generated-redaction-policy');await engine.stage(scan({...item,title:'[已遮盖] title',text:'[已遮盖] body'}),false);
  expect(engine.status().pending).toBe(1);expect(engine.status().lastAcknowledgedAt).toBe(ack);
  ui.update([{...edited,...engine.status()}]);await flush();
  expect(api.sourcePendingContent).toHaveBeenCalledTimes(reads+1);
  expect(el('source-detail-body').textContent).not.toContain(item.title);expect(el('source-detail-body').textContent).toContain('[已遮盖] title');
  const version=engine.status().pendingContentRevision;
  await engine.stage(scan({...item,title:'[已遮盖] title',text:'[已遮盖] body'}),false);
  expect(engine.status().pendingContentRevision).toBe(version);
  ui.update([{...edited,...engine.status()}]);await flush();expect(api.sourcePendingContent).toHaveBeenCalledTimes(reads+1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('keeps loaded archive pages when only status fields change',async()=>{
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[{key:'capture:generated-page-one',source:'file',title:'Generated page one',observedAt:'2026-10-30T01:00:00.000Z',preview:''}],nextCursor:'generated-cursor'}).mockResolvedValueOnce({items:[{key:'capture:generated-page-two',source:'file',title:'Generated page two',observedAt:'2026-10-29T01:00:00.000Z',preview:''}]});
 ui.open(id);await flush();
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='加载更多')!.click();await flush();
 expect(el('source-detail-body').textContent).toContain('Generated page one');expect(el('source-detail-body').textContent).toContain('Generated page two');
 ui.update([{...structuredClone(source),message:'Generated status change',lastSyncAt:'2026-11-01T05:00:00.000Z'}]);
 expect(el('source-detail-body').textContent).toContain('Generated page one');expect(el('source-detail-body').textContent).toContain('Generated page two');
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(3);
});

it('revalidates the archive once after the owner returns from Central while local counts stay fixed',async()=>{
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[{key:'capture:generated-deleted',source:'file',title:'Generated archived row',observedAt:'2026-10-30T01:00:00.000Z',preview:''}]});
 ui.open(id);await flush();
 expect(el('source-detail-body').textContent).toContain('Generated archived row');
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='查看中央资料')!.click();
 expect(api.openCentral).toHaveBeenCalledWith('library');
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[]});
 dom.window.dispatchEvent(new dom.window.Event('focus'));await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(3);expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);
 expect(el('source-detail-body').textContent).not.toContain('Generated archived row');expect(el('source-detail-body').textContent).toContain('暂无中央归档内容');
});

it('revalidates the archive on the next status update after opening Central, not on every poll',async()=>{
 await flush();vi.spyOn(document,'hasFocus').mockReturnValue(true);
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='查看中央资料')!.click();
 ui.update([{...structuredClone(source),message:'Generated later poll'}]);await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
 ui.update([{...structuredClone(source),message:'Generated another poll'}]);await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
});

it('keeps the archive revalidation armed while the owner is still in the browser',async()=>{
 await flush();
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='查看中央资料')!.click();
 const focus=vi.spyOn(document,'hasFocus').mockReturnValue(false);
 ui.update([{...structuredClone(source),message:'Generated poll while browsing'}]);await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[{key:'capture:generated-kept',source:'file',title:'Generated current archive',observedAt:'2026-10-30T01:00:00.000Z',preview:''}]});
 focus.mockRestore();
 dom.window.dispatchEvent(new dom.window.Event('focus'));await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);expect(el('source-detail-body').textContent).toContain('Generated current archive');
});

it('rechecks on return even if a local content update rendered the archive before the Central deletion',async()=>{
 await flush();
 const archived={key:'capture:generated-deleted',source:'file' as const,title:'Generated deleted after local update',observedAt:'2026-10-30T01:00:00.000Z',preview:''};
 vi.mocked(api.sourceArchivedContent).mockResolvedValue({items:[archived]});
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='查看中央资料')!.click();
 vi.spyOn(document,'hasFocus').mockReturnValue(false);
 const changed={...structuredClone(source),pending:1,lastAcknowledgedAt:'2026-11-01T05:30:00.000Z'};
 ui.update([changed]);await flush();
 expect(el('source-detail-body').textContent).toContain(archived.title);
 vi.mocked(api.sourceArchivedContent).mockResolvedValue({items:[]});
 dom.window.dispatchEvent(new dom.window.Event('focus'));await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(3);expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);
 expect(el('source-detail-body').textContent).not.toContain(archived.title);
 for(let index=0;index<5;index++)ui.update([{...changed,message:`Generated poll ${index}`}]);
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(3);
});

it('defers a window-return recheck while hidden even without the Central entrypoint',async()=>{
 await flush();detailPage().hidden=true;
 dom.window.dispatchEvent(new dom.window.Event('focus'));await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
 detailPage().hidden=false;vi.spyOn(document,'hasFocus').mockReturnValue(true);
 ui.update([structuredClone(source)]);await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
});

it('withdraws the displayed archive when the return-time read reports denied authorization',async()=>{
 await flush();
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[{key:'capture:generated-private',source:'file',title:'Generated private archive',observedAt:'2026-10-30T01:00:00.000Z',preview:''}]});
 ui.open(id);await flush();expect(el('source-detail-body').textContent).toContain('Generated private archive');
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[],authorizationDenied:true});
 dom.window.dispatchEvent(new dom.window.Event('focus'));await flush();
 expect(el('source-detail-body').textContent).not.toContain('Generated private archive');
 expect(el('source-detail-body').textContent).toContain('无法访问采集记录，请检查中央连接权限');
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(3);
});

it('consumes the deferred Central denial when the reader returns to detail without another source poll',async()=>{
 await flush();
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[{key:'capture:generated-reader-private',source:'file',title:'Generated reader archive',observedAt:'2026-10-30T01:00:00.000Z',preview:''}]});
 ui.open(id);await flush();expect(el('source-detail-body').textContent).toContain('Generated reader archive');
 detailPage().hidden=true;document.querySelector<HTMLElement>('[data-page=content-reader]')!.hidden=false;await flush();
 dom.window.dispatchEvent(new dom.window.Event('focus'));await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[],authorizationDenied:true});
 document.querySelector<HTMLElement>('[data-page=content-reader]')!.hidden=true;detailPage().hidden=false;await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(3);expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);
 expect(el('source-detail-body').textContent).not.toContain('Generated reader archive');
 expect(el('source-detail-body').textContent).toContain('无法访问采集记录，请检查中央连接权限');
});

it('withdraws a remote deletion while Mac stays visible, with four archive-only reads per minute and none hidden',async()=>{
 ui.clear();vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});
 vi.mocked(api.sourcePendingContent).mockClear();vi.mocked(api.sourceArchivedContent).mockClear();
 vi.mocked(api.sourceArchivedContent).mockResolvedValueOnce({items:[{key:'capture:generated-remote-delete',source:'file',title:'Generated deleted on other device',observedAt:'2026-10-30T01:00:00.000Z',preview:''}]}).mockResolvedValue({items:[]});
 ui=createSourceWorkspaceUi(api,{openDetail:()=>true,edit:()=>{},toggle,content:()=>{},read:()=>{}});ui.status(status(1));ui.update([structuredClone(source)]);ui.open(id);await flush();
 expect(el('source-detail-body').textContent).toContain('Generated deleted on other device');
 await vi.advanceTimersByTimeAsync(14999);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);
 expect(el('source-detail-body').textContent).not.toContain('Generated deleted on other device');
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(45000);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(5);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
 detailPage().hidden=true;await flush();await vi.advanceTimersByTimeAsync(60000);
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(5);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
 detailPage().hidden=false;await flush();expect(api.sourceArchivedContent).toHaveBeenCalledTimes(6);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
});

it('lets 16-second archive reads finish across the 15-second timer without starving the visible result',async()=>{
 await flush();
 vi.mocked(api.sourceArchivedContent).mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve({items:[{key:'capture:generated-slow',source:'file',title:'Generated slow archive',observedAt:'2026-10-30T01:00:00.000Z',preview:''}]}),16000)));
 timedUi();await vi.advanceTimersByTimeAsync(15000);
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1000);expect(el('source-detail-body').textContent).toContain('Generated slow archive');
 await vi.advanceTimersByTimeAsync(16000);expect(el('source-detail-body').textContent).toContain('Generated slow archive');
 expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
});

it('keeps both loaded archive pages and the focused row across an unchanged periodic recheck',async()=>{
 await flush();
 const first={key:'capture:generated-preserved-one',source:'file' as const,title:'Generated preserved one',observedAt:'2026-10-30T01:00:00.000Z',preview:''};
 const second={...first,key:'capture:generated-preserved-two',title:'Generated preserved two'};
 vi.mocked(api.sourceArchivedContent).mockImplementation(async(_id,cursor)=>cursor?{items:[second]}:{items:[first],nextCursor:'generated-second'});
 timedUi();await flush();
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='加载更多')!.click();await flush();
 const row=Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent?.includes(second.title))!;row.focus();
 await vi.advanceTimersByTimeAsync(15000);
 expect(el('source-detail-body').textContent).toContain(first.title);expect(el('source-detail-body').textContent).toContain(second.title);
 expect(Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent?.includes(second.title))).toBe(row);expect(document.activeElement).toBe(row);
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(4);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
});

it('keeps a load-more response that crosses a periodic tick and coalesces the recheck behind it',async()=>{
 await flush();let finish!:(page:{items:import('../src/contracts/content').ContentItem[]})=>void,hold=true;
 const first={key:'capture:generated-crossing-one',source:'file' as const,title:'Generated crossing one',observedAt:'2026-10-30T01:00:00.000Z',preview:''};
 const second={...first,key:'capture:generated-crossing-two',title:'Generated crossing two'};
 vi.mocked(api.sourceArchivedContent).mockImplementation(async(_id,cursor)=>cursor?(hold?await new Promise(resolve=>{finish=resolve;}):{items:[second]}):{items:[first],nextCursor:'generated-crossing-second'});
 timedUi();await flush();
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='加载更多')!.click();await flush();
 await vi.advanceTimersByTimeAsync(15000);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);
 hold=false;finish({items:[second]});await flush();
 expect(el('source-detail-body').textContent).toContain(second.title);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(4);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
});

it('withdraws a remotely deleted row on a loaded second page without removing the unchanged first row',async()=>{
 await flush();let deleted=false;
 const first={key:'capture:generated-page-delete-one',source:'file' as const,title:'Generated retained first row',observedAt:'2026-10-30T01:00:00.000Z',preview:''};
 const second={...first,key:'capture:generated-page-delete-two',title:'Generated deleted second row'};
 vi.mocked(api.sourceArchivedContent).mockImplementation(async(_id,cursor)=>cursor?{items:deleted?[]:[second]}:{items:[first],nextCursor:'generated-delete-second'});
 timedUi();await flush();Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='加载更多')!.click();await flush();
 const firstRow=Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent?.includes(first.title));
 deleted=true;await vi.advanceTimersByTimeAsync(15000);
 expect(el('source-detail-body').textContent).not.toContain(second.title);
 expect(Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent?.includes(first.title))).toBe(firstRow);
});

it('stops a multi-page recheck before the next request when the window hides during the first response',async()=>{
 await flush();let finish!:(page:{items:import('../src/contracts/content').ContentItem[];nextCursor:string})=>void;
 const first={key:'capture:generated-hide-between-one',source:'file' as const,title:'Generated hide-between first row',observedAt:'2026-10-30T01:00:00.000Z',preview:''};
 const second={...first,key:'capture:generated-hide-between-two',title:'Generated hide-between second row'};
 vi.mocked(api.sourceArchivedContent).mockImplementation(async(_id,cursor)=>cursor?{items:[second]}:{items:[first],nextCursor:'generated-hide-between-cursor'});
 timedUi();await flush();Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='加载更多')!.click();await flush();
 vi.mocked(api.sourceArchivedContent).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 await vi.advanceTimersByTimeAsync(15000);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(3);
 const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true);document.dispatchEvent(new dom.window.Event('visibilitychange'));
 finish({items:[first],nextCursor:'generated-hide-between-cursor'});await flush();
 await vi.advanceTimersByTimeAsync(60000);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(3);
 hidden.mockReturnValue(false);document.dispatchEvent(new dom.window.Event('visibilitychange'));await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(5);expect(el('source-detail-body').textContent).toContain(second.title);
});

it('does not poll a tray-hidden document and rechecks once when the window is visible again',async()=>{
 await flush();timedUi();await flush();
 const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true);
 document.dispatchEvent(new dom.window.Event('visibilitychange'));
 for(let index=0;index<5;index++)ui.update([{...structuredClone(source),pending:index}]);
 await vi.advanceTimersByTimeAsync(60000);expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
 hidden.mockReturnValue(false);document.dispatchEvent(new dom.window.Event('visibilitychange'));await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);expect(api.sourcePendingContent).toHaveBeenCalledTimes(2);
});

it('defers the Central archive revalidation while hidden and folds it into the next visible read',async()=>{
 await flush();
 Array.from(el('source-detail-body').querySelectorAll('button')).find(button=>button.textContent==='查看中央资料')!.click();
 detailPage().hidden=true;
 ui.update([{...structuredClone(source),message:'Generated hidden poll'}]);await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(1);
 detailPage().hidden=false;
 vi.spyOn(document,'hasFocus').mockReturnValue(true);
 ui.update([{...structuredClone(source),message:'Generated hidden poll'}]);await flush();
 expect(api.sourceArchivedContent).toHaveBeenCalledTimes(2);expect(api.sourcePendingContent).toHaveBeenCalledTimes(1);
});
