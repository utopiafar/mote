import { type CapturePreview } from '@mote/shared';
import { getLocale,moteText } from '@mote/shared/i18n';
import {
ArrowLeft,
ArrowRight,
Clock3,
Monitor,
RefreshCw
} from "lucide-react";
import React,{
useCallback,
useEffect,
useMemo,
useRef,
useState,
} from "react";
import {
duration,
errorMessage,
queryString,
type Activity,
type Api,
type Device,
type Range
} from "./api";
import { captureDateRange,localDateInput } from './capture-presentation';
import { FeatureCollections } from './features/runtime';
const CaptureSessions = React.lazy(()=>import('./CaptureSessions').then(module=>({default:module.CaptureSessions})));

import { sourceLabels } from './Metadata';


import { CaptureCard,Empty,ErrorNotice,Spinner } from './shell-components';
export type ArchiveTab = string;
export function ActivitySummary({activity}:{activity:Activity}) {return <section className="panel activity-panel"><div className="section-heading"><div><h2>{moteText("应用活动概况")}</h2><p>{moteText("前台应用采样时长 ·")}{' '}{duration(activity.totalDurationMs)}</p></div></div>{activity.apps.length?<><div className="app-list">{activity.apps.map((app,index)=><div className="app-row" key={app.appId||app.appName}><span className={'app-dot dot-'+index%5}/><strong>{app.appName}</strong><span>{duration(app.durationMs)}</span><small>{activity.totalDurationMs?Math.round(app.durationMs/activity.totalDurationMs*100):0}%</small></div>)}</div><p className="measurement-note">{moteText("多台设备分别计时；未采样的时间不会补齐，应用活动不代表注意力或实际工作成果。后台媒体播放单独统计，可在「媒体播放」中查看。")}</p></>:<Empty icon={Clock3} title={moteText("这段时间还没有活动采样")}><p>{moteText("设备完成同步后，可以在这里查看应用时间分布。")}</p></Empty>}</section>;}

export function Archive({api,devices,range,activity,revision,onOpen,tab,setTab,onChanged}:{onChanged?:()=>void;api:Api;devices:Device[];range:Range;activity:Activity;revision:number;onOpen:(id:string)=>void;tab:ArchiveTab;setTab:(tab:ArchiveTab)=>void}) {
 return <div className="archive-page"><div className="page-heading"><div className="eyebrow">{moteText("有来处，也有脉络")}</div><h1>{moteText("资料库")}</h1><p>{moteText("浏览原始记录、活动与播放分布，以及有证据支撑的记忆。")}</p></div><FeatureCollections selected={tab} onSelect={setTab} props={{api,devices,range,activity,revision,onOpen,onChanged}}/></div>;
}

export function Timeline(props:{api:Api;devices:Device[];onOpen:(id:string)=>void;revision:number;embedded?:boolean}) {
  const Heading=props.embedded?'h2':'h1';
  const [view,setView]=useState(props.embedded?'records':'sessions');
  return <><div className="filter-bar" role="group" aria-label={moteText("记录视图")}><button className={'button '+(view==='sessions'?'primary':'')} onClick={()=>setView('sessions')}>{moteText("片段 / 应用分组")}</button><button className={'button '+(view==='records'?'primary':'')} onClick={()=>setView('records')}>{moteText("全部记录")}</button></div>{view==='sessions'?<><div className="page-heading timeline-heading"><div className="eyebrow">{moteText("沿着连续的记录回看")}</div><Heading>{moteText("片段")}</Heading><p>{moteText("先看一段，再展开其中的截图与上下文。")}</p></div><CaptureSessions {...props}/></>:<RecordTimeline {...props}/>}</>;
}

