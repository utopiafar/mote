import '@mote/shared/i18n-all';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createSyncHistoryUi} from '../src/sync-history-ui';
import type {DesktopApi,Status} from '../src/contracts';
import {configureLocale,moteText} from '@mote/shared/i18n';
let dom:JSDOM,api:DesktopApi,ui:ReturnType<typeof createSyncHistoryUi>;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const status=(generation=1)=>({authorizationGeneration:generation,config:{serverUrl:'http://127.0.0.1:1',deviceId:'generated-device',tokenConfigured:true},sync:{state:'manual',message:'Generated manual'}} as Status);
const page=()=>({items:[],total:0,offset:0,received:7,bytes:4096,since:'2026-10-30T00:00:00Z',days:[],sources:[]});
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
beforeEach(()=>{dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'));vi.stubGlobal('document',dom.window.document);for(const id of ['upload-content-dialog','upload-receipt-dialog'])el<HTMLDialogElement>(id).close=()=>{};api={syncHistory:vi.fn(async()=>page()),syncHistoryPending:vi.fn(async()=>[])} as unknown as DesktopApi;ui=createSyncHistoryUi(api,()=>{});ui.update(status());});
afterEach(()=>{ui.hide();dom.window.close();vi.unstubAllGlobals();configureLocale(()=> 'zh-CN');});
it('does not present initial zero placeholders as read facts after a first request failure',async()=>{
 vi.mocked(api.syncHistory).mockRejectedValue(Error('HTTP503 generated'));ui.show();await flush();expect(document.querySelector<HTMLElement>('.upload-metrics')!.hidden).toBe(true);expect(document.querySelector<HTMLElement>('.upload-status')!.hidden).toBe(true);expect(el('upload-run-list').hidden).toBe(true);expect(el('upload-error').firstChild!.textContent).toBe('状态读取失败，请重试。');expect(el('upload-error').querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
});
it('retains a verified same-range page on a refresh failure but withdraws it synchronously on a new range',async()=>{
 ui.show();await flush();expect(el('upload-received').textContent).toBe('7');expect(document.querySelector<HTMLElement>('.upload-metrics')!.hidden).toBe(false);vi.mocked(api.syncHistory).mockRejectedValue(Error('HTTP503 generated'));el('upload-refresh').click();await flush();expect(el('upload-received').textContent).toBe('7');expect(document.querySelector<HTMLElement>('.upload-metrics')!.hidden).toBe(false);el<HTMLInputElement>('upload-day').value='2000-01-01';el('upload-day').dispatchEvent(new dom.window.Event('change'));expect(document.querySelector<HTMLElement>('.upload-metrics')!.hidden).toBe(true);await flush();expect(el('upload-run-list').hidden).toBe(true);
});
it('withdraws an old owner page and rejects a late reply without reviving its facts',async()=>{
 ui.show();await flush();const releases:((value:ReturnType<typeof page>)=>void)[]=[];vi.mocked(api.syncHistory).mockImplementation(()=>new Promise(resolve=>{releases.push(resolve);}));el('upload-refresh').click();await flush();ui.update(status(2));expect(document.querySelector<HTMLElement>('.upload-metrics')!.hidden).toBe(true);releases[0]({...page(),received:99});releases[1]({...page(),received:99});await flush();expect(document.querySelector<HTMLElement>('.upload-metrics')!.hidden).toBe(true);expect(el('upload-received').textContent).not.toBe('99');releases[2]({...page(),received:3});releases[3]({...page(),received:3});await flush();expect(document.querySelector<HTMLElement>('.upload-metrics')!.hidden).toBe(false);expect(el('upload-received').textContent).toBe('3');
});

it('keeps an unknown local original and a later confirmed central read captioned by their actual locations across refresh and locale changes',async()=>{
 const key='11111111-1111-4111-8111-111111111111',run={id:'generated-run',startedAt:'2026-10-30T00:00:00Z',finishedAt:'2026-10-30T00:00:01Z',trigger:'manual' as const,outcome:'unconfirmed' as const,sources:['note' as const],received:0,unconfirmed:1,total:1,bytes:64};
 const item={key,captureId:key,source:'note' as const,title:'Generated exact note',observedAt:run.startedAt,outcome:'unconfirmed' as const,firstReceipt:false};
 for(const id of ['upload-content-dialog','upload-receipt-dialog']){const dialog=el<HTMLDialogElement>(id);dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};}
 api.syncHistory=vi.fn(async()=>({...page(),items:[run],total:1}));
 api.syncHistoryContents=vi.fn(async()=>({run,items:[item],offset:0,total:1}));
 api.syncHistoryContent=vi.fn(async()=>({item,location:'local' as const,text:'Generated body, not a model answer.',description:'Generated independent description.',metadata:'{}'}));
 api.retry=vi.fn();ui.show();await flush();el('upload-run-list').querySelector<HTMLButtonElement>('[data-upload-run]')!.click();await flush();el('upload-view-all').click();await flush();
 const preview=el('upload-content-preview');
 expect(preview.querySelector('.upload-note')!.textContent).toContain('当前显示本机副本');
 expect(preview.textContent).toContain('中央接收仍待确认');expect(preview.textContent).not.toContain('已上传内容从中央读取');
 expect(preview.querySelector('#upload-preview-central')).toBeNull();expect(preview.querySelector('.upload-content-description')!.textContent).toContain('Generated independent description.');
 configureLocale(()=> 'en');el('upload-preview-refresh').click();await flush();
 expect(preview.querySelector('.upload-note')!.textContent).toBe(moteText('当前显示本机副本；中央接收仍待确认。正文最多预览 100000 个字符。'));
 expect(preview.querySelector('.upload-note')!.textContent).not.toContain('当前');
 vi.mocked(api.syncHistoryContent).mockResolvedValueOnce({item,location:'central',captureId:key,text:'Generated body, not a model answer.',metadata:'{}'});
 el('upload-preview-refresh').click();await flush();
 expect(preview.querySelector('.upload-note')!.textContent).toBe(moteText('已上传内容从中央读取；本机副本可能已清理。正文最长预览 100000 个字符，原件及完整内容可在中央查看。'));
 expect(preview.querySelector<HTMLButtonElement>('#upload-preview-central')!.dataset.capture).toBe(key);
 expect(api.syncHistoryContent).toHaveBeenCalledTimes(3);for(const args of vi.mocked(api.syncHistoryContent).mock.calls)expect(args).toEqual([run.id,key,0]);
 expect(api.retry).not.toHaveBeenCalled();expect(el('upload-content-list').querySelector('[aria-pressed=true]')!.getAttribute('data-upload-key')).toBe(key);
});
