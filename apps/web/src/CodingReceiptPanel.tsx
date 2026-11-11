import {moteText} from '@mote/shared/i18n';
import type {Api} from './api';
import {useResource} from './useResource';
import {CodingUploads} from './CodingUploads';
import {useDiscoveryState,discoveryAvailabilityText} from './DiscoveryLink';
import {resolveDiscoveryTarget} from './discovery-availability';
import { LoadingText } from './Loading';

type Receipt={received:{events:number};materials:number;work:{state:string;count:number}[];memory:{state:string;count:number}[]};
const target={pageId:'archive',collectionId:'coding-status',href:'#/library?view=coding-status'};
/** Optional Coding support does not become a dependency of unrelated work. */
export function CodingReceiptPanel({api}:{api:Api}){
 const state=useDiscoveryState(api),availability=resolveDiscoveryTarget(target,state);
 if(availability.state==='unavailable')return null;
 if(availability.state!=='available')return <section className="panel panel-pad coding-receipt-summary"><h2>{moteText('Coding 会话接收状态')}</h2><p role="status">{discoveryAvailabilityText(availability.state)}</p></section>;
 return <CodingReceiptContent api={api}/>;
}
function CodingReceiptContent({api}:{api:Api}){
 const receipt=useResource<{items:Receipt[];nextOffset:number|null}>(api,'/api/coding/uploads?offset=0&limit=20',5000);
 const items=receipt.data?.items??[];
 const attention=items.some(item=>[...item.work,...item.memory].some(work=>['blocked','failed'].includes(work.state)));
 return <section className="panel panel-pad coding-receipt-summary"><h2>{moteText('Coding 会话接收状态')}</h2><p role="status">{receipt.error!==undefined?moteText('接收状态暂不可用，请展开重试。'):receipt.data?moteText('当前页 {0} 个来源 · 已接收 {1} 条增量 · 已发布 {2} 份会话{3}',items.length,items.reduce((n,i)=>n+i.received.events,0),items.reduce((n,i)=>n+i.materials,0),attention?moteText(' · 有处理事项需关注'):''):<LoadingText/>}</p><details><summary>{moteText('查看接收、发布、索引与记忆进度')}</summary><CodingUploads api={api} embedded/></details></section>;
}
