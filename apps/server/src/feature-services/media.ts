import type {ImageProcessing} from '../image-processing.js';
import type {MediaAssets} from '../media-assets.js';
import type {MediaPreparation} from '../media-preparation.js';
import type {Store} from '../store.js';

/** C18 media members. */
export interface MediaFeatureServices {
  mediaAssets:MediaAssets;
  mediaPreparation:MediaPreparation;
  perception:ImageProcessing;
  mediaRange:RequestParser<NonNullable<Parameters<Store['mediaActivity']>[0]>>;
  withMediaOwnerBatch:<T>(ids:readonly string[],task:()=>T)=>Promise<T>;
  withMediaOwnerIntent:<T>(id:string,task:()=>T|Promise<T>)=>Promise<T>;
}

export interface RequestParser<T>{parse(input:unknown):T}

export const mediaFeatureServiceMembers = ['mediaAssets','mediaPreparation','perception','mediaRange','withMediaOwnerBatch','withMediaOwnerIntent'] as const satisfies readonly (keyof MediaFeatureServices)[];
