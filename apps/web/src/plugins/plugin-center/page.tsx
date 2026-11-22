import {ArrowLeft} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {pageHash,pageRoutes} from '@mote/shared';
import React,{useEffect,useState} from 'react';
import type {PageEntry,PageProps} from '../../features/types';

const PluginCenter=React.lazy(()=>import('./PluginCenter').then(module=>({default:module.PluginCenter})));
const SkillsPage=React.lazy(()=>import('./SkillsPage').then(module=>({default:module.SkillsPage})));
const skillsStyles=[
  new URL('../../plugin-center.css?no-inline',import.meta.url).href,
  new URL('../../settings-ui.css?no-inline',import.meta.url).href,
];
function SkillsStyles(){return <>{skillsStyles.map(href=><link key={href} rel="stylesheet" href={href} precedence="default"/>)}</>;}

/** The skills surface owns the default page. Explicit tab deep links keep the
 * existing catalog and installed management surfaces reachable. */
function PluginCenterRoute({api,onPage}:Pick<PageProps,'api'|'onPage'>){
  const [hash,setHash]=useState(()=>window.location.hash);
  useEffect(()=>{
    const update=()=>setHash(window.location.hash);
    window.addEventListener('hashchange',update);
    return()=>window.removeEventListener('hashchange',update);
  },[]);
  const explicitTab=new URLSearchParams(hash.split('?')[1]??'').has('tab');
  return explicitTab
    ? <><SkillsStyles/><button className="text-button" onClick={()=>{window.location.hash=pageHash('skills');}}><ArrowLeft size={14} aria-hidden="true" style={{verticalAlign:"middle",marginInlineEnd:"0.3em"}}/>{moteText('返回技能')}</button><PluginCenter api={api} onPage={onPage}/></>
    : <><SkillsStyles/><SkillsPage api={api}/></>;
}

export const pluginCenterPage:PageEntry={
  id:'extensions',route:pageRoutes.skills,aliases:['system/extensions'],navItem:'skills',label:moteText('技能'),section:'system',order:3,featureId:'mote.features',
  render:({api,onPage})=><PluginCenterRoute api={api} onPage={onPage}/>,
};
export const pages:PageEntry[]=[pluginCenterPage];
