import { useState } from 'react';
import {confirmNavigation} from './unsaved';
import {useDiscoveryState,discoveryAvailabilityText} from './DiscoveryLink';
import {resolveDiscoveryTarget} from './discovery-availability';
import { moteText } from '@mote/shared/i18n';
import { ApiError,type Api, bytes, dateTime,errorMessage } from './api';
import { useResource } from './useResource';
import {resources} from './resource-cache';
type Upload = {
    source: {
        id: string;
        name: string;
        deviceId: string;
        enabled: boolean;
        status?: {
            state: string;
            lastSyncAt?: string;
        };
    };
    received: {
        events: number;
        lastObservedAt: string | null;
    };
    archiveBytes: number;
    materials: number;
    indexedMaterials: number;
    memory: {
        state: string;
        count: number;
    }[];
    work: {
        state: string;
        count: number;
    }[];
    pipeline: string | null;
};
function stateLabel(state: string) {
    const labels: Record<string, string> = { not_requested: moteText("未安排"), waiting: moteText("等待处理"), pending: moteText("等待处理"), queued: moteText("排队中"), running: moteText("处理中"), complete: moteText("已完成"), completed: moteText("已完成"), blocked: moteText("需要处理，查看具体原因"), failed: moteText("失败，需关注"), waiting_for_model: moteText("等待配置模型"), waiting_for_input: moteText("等待输入或澄清"), paused: moteText("已暂停"), pausing: moteText("当前批次结束后暂停"), cancelled: moteText("已取消"), stale: moteText("输入已变更"), invalidated: moteText("证据已失效"), disabled: moteText("未启用") };
    return moteText(labels[state] ?? '未知状态');
}
function counts(rows: {
    state: string;
    count: number;
}[], empty: string) { return rows.map(row => `${stateLabel(row.state)}: ${row.count}`).join(' · ') || empty; }
export function CodingUploads({ api, embedded = false,onOpen }: {
    api: Api;
    embedded?: boolean;
    onOpen?:(ref:string)=>void;
}) {
    const Heading = embedded ? 'h3' : 'h1';
    const discovery=useDiscoveryState(api),browse=resolveDiscoveryTarget({pageId:'archive',collectionId:'materials',href:'#/library?view=materials'},discovery);
    const [paging,setPaging]=useState({owner:api,offset:0});
    const offset=paging.owner===api?paging.offset:0,setOffset=(offset:number)=>setPaging({owner:api,offset});
    const page = useResource<{
        items: Upload[];
        nextOffset: number | null;
    }>(api, `/api/coding/uploads?offset=${offset}&limit=20`, 5000);
    return <div className="coding-uploads special-coding" role={embedded?'region':undefined} aria-label={embedded?moteText('Coding 会话同步状态'):undefined} tabIndex={embedded?0:undefined}>
  <div className="page-heading"><Heading>{moteText("Coding 会话同步状态")}</Heading></div>
  <details className="coding-intake-help"><summary>{moteText('接入说明')}</summary><p>{moteText("查看 Mac 客户端同步到中央的结果。增量事件接收、会话正文发布、索引与记忆分别推进；事件条数与会话份数不能直接比较。")}</p><p>{moteText("接收成功或任务完成不代表源会话内容完整；请在会话正文中另行核对覆盖范围和缺片提示。")}</p><h3>{moteText("从 Mac 客户端接入")}</h3><p>{moteText("先安装 Mac 客户端并连接中央，再在客户端打开「来源 → 连接 Coding Agent」，选择本机实际存在的 Claude Code、Codex 或 Kimi 和采集范围，启动同步。这里查看同步状态；本机采集由客户端控制。")}</p><div className="processing-actions"><a className="text-button" href="https://github.com/utopiafar/mote/releases" target="_blank" rel="noreferrer">{moteText("下载 Mac 客户端 →")}</a><a className="text-button" href="#/connections/pair">{moteText("连接到中央 →")}</a>{!embedded&&<a className="text-button" href="#/activity?coding=receipts">{moteText("在处理任务中查看接收状态 →")}</a>}</div><p>{moteText("已有文件、ZIP 和文件夹可使用「导入资料」。")} <a className="text-button" href="#/library/import">{moteText("导入资料 →")}</a></p></details>
  {page.error !== undefined && <p role="alert">{errorMessage(page.error)}</p>}
  {!page.data && page.loading && <p role="status">{moteText("正在读取同步状态…")}</p>}
  {page.data?.items.map(item=><article key={item.source.id} className="coding-source"><h3>{item.source.name}</h3><div className="coding-stages"><section><span>{moteText('接收')}</span><strong>{Number.isSafeInteger(item.received.events)&&item.received.events>=0?moteText('{0} 个事件',item.received.events):moteText('待确认')}</strong><p>{item.received.lastObservedAt?moteText('最近接收 {0}',dateTime(item.received.lastObservedAt)):moteText('尚无同步时间')}</p></section><section><span>{moteText('正文')}</span><strong>{Number.isSafeInteger(item.materials)&&item.materials>=0?moteText('{0} 份已发布',item.materials):moteText('待确认')}</strong><p>{counts(item.work,moteText('暂无处理任务'))}</p></section><section><span>{moteText('索引')}</span><strong>{Number.isSafeInteger(item.indexedMaterials)&&item.indexedMaterials>=0?moteText('{0} 份可检索',item.indexedMaterials):moteText('待确认')}</strong></section><section><span>{moteText('记忆')}</span><strong>{item.memory.length===1?stateLabel(item.memory[0].state):item.memory.length?moteText('记忆整理'):moteText('未安排')}</strong><p>{counts(item.memory,moteText('未安排'))}</p></section></div><CodingPublished api={api} sourceId={item.source.id} expected={item.materials} availability={browse.state} onOpen={onOpen}/><details className="coding-receipt-details"><summary>{moteText('接收与存储')}</summary><dl><dt>{moteText('已接收事件')}</dt><dd>{item.received.events}</dd><dt>{moteText('原件大小')}</dt><dd>{bytes(item.archiveBytes)}</dd><dt>{moteText('设备')}</dt><dd>{item.source.deviceId}</dd><dt>{moteText('来源接收')}</dt><dd>{item.source.enabled?moteText('已启用'):moteText('已暂停')}</dd></dl><p>{moteText('索引进度以实际可检索份数为准。')}</p><details><summary>{moteText('技术状态码')}</summary><p>{moteText('正文处理：')}{item.work.map(row=>`${row.state}: ${row.count}`).join(' · ')||'—'}</p><p>{moteText('记忆整理：')}{item.memory.map(row=>`${row.state}: ${row.count}`).join(' · ')||'—'}</p></details></details><a className="text-button coding-all-materials" href={'#/library?view=materials&sourceId='+encodeURIComponent(item.source.id)}>{moteText("查看此来源的会话正文")}</a></article>)}
  {page.data && !page.data.items.length && <p>{moteText("还没有收到 Coding 来源。按上方客户端步骤接入后，可在这里查看接收与处理结果。")}</p>}
  <div className="processing-actions">{offset > 0 && <button className="button" onClick={() => setOffset(0)}>{moteText('返回第一页')}</button>}{page.data?.nextOffset != null && <button className="button" onClick={() => setOffset(page.data!.nextOffset!)}>{moteText('下一页')}</button>}</div>
 </div>;
}


