import type {SourceControlPort} from './source-runtime-storage.js';

/** Owner archive overview. Each domain owns its queries; this read model owns
 * the cross-domain response shared by source transport and its consumers. */
export class LayersReadModel {
 constructor(private sources:Pick<SourceControlPort,'summary'>,private memories:()=>number){}
 summary(){return {...this.sources.summary(),memories:this.memories()};}
}
