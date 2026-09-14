import type {RecordMetadata, SourceMetadata} from '@mote/shared';
import {bytes, dateTime} from './api';

export const sourceLabels: Record<string,string> = {screen:'屏幕采样',activity:'仅应用活动',note:'随手记',file:'文件',calendar:'日历',event:'事件',message:'消息',metric:'指标',memory:'记忆'};
export const activityExplanation = '仅记录前台应用与采样时长；没有采集截图、窗口标题或正文。时长存在采样空隙，不代表完整使用历史。';
type Row = [string, string | number | boolean | undefined];
const bool = (value: boolean | undefined) => value === undefined ? undefined : value ? '是' : '否';
const time = (value: string | undefined) => value === undefined ? undefined : dateTime(value);

export function Metadata({metadata,source,modifiedAt}: {metadata?:RecordMetadata;source?:SourceMetadata;modifiedAt?:string}) {
  if (!metadata && !source && !modifiedAt) return <p className="field-note">此记录未上报额外元数据（早期客户端或系统未提供）。</p>;
  const d=metadata?.device,s=metadata?.state,c=metadata?.capture,f=source?.file;
  const network:Record<string,string>={none:'无网络',wifi:'Wi-Fi',cellular:'移动网络',ethernet:'以太网',other:'其他',unknown:'未知'};
  const thermal:Record<string,string>={unknown:'未知',nominal:'正常',fair:'略热',serious:'严重',critical:'临界'};
  const methods:Record<string,string>={accessibility:'无障碍采集',media_projection:'系统录屏',screen_capture:'系统屏幕采集',manual:'主动记录',file:'文件同步',calendar:'日历同步',mcp:'MCP',import:'导入'};
  const rows:Row[]=[
    ['状态观察时间',time(metadata?.observedAt)],['客户端版本',metadata?.collector?.version],['采集方式',metadata?.collector?.method ? methods[metadata.collector.method] : undefined],
    ['设备型号',d?.model],['制造商',d?.manufacturer],['系统版本',d?.osVersion],['系统构建',d?.osBuild],['处理器架构',d?.architecture],['地区',d?.locale],['设备时区',d?.timeZone],
    ['电池电量',s?.batteryPercent === undefined ? undefined : `${s.batteryPercent}%`],['正在充电',bool(s?.charging)],['使用电池',bool(s?.onBattery)],['省电模式',bool(s?.powerSave)],
    ['温度状态',s?.thermalState ? thermal[s.thermalState] : undefined],['网络类型',s?.networkType ? network[s.networkType] : undefined],['计量网络',bool(s?.networkMetered)],
    ['屏幕可交互',bool(s?.screenInteractive)],['屏幕锁定',bool(s?.screenLocked)],['已空闲',s?.idleSeconds === undefined ? undefined : `${s.idleSeconds} 秒`],
    ['设备可用存储',s?.availableStorageBytes === undefined ? undefined : bytes(s.availableStorageBytes)],
    ['采样间隔',c?.intervalMs === undefined ? undefined : `${c.intervalMs / 1000} 秒`],['画面宽度',c?.width],['画面高度',c?.height],['显示缩放',c?.displayScale],['启用 OCR',bool(c?.ocrEnabled)],['应用遮罩数',c?.maskCount],
    ['源文件大小',f?.sizeBytes === undefined ? undefined : bytes(f.sizeBytes)],['文件创建时间',time(f?.createdAt)],['源内容修改时间',time(modifiedAt)],
    ['文件访问时间（文件系统）',time(f?.accessedAt)],['文件属性变更时间',time(f?.metadataChangedAt)],['扫描发现来源消失的时间',time(f?.deletionObservedAt)],
    ['提供方创建时间',time(source?.provider?.createdAt)],['提供方更新时间',time(source?.provider?.updatedAt)],
  ];
  return <details className="metadata-details"><summary>采集与来源元数据</summary>
    <dl>{rows.filter(([,value])=>value!==undefined).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
    <p className="field-note">仅显示上报时可获取的字段。状态是当时的观察值；缺失不代表否或零。</p>
    {f?.accessedAt && <p className="field-note">文件访问时间也可能由同步程序或其他进程读取更新，不能据此断定你查看过文件。</p>}
    {f?.deletionObservedAt && <p className="field-note">这是完整扫描发现来源消失的时间，无法确认实际删除时刻或原因，也可能是移动或重命名。</p>}
  </details>;
}
