import {desktopAppearance,receiveAppearance} from './appearance';
import { configureLocale, translate, languagePreference, type LanguagePreference } from '@mote/shared/i18n';
async function start() {
  let language = await window.mote.language();
  configureLocale(() => language.locale);
  document.documentElement.lang = language.locale;
  document.documentElement.dir = 'ltr';
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) element.textContent = translate(language.locale, element.textContent ?? '');
  for (const attribute of ['placeholder', 'title', 'aria-label', 'alt']) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`))) element.setAttribute(attribute, translate(language.locale, element.getAttribute(attribute) ?? ''));
  }
  const select = document.getElementById('language') as HTMLSelectElement;
  select.value = language.preference;
  select.addEventListener('change', async () => {
    const next: LanguagePreference = languagePreference(select.value);
    if (!window.confirm(translate(language.locale, '切换语言会重新加载界面，请先保存未提交的设置。继续？'))) { select.value = language.preference; return; }
    try { language = await window.mote.setLanguage(next); }
    catch { select.value = language.preference; window.alert(translate(language.locale, '语言保存失败，请重试。')); }
  });
  const appearance=document.getElementById('appearance') as HTMLSelectElement;
  const updateAppearance=()=>{appearance.value=desktopAppearance.getSnapshot().preference;};
  desktopAppearance.subscribe(updateAppearance);updateAppearance();
  appearance.addEventListener('change',async()=>{
    const error=document.getElementById('appearance-error')!;
    try { receiveAppearance(await window.mote.setAppearance(appearance.value as 'light'|'dark'|'auto'));error.hidden=true; }
    catch { updateAppearance();error.hidden=false; }
  });
  await import('./ui');
}
void start().catch(() => { document.getElementById('feedback')!.textContent = 'Unable to load language settings / 无法读取语言设置'; });
