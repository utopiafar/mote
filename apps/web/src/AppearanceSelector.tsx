import {useState,useSyncExternalStore} from 'react';
import {moteText} from '@mote/shared/i18n';
import {webAppearance} from './appearance';
import {installedWebPlugins} from './features/registry';
import {webPresentation} from './presentation';
export function AppearanceSelector() {
  const {preference}=useSyncExternalStore(webAppearance.subscribe,webAppearance.getSnapshot,webAppearance.getSnapshot);
  const choices=useSyncExternalStore(installedWebPlugins.subscribe,installedWebPlugins.getSnapshot,installedWebPlugins.getSnapshot);
  const selected=useSyncExternalStore(webPresentation.subscribe,webPresentation.getSnapshot,webPresentation.getSnapshot);
  const [failed,setFailed]=useState(false);
  return <><label className="language-selector">{moteText('外观')}
    <select aria-label={moteText('外观')} value={preference} onChange={event=>setFailed(!webAppearance.save(event.target.value))}>
      <option value="auto">{moteText('跟随系统')}</option><option value="light">{moteText('浅色')}</option><option value="dark">{moteText('深色')}</option>
    </select>{failed&&<span role="status">{moteText('无法保存外观偏好，已跟随系统。')}</span>}
  </label>{(['theme','layout'] as const).map(surface=>choices[surface].length>0&&<label className="language-selector" key={surface}>{moteText(surface==='theme'?'外观':'展示方式')} · {moteText('插件中心')}
    <select aria-label={moteText(surface==='theme'?'外观':'展示方式')+' · '+moteText('插件中心')}
      value={choices[surface].find(choice=>choice.reference.id===selected[surface].id&&choice.reference.version===selected[surface].version)?.key??''}
      onChange={event=>installedWebPlugins.select(surface,event.target.value)}>
      <option value="">{moteText('默认')}</option>{choices[surface].map(choice=><option key={choice.key} value={choice.key}>{choice.label}</option>)}
    </select>
  </label>)}</>;
}
