import type {ImportStore} from '../imports.js';

/** C20 imports members. */
export interface ImportsFeatureServices {
  imports:ImportStore;
  importTasks:Map<string,Promise<unknown>>;
  launchImport:(id:string,task:()=>Promise<unknown>)=>void;
  launchOwnerImport:(id:string,task:()=>Promise<unknown>)=>void;
}

export const importsFeatureServiceMembers = ['imports','importTasks','launchImport','launchOwnerImport'] as const satisfies readonly (keyof ImportsFeatureServices)[];
