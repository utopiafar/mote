import { moteText } from '@mote/shared/i18n';
import type {RecordMetadata, SourceMetadata} from '@mote/shared';
import {bytes, dateTime} from './api';

export const sourceLabels: Record<string,string> = {ui_page:moteText("页面内容采集"),screen:moteText("屏幕采样"),activity:moteText("仅应用活动"),media:moteText("媒体播放"),notification:moteText("通知事件"),device_event:moteText("设备事件"),note:moteText("随手记"),file:moteText("文件"),calendar:moteText("日历"),event:moteText("事件"),message:moteText("消息"),metric:moteText("指标"),memory:moteText("记忆")};
export const activityExplanation = moteText("仅记录前台应用与采样时长；没有采集截图、窗口标题或正文。时长存在采样空隙，不代表完整使用历史。");
type Row = [string, string | number | boolean | undefined];
const bool = (value: boolean | undefined) => value === undefined ? undefined : value ? moteText("是") : moteText("否");
const time = (value: string | undefined) => value === undefined ? undefined : dateTime(value);

export function Metadata({metadata,source,modifiedAt,stateSeries}: {stateSeries?:import('@mote/shared').StateSeries;metadata?:RecordMetadata;source?:SourceMetadata;modifiedAt?:string}) {
  if (!metadata && !source && !modifiedAt && !stateSeries) return <p className="field-note">{moteText("此记录未上报额外元数据（早期客户端或系统未提供）。")}</p>;
  const d=metadata?.device,s=metadata?.state,c=metadata?.capture,f=source?.file;
  const network:Record<string,string>={none:moteText("无网络"),wifi:'Wi-Fi',cellular:moteText("移动网络"),ethernet:moteText("以太网"),other:moteText("其他"),unknown:moteText("未知")};
  const thermal:Record<string,string>={unknown:moteText("未知"),nominal:moteText("正常"),fair:moteText("略热"),serious:moteText("严重"),critical:moteText("临界")};
  const methods:Record<string,string>={accessibility:moteText("无障碍采集"),media_projection:moteText("系统录屏"),screen_capture:moteText("系统屏幕采集"),media_session:moteText("系统媒体会话"),notification_listener:moteText("系统通知服务"),manual:moteText("主动记录"),file:moteText("文件同步"),calendar:moteText("日历同步"),mcp:'MCP',import:moteText("导入")};
  const n=metadata?.notification,e=metadata?.deviceEvent;
  const actions:Record<string,string>={posted:moteText("发布（首次观察）"),updated:moteText("更新"),removed:moteText("移除"),screen_on:moteText("亮屏"),screen_off:moteText("熄屏"),user_present:moteText("用户已解锁 / 在场"),state_observed:moteText("锁定状态观察")};
  const page=metadata?.uiPage;
  const rows:Row[]=[
    [moteText("页面解析规则"),page?`${page.adapterId}@${page.adapterVersion}`:undefined],
    [moteText("页面读取状态"),page?.status],[moteText("应用版本"),page?.appVersion],[moteText("页面标识"),page?.activity],
    [moteText("系统事件"),n?actions[n.action]:e?actions[e.action]:undefined],[moteText("通知标题"),n?.title],[moteText("通知正文"),n?.text],[moteText("展开正文"),n?.bigText],[moteText("补充文字"),n?.subText],[moteText("通知多行正文"),n?.textLines?.join('\n')],
    [moteText("通知发布时间"),time(n?.postedAt)],[moteText("持续通知"),bool(n?.ongoing)],[moteText("分组摘要"),bool(n?.groupSummary)],[moteText("应用声明的通知类别"),n?.category],[moteText("通知通道"),n?.channelId],[moteText("系统移除原因代码"),n?.removalReason],[moteText("通知关联键（哈希）"),n?.notificationKey],
    [moteText("系统报告锁定"),bool(e?.keyguardLocked)],[moteText("系统报告屏幕可交互"),bool(e?.screenInteractive)],[moteText("观察会话"),metadata?.observation?.sessionId],[moteText("开机后观察毫秒数"),metadata?.observation?.elapsedRealtimeMs],
    [moteText("状态观察时间"),time(metadata?.observedAt)],[moteText("客户端版本"),metadata?.collector?.version],[moteText("采集方式"),metadata?.collector?.method ? methods[metadata.collector.method] : undefined],
    [moteText("设备型号"),d?.model],[moteText("制造商"),d?.manufacturer],[moteText("系统版本"),d?.osVersion],[moteText("系统构建"),d?.osBuild],[moteText("处理器架构"),d?.architecture],[moteText("地区"),d?.locale],[moteText("设备时区"),d?.timeZone],
    [moteText("电池电量"),s?.batteryPercent === undefined ? undefined : `${s.batteryPercent}%`],[moteText("正在充电"),bool(s?.charging)],[moteText("使用电池"),bool(s?.onBattery)],[moteText("省电模式"),bool(s?.powerSave)],
    [moteText("温度状态"),s?.thermalState ? thermal[s.thermalState] : undefined],[moteText("网络类型"),s?.networkType ? network[s.networkType] : undefined],[moteText("计量网络"),bool(s?.networkMetered)],
    [moteText("屏幕可交互"),bool(s?.screenInteractive)],[moteText("屏幕锁定"),bool(s?.screenLocked)],[moteText("已空闲"),s?.idleSeconds === undefined ? undefined : moteText("{0} 秒", s.idleSeconds)],
    [moteText("设备可用存储"),s?.availableStorageBytes === undefined ? undefined : bytes(s.availableStorageBytes)],
    [moteText("图片去重命中"),bool(c?.deduplication?.duplicate)],[moteText("图片去重档位"),c?.deduplication ? ({exact:moteText("精确"),conservative:moteText("保守"),balanced:moteText("均衡"),aggressive:moteText("激进")}[c.deduplication.mode]) : undefined],
    [moteText("采样间隔"),c?.intervalMs === undefined ? undefined : moteText("{0} 秒", c.intervalMs / 1000)],[moteText("画面宽度"),c?.width],[moteText("画面高度"),c?.height],[moteText("显示缩放"),c?.displayScale],[moteText("启用 OCR"),bool(c?.ocrEnabled)],[moteText("应用遮罩数"),c?.maskCount],
    [moteText("源文件大小"),f?.sizeBytes === undefined ? undefined : bytes(f.sizeBytes)],[moteText("文件创建时间"),time(f?.createdAt)],[moteText("源内容修改时间"),time(modifiedAt)],
    [moteText("文件访问时间（文件系统）"),time(f?.accessedAt)],[moteText("文件属性变更时间"),time(f?.metadataChangedAt)],[moteText("扫描发现来源消失的时间"),time(f?.deletionObservedAt)],
    [moteText("提供方创建时间"),time(source?.provider?.createdAt)],[moteText("提供方更新时间"),time(source?.provider?.updatedAt)],
  ];
  return <details className="metadata-details"><summary>{moteText("采集与来源元数据")}</summary>
    <>{stateSeries&&<p className="field-note">{moteText("相同状态合并为 {0} 次观察，最近一次：{1}。统计逐次使用实测时长，观察间隙不计为连续使用。",stateSeries.samples.length,dateTime(stateSeries.samples.at(-1)!.at))}</p>}</>
    {page&&<details><summary>{moteText("页面节点证据")}</summary><p>{moteText("仅表示当时窗口内观察到的文字，不代表阅读过全文。")}</p><pre>{JSON.stringify(page,null,2)}</pre></details>}
    <dl>{rows.filter(([,value])=>value!==undefined).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
    <p className="field-note">{moteText("仅显示上报时可获取的字段。状态是当时的观察值；缺失不代表否或零。")}</p>
    {(n||e)&&<p className="field-note">{moteText("原始系统事件，不表示你已阅读通知或正在执行某项任务。熄屏不等于锁定；服务中断期间不补造事件。系统可能隐藏敏感通知。")}</p>}
    {f?.accessedAt && <p className="field-note">{moteText("文件访问时间也可能由同步程序或其他进程读取更新，不能据此断定你查看过文件。")}</p>}
    {f?.deletionObservedAt && <p className="field-note">{moteText("这是完整扫描发现来源消失的时间，无法确认实际删除时刻或原因，也可能是移动或重命名。")}</p>}
  </details>;
}
