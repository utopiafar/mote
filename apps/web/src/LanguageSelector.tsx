import { useState } from 'react';
import { getLanguagePreference, getLocale, languagePreference, saveLanguagePreference } from '@mote/shared/i18n';

export function LanguageSelector() {
  const [error, setError] = useState('');
  const chinese = getLocale() === 'zh-CN';
  return <label className="language-selector">{chinese ? '界面语言' : 'Language'}
    <select aria-label={chinese ? '界面语言' : 'Language'} value={getLanguagePreference()} onChange={event => {
      const next = languagePreference(event.target.value);
      if (!window.confirm(chinese ? '切换语言会重新加载页面，请先保存未提交的修改。继续？' : 'Changing language reloads this page. Save pending edits first. Continue?')) return;
      try { saveLanguagePreference(next); window.location.reload(); }
      catch { setError(chinese ? '无法保存语言偏好，请检查浏览器存储。' : 'Cannot save language preference. Check browser storage.'); }
    }}>
      <option value="system">{chinese ? '跟随系统' : 'System default'}</option>
      <option value="zh-CN">中文</option><option value="en">English</option>
    </select>{error && <span role="alert">{error}</span>}
  </label>;
}
