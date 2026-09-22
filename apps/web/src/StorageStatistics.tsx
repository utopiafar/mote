import {useResource} from './useResource';
import {useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {StorageStatistics as Report,StorageBucket} from '@mote/shared/storage-statistics';
import {type Api,bytes,errorMessage} from './api';
export function StorageStatistics({api,onUsage}:{api:Api;onUsage:()=>void}) {
 const {data:report,error,loading,refresh}=useResource<Report>(api,'/api/storage-statistics');
 const [days,setDays]=useState(30);
 function chart(rows:StorageBucket[]){const max=Math.max(1,...rows.map(r=>r.bytes));return <div className="storage-chart">{rows.map(row=><div className="storage-bar" key={row.key}><span>{({database:"SQLite",json:"JSON",image:moteText("图片"),model:moteText("模型"),original:moteText("原始文件"),other:moteText("其他")} as Record<string,string>)[row.key]??row.key}</span><meter min={0} max={max} value={row.bytes}/><strong>{bytes(row.bytes)}</strong><small>{row.files} {moteText("文件")}</small></div>)}{!rows.length&&<p>{moteText("暂无数据")}</p>}</div>;}
 const cutoff=new Date(Date.now()-days*86400000).toISOString().slice(0,10);
 return <div><div className="page-heading"><h1>{moteText("统计中心")}</h1><p>{moteText("当前磁盘占用，按文件类型和最后修改日期（UTC）汇总。共享文件只计一次；日期分布不是每日新增量。")}</p><button className="button" onClick={refresh} disabled={loading}>{moteText("刷新")}</button> <button className="button subtle" onClick={onUsage}>{moteText("用量与费用")}</button></div>{error!==undefined&&<p role="alert">{errorMessage(error)}</p>}{report&&<><div className="stats-grid"><div className="stat"><span>{moteText("存储空间")}</span><strong>{bytes(report.bytes)}</strong></div><div className="stat"><span>{moteText("文件")}</span><strong>{report.files}</strong></div></div>{report.skipped>0&&<p role="status">{moteText("部分文件无法读取，统计可能不完整。")}</p>}<section className="panel storage-panel"><h2>{moteText("按文件类型")}</h2>{chart(report.types)}</section><section className="panel storage-panel"><h2>{moteText("按日期")}</h2><select aria-label={moteText("时间范围")} value={days} onChange={e=>setDays(Number(e.target.value))}><option value={7}>{moteText("过去 7 天")}</option><option value={30}>{moteText("过去 30 天")}</option><option value={0}>{moteText("全部时间")}</option></select>{chart(report.days.filter(r=>!days||r.key>=cutoff))}</section></>}</div>;
}
