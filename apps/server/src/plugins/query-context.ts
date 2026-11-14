import {ContextQuery} from '../context-query.js';
import {formatEvidenceRef} from '@mote/shared';
import type {EvidenceReader} from '../evidence-reader.js';
import type {SourceStore} from '../sources.js';
import type {ContextInventoryRead} from './central-contracts.js';

type ContextQueryReader=Pick<EvidenceReader,'records'|'search'|'evidence'|'archivedEvidence'|'artifact'|'memories'|'memory'|'memoryPage'|'memoryAsync'|'memoryPageAsync'|'memoryBindings'>;

/** Composition binds read-only inventory and reader ports without giving
 * ContextQuery a database, Memory writer or provider binding. */
export function createContextQuery(store:{stats:ContextInventoryRead['archive']['stats']},sources:Pick<SourceStore,'listSources'>,reader:ContextQueryReader){
  return new ContextQuery({
    records:reader.records.bind(reader),search:reader.search.bind(reader),
    evidence:(refs,scope)=>{
      const archived=reader.archivedEvidence(refs,scope),files=archived.filter(record=>record.source==='file');
      // Owner context retains other immutable originals, including withdrawn
      // source items. Files keep their current revision/source grant here;
      // explicit historical originals remain available through the file archive.
      const currentFiles=new Set(files.length?reader.evidence(files.map(record=>formatEvidenceRef('capture',record.id)),scope).map(record=>record.id):[]);
      return archived.filter(record=>record.source!=='file'||currentFiles.has(record.id));
    },artifact:reader.artifact.bind(reader),
  },{
    memory:reader.memory.bind(reader),memoryPage:reader.memoryPage.bind(reader),
    memoryAsync:reader.memoryAsync.bind(reader),memoryPageAsync:reader.memoryPageAsync.bind(reader),
  },{
    archive:{stats:store.stats.bind(store)},sources:{listSources:sources.listSources.bind(sources)},
    latestMemoryCreatedAt:()=>{
      const latest=reader.memories.page({level:'overview',limit:1,includeStale:true}).items[0] as {createdAt?:string}|undefined;
      return latest?.createdAt??null;
    },
  },()=>reader.memoryBindings?.retainSnapshot());
}
