import '@mote/shared/i18n-all';
import {mountCaptureWorkspace} from './capture-workspace';
import {mountSettingsWorkspace} from './settings-workspace';
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
  mountSettingsWorkspace();mountCaptureWorkspace();
  const select = document.getElementById('language') as HTMLSelectElement;
  select.value = language.preference;
  const appearance=document.getElementById('appearance') as HTMLSelectElement;
  const preferences=document.querySelector<HTMLElement>('[data-page="preferences"]')!;
  const apply=document.getElementById('preferences-apply') as HTMLButtonElement;
  const reset=document.getElementById('preferences-reset') as HTMLButtonElement;
  const error=document.getElementById('appearance-error')!;
  let saving=false;
  const dirty=()=>appearance.value!==desktopAppearance.getSnapshot().preference||select.value!==language.preference;
  const update=()=>{preferences.dataset.dirty=String(dirty());apply.disabled=saving||!dirty();reset.disabled=saving||!dirty();};
  const restore=()=>{appearance.value=desktopAppearance.getSnapshot().preference;select.value=language.preference;error.hidden=true;update();};
  restore();
  desktopAppearance.subscribe(()=>{if(preferences.dataset.dirty!=='true')restore();});
  select.addEventListener('change',update);appearance.addEventListener('change',update);reset.addEventListener('click',restore);
  apply.addEventListener('click',async()=>{
    if(saving||!dirty())return;
    const next=languagePreference(select.value);
    if(next!==language.preference&&!window.confirm(translate(language.locale,'切换语言会重新加载界面，请先保存未提交的设置。继续？')))return;
    saving=true;update();error.hidden=true;
    try {
      if(appearance.value!==desktopAppearance.getSnapshot().preference)receiveAppearance(await window.mote.setAppearance(appearance.value as 'light'|'dark'|'auto'));
      if(next!==language.preference){if(!window.dispatchEvent(new Event('mote-language-changing',{cancelable:true})))throw Error('Unable to preserve the current question draft');language=await window.mote.setLanguage(next);}
      preferences.dataset.dirty='false';
    } catch {
      window.dispatchEvent(new Event('mote-language-change-failed'));
      error.textContent=translate(language.locale,next!==language.preference?'语言保存失败，请重试。':'无法保存外观偏好，请重试。');error.hidden=false;
    } finally {saving=false;update();}
  });
  await import('./ui');
}
void start().catch(error => { console.error('Mote UI initialization failed',error instanceof Error?error.stack:String(error)); document.getElementById('feedback')!.textContent = 'Unable to load language settings / 无法读取语言设置'; });
