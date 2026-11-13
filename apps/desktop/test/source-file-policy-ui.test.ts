import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createSourceFilePolicyDraft } from '../src/source-file-policy-ui';

it('preserves explicit history and retention choices while switching import and continuous modes', () => {
  const dom=new JSDOM('<select id="history"><option value="all">All</option><option value="new_only">New only</option></select><select id="retention"><option value="snapshot">Snapshot</option><option value="reference">Reference</option><option value="archive">Archive</option></select>');
  const history=dom.window.document.querySelector<HTMLSelectElement>('#history')!,retention=dom.window.document.querySelector<HTMLSelectElement>('#retention')!;
  const draft=createSourceFilePolicyDraft(history,retention);
  history.value='new_only';history.dispatchEvent(new dom.window.Event('change'));
  retention.value='reference';retention.dispatchEvent(new dom.window.Event('change'));
  draft.setOneTime(true);
  expect(history.disabled).toBe(true);expect(history.value).toBe('all');expect(retention.value).toBe('reference');
  draft.setOneTime(false);
  expect(history.disabled).toBe(false);expect(history.value).toBe('new_only');expect(retention.value).toBe('reference');
  retention.value='archive';draft.setOneTime(true);draft.setOneTime(false);
  expect(history.value).toBe('new_only');expect(retention.value).toBe('archive');
  draft.reset();expect(history.value).toBe('all');expect(retention.value).toBe('snapshot');
  dom.window.close();
});
