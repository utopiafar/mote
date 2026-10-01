import {z} from 'zod';

export const recordingSelectionSchema=z.object({
 enabled:z.boolean(),start:z.string().datetime({offset:true}),end:z.string().datetime({offset:true}).optional(),
 autoSync:z.boolean(),backupAudio:z.literal(true).default(true),
}).strict().refine(v=>!v.end||Date.parse(v.end)>=Date.parse(v.start),{message:'Invalid recording range'});
export type RecordingSelection=z.infer<typeof recordingSelectionSchema>;
export interface RecordingStatus {
 category?:'recordings';label?:string;setup?:{description?:string;command?:string;documentationUrl?:string};
 provider:string;connected:boolean;accountName?:string;sourceId?:string;selection:RecordingSelection;
 steps:{id:string;phase:string;state:string;attempts:number;error?:string}[];
 counts:{transcripts:number;audio:number;pending:number;failed:number};error?:string;
}
