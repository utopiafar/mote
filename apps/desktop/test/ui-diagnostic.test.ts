import {expect,it} from 'vitest';
import {JSDOM} from 'jsdom';
import {appendDiagnostic,renderReadableFailure} from '../src/ui-diagnostic';

it('keeps an uncertain transport response readable without interpreting or losing its diagnostic bytes',()=>{
  const dom=new JSDOM('<div role="alert" hidden></div>'),root=dom.window.document.querySelector('div')!;
  const diagnostic='Error invoking remote method mote:ask: HTTP 503 <script>window.leaked=true</script>\nrequest abc';
  renderReadableFailure(root,'先刷新结果，避免重复发送。',diagnostic);
  expect(root.hidden).toBe(false);expect(root.firstChild?.textContent).toBe('先刷新结果，避免重复发送。');
  const details=root.querySelector('details')!;expect(details.open).toBe(false);expect(details.querySelector('pre')!.textContent).toBe(diagnostic);expect(root.querySelector('script')).toBeNull();
  renderReadableFailure(root,'请求失败，请重试','later failure');expect(root.querySelectorAll('details')).toHaveLength(1);expect(root.textContent).not.toContain('request abc');dom.window.close();
});

it('keeps the exact terminal run diagnostics alongside its readable completion status',()=>{
  const dom=new JSDOM('<div>回答未完成</div>'),root=dom.window.document.querySelector('div')!;
  const payload=JSON.stringify({id:'same-run',status:'failed',error:{code:'provider_failed',message:'HTTP503'},events:[{tool:'material_read',message:'private diagnostic'}]});
  appendDiagnostic(root,payload);expect(root.firstChild?.textContent).toBe('回答未完成');expect(root.querySelector('details')!.open).toBe(false);expect(JSON.parse(root.querySelector('pre')!.textContent!)).toEqual(JSON.parse(payload));dom.window.close();
});
