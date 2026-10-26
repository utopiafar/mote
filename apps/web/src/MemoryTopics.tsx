import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {useResource} from './useResource';
export interface ContextTree {id:string;version:string;label:string;nodes:{id:string;label:string;parentId?:string}[]}
export function MemoryTopics({api,treeId,nodeId,onChange}:{api:Api;treeId:string;nodeId:string;onChange:(treeId:string,nodeId:string)=>void}){
 const trees=useResource<{items:ContextTree[];classification?:{state:'unavailable'|'ready'|'running'|'failed'}}>(api,'/api/context-trees',5000);
 const tree=trees.data?.items.find(item=>item.id===treeId);
 const missing=trees.data!==undefined&&(!tree||(nodeId&&!tree.nodes.some(node=>node.id===nodeId)));
 const automatic=trees.data?.items.some(item=>item.id.startsWith('auto.'));
 return <section className="memory-topic-browser" aria-label={moteText('记忆主题')}>
 <div className="memory-dimension"><label>{moteText('浏览维度')}<select aria-label={moteText('浏览维度')} value={tree?.id??''} disabled={!trees.data} onChange={event=>onChange(event.target.value,'')}>
 {!tree&&<option value="">{moteText('主题')}</option>}{trees.data?.items.map(item=><option value={item.id} key={item.id}>{item.label}</option>)}</select></label></div>
 {trees.loading&&!trees.data&&<p role="status">{moteText('正在加载…')}</p>}
 {trees.error!==undefined&&<p role="alert">{errorMessage(trees.error)}<button className="text-button" onClick={trees.refresh}>{moteText('重新读取')}</button></p>}
 {trees.data&&<p className="muted" role="status">{trees.data.classification?.state==='running'?moteText('正在整理自动主题…'):trees.data.classification?.state==='failed'?moteText('自动主题整理未完成；已有记忆仍可浏览。'):trees.data.classification?.state==='unavailable'?moteText('自动主题服务尚未就绪；已有记忆仍可浏览。'):automatic?moteText('主题是模型整理的浏览视图，不代表新的用户事实。'):moteText('尚无自动主题；仍可浏览全部记忆和已有维度。')}</p>}
 {missing&&<p role="status">{moteText('此主题已不可用，请返回全部记忆。')}<button onClick={()=>onChange('topics','')}>{moteText('全部记忆')}</button></p>}
 {tree&&<nav className="memory-topic-nodes" aria-label={tree.label}><button className={!nodeId?'active':''} aria-current={!nodeId?'page':undefined} onClick={()=>onChange(tree.id,'')}>{moteText('全部记忆')}</button>{tree.nodes.map(node=><button key={node.id} className={(nodeId===node.id?'active ':'')+(node.parentId?'child':'')} aria-current={nodeId===node.id?'page':undefined} onClick={()=>onChange(tree.id,node.id)}>{node.label}</button>)}</nav>}
 </section>;
}
