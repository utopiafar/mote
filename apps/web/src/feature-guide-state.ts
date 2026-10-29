import type {Api} from './api';
type GuideVisit={query:string;expanded:string[];scroll:number;origin?:string;returnAvailable:boolean};
const visits=new WeakMap<Api,GuideVisit>();
/** Directory-only presentation state is isolated by verified API identity. */
export function guideVisit(api:Api):GuideVisit{
 let visit=visits.get(api);
 if(!visit){visit={query:'',expanded:[],scroll:0,returnAvailable:false};visits.set(api,visit);}
 return visit;
}
export function enterGuide(api:Api,origin:string){const visit=guideVisit(api);visit.origin=origin;visit.returnAvailable=false;}
export function leaveGuide(api:Api){guideVisit(api).returnAvailable=true;}
