import {moteText} from '@mote/shared/i18n';
import {Unplug} from 'lucide-react';
import {useEffect,useRef,useState} from 'react';
import {containDialogFocus} from './dialog-focus';
import {AppearanceSelector} from './AppearanceSelector';
import {LanguageSelector} from './LanguageSelector';
import {preserveChatForLanguageReload} from './plugins/ask/chat-drafts';
import type {PageProps} from './features/types';
import type {SessionLifetime} from './session';
export function WebPreferences({api,status,disconnect,sessionLifetime,changeSessionLifetime,onPage}:Pick<PageProps,'api'|'status'|'disconnect'|'sessionLifetime'|'changeSessionLifetime'|'onPage'>){
 const [error,setError]=useState(''),[reviewSignOut,setReviewSignOut]=useState(false);
 return <section className="web-preferences"><div className="page-heading"><h1>{moteText('外观、语言与会话')}</h1><button className="text-button" onClick={()=>onPage('about')}>← {moteText('返回')}</button></div><section className="web-preference-section"><h2>{moteText('此浏览器')}</h2><AppearanceSelector/><LanguageSelector beforeReload={()=>{const saved=preserveChatForLanguageReload(api);if(!saved)setError(moteText('无法保留当前问题草稿，请稍后再切换语言。'));return saved;}}/>{error&&<p role="alert">{error}</p>}</section><section className="web-preference-section"><h2>{moteText('当前服务')}</h2><dl className="web-service-facts"><dt>{moteText('连接')}</dt><dd>{window.location.origin}</dd><dt>{moteText('状态')}</dt><dd>{status?moteText('已登录'):moteText('尚未验证')}</dd></dl><label className="web-session-lifetime">{moteText('浏览器登录保留时间')}<select aria-label={moteText('浏览器登录保留时间')} value={sessionLifetime} onChange={e=>changeSessionLifetime(e.target.value as SessionLifetime)}><option value="session">{moteText('当前窗口')}</option><option value="1d">{moteText('1 天')}</option><option value="7d">{moteText('7 天')}</option><option value="30d">{moteText('30 天')}</option></select><small>{moteText('只影响此浏览器的登录。')}</small></label><button className="button subtle" onClick={()=>setReviewSignOut(true)}><Unplug size={15}/>{moteText('退出登录')}</button></section>{reviewSignOut&&<SignOutReview cancel={()=>setReviewSignOut(false)} confirm={disconnect}/>}</section>;
}

function SignOutReview({cancel,confirm}:{cancel:()=>void;confirm:()=>void}){const panel=useRef<HTMLElement>(null);useEffect(()=>panel.current?containDialogFocus(panel.current,document.activeElement as HTMLElement|null):undefined,[]);return <div className="modal-backdrop" onKeyDown={event=>{if(event.key==='Escape')cancel();}}><section className="modal" role="dialog" aria-modal="true" aria-label={moteText('退出此浏览器？')} ref={panel}><h2>{moteText('退出此浏览器？')}</h2><p>{moteText('已保存资料和对话保留。其他设备与 Agent 的连接不受影响。')}</p><div className="button-row"><button className="button subtle" onClick={cancel}>{moteText('取消')}</button><button className="button primary" onClick={confirm}>{moteText('退出登录')}</button></div></section></div>;}
