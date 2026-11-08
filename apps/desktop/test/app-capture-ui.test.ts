import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {uiRulesSchema} from '@mote/shared';
import {createAppCaptureUi} from '../src/app-capture-ui';
import {captureRulesForApp,captureAppRows,captureAppNeedsAttention} from '../src/app-capture-model';
import {defaultConfig} from '../src/config';
import type {Status} from '../src/contracts';
let dom:JSDOM,ui:ReturnType<typeof createAppCaptureUi>,changed:ReturnType<typeof vi.fn>,applications:ReturnType<typeof vi.fn>;
const duration={duration:true,screenshots:false,structured:false};
const off={duration:false,screenshots:false,structured:false};
const generatedRules=()=>uiRulesSchema.parse([{id:'generated.reader.article',version:'1',platform:'macos',appId:'dev.generated.reader',appVersion:'1.2',formatVersion:3,kind:'article',fields:{title:{select:{resourceId:'generated_title'},required:true},body:{select:{resourceId:'generated_body'}}}}]);
const status=(screenPermission='granted')=>({platform:'macos',screenPermission} as Status);
const config=()=>({...defaultConfig(),tokenConfigured:false,uiPageRules:generatedRules()});
const el=<T extends HTMLElement=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const select=(id:string)=>el<HTMLButtonElement>(`[data-capture-app="${id}"]`).click();
const change=(selector:string,checked:boolean)=>{const input=el<HTMLInputElement>(selector);input.checked=checked;input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
beforeEach(async()=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'));
  vi.stubGlobal('document',dom.window.document);
  const root=el('#default-collection');
  for(const key of ['duration','screenshots','structured']){const input=document.createElement('input');input.type='checkbox';input.dataset.channel=key;input.checked=key==='duration';root.append(input);}
  el<HTMLTextAreaElement>('#ui-page-rules').value=JSON.stringify(generatedRules());
  changed=vi.fn();applications=vi.fn(async()=>[{appId:'dev.generated.reader',appName:'Generated reader',appVersion:'1.2'},{appId:'dev.generated.notes',appName:'Generated notes',appVersion:'2.0'}]);
  ui=createAppCaptureUi({root:el('#app-collection-rules'),defaultRoot:root,rulesEditor:el('#ui-page-rules'),applications,changed,editRules:vi.fn(),permissions:vi.fn()});
  ui.setConfig(config());ui.setStatus(status());await ui.refreshApplications();
});
afterEach(()=>{dom.window.close();vi.unstubAllGlobals();});
it('lets the owner choose independent channels, keeps drafts through status refresh, and restores inherited defaults',()=>{
  select('dev.generated.reader');expect(el<HTMLInputElement>('.app-capture-detail [data-channel=structured]').disabled).toBe(true);
  change('[data-app-inherit]',false);change('.app-capture-detail [data-channel=duration]',false);change('.app-capture-detail [data-channel=structured]',true);
  expect(ui.readRules()).toEqual({'dev.generated.reader':{...off,structured:true}});
  ui.setStatus(status('denied'));
  expect(el<HTMLInputElement>('.app-capture-detail [data-channel=structured]').checked).toBe(true);
  expect(el<HTMLInputElement>('.app-capture-detail [data-channel=screenshots]').checked).toBe(false);
  expect(el('.app-capture-list').textContent).toContain('结构化解析');
  change('[data-app-inherit]',true);expect(ui.readRules()).toEqual({});
  change('#default-collection [data-channel=screenshots]',true);
  expect(el<HTMLInputElement>('.app-capture-detail [data-channel=screenshots]').checked).toBe(true);
  expect(el<HTMLInputElement>('.app-capture-detail [data-channel=screenshots]').disabled).toBe(true);
  expect(changed).toHaveBeenCalled();
});
it('lists actual configured fields separately from collection choices and surfaces an app version mismatch',async()=>{
  select('dev.generated.reader');expect(el('.app-capture-detail').textContent).toContain('标题、正文');
  expect(el('.app-capture-detail').textContent).toContain('未开启结构化');expect(ui.readRules()).toEqual({});
  applications.mockResolvedValueOnce([{appId:'dev.generated.reader',appName:'Generated reader',appVersion:'1.3'}]);
  ui.addOverride('dev.generated.reader',{...off,structured:true});await ui.refreshApplications();
  expect(el('.app-capture-detail').textContent).toContain('规则版本不符');
  el<HTMLButtonElement>('[data-app-filter=attention]').click();expect(el('.app-capture-list').textContent).toContain('Generated reader');
  expect(ui.readRules()['dev.generated.reader']).toEqual({...off,structured:true});
  el<HTMLTextAreaElement>('#ui-page-rules').value='[';ui.refreshRules();
  expect(el('#app-collection-rules').textContent).toContain('页面规则格式有误');
  expect(ui.readRules()['dev.generated.reader'].screenshots).toBe(false);
});
it('does not overwrite edits when application discovery completes late or fails, and config reload discards a draft',async()=>{
  let resolve!:(apps:{appId:string;appName:string}[])=>void;
  applications.mockImplementationOnce(()=>new Promise(finish=>{resolve=finish;}));
  const discovery=ui.refreshApplications();ui.addOverride('dev.generated.private',{...off});
  resolve([{appId:'dev.generated.reader',appName:'Generated reader'}]);await discovery;
  expect(ui.readRules()['dev.generated.private']).toEqual(off);
  applications.mockRejectedValueOnce(new Error('generated discovery failure'));await ui.refreshApplications();
  expect(el('#app-collection-rules').textContent).toContain('应用列表读取失败');expect(ui.readRules()['dev.generated.private']).toEqual(off);
  ui.setConfig(config());expect(ui.readRules()).toEqual({});
  el<HTMLButtonElement>('[data-app-filter=custom]').click();expect(el('.app-capture-list').textContent).toContain('没有符合此范围的应用');
});
it('search and rule refresh retain edits and render names and IDs as text',async()=>{
  ui.addOverride('dev.generated.reader',{...off,structured:true});
  const formInput=vi.fn();el('#settings').addEventListener('input',formInput);el('#settings').addEventListener('change',formInput);
  const search=el<HTMLInputElement>('.app-capture-toolbar input');search.value='notes';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));search.dispatchEvent(new dom.window.Event('change',{bubbles:true}));expect(formInput).not.toHaveBeenCalled();
  expect(ui.readRules()['dev.generated.reader']).toEqual({...off,structured:true});
  el<HTMLTextAreaElement>('#ui-page-rules').value='[]';ui.refreshRules();expect(ui.readRules()['dev.generated.reader'].structured).toBe(true);
  search.value='';search.dispatchEvent(new dom.window.Event('input'));
  applications.mockResolvedValueOnce([{appId:'dev.generated.reader',appName:'<img src=x onerror=alert(1)>',appVersion:'1.2'}]);await ui.refreshApplications();
  expect(el('.app-capture-list').querySelector('img')).toBeNull();expect(el('.app-capture-list').textContent).toContain('<img');await flush();
});
it('describes built-in WeChat, browser prerequisites and unused configured mappings using actual collector boundaries',()=>{
  const rules=uiRulesSchema.parse([{formatVersion:3,id:'generated.old',version:'1',platform:'macos',appId:'dev.generated.reader',appVersion:'1.2',activity:'generated.Page',kind:'article',fields:{title:{select:{role:'AXStaticText'},required:true}}}]);
  const rows=captureAppRows([{appId:'com.tencent.xinWeChat',appName:'Generated WeChat',appVersion:'4.1.15'},{appId:'com.google.Chrome',appName:'Generated Chrome'},{appId:'dev.generated.reader',appName:'Generated reader'}],{'com.tencent.xinWeChat':{...off,structured:true},'com.google.Chrome':{...off,structured:true},'dev.generated.reader':{...off,structured:true}},duration,rules);
  const wechat=rows.find(row=>row.appId==='com.tencent.xinWeChat')!,chrome=rows.find(row=>row.appId==='com.google.Chrome')!,reader=rows.find(row=>row.appId==='dev.generated.reader')!;
  expect(wechat.rules[0]).toMatchObject({source:'builtin',appVersion:'4.1.15',applicability:'available'});
  expect(captureAppNeedsAttention(wechat,'granted','macos',[])).toBe(false);
  expect(captureAppNeedsAttention(chrome,'granted','macos',[])).toBe(true);
  expect(reader.rules[0].applicability).toBe('unused');expect(captureAppNeedsAttention(reader,'granted','macos',[])).toBe(true);
});
it('keeps the same current-format macOS rule availability set used by the collector',()=>{
  const rules=uiRulesSchema.parse([
    {formatVersion:3,id:'generated.reader.current',version:'1',platform:'macos',appId:'dev.generated.reader',appVersion:'1.2',kind:'article',fields:{title:{select:{resourceId:'generated_title'},required:true},body:{select:{resourceId:'generated_body'}}}},
    {formatVersion:3,id:'generated.reader.other-version',version:'1',platform:'macos',appId:'dev.generated.reader',appVersion:'9.9',kind:'article',fields:{title:{select:{resourceId:'generated_title'}}}},
    {formatVersion:3,id:'generated.reader.activity',version:'1',platform:'macos',appId:'dev.generated.reader',appVersion:'1.2',activity:'generated.Page',kind:'article',fields:{title:{select:{resourceId:'generated_title'}}}},
  ]);
  expect(captureRulesForApp({appId:'dev.generated.reader',appName:'Generated reader',appVersion:'1.2'},rules)).toEqual([
    {id:'generated.reader.current',version:'1',appVersion:'1.2',kind:'article',fields:['title','body'],source:'configured',applicability:'available'},
    {id:'generated.reader.other-version',version:'1',appVersion:'9.9',kind:'article',fields:['title'],source:'configured',applicability:'version_mismatch'},
    {id:'generated.reader.activity',version:'1',appVersion:'1.2',kind:'article',fields:['title'],source:'configured',applicability:'unused'},
  ]);
});