type PublishedPage={items:{entryType:string;ref:string;contentAt:string;material?:{title:string;ref:string;origin:{sourceId:string}}}[];nextCursor:string|null};
function CodingPublished({api,sourceId,expected,availability,onOpen}:{api:Api;sourceId:string;expected:number;onOpen?:(ref:string)=>void;availability:'available'|'unavailable'|'checking'|'unknown'}){
 const [paging,setPaging]=useState<{owner:Api;source:string;cursors:(string|undefined)[]}>({owner:api,source:sourceId,cursors:[undefined]});
 const cursors=paging.owner===api&&paging.source===sourceId?paging.cursors:[undefined];
 const params=new URLSearchParams({sourceId,type:'coding',limit:'5',...(cursors.at(-1)?{cursor:cursors.at(-1)!}:{})});
 const page=useResource<PublishedPage>(api,availability==='available'?'/api/library/browse?'+params:null);
 const [discarded,setDiscarded]=useState<PublishedPage>();
 const changed=page.error instanceof ApiError&&page.error.status===409,revoked=page.error instanceof ApiError&&[401,403,404,410].includes(page.error.status);
 const data=changed||revoked||page.data===discarded?undefined:page.data;
 const mismatched=data?.items.some(item=>item.entryType!=='material'||item.material?.origin.sourceId!==sourceId||item.material?.ref!==item.ref);
 const items=mismatched?[]:data?.items??[];
 const reset=()=>{const first=resources(api).get<PublishedPage>('/api/library/browse?'+new URLSearchParams({sourceId,type:'coding',limit:'5'}));setDiscarded(first.getSnapshot().data);setPaging({owner:api,source:sourceId,cursors:[undefined]});first.refresh();};
 return <section className="coding-published"><h4>{moteText('已发布正文')}</h4>{availability!=='available'?<p>{discoveryAvailabilityText(availability)}</p>:<>
 {page.error!==undefined||mismatched?<div role="alert"><p>{changed?moteText('当前正文列表已变化，请重新读取。'):mismatched?moteText('中央响应格式无效，请刷新后重试。'):moteText('正文暂不可读取，请重试。')}</p><button className="text-button" onClick={changed||mismatched?reset:page.refresh}>{moteText('重新读取')}</button><details><summary>{moteText('技术详情')}</summary><pre>{errorMessage(page.error??new Error('Published source identity mismatch'))}</pre></details></div>:null}
 {page.loading&&!data&&<p role="status">{moteText('正在读取…')}</p>}{!page.loading&&!page.error&&!mismatched&&!items.length&&<p>{expected===0?moteText('尚无已发布正文'):moteText('正文暂不可读取，请重试。')}</p>}
 <div className="coding-published-list">{items.map(item=><a key={item.ref} className="coding-published-row" onClick={event=>{if(onOpen&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();if(confirmNavigation())onOpen(item.ref);}}} href={'#/library?'+new URLSearchParams({view:'materials',sourceId,selected:item.ref})}><span><strong>{item.material!.title}</strong><small>{dateTime(item.contentAt)}</small></span><span aria-hidden="true">›</span></a>)}</div>
 {(cursors.length>1||data?.nextCursor)&&<nav aria-label={moteText('已发布正文')}><button className="text-button" disabled={page.loading||cursors.length===1} onClick={()=>setPaging({owner:api,source:sourceId,cursors:cursors.slice(0,-1)})}>{moteText('上一页')}</button><span>{moteText('第 {0} 页',cursors.length)}</span><button className="text-button" disabled={page.loading||!data?.nextCursor} onClick={()=>{if(data?.nextCursor)setPaging({owner:api,source:sourceId,cursors:[...cursors,data.nextCursor]});}}>{moteText('下一页')}</button></nav>}
 </>}</section>;
}
