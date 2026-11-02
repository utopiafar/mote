import {createRoot} from 'react-dom/client';
import {createElement} from 'react';
import {CustomPluginPage} from '../src/plugin-host/custom-page';
const Harness = (window as any).__HARNESS__ as {nonce: string; documentKey: string};
(window as any).got = [];
(window as any).invokeCalls = [];
window.addEventListener('message', e => {(window as any).got.push(e.data);});
// Fail-closed fixture: the component renders the sandboxed entry but
// issues no channel — there is no invoker at all; any attempt by a page
// document (or a leaked holder) can only count against this stub.
const invokeStub = (method: string, p: unknown) => { (window as any).invokeCalls.push(method + ':' + JSON.stringify(p ?? null)); };
createRoot(document.getElementById('root')!).render(createElement(CustomPluginPage, {
  entryUrl: '/entry1.html', title: 'generated page',
}));
