import {moteText} from '@mote/shared/i18n';
import React from 'react';
import type {Api} from '../../api';
import {modelSetupHref} from '../../ModelStartGuide';
import type {PageEntry,PageProps} from '../../features/types';
import type {BuiltinWebPlugin} from '../types';
import {ImportQueue,importQueue} from './import-queue';

export const Imports=React.lazy(()=>import('./Imports').then(module=>({default:module.Imports})));

export {Files,FileDetail} from './Files';
export {FileReview,downloadFileExport} from './FileReview';
export {ImportQueueDetail,ImportQueueRow} from './ImportQueueEntry';
export {ImportQueue,importQueue,validateImportFiles,type ImportDraft,type ImportQueueEntry,type ImportQueueState,type ImportSource} from './import-queue';
export {uploadImportFiles} from './import-upload-scheduler';

const importOwners=new WeakMap<Api,number>();let nextImportOwner=0;
function importOwner(api:Api){let id=importOwners.get(api);if(id===undefined){id=++nextImportOwner;importOwners.set(api,id);}return id;}

export const pages:PageEntry[]=[
{id:'imports',route:'library/import',label:moteText('导入'),section:'library',order:8,featureId:'mote.imports',render:({api,onPage,onOpen:setEvidenceId,setArchiveTab,timelineRevision,refresh}:PageProps)=><Imports key={importOwner(api)} api={api} refreshVersion={timelineRevision} onOpen={setEvidenceId} onMemories={()=>{setArchiveTab("memories");onPage("archive");}} onSettings={()=>{window.location.hash=modelSetupHref('providers',window.location.hash);}} onChanged={refresh}/>},
];

/** The intake package owns the imports page, the session-scoped upload queue
 * and the file/recording surfaces it hands to the library view. */
export const intake:BuiltinWebPlugin={id:'mote.imports',pages};

/** Plugin-owned lifecycle: activation creates (or resumes) the upload queue,
 * deactivation pauses every in-flight upload while retaining the selected
 * files and their operation identities, and disposal ends the owner session. */
export function createIntakePlugin(options:{api:Api}){
 let queue:ImportQueue|undefined,active=false;
 return {
  id:'mote.imports' as const,
  get queue():ImportQueue|undefined{return queue;},
  activate():ImportQueue{queue??=importQueue(options.api);if(!active){active=true;queue.start();}return queue;},
  deactivate():void{if(!active)return;active=false;queue?.suspend();},
  dispose():void{active=false;queue?.close();queue=undefined;},
 };
}

export type IntakePlugin=ReturnType<typeof createIntakePlugin>;

const plugins=new WeakMap<Api,IntakePlugin>();
/** One plugin instance per owner connection; the page and the application
 * lifecycle share its queue, so page unmount cannot interrupt an upload. */
export function intakePlugin(api:Api){let plugin=plugins.get(api);if(!plugin){plugin=createIntakePlugin({api});plugins.set(api,plugin);}return plugin;}
