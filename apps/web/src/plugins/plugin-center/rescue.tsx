import {moteText} from '@mote/shared/i18n';
import type {Page} from '../../navigation';

/** Host-owned minimum entry. It deliberately imports none of the plugin
 * center's controls or data readers, so a failed plugin-center bundle still
 * leaves the owner a route back to settings and a reload action. */
export function PluginCenterRescue({onPage}:{onPage:(page:Page)=>void}){
 return <div className="plugin-center plugin-center-rescue">
  <button className="back-link" onClick={()=>onPage('about')}>← {moteText('返回设置')}</button>
  <div className="page-heading"><h1>{moteText('插件中心')}</h1></div>
  <section className="panel panel-pad">
   <p role="status">{moteText('插件中心暂时不可用；请重新加载或返回设置。')}</p>
   <div className="plugin-footer">
    <button className="button primary" onClick={()=>window.location.reload()}>{moteText('重新加载')}</button>
    <button className="button subtle" onClick={()=>onPage('about')}>{moteText('返回设置')}</button>
   </div>
  </section>
 </div>;
}
