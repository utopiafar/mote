import {createRoot} from 'react-dom/client';
import {createElement, useRef, useState} from 'react';
import {CustomPluginPage} from '../src/plugin-host/custom-page';
const Harness = (window as any).__HARNESS__ as {entry1: string; entry2: string; nonce: string; documentKey: string};
let generation = 1, visible = true;
(window as any).got = [];
(window as any).calls = [];
(window as any).responseCount = 0;
window.addEventListener('message', e => {(window as any).got.push(e.data);const f=document.querySelector('iframe');(window as any).srcMatch=e.source===f?.contentWindow;});
const HarnessApp = () => {
  const [docKey, setDocKey] = useState(Harness.documentKey);
  const calls: string[] = (window as any).calls;
  return createElement(CustomPluginPage, {
    entryUrl: '/entry1.html',
    instanceId: 'inst:one', nonce: Harness.nonce, documentKey: docKey,
    generation: () => generation, visible: () => visible,
    declared: ['read'], title: 'generated page',
    invoke: async (method: string, p: unknown) => { calls.push(method + ':' + JSON.stringify(p ?? null)); await new Promise(r => setTimeout(r, 400)); return 'ok-' + method; },
    onNavigated: () => { setDocKey('rotated-' + Math.random().toString(36).slice(2)); },
    onRejected: (r: string) => { (window as any).rejected = ((window as any).rejected || '') + r + ';'; },
  });
};
createRoot(document.getElementById('root')!).render(createElement(HarnessApp));
