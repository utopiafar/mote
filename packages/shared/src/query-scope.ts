import {z} from 'zod';
import {sourceIdSchema} from './sources.js';

/** The discriminator distinguishes all sources from an explicit source or
 * evidence selection. Specified filters intersect: either empty array means no
 * originals. Neither a scope nor an anchor is an authorization. */
const filters={
  after:z.string().datetime({offset:true}).optional(),
  before:z.string().datetime({offset:true}).optional(),
  deviceId:sourceIdSchema.optional(),
  timeZone:z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},{message:'Unknown time zone'}).optional(),
  evidenceIds:z.array(z.string().uuid()).optional(),
};
export const queryScopeSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('all'),...filters}).strict(),
  z.object({kind:z.literal('selection'),sourceIds:z.array(sourceIdSchema).optional(),...filters}).strict(),
]).refine(value=>value.kind==='all'||value.sourceIds!==undefined||value.evidenceIds!==undefined,{message:'Selection requires sourceIds or evidenceIds'})
  .refine(value=>!value.after||!value.before||Date.parse(value.after)<Date.parse(value.before),{message:'Invalid time range'});
export type QueryScope=z.infer<typeof queryScopeSchema>;
