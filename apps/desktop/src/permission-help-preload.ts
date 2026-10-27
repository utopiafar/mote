import { ipcRenderer } from 'electron';
import type { PermissionHelpState } from './permission-types';

window.addEventListener('DOMContentLoaded', () => {
  const byId = (id: string) => document.getElementById(`permission-help-${id}`)!;
  void ipcRenderer.invoke('mote:permission-help-state').then((state: PermissionHelpState) => {
    document.documentElement.lang = state.locale;
    document.title = state.title;
    for (const key of ['title', 'drag', 'existing', 'note', 'reveal'] as const) byId(key).textContent = state[key];
    byId('name').textContent = state.appName;
    (byId('icon') as HTMLImageElement).src = state.icon;
    byId('app').setAttribute('aria-label', `${state.appName} · ${state.drag}`);
    byId('close').setAttribute('aria-label', state.close);
    requestAnimationFrame(() => ipcRenderer.send('mote:permission-help-action', 'resize', document.body.getBoundingClientRect().height));
  });
  byId('app').addEventListener('dragstart', event => { event.preventDefault(); ipcRenderer.send('mote:permission-help-action', 'drag'); });
  byId('close').addEventListener('click', () => ipcRenderer.send('mote:permission-help-action', 'close'));
  byId('reveal').addEventListener('click', () => ipcRenderer.send('mote:permission-help-action', 'reveal'));
  window.addEventListener('keydown', event => { if (event.key === 'Escape') ipcRenderer.send('mote:permission-help-action', 'close'); });
});
