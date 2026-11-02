import {EvidenceReader} from '../../src/evidence-reader.js';
import type {FileStore} from '../../src/files.js';
import type {MaterialOrganizerRuntime} from '../../src/material-organizers.js';
import type {MaterialStore} from '../../src/materials.js';
import type {SourcePipelineRuntime} from '../../src/source-pipelines.js';
import type {SourceStore} from '../../src/sources.js';
import type {Store} from '../../src/store.js';

/** Test injection point for the roots-owned reader. Production passes the one
 * reader built by the evidence-context factory; connector fixtures that never
 * read evidence still need the same required object. */
export function connectorReader(store:Store,sources:SourceStore,
  extra:{files?:FileStore;materials?:MaterialStore;sourcePipelines?:SourcePipelineRuntime;materialOrganizers?:MaterialOrganizerRuntime}={}){
  return new EvidenceReader(store,sources,extra.files,undefined,undefined,extra.materials,extra.sourcePipelines,extra.materialOrganizers?.sourceItemRecipes);
}
