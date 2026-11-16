import {InsightRuns} from './insight-runs.js';
import type {Store} from './store.js';
import type {ExecutionEngine} from './execution-engine.js';
import type {EvidenceReader} from './evidence-reader.js';
import type {InsightServicesDependencies} from './plugins/insight-services.js';

/** Private persistence/execution adapter until those repositories own narrow
 * ports. It lends callbacks, never Store or SQL access, to the domain plugin.
 * Creating the adapter acquires no run manager, handler or timer. */
export function insightServiceInputs({store,executor,evidenceReader,...services}:Omit<InsightServicesDependencies,'openRuns'|'readHistory'|'readReport'>&{
  readonly store:Store;readonly executor:ExecutionEngine;readonly evidenceReader:EvidenceReader;
}):InsightServicesDependencies{
  return Object.freeze({...services,
    openRuns:()=>new InsightRuns(store,{executor,evidenceReader}),
    readHistory:(query:unknown)=>store.insights(query),readReport:(id:string)=>store.insight(id),
  });
}
