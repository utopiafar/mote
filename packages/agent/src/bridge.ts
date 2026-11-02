import {createContextToolSession} from './context-tool-session.js';
import {startBridgeTransport} from './bridge-transport.js';
import type {ContextReader} from './context-contracts.js';
import type {QueryInput} from './query-contracts.js';

export {TOOL_NAMES,originalEvidenceReceipt} from './context-tool-session.js';
export type {PreparedToolDelivery,PrepareToolDelivery} from './bridge-contracts.js';

/** Compose a private transport with one query-local authorization/disclosure session. */
export async function startBridge(reader:ContextReader,bounds:QueryInput,maxToolCalls?:number) {
  const {handle,session,close:closeSession}=await createContextToolSession(reader,bounds,maxToolCalls);
  let transport:Awaited<ReturnType<typeof startBridgeTransport>>;
  try {
    transport=await startBridgeTransport(handle);
  } catch(error) {
    closeSession();
    throw error;
  }
  return Object.assign(session,{
    url:transport.url,
    token:transport.token,
    async close() {
      closeSession();
      await transport.close();
    },
  });
}
