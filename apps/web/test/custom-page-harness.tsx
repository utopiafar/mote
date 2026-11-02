import {createRoot} from 'react-dom/client';
import {createElement} from 'react';
import {CustomPluginPage} from '../src/plugin-host/custom-page';
// Observe actual host MessageChannel construction BEFORE any mount —
// channel issuance is the only way an RPC carrier could be created.
(window as any).channelsCreated = 0;
const NativeMessageChannel = window.MessageChannel;
(window as any).MessageChannel = class extends NativeMessageChannel {
  constructor() { super(); (window as any).channelsCreated++; }
};
(window as any).got = [];
window.addEventListener('message', e => {(window as any).got.push(e.data);});
createRoot(document.getElementById('root')!).render(createElement(CustomPluginPage, {
  entryUrl: '/entry1.html', title: 'generated page',
}));
