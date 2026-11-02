import {createRoot} from 'react-dom/client';
import {createElement} from 'react';
import {CustomPluginPage} from '../src/plugin-host/custom-page';
const H = (window as any).__HARNESS__ as {nonce: string; nonce2: string; instanceId: string; documentKey: string};
(window as any).calls = [];
(window as any).got = [];
window.addEventListener('message', e => {(window as any).got.push(e.data);});
const invoke = async (method: string, p: unknown) => {
  (window as any).calls.push(method + ':' + JSON.stringify(p ?? null));
  await new Promise(r => setTimeout(r, 400));
  return 'ok-' + method;
};
const mount = (nonce: string, key: string, entry: string) => ({
  entryUrl: location.origin + entry, instanceId: H.instanceId, nonce, documentKey: key,
  declared: ['read'], invoke, visible: () => true, title: 'generated page',
});
const root = createRoot(document.getElementById('root')!);
root.render(createElement(CustomPluginPage, mount(H.nonce, H.documentKey, '/entry1.html')));
(window as any).__mountSecond = () => {
  const div = document.createElement('div'); document.body.append(div);
  createRoot(div).render(createElement(CustomPluginPage, mount(H.nonce2, 'doc2', '/entry4.html')));
};
