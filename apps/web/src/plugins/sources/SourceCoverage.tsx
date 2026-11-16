import type {SourceConnection} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {dateTime} from '../../api';

export const coverageLabel=(source:SourceConnection)=>source.status?.coverage?.state==='complete'?moteText('所选范围已完成'):source.status?.coverage?moteText('部分覆盖'):moteText('覆盖未知');
export function SourceCoverageDetails({source}:{source:SourceConnection}){
 const coverage=source.status?.coverage;
 return <section className="source-final-coverage" aria-label={moteText('同步覆盖')} data-coverage-state={coverage?.state??'unknown'}><strong>{coverageLabel(source)}</strong>{source.initialSync==='new_only'&&<p>{moteText('首次同步建立基线，之后接入新增内容并跟踪已接入资料的修订。')}</p>}{coverage&&<>
  <p>{moteText('已处理 {0} 条来源记录',coverage.processed)} · {coverage.remaining===null?moteText('剩余条目数未知'):moteText('剩余 {0} 条来源记录',coverage.remaining)} · {moteText('待处理的失败 {0} 项',coverage.failed)}</p>
  <p>{moteText('覆盖窗口')} · {coverage.window.from?moteText('从 {0} 到 {1}',dateTime(coverage.window.from),dateTime(coverage.window.to)):moteText('截至 {0}',dateTime(coverage.window.to))}</p>
  {coverage.limitations.length>0&&<ul>{coverage.limitations.map(limit=><li key={limit}>{limit==='pagination_pending'?moteText('仍有分页待继续'):moteText('部分正文尚未读取')}</li>)}</ul>}
 </>}</section>;
}
