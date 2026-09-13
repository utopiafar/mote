import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, Status } from './contracts';

const api: DesktopApi = {
  exportSupport: () => ipcRenderer.invoke('mote:support-export'),
  sampleDiagnostics: () => ipcRenderer.invoke('mote:diagnostics-sample'),
  exportDiagnostics: () => ipcRenderer.invoke('mote:diagnostics-export'),
  noteDraft: () => ipcRenderer.invoke('mote:note-draft'),
  updateNoteDraft: input => ipcRenderer.invoke('mote:note-draft-update', input),
  saveNote: input => ipcRenderer.invoke('mote:note', input),
  openCentral: () => ipcRenderer.invoke('mote:central'),
  status: () => ipcRenderer.invoke('mote:get-status'),
  configure: update => ipcRenderer.invoke('mote:configure', update),
  start: () => ipcRenderer.invoke('mote:start'),
  stop: () => ipcRenderer.invoke('mote:stop'),
  retry: () => ipcRenderer.invoke('mote:retry'),
  openPermissions: () => ipcRenderer.invoke('mote:permissions'),
  openDataFolder: () => ipcRenderer.invoke('mote:data-folder'),
  exportQueue: () => ipcRenderer.invoke('mote:export-queue'),
  importQueue: () => ipcRenderer.invoke('mote:import-queue'),
  downloadModel: () => ipcRenderer.invoke('mote:model-download'),
  cancelModelDownload: () => ipcRenderer.invoke('mote:model-cancel'),
  importModel: () => ipcRenderer.invoke('mote:model-import'),
  reloadModel: () => ipcRenderer.invoke('mote:model-reload'),
  onStatus: callback => {
    const handler = (_event: Electron.IpcRendererEvent, status: Status) => callback(status);
    ipcRenderer.on('mote:status', handler);
    return () => ipcRenderer.removeListener('mote:status', handler);
  },
};
contextBridge.exposeInMainWorld('mote', api);
