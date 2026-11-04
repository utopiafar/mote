import {registerLibrarySourceView} from '../library-source-view.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ConnectionCredential} from '../connections.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {MaterialStore} from '../materials.js';
import type {SourceStore} from '../sources.js';
import type {Store} from '../store.js';
import type {FeatureRoute} from './index.js';

export interface SourcesFeatureDependencies {
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly evidenceReader:EvidenceReader;
  readonly sources:SourceStore;
  readonly store:Store;
  readonly materials:MaterialStore;
}

/** sources: retains the library view; C09 owns source polling and transport. */
export function sourcesFeature(dependencies:SourcesFeatureDependencies):FeatureRoute {
  return Object.freeze({id:'mote.sources',mount(app:FastifyInstance){
    registerLibrarySourceView(app,{store:dependencies.store,sources:dependencies.sources,materials:dependencies.materials,evidenceReader:dependencies.evidenceReader,credential:dependencies.credential});
  }});
}
