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
    const chinese = language.locale === 'zh-CN';
    if (!window.confirm(chinese ? '切换语言会重新加载界面，请先保存未提交的设置。继续？' : 'Changing language reloads this window. Save pending settings first. Continue?')) { select.value = language.preference; return; }
    try { language = await window.mote.setLanguage(next); }
    catch { select.value = language.preference; window.alert(chinese ? '语言保存失败，请重试。' : 'Could not save language. Please retry.'); }
  });
  await import('./ui');
}
void start().catch(() => { document.getElementById('feedback')!.textContent = 'Unable to load language settings / 无法读取语言设置'; });
