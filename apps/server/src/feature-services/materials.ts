import type {createContextTrees} from '../context-trees.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import type {MaterialOrganizerRuntime} from '../material-organizers.js';
import type {MaterialStore} from '../materials.js';
import type {RetrievalIndex} from '../plugins/central-contracts.js';

/** C19 materials members. */
export interface MaterialsFeatureServices {
  materials:MaterialStore;
  materialOrganizer:MaterialOrganizerRuntime;
  materialMemoryWork:MaterialMemoryWork;
  indexer:RetrievalIndex;
  evidenceReader:EvidenceReader;
  contextTrees:ReturnType<typeof createContextTrees>;
}

export const materialsFeatureServiceMembers = ['materials','materialOrganizer','materialMemoryWork','indexer','evidenceReader','contextTrees'] as const satisfies readonly (keyof MaterialsFeatureServices)[];
