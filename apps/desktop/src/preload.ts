import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, Status } from './contracts';

const api: DesktopApi = {
  browseCaptures: input => ipcRenderer.invoke('mote:captures-browse', input),
  captureDetail: (location, id) => ipcRenderer.invoke('mote:captures-detail', location, id),
  captureImage: (location, id, thumbnail) => ipcRenderer.invoke('mote:captures-image', location, id, thumbnail),
  installedApplications: () => ipcRenderer.invoke('mote:installed-applications'),
  onNavigate: callback => {
    const handler = (_event: Electron.IpcRendererEvent, page: 'overview' | 'notes' | 'sources' | 'settings') => callback(page);
    ipcRenderer.on('mote:navigate', handler);
    return () => ipcRenderer.removeListener('mote:navigate', handler);
  },
  previewConnection: input => ipcRenderer.invoke('mote:connection-preview', input),
  importConnection: kind => ipcRenderer.invoke('mote:connection-import', kind),
  cancelConnection: () => ipcRenderer.invoke('mote:connection-cancel'),
  confirmConnection: (id, origin) => ipcRenderer.invoke('mote:connection-confirm', id, origin),
  connectionStatus: () => ipcRenderer.invoke('mote:connection-status'),
  testConnection: () => ipcRenderer.invoke('mote:connection-test'),
  openCentralOwner: token => ipcRenderer.invoke('mote:central-owner', token),
  updateStatus: () => ipcRenderer.invoke('mote:update-status'),
  updateChannel: channel => ipcRenderer.invoke('mote:update-channel', channel),
  checkUpdate: () => ipcRenderer.invoke('mote:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('mote:update-download'),
  cancelUpdate: () => ipcRenderer.invoke('mote:update-cancel'),
  installUpdate: () => ipcRenderer.invoke('mote:update-install'),
  revealUpdate: () => ipcRenderer.invoke('mote:update-reveal'),
  releaseNotes: () => ipcRenderer.invoke('mote:update-notes'),
  openFeedback: () => ipcRenderer.invoke('mote:feedback'),
  sources: () => ipcRenderer.invoke('mote:sources'),
  chooseSourceFiles: (mode, options) => ipcRenderer.invoke('mote:source-files', mode, options),
  authorizeCalendar: () => ipcRenderer.invoke('mote:calendar-authorize'),
  addCalendarSource: (id, options) => ipcRenderer.invoke('mote:source-calendar', id, options),
  updateSource: (id, options) => ipcRenderer.invoke('mote:source-update', id, options),
  syncSources: () => ipcRenderer.invoke('mote:source-sync'),
  openCalendarPermissions: () => ipcRenderer.invoke('mote:calendar-permissions'),
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
