import { useState } from 'react';
import { getLanguagePreference, languagePreference, moteText, saveLanguagePreference } from '@mote/shared/i18n';

export function LanguageSelector({beforeReload}:{beforeReload?:()=>boolean}={}) {
  const [error, setError] = useState('');
  return <label className="language-selector">{moteText('界面语言')}
    <select aria-label={moteText('界面语言')} value={getLanguagePreference()} onChange={event => {
      const next = languagePreference(event.target.value);
      if (!window.confirm(beforeReload?moteText('切换后重新载入页面。当前问题草稿会保留。'):moteText('切换语言会重新加载页面，先保存未提交的修改。继续？'))) return;
      if(beforeReload&&!beforeReload())return;
      try { saveLanguagePreference(next); window.location.reload(); }
      catch { setError(moteText('无法保存语言偏好，检查浏览器存储。')); }
    }}>
      <option value="system">{moteText('跟随系统')}</option>
      <option value="zh-CN">中文</option><option value="en">English</option>
    </select>{error && <span role="alert">{error}</span>}
  </label>;
}
