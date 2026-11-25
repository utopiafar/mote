import {StoreError} from './evidence-store.js';

export interface CivilDay {day:string;after:string;before:string}

/** Split civil dates at their actual instants, including 23/25-hour DST days. */
export function dayBuckets(after:string,before:string,timeZone:string):CivilDay[] {
 let formatter:Intl.DateTimeFormat;try{formatter=new Intl.DateTimeFormat('en',{timeZone,calendar:'iso8601',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit'});}catch{throw new StoreError('Invalid timeline time zone');}
 const day=(at:number)=>{const p=Object.fromEntries(formatter.formatToParts(new Date(at)).map(part=>[part.type,part.value]));return `${p.year}-${p.month}-${p.day}`;};
 const end=Date.parse(before),result:CivilDay[]=[];let at=Date.parse(after);
 while(at<end){
  const label=day(at);let low=at,high=Math.min(end,at+6*3600000);
  while(high<end&&day(high)===label){low=high;high=Math.min(end,high+6*3600000);}
  if(day(high-1)===label&&high===end){result.push({day:label,after:new Date(at).toISOString(),before});break;}
  while(high-low>1){const middle=Math.floor((low+high)/2);if(day(middle)===label)low=middle;else high=middle;}
  result.push({day:label,after:new Date(at).toISOString(),before:new Date(high).toISOString()});at=high;
  if(result.length>40)throw new StoreError('Choose a shorter timeline range');
 }
 return result;
}
