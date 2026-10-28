import { useState } from 'react';
import { getLanguagePreference, languagePreference, moteText, saveLanguagePreference } from '@mote/shared/i18n';

export function LanguageSelector() {
  const [error, setError] = useState('');
  return <label className="language-selector">{moteText('界面语言')}
    <select aria-label={moteText('界面语言')} value={getLanguagePreference()} onChange={event => {
      const next = languagePreference(event.target.value);
      if (!window.confirm(moteText('切换语言会重新加载页面，请先保存未提交的修改。继续？'))) return;
      try { saveLanguagePreference(next); window.location.reload(); }
      catch { setError(moteText('无法保存语言偏好，请检查浏览器存储。')); }
    }}>
      <option value="system">{moteText('跟随系统')}</option>
      <option value="zh-CN">中文</option><option value="en">English</option><option value="ja">日本語</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="es">Español</option><option value="ru">Русский</option>
    </select>{error && <span role="alert">{error}</span>}
  </label>;
}
