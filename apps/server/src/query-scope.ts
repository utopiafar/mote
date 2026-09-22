import {z} from 'zod';
export type QueryScope = {after?:string;before?:string;deviceId?:string;timeZone?:string};
export const scopeFields={after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),deviceId:z.string().min(1).max(200).optional(),timeZone:z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},{message:'Unknown time zone'}).optional()};
export const validRange=(v:QueryScope)=>!v.after||!v.before||Date.parse(v.after)<Date.parse(v.before);
