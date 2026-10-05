import {useState} from 'react';
import {moteText} from '@mote/shared/i18n';

/** Keep cursor boundaries so Previous returns to the preceding page, including page three. */
export function useCursorPages() {
  const [cursors,setCursors]=useState<(number|undefined)[]>([undefined]);
  return {
    cursor:cursors.at(-1),page:cursors.length,
    reset:()=>setCursors([undefined]),
    previous:()=>setCursors(value=>value.length>1?value.slice(0,-1):value),
    next:(cursor:number)=>setCursors(value=>[...value,cursor]),
  };
}

export function ListPagination({label,paging,nextCursor,count,loading,pageSize,onPageSize}:{
  label:string;paging:ReturnType<typeof useCursorPages>;nextCursor?:number|null;count:number;loading:boolean;
  pageSize?:number;onPageSize?:(size:number)=>void;
}) {
  return <nav className="list-pagination" aria-label={label}>
    <span role="status">{moteText('第 {0} 页 · {1} 条',paging.page,count)}</span>
    {onPageSize&&<label>{moteText('每页条数')}<select aria-label={moteText('每页条数')} value={pageSize} disabled={loading} onChange={e=>onPageSize(Number(e.target.value))}>{[10,20,50].map(size=><option key={size} value={size}>{size}</option>)}</select></label>}
    <div><button className="button" disabled={loading||paging.page===1} onClick={paging.previous}>{moteText('上一页')}</button><button className="button" disabled={loading||!nextCursor} onClick={()=>nextCursor&&paging.next(nextCursor)}>{moteText('下一页')}</button></div>
  </nav>;
}
