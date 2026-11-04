import type {MediaAssets} from '../media-assets.js';
import type {Store} from '../store.js';

/** C18 media members. Image operations are plugin ports, not bridge members. */
export interface MediaFeatureServices {
  mediaAssets:MediaAssets;
  mediaRange:RequestParser<NonNullable<Parameters<Store['mediaActivity']>[0]>>;
  withMediaOwnerBatch:<T>(ids:readonly string[],task:()=>T)=>Promise<T>;
  withMediaOwnerIntent:<T>(id:string,task:()=>T|Promise<T>)=>Promise<T>;
}

export interface RequestParser<T>{parse(input:unknown):T}

export const mediaFeatureServiceMembers = ['mediaAssets','mediaRange','withMediaOwnerBatch','withMediaOwnerIntent'] as const satisfies readonly (keyof MediaFeatureServices)[];
