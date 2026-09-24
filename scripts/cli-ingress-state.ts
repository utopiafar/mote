import {rm} from 'node:fs/promises';
import {sourceWork} from '../apps/desktop/src/background.js';
import type {SourceSync} from '../apps/desktop/src/source-sync.js';

/** The v2 outbox deliberately rejects old receipts. Remove originals that can
 * no longer be referenced after its reset, while preserving current spools. */
export async function initializeCliIngressState(statePath:string,engine:SourceSync):Promise<{reset:boolean}> {
  const previous=await sourceWork.run<Record<string,unknown>|undefined>({kind:'source-state',path:statePath});
  // Clear before resetting the outbox so an interrupted migration cannot leave
  // unreferenced original bytes behind under an already-current v2 state.
  if(previous?.ingressVersion!==2)await rm(statePath+'.atime.json.originals',{recursive:true,force:true});
  await engine.initialize();
  return {reset:previous!==undefined&&previous.ingressVersion!==2};
}
