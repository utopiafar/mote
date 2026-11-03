import {createRoot, type Root} from 'react-dom/client';
import {createElement} from 'react';
import {CustomPluginPage} from '../src/plugin-host/custom-page';

interface HarnessIdentity {
  nonce: string;
  nonce2: string;
  documentKey: string;
  documentKey2: string;
  instanceId: string;
}
interface BridgeReceipt {
  data: {kind: string; page: string; handshake: Record<string, unknown>};
  port: MessagePort;
}
interface Call {
  method: string;
  payload: unknown;
}

const H = (window as any).__HARNESS__ as HarnessIdentity;
const state = window as any;
state.channelsCreated = 0;
const NativeMessageChannel = window.MessageChannel;
state.MessageChannel = class extends NativeMessageChannel {
  constructor() { super(); state.channelsCreated++; }
};
state.calls = [] as Call[];
state.rejected = [] as string[];
state.got = [] as unknown[];
state.bridges = [] as BridgeReceipt[];
state.readGates = [] as (() => void)[];
window.addEventListener('message', event => {
  state.got.push(event.data);
  if (event.data?.kind === 'bridge-port' && event.ports[0]) {
    const port = event.ports[0];
    port.onmessage = reply => state.got.push({kind: 'rpc-response', page: event.data.page, data: reply.data});
    port.start();
    state.bridges.push({data: event.data, port});
  }
});
const invoke = async (method: string, payload: unknown) => {
  state.calls.push({method, payload});
  if ((payload as {hold?: boolean})?.hold)
    await new Promise<void>(resolve => state.readGates.push(resolve));
  return 'ok-' + method;
};
const mount = (nonce: string, documentKey: string, entryUrl: string) => ({
  entryUrl: location.origin + entryUrl,
  title: 'generated page',
  instanceId: H.instanceId,
  nonce,
  documentKey,
  declared: ['read'],
  invoke,
  visible: () => true,
  onRejected: (reason: string) => state.rejected.push(reason),
});
let root: Root = createRoot(document.getElementById('root')!);
root.render(createElement(CustomPluginPage, mount(H.nonce, H.documentKey, '/entry1.html')));
state.__unmount = () => root.unmount();
state.__reinstall = () => {
  root = createRoot(document.getElementById('root')!);
  root.render(createElement(CustomPluginPage, mount(H.nonce2, H.documentKey2, '/entry3.html')));
};
