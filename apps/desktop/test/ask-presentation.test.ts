import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderAskAnswer, renderAskCitation, renderAskScope } from '../src/ask-presentation';
const id = '11111111-2222-4333-8444-555555555555';
const citation = { id, appName: 'Generated note', capturedAt: '2026-09-27', excerpt: 'Generated full excerpt\n末尾不丢失' };
it('formats prose and only declared citations, keeping code and authored links inert', () => {
  const document = new JSDOM('').window.document, opened: string[] = [];
  const view = renderAskAnswer(document, `# Result\n\n**Confirmed** [${id}]\n- first\n- second\n\n\`[${id}]\`\n\n[other-id]\n[${id}](https://example.test)`, [citation], value => opened.push(value));
  expect(view.querySelector('h3')?.textContent).toBe('Result');
  expect(view.querySelector('strong')?.textContent).toBe('Confirmed');
  expect(view.querySelectorAll('li')).toHaveLength(2);
  expect(view.querySelectorAll('button')).toHaveLength(1);
  view.querySelector('button')!.click(); expect(opened).toEqual([id]);
  expect(view.querySelector('code')?.textContent).toBe(`[${id}]`);
  expect(view.textContent).toContain('[other-id]');
  expect(view.querySelector('a')).toBeNull();
});
it('never interprets HTML, images, scripts or URLs as executable content', () => {
  const document = new JSDOM('').window.document;
  const text = '<script>window.bad=true</script>\n<img src="https://example.test/private">\n[run](javascript:alert(1))\n![image](https://example.test/private)\n```html\n<button onclick="bad()">untrusted</button>\n```';
  const view = renderAskAnswer(document, text, [], () => { throw Error('must not navigate'); });
  expect(view.querySelectorAll('script,img,a,button')).toHaveLength(0);
  expect(view.textContent).toContain('<img src="https://example.test/private">');
  expect(view.querySelector('pre code')?.textContent).toBe('<button onclick="bad()">untrusted</button>');
});
it('keeps exact evidence text and a visible original action outside the excerpt disclosure', () => {
  const document = new JSDOM('').window.document, opened: string[] = [];
  const view = renderAskCitation(document, citation, value => opened.push(value));
  expect(view.querySelector('.ask-excerpt')?.textContent).toBe(citation.excerpt);
  expect(view.querySelector('details button')).toBeNull();
  view.querySelector('button')!.click(); expect(opened).toEqual([id]);
  expect(view.querySelector('p')?.textContent).not.toContain(id);
});

it('distinguishes strict records from reference records and opens exact original identities', () => {
  const document = new JSDOM('').window.document, opened: string[] = [];
  for (const [scope, wording] of [[{evidenceIds:[id]}, '严格范围：只查询'], [{anchorEvidenceIds:[id]}, '其他已授权内容']] as const) {
    const view = renderAskScope(document, {...scope, ...('evidenceIds' in scope ? {evidenceIds:[id]} : {anchorEvidenceIds:[id]})}, value => opened.push(value));
    expect(view.textContent).toContain(wording); view.querySelector('button')!.click();
  }
  expect(opened).toEqual([id,id]);
  expect(renderAskScope(document, {}, () => {}).textContent).toContain('未额外限定记录');
  const unavailable = renderAskScope(document, {evidenceIds:[id]}, () => {}, true);
  expect(unavailable.textContent).toContain('暂不可用'); expect(unavailable.querySelector('button')).toBeNull();
});
it('renders other current filters as literal text without granting navigation', () => {
  const document = new JSDOM('').window.document;
  const view = renderAskScope(document, {deviceId:'<img src=evil>',after:'2026-01-01'}, () => {});
  expect(view.textContent).toContain('<img src=evil>'); expect(view.querySelector('img')).toBeNull();
});
