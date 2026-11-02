import type {CaptureRecord} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {StoreError,type Range,type Store} from '../store.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialNoteDeletion} from '../material-note-deletion.js';

/** C10B's first, independently completable slice. The write receipt stays on
 * the existing feature ingress until C10A freezes its intake port. These
 * dependencies are trusted-assembly functions from current production, never
 * a published Store, generic writer or synthetic C19D/C24 contract. */
export interface NotesSourceDependencies {
  /** Note-only page using the existing Store.list cursor and total semantics. */
  readonly page:(args:Range)=>ReturnType<Store['list']>;
  readonly attribution:(record:CaptureRecord)=>ReturnType<MaterialStore['contextForEvidence']>;
  readonly evidence:(ids:string[])=>ReturnType<Store['evidence']>;
  /** Current DELETE /api/notes/:id semantics; material aliases stay on the
   * capture/EvidenceDeletion path. */
  readonly deleteNote:(id:string)=>ReturnType<Store['delete']>;
  readonly noteDeletion:Pick<MaterialNoteDeletion,'resolve'>;
}
export type NotesAttribution=ReturnType<MaterialStore['contextForEvidence']>;
export type NoteListPage=Omit<ReturnType<Store['list']>,'items'> & {items:(CaptureRecord&{attributionContext:NotesAttribution})[]};
export type NoteDeleteResult=ReturnType<Store['delete']>;
export type MaterialNoteAlias=ReturnType<MaterialNoteDeletion['resolve']>;

/** H03 owns the package Manifest. C10A's frozen intake adds the exact host
 * requirement; this first slice publishes no ordinary service. */
export const notesSourceContribution={
  id:'notes-source',version:'1.0.0',surface:'data',runtime:'host',provides:[],
} as const satisfies ManifestContribution;
export const notesSourceDeclaration={id:notesSourceContribution.id,apiVersion:'1'} as const;
export const notesSourceReplacement='hot' as const;

/** Trusted feature wiring only; never a published service. */
export interface NotesSourceAssembly {
  list(args:Range):NoteListPage;
  delete(id:string):NoteDeleteResult;
  resolve(id:string):MaterialNoteAlias;
}
export interface NotesSource extends PluginLifecycle {
  assemblyForRoutes():NotesSourceAssembly;
  close():Promise<void>;
}

export function createNotesSource(dependencies:NotesSourceDependencies):NotesSource {
  const {page,attribution,evidence,deleteNote,noteDeletion}=dependencies;
  if(!page||!attribution||!evidence||!deleteNote||!noteDeletion)throw new StoreError('Notes source dependencies are unavailable',503);
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created',closing:Promise<void>|undefined;
  const unavailable=()=>new StoreError('Notes source is unavailable',503);
  const readable=()=>phase==='prepared'||phase==='active'||phase==='quiescing';
  const closeOnce=()=>closing??=(async()=>{phase='stopped';})();
  const assembly:NotesSourceAssembly=Object.freeze({
    list(args:Range){
      if(!readable())throw unavailable();
      const result=page(args);
      return {...result,items:result.items.map(record=>({...record,attributionContext:attribution(record)}))};
    },
    delete(id:string){
      if(phase!=='active')throw unavailable();
      const record=evidence([id])[0];
      if(record&&record.source!=='note')throw new StoreError('Note not found',404);
      return deleteNote(id);
    },
    resolve(id:string){if(!readable())throw unavailable();return noteDeletion.resolve(id);},
  });
  return Object.freeze({
    prepare(){if(phase!=='created')throw unavailable();phase='prepared';},
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async()=>{await closeOnce();},
    dispose:closeOnce,close:closeOnce,
    assemblyForRoutes(){if(phase!=='prepared'&&phase!=='active')throw unavailable();return assembly;},
  });
}

/** Trusted H04/C10 wiring; no service, Store or writer leaves this factory. */
export function createNotesSourceFactory(dependencies:NotesSourceDependencies){
  return (context:HostPluginContext):PluginLifecycle=>{
    const source=createNotesSource(dependencies);
    context.scope.defer(()=>source.close());
    return {prepare:()=>source.prepare(),start:()=>source.start(),quiesce:(reason:StopReason)=>source.quiesce(reason),stop:(reason:StopReason)=>source.stop(reason),dispose:()=>source.dispose()};
  };
}
