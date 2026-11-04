import {registerLibrarySourceView} from '../library-source-view.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ConnectionCredential} from '../connections.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {MaterialStore} from '../materials.js';
import type {SourceStore} from '../sources.js';
import type {Store} from '../store.js';
import type {FeatureRoute,FeatureScope} from './index.js';

export interface SourcesFeatureDependencies {
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly evidenceReader:EvidenceReader;
  readonly sources:SourceStore;
  readonly store:Store;
  readonly materials:MaterialStore;
  readonly sourcePipelines:{tick():Promise<unknown>;close():unknown};
}

/** sources: retains polling and the library view; C10 owns source transport. */
export function sourcesFeature(dependencies:SourcesFeatureDependencies):FeatureRoute {
  const {sourcePipelines}=dependencies;
  return Object.freeze({id:'mote.sources',mount(app:FastifyInstance,scope:FeatureScope){
    scope.every(5000,()=>sourcePipelines.tick());scope.defer(()=>sourcePipelines.close());
    registerLibrarySourceView(app,{store:dependencies.store,sources:dependencies.sources,materials:dependencies.materials,evidenceReader:dependencies.evidenceReader,credential:dependencies.credential});
  }});
}
