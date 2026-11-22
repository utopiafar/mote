import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createWorkPendingUi} from '../src/work-pending-ui';
import type {DesktopApi,Status} from '../src/contracts';
let dom:JSDOM,ui:ReturnType<typeof createWorkPendingUi>,api:DesktopApi;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const item={key:'note:generated',title:'Generated literal note',source:'note' as const,observedAt:'2026-10-30T00:00:00Z',preview:'Generated literal note'};
const scope=(generation=1)=>({authorizationGeneration:generation,queueDepth:2,sync:{pendingRecords:2},config:{serverUrl:'',tokenConfigured:false}} as Status);
const open=vi.fn(),receipts=vi.fn();
beforeEach(()=>{dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'));vi.stubGlobal('document',dom.window.document);api={localContent:vi.fn(async()=>({items:[item],total:2,nextOffset:1}))} as unknown as DesktopApi;open.mockReset();receipts.mockReset();ui=createWorkPendingUi(api,open,receipts);ui.update(scope());});
afterEach(()=>{ui.hide();dom.window.close();vi.unstubAllGlobals();});
it('keeps the exact row reader and both paging layers while making Central controls secondary',async()=>{
 ui.show();await flush();const more=document.getElementById('home-sync-details') as HTMLDetailsElement;expect(more.open).toBe(false);expect(more.contains(document.getElementById('work-list'))).toBe(true);expect(more.contains(document.getElementById('work-next'))).toBe(true);expect(more.contains(document.getElementById('pause-sending'))).toBe(false);
 const row=document.querySelector<HTMLButtonElement>('#work-pending-list .home-content-row')!;
 expect(row.querySelector('.home-content-symbol svg[aria-hidden="true"] use')?.getAttribute('href')).toBe('#icon-pencil');
 expect(row.querySelector('.chevron svg[aria-hidden="true"] use')?.getAttribute('href')).toBe('#icon-chevron-right');
 row.click();expect(open).toHaveBeenCalledWith(item);document.getElementById('work-receipts')!.click();expect(receipts).toHaveBeenCalledOnce();document.getElementById('work-pending-more')!.click();await flush();expect(api.localContent).toHaveBeenLastCalledWith(1,undefined,true);expect(document.querySelectorAll('#work-pending-list button')).toHaveLength(2);
});
it('keeps already readable rows on a page error, folds the exact diagnostic, and rejects an old owner reply',async()=>{
 ui.show();await flush();vi.mocked(api.localContent).mockRejectedValueOnce(Error('HTTP 503 Generated raw failure'));document.getElementById('work-pending-more')!.click();await flush();expect(document.querySelectorAll('#work-pending-list button')).toHaveLength(1);const state=document.getElementById('work-pending-state')!;expect(state.firstChild!.textContent).toBe('内容暂不可完整读取，请重试。');expect(state.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
 let release!:(value:any)=>void;vi.mocked(api.localContent).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));document.getElementById('work-refresh')!.click();await flush();ui.update(scope(2));release({items:[{...item,title:'OLD OWNER BODY'}],total:1});await flush();expect(document.getElementById('work-pending-list')!.textContent).not.toContain('OLD OWNER BODY');
});
