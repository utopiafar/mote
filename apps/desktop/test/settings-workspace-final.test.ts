import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mountCaptureWorkspace} from '../src/capture-workspace';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {beginDiagnosticFactsRefresh,mountSettingsWorkspace,renderSettingsWorkspace} from '../src/settings-workspace';
import type {Status} from '../src/contracts';
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
let dom:JSDOM,originalMetadata:HTMLButtonElement,metadataAction:ReturnType<typeof vi.fn>;
beforeEach(()=>{dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'));vi.stubGlobal('document',dom.window.document);originalMetadata=el<HTMLButtonElement>('export-metadata');metadataAction=vi.fn();originalMetadata.addEventListener('click',metadataAction);mountSettingsWorkspace();});
afterEach(()=>{dom.window.close();vi.unstubAllGlobals();});
const status=()=>({queueDepth:2,sync:{pendingRecords:2,message:'Generated stopped sends'},config:{defaultCollection:{duration:true,screenshots:false,structured:false},serverUrl:'',syncPaused:true},credentialStorage:'json',environment:{profile:'generated',defaultProfile:false}} as Status);
it('states the exact queued-backup exclusions and keeps the existing metadata action under its scope disclosure',()=>{
 const metadata=el<HTMLButtonElement>('export-metadata');expect(metadata).toBe(originalMetadata);const details=metadata.closest('details')!;expect(details.open).toBe(false);expect(details.querySelector('summary')!.textContent).toBe('备份包含什么');expect(details.textContent).toContain('来源文件使用独立的传输队列');expect(details.textContent).toContain('来源文件原件、未提交草稿、设置或登录凭据');expect(details.textContent).toContain('个人资料');metadata.click();expect(metadataAction).toHaveBeenCalledOnce();expect(document.querySelectorAll('#export-metadata')).toHaveLength(1);expect(el('data-folder').closest('details')).not.toBe(details);renderSettingsWorkspace(status());expect(el('backup-facts').textContent).toBe('2条');
});
it('puts actual diagnostic samples after controls and before exports while retaining full diagnostics behind More without touching drafts',()=>{
 const view=status();renderSettingsWorkspace(view);expect(el('diagnostics-current-facts').hidden).toBe(true);const interval=el<HTMLInputElement>('diagnostic-interval');interval.value='90';el<HTMLInputElement>('diagnostics-enabled').checked=true;
 view.diagnostics={enabled:true,sampleCount:3,fileBytes:120,counters:{saved:0,blocked:0,failed:0,imageBytes:0,uploadedBytes:0,inferenceMs:0,ocrMs:0,captureMs:0},latest:{at:'2026-10-30T01:00:00.000Z',rssBytes:104857600,cpuUserMicros:1500000,cpuSystemMicros:500000,processId:42,queueBytes:0,modelBytes:0,counters:{saved:0,blocked:0,failed:0,imageBytes:0,uploadedBytes:0,inferenceMs:0,ocrMs:0,captureMs:0}}};renderSettingsWorkspace(view);const facts=el('diagnostics-current-facts');expect(facts.hidden).toBe(true,'a background or transient configuration sample is not a user refresh');const accept=beginDiagnosticFactsRefresh();view.diagnostics.latest.at='2026-10-30T01:01:00.000Z';renderSettingsWorkspace(view);expect(facts.hidden).toBe(true);accept(view);expect(facts.hidden).toBe(false);expect(facts.textContent).toContain('3 条数值样本');expect(facts.textContent).toContain('100.0 MiB');expect(facts.textContent).toContain('2.0 s');expect(Boolean(el('diagnostics-sample').compareDocumentPosition(facts)&4)).toBe(true);expect(Boolean(facts.compareDocumentPosition(document.querySelector('.diagnostic-exports')!)&4)).toBe(true);expect(el<HTMLDetailsElement>('diagnostics-more').open).toBe(false);expect(el('diagnostics-more').contains(el('diagnostics-detail'))).toBe(true);expect(interval.value).toBe('90');expect(el<HTMLInputElement>('diagnostics-enabled').checked).toBe(true);
 renderSettingsWorkspace(status());expect(facts.hidden).toBe(true);expect(facts.textContent).toBe('');expect(interval.value).toBe('90');
});

it('keeps runtime log controls separate from the capture settings draft',()=>{
 const form=el<HTMLFormElement>('settings'),changed=vi.fn();form.addEventListener('change',changed);
 const enabled=el<HTMLInputElement>('runtime-log-enabled'),level=el<HTMLSelectElement>('runtime-log-level');
 expect(enabled.closest('[data-page]')?.getAttribute('data-page')).toBe('developer');
 expect([...level.options].map(option=>option.value)).toEqual(['debug','info','warn','error']);
 enabled.dispatchEvent(new dom.window.Event('change',{bubbles:true}));level.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
 expect(changed).not.toHaveBeenCalled();
 expect(el('runtime-log-save').getAttribute('type')).toBe('button');
 expect(el('runtime-log-export').getAttribute('type')).toBe('button');
});

it('a failed explicit refresh followed by later automatic samples does not disclose facts',()=>{
 const view=status();renderSettingsWorkspace(view);beginDiagnosticFactsRefresh();const counters={saved:0,blocked:0,failed:0,imageBytes:0,uploadedBytes:0,inferenceMs:0,ocrMs:0,captureMs:0};view.diagnostics={enabled:true,sampleCount:1,fileBytes:1,counters,latest:{at:'2026-10-30T01:00:00Z',rssBytes:1048576,cpuUserMicros:1,cpuSystemMicros:1,processId:1,queueBytes:0,modelBytes:0,counters}};renderSettingsWorkspace(view);expect(el('diagnostics-current-facts').hidden).toBe(true);view.diagnostics.latest!.at='2026-10-30T01:02:00Z';renderSettingsWorkspace(view);expect(el('diagnostics-current-facts').hidden).toBe(true);const rejected=beginDiagnosticFactsRefresh();rejected({...view,diagnostics:{...view.diagnostics,error:'Generated sample write failure'}});expect(el('diagnostics-current-facts').hidden).toBe(true);
});
it('only the current owner and newest explicit sample acknowledgement may disclose facts',()=>{
 const a=status(),counters={saved:0,blocked:0,failed:0,imageBytes:0,uploadedBytes:0,inferenceMs:0,ocrMs:0,captureMs:0};a.diagnostics={enabled:true,sampleCount:1,fileBytes:1,counters,latest:{at:'2026-10-30T01:00:00Z',rssBytes:1048576,cpuUserMicros:1,cpuSystemMicros:1,processId:1,queueBytes:0,modelBytes:0,counters}};renderSettingsWorkspace(a);const old=beginDiagnosticFactsRefresh(),latest=beginDiagnosticFactsRefresh();old(a);expect(el('diagnostics-current-facts').hidden).toBe(true);const b={...a,authorizationGeneration:2};renderSettingsWorkspace(b);latest(a);expect(el('diagnostics-current-facts').hidden).toBe(true);const current=beginDiagnosticFactsRefresh();current(b);expect(el('diagnostics-current-facts').hidden).toBe(false);renderSettingsWorkspace(a);current(b);expect(el('diagnostics-current-facts').hidden).toBe(true);
});

it('keeps the existing recovery action in the Storage page after all workspace mounting',()=>{
 mountCaptureWorkspace();
 expect(el('storage-restart').closest('[data-page]')?.getAttribute('data-page')).toBe('storage');
});
