import {useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {ApiError,errorMessage,dateTime} from '../api';
import {useResource} from '../useResource';
import type {ViewEntry,ViewProps} from './types';
type Position={block:number;offset:number};
type Item={blockId:string;type:'text'|'source'|'asset'|'raw';text:string;offset:number;total:number;continued:boolean;speaker?:string;confirmedName?:string;capturedAt?:string;appName?:string;sourceRef?:string;startMs?:number;endMs?:number;mimeType?:string};
type Page={material?:{coverage:{state:string}};items:Item[];next:Position|null};
export function SourceMaterialView({api,value,fallback,onOpen}:ViewProps){
  const [position,setPosition]=useState<Position>({block:0,offset:0}),[history,setHistory]=useState<Position[]>([]),[raw,setRaw]=useState(false);
  const match=/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/.exec(value.ref);
  const page=useResource<Page>(api,match&&!raw?`/api/materials/${match[1]}/source-view?`+new URLSearchParams({revision:match[2],block:String(position.block),offset:String(position.offset),length:'4000'}):null,5000);
  const pending=page.error instanceof ApiError&&page.error.status===409;
  const go=(next:Position)=>{setHistory(old=>[...old,position]);setPosition(next);};
  if(!match)return <>{fallback}</>;
  return <div className="source-material-view"><button className="button subtle" aria-expanded={raw} onClick={()=>setRaw(!raw)}>{raw?moteText('返回阅读视图'):moteText('查看原始结构')}</button>
    {raw?fallback:<>
      {page.error!==undefined&&<p role={pending?'status':'alert'}>{pending?moteText('来源已更正，正在重新整理资料。完成后可继续查看。'):errorMessage(page.error)} <button className="button" onClick={page.refresh}>{moteText('重试')}</button></p>}
      {page.loading&&!page.data&&<p role="status">{moteText('正在读取…')}</p>}
      {page.error===undefined&&page.data&&<>
        {page.data.material?.coverage.state==='pending'&&<p role="status">{moteText('资料仍在整理，先展示当前可读的内容。')}</p>}
        {page.data.material?.coverage.state==='partial'&&<p role="status">{moteText('资料尚不完整，可在“来源与处理”中查看缺失情况。')}</p>}
        <div className="source-material-blocks">{page.data.items.map(item=><section className="source-item" key={item.blockId+':'+item.offset}>
        {item.type==='source'&&<p className="fine-print">{item.appName}{item.capturedAt&&' · '+dateTime(item.capturedAt)}</p>}
        {item.sourceRef&&<button className="text-button" onClick={()=>onOpen(item.sourceRef!)}>{moteText('查看文件详情')}</button>}
        {item.type==='asset'?<p>{moteText('归档附件')} · {item.mimeType}</p>:<>
          {(item.confirmedName||item.speaker||item.startMs!==undefined)&&<p className="source-material-speaker">{item.confirmedName?moteText('已确认说话人：{0}',item.confirmedName):item.speaker?moteText('匿名说话人：{0}',item.speaker):''}{item.startMs!==undefined&&<> · {moteText('{0} 秒',Math.floor(item.startMs/1000))}</>}</p>}
          {item.offset>0&&<p className="fine-print">{moteText('接上一页')}</p>}
          {item.text&&<p className={item.type==='raw'?'file-text feature-json':'file-text'}>{item.text}</p>}
          {item.continued&&<p className="fine-print">{moteText('本片段未完，下一页继续。')}</p>}
        </>}
      </section>)}</div><div className="processing-actions">{!!history.length&&<button className="button" onClick={()=>{setPosition(history.at(-1)!);setHistory(old=>old.slice(0,-1));}}>{moteText('上一页')}</button>}{(position.block>0||position.offset>0)&&<button className="button" onClick={()=>{setPosition({block:0,offset:0});setHistory([]);}}>{moteText('返回第一页')}</button>}{page.data.next&&<button className="button" onClick={()=>go(page.data!.next!)}>{moteText('继续展开')}</button>}</div></>}
    </>}
  </div>;
}
export const sourceMaterialViews:ViewEntry[]=[{id:'source-item.file',kind:'mote.file',schemaVersion:1,representation:'owner-material',render:props=><SourceMaterialView key={props.value.ref} {...props}/>}];