export function RecordTimeline({
  api,
  devices,
  onOpen,
  revision,
}: {
  api: Api;
  devices: Device[];
  onOpen: (id: string) => void;
  revision: number;
}) {
  const [layout,setLayout]=useState<'grid'|'list'>(()=>localStorage.getItem('mote.record-layout')==='grid'?'grid':'list');
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [device, setDevice] = useState("");
  const [collection, setCollection] = useState<'' | 'activity' | 'content'>('');
  const [source,setSource] = useState('');
  const [ocrStatus, setOcrStatus] = useState('');
  const [items, setItems] = useState<CapturePreview[]>([]);
  const [totalCount, setTotalCount] = useState<number>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [pageCursors, setPageCursors] = useState<(string | undefined)[]>([undefined]);
  const requestVersion = useRef(0);
  const inFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const range = useMemo(
    () => ({
      ...captureDateRange(after, before),
      ...(device ? { deviceId: device } : {}),
      ...(collection ? {collection} : {}),
      ...(source ? {source} : {}),
      ...(ocrStatus ? {ocrStatus} : {}),
    }),
    [after, before, device, collection, source, ocrStatus],
  );
  const load = useCallback(
    async (next?: string, version = requestVersion.current, targetPage = 0) => {
      if (inFlight.current && next) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      inFlight.current = true;
      setLoading(true);
      setError("");
      try {
        const result = await api.request<{
          items: CapturePreview[];
          nextCursor: string | null;
          totalCount: number;
        }>(`/api/capture-browser${queryString(range, { limit: 24, cursor: next })}`, {signal: controller.signal});
        if (requestVersion.current !== version || controller.signal.aborted) return;
        setItems(result.items);
        setPage(targetPage);
        setPageCursors(previous => [...previous.slice(0, targetPage), next]);
        setCursor(result.nextCursor);
        setTotalCount(result.totalCount);
      } catch (e) {
        if (requestVersion.current === version && !controller.signal.aborted) setError(errorMessage(e));
      } finally {
        if (requestVersion.current === version) {
          setLoading(false);
          inFlight.current = false;
        }
      }
    },
    [api, range],
  );
  useEffect(() => {
    const version = ++requestVersion.current;
    setItems([]);
    setPage(0);
    setPageCursors([undefined]);
    setCursor(null);
    setTotalCount(undefined);
    inFlight.current = false;
    void load(undefined, version);
    return () => {request.current?.abort();requestVersion.current++;};
  }, [load, revision, refreshVersion]);
  const groups = useMemo(() => {
    const result = new Map<string, CapturePreview[]>();
    for (const item of items) {
      const key = new Date(item.capturedAt).toLocaleDateString(getLocale(), {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      });
      result.set(key, [...(result.get(key) || []), item]);
    }
    return [...result.entries()];
  }, [items]);
  return (
    <>
      <div className="page-heading timeline-heading">
        <div className="eyebrow">{moteText("按天回看，保留来处")}</div>
        <h1>{moteText("采集记录")}</h1>
        <p>{moteText("按日期浏览截图、文字与媒体状态；点击记录查看内容和采样时的上下文。")}</p>
      </div>
      <div className="capture-day-controls">
        <label><span>{moteText("按天查看")}</span><input type="date" aria-label={moteText("查看某天的采集记录")} value={after && after === before ? after : ''} onChange={event => {setAfter(event.target.value);setBefore(event.target.value);}}/></label>
        <button className="button subtle" onClick={() => {const day=localDateInput(new Date());setAfter(day);setBefore(day);}}>{moteText("今天")}</button>
        <button className="button subtle" aria-label={moteText("查看前一天")} disabled={!after || after !== before} onClick={() => {const date=new Date(`${after}T00:00:00`);date.setDate(date.getDate()-1);const day=localDateInput(date);setAfter(day);setBefore(day);}}><ArrowLeft size={15}/></button>
        <button className="button subtle" aria-label={moteText("查看后一天")} disabled={!after || after !== before} onClick={() => {const date=new Date(`${after}T00:00:00`);date.setDate(date.getDate()+1);const day=localDateInput(date);setAfter(day);setBefore(day);}}><ArrowRight size={15}/></button>
        <button className="button subtle capture-refresh" disabled={loading} onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={15} className={loading ? 'spin' : ''}/>{moteText("刷新记录")}</button>
      </div>
      <div className="filter-bar capture-filters"><label>{moteText("展示方式")}<select aria-label={moteText("记录展示方式")} value={layout} onChange={e=>{const v=e.target.value as 'grid'|'list';setLayout(v);localStorage.setItem('mote.record-layout',v);}}><option value="grid">{moteText("缩略图")}</option><option value="list">{moteText("列表")}</option></select></label>
        <label>
          <span>{moteText("从")}</span>
          <input
            type="date"
            aria-label={moteText("开始日期")}
            value={after}
            onChange={(e) => setAfter(e.target.value)}
          />
        </label>
        <label>
          <span>{moteText("至")}</span>
          <input
            type="date"
            aria-label={moteText("结束日期")}
            value={before}
            min={after}
            onChange={(e) => setBefore(e.target.value)}
          />
        </label>
        <label>
          <Monitor size={15} />
          <select
            aria-label={moteText("筛选设备")}
            value={device}
            onChange={(e) => setDevice(e.target.value)}
          >
            <option value="">{moteText("全部设备")}</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.deviceName}
              </option>
            ))}
          </select>
        </label>
        <label><span>{moteText("来源")}</span><select aria-label={moteText("筛选记录来源")} value={source} onChange={event=>{setSource(event.target.value);if(event.target.value&&event.target.value!=='screen')setOcrStatus('');}}><option value="">{moteText("全部来源")}</option>{Object.entries(sourceLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>{moteText("采集级别")}</span><select aria-label={moteText("筛选采集级别")} value={collection} onChange={event=>setCollection(event.target.value as typeof collection)}><option value="">{moteText("全部记录")}</option><option value="activity">{moteText("仅活动状态")}</option><option value="content">{moteText("允许保留的内容")}</option></select></label>
        <label><span>OCR</span><select aria-label={moteText("筛选 OCR 状态")} value={ocrStatus} onChange={event=>setOcrStatus(event.target.value)}><option value="">{moteText("全部状态")}</option><option value="pending">{moteText("待处理")}</option><option value="completed">{moteText("已完成")}</option><option value="failed">{moteText("失败")}</option><option value="disabled">{moteText("已关闭")}</option><option value="unknown">{moteText("状态未知")}</option></select></label>
        {(after || before || device || collection || source || ocrStatus) && (
          <button
            className="text-button"
            onClick={() => {
              setAfter("");
              setBefore("");
              setDevice("");
              setCollection('');
              setSource('');
              setOcrStatus('');
            }}
          >
            {moteText("清除筛选")}</button>
        )}
        <span className="filter-count">{totalCount === undefined ? moteText("已读取") + " " + items.length : moteText("共 {0} 条 · 本页 {1} 条", totalCount, items.length)}</span>
      </div>
      <p className="capture-browse-note">{moteText("日期按当前浏览器时区显示。这里展示已同步到中央节点的记录；待充电的 OCR 由采集端补做，结果同步后可刷新查看。")}</p>
      {error && (
        <ErrorNotice
          text={error}
          retry={() => void load(pageCursors[page], requestVersion.current, page)}
        />
      )}
      {groups.map(([day, records]) => (
        <section className="timeline-group" key={day}>
          <h2>
            <span className="timeline-dot" />
            {day}
            <small>{moteText("已加载")}{' '}{records.length}{' '}{moteText("条")}</small>
          </h2>
          <div className={layout==='list'?'capture-grid capture-list':'capture-grid'}>
            {records.map((capture) => (
              <CaptureCard
                key={capture.id}
                capture={capture}
                api={api}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}
      {loading && (
        <div className="load-more">
          <Spinner label={moteText("正在找回这些片刻…")} />
        </div>
      )}
      {!loading && !items.length && !error && (
        <div className="panel">
          <Empty icon={Clock3} title={moteText("这段时间还没有记录")}>
            <p>{moteText("试试其他时间或设备，或检查采集端是否已开启。")}</p>
          </Empty>
        </div>
      )}
      <nav className="load-more" aria-label={moteText("采集记录分页")}>
        <button className="button subtle" disabled={loading || page === 0} onClick={() => void load(pageCursors[page - 1], requestVersion.current, page - 1)}>{moteText("上一页")}</button>
        <span>{moteText("第 {0} 页", page + 1)}</span>
        <button className="button subtle" disabled={loading || !cursor} onClick={() => cursor && void load(cursor, requestVersion.current, page + 1)}>{moteText("下一页")}</button>
      </nav>
    </>
  );
}
