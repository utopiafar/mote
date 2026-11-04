import { contextBridge, ipcRenderer } from 'electron';
import {
  askWorkspaceChannels, captureChannels, capabilityPublisherChannels, chromeChannels,
  customPageChannels, deviceSettingsChannels, hostChannels, libraryWorkspaceChannels,
  localStorageBackupChannels, notesChannels, pushChannels, sourcesChannels,
  systemToolsChannels, workHistoryWorkspaceChannels,
} from './desktop-ipc-channels';
import type { DesktopApi, Status } from './contracts';

/** The renderer bridge names only channels declared by the build inventory;
 * plugin scopes and host primitives enforce sender, frame and capability. */
const api: DesktopApi = {
  initialAppearance: ipcRenderer.sendSync(hostChannels.appearanceInitial),
  setAppearance: preference => ipcRenderer.invoke(hostChannels.setAppearance,preference),
  onAppearance: callback => {
    const handler=(_event: Electron.IpcRendererEvent,value: DesktopApi['initialAppearance'])=>callback(value);
    ipcRenderer.on(pushChannels.appearance,handler);
    return ()=>ipcRenderer.removeListener(pushChannels.appearance,handler);
  },
  workActivity: input => ipcRenderer.invoke(workHistoryWorkspaceChannels.workActivity,input),
  openWorkActivity: workId => ipcRenderer.invoke(hostChannels.centralWork,workId),
  syncHistory: input => ipcRenderer.invoke(workHistoryWorkspaceChannels.syncHistory,input),
  syncHistoryContents: input => ipcRenderer.invoke(workHistoryWorkspaceChannels.syncHistoryContents,input),
  syncHistoryContent: (runId,key,chunkOffset,includeImage) => ipcRenderer.invoke(workHistoryWorkspaceChannels.syncHistoryContent,runId,key,chunkOffset,includeImage),
  syncHistoryPending: () => ipcRenderer.invoke(workHistoryWorkspaceChannels.syncHistoryPending),
  ask: (command, input) => ipcRenderer.invoke(askWorkspaceChannels.request, command, input),
  storageStatistics: () => ipcRenderer.invoke(hostChannels.storageStatistics),
  language: () => ipcRenderer.invoke(deviceSettingsChannels.language),
  setLanguage: preference => ipcRenderer.invoke(deviceSettingsChannels.setLanguage, preference),
  compressionPreview: (quality, maxSide) => ipcRenderer.invoke(localStorageBackupChannels.compressionPreview, quality, maxSide),
  browseCaptures: input => ipcRenderer.invoke(libraryWorkspaceChannels.capturesBrowse, input),
  captureDetail: (location, id) => ipcRenderer.invoke(libraryWorkspaceChannels.capturesDetail, location, id),
  captureImage: (location, id, thumbnail) => ipcRenderer.invoke(libraryWorkspaceChannels.capturesImage, location, id, thumbnail),
  checkChromePermissions:id=>ipcRenderer.invoke(chromeChannels.permissions,id),
  cancelChromePermissions:id=>ipcRenderer.invoke(chromeChannels.permissionsCancel,id),
  openChromeExtensions:()=>ipcRenderer.invoke(chromeChannels.extensions),
  setupChromeCapture: () => ipcRenderer.invoke(chromeChannels.setup),
  installedApplications: () => ipcRenderer.invoke(hostChannels.installedApplications),
  onNavigate: callback => {
    const handler = (_event: Electron.IpcRendererEvent, page: 'overview' | 'notes' | 'sources' | 'settings' | 'central') => callback(page);
    ipcRenderer.on(pushChannels.navigate, handler);
    return () => ipcRenderer.removeListener(pushChannels.navigate, handler);
  },
  previewConnection: input => ipcRenderer.invoke(deviceSettingsChannels.connectionPreview, input),
  importConnection: kind => ipcRenderer.invoke(deviceSettingsChannels.connectionImport, kind),
  cancelConnection: () => ipcRenderer.invoke(deviceSettingsChannels.connectionCancel),
  confirmConnection: (id, origin, deviceName) => ipcRenderer.invoke(deviceSettingsChannels.connectionConfirm, id, origin, deviceName),
  connectionStatus: () => ipcRenderer.invoke(deviceSettingsChannels.connectionStatus),
  testConnection: () => ipcRenderer.invoke(deviceSettingsChannels.connectionTest),
  updateStatus: () => ipcRenderer.invoke(systemToolsChannels.updateStatus),
  updateChannel: channel => ipcRenderer.invoke(systemToolsChannels.updateChannel, channel),
  checkUpdate: () => ipcRenderer.invoke(systemToolsChannels.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(systemToolsChannels.updateDownload),
  cancelUpdate: () => ipcRenderer.invoke(systemToolsChannels.updateCancel),
  installUpdate: () => ipcRenderer.invoke(systemToolsChannels.updateInstall),
  revealUpdate: () => ipcRenderer.invoke(systemToolsChannels.updateReveal),
  releaseNotes: () => ipcRenderer.invoke(systemToolsChannels.updateNotes),
  openFeedback: () => ipcRenderer.invoke(hostChannels.feedback),
  codingAgents: () => ipcRenderer.invoke(hostChannels.codingAgents),
  addCodingAgent: (provider, options) => ipcRenderer.invoke(sourcesChannels.coding, provider, options),
  setSyncPaused: paused => ipcRenderer.invoke(deviceSettingsChannels.syncPaused, paused),
  sources: () => ipcRenderer.invoke(sourcesChannels.list),
  sourceArchivedContent:(id,cursor)=>ipcRenderer.invoke(libraryWorkspaceChannels.sourceArchivedContent,id,cursor),
  sourcePendingContent:id=>ipcRenderer.invoke(libraryWorkspaceChannels.sourcePendingContent,id),
  sourceContext:id=>ipcRenderer.invoke(sourcesChannels.context,id),
  saveSourceContext:(id,input)=>ipcRenderer.invoke(sourcesChannels.contextSave,id,input),
  selectSourceFiles: mode => ipcRenderer.invoke(sourcesChannels.select, mode),
  confirmSourceFiles: (id, options) => ipcRenderer.invoke(sourcesChannels.confirm, id, options),
  cancelSourceFiles: id => ipcRenderer.invoke(sourcesChannels.cancel, id),
  memoryTopics: () => ipcRenderer.invoke(libraryWorkspaceChannels.memoryTopics),
  memoryTopicPage: input => ipcRenderer.invoke(libraryWorkspaceChannels.memoryTopicPage,input),
  memoryTopicEvidence: (memoryId,evidenceId) => ipcRenderer.invoke(libraryWorkspaceChannels.memoryTopicEvidence,memoryId,evidenceId),
  memoryTopicDetail: id => ipcRenderer.invoke(libraryWorkspaceChannels.memoryTopicDetail,id),
  centralContent: (cursor,query) => ipcRenderer.invoke(libraryWorkspaceChannels.contentCentral, cursor,query),
  centralContentDetail: (id,offset,image) => ipcRenderer.invoke(libraryWorkspaceChannels.contentCentralDetail,id,offset,image),
  localContent: (offset,query) => ipcRenderer.invoke(libraryWorkspaceChannels.contentLocal, offset,query),
  localContentDetail: (key, image) => ipcRenderer.invoke(libraryWorkspaceChannels.contentLocalDetail, key, image),
  chooseSourceFiles: (mode, options) => ipcRenderer.invoke(sourcesChannels.files, mode, options),
  connectActionCalendar: () => ipcRenderer.invoke(capabilityPublisherChannels.calendarConnect),
  authorizeCalendar: () => ipcRenderer.invoke(sourcesChannels.calendarAuthorize),
  addCalendarSource: (id, options) => ipcRenderer.invoke(sourcesChannels.calendar, id, options),
  updateSource: (id, options) => ipcRenderer.invoke(sourcesChannels.update, id, options),
  syncSources: () => ipcRenderer.invoke(sourcesChannels.sync),
  openCalendarPermissions: () => ipcRenderer.invoke(sourcesChannels.calendarPermissions),
  exportSupport: hours => ipcRenderer.invoke(systemToolsChannels.supportExport, hours),
  sampleDiagnostics: () => ipcRenderer.invoke(hostChannels.diagnosticsSample),
  exportDiagnostics: () => ipcRenderer.invoke(hostChannels.diagnosticsExport),
  readRawEvents: () => ipcRenderer.invoke(systemToolsChannels.eventsRaw),
  readEvents: () => ipcRenderer.invoke(systemToolsChannels.eventsRead),
  openQuickNote: () => ipcRenderer.invoke(hostChannels.quickNote),
  resizeQuickNote: expanded => ipcRenderer.invoke(hostChannels.quickNoteSize, expanded),
  customPagePrepare: target => ipcRenderer.invoke(customPageChannels.prepare, target),
  customPageClaim: claim => ipcRenderer.invoke(customPageChannels.claim, claim),
  onCustomPageRevoked: callback => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) => callback(value);
    ipcRenderer.on(pushChannels.customPageRevoked, handler);
    return () => ipcRenderer.removeListener(pushChannels.customPageRevoked, handler);
  },
  noteDraft: () => ipcRenderer.invoke(notesChannels.draft),
  updateNoteDraft: input => ipcRenderer.invoke(notesChannels.update, input),
  saveNote: input => ipcRenderer.invoke(notesChannels.save, input),
  openCentral: (page?: string, evidenceId?: string,conversationId?:string) => ipcRenderer.invoke(hostChannels.central,page,evidenceId,conversationId),
  status: () => ipcRenderer.invoke(hostChannels.getStatus),
  restartForStorageRecovery: () => ipcRenderer.invoke(hostChannels.storageRestart),
  chooseCaptureDirectory: () => ipcRenderer.invoke(localStorageBackupChannels.storageChoose),
  openCaptureDirectory: () => ipcRenderer.invoke(localStorageBackupChannels.storageOpen),
  configure: update => ipcRenderer.invoke(deviceSettingsChannels.configure, update),
  start: () => ipcRenderer.invoke(captureChannels.start),
  stop: () => ipcRenderer.invoke(captureChannels.stop),
  reviewPending: () => ipcRenderer.invoke(captureChannels.reviewPending),
  rejectReview: id => ipcRenderer.invoke(captureChannels.reviewReject,id),
  approveReview: id => ipcRenderer.invoke(captureChannels.reviewApprove,id),
  retry: () => ipcRenderer.invoke(captureChannels.retry),
  permissionStatus: () => ipcRenderer.invoke(deviceSettingsChannels.permissionStatus),
  permissionSettings: kind => ipcRenderer.invoke(deviceSettingsChannels.permissionSettings, kind),
  requestPermission: kind => ipcRenderer.invoke(deviceSettingsChannels.permissionRequest, kind),
  restartForPermissions: () => ipcRenderer.invoke(deviceSettingsChannels.permissionRestart),
  openPermissions: () => ipcRenderer.invoke(deviceSettingsChannels.permissions),
  openDataFolder: () => ipcRenderer.invoke(hostChannels.dataFolder),
  exportMetadata: () => ipcRenderer.invoke(hostChannels.exportMetadata),
  captureContext:channel=>ipcRenderer.invoke(deviceSettingsChannels.captureContext,channel),
  saveCaptureContext:(channel,input)=>ipcRenderer.invoke(deviceSettingsChannels.captureContextSave,channel,input),
  exportQueue: () => ipcRenderer.invoke(localStorageBackupChannels.exportQueue),
  importQueue: () => ipcRenderer.invoke(localStorageBackupChannels.importQueue),
  onStatus: callback => {
    const handler = (_event: Electron.IpcRendererEvent, status: Status) => callback(status);
    ipcRenderer.on(pushChannels.status, handler);
    return () => ipcRenderer.removeListener(pushChannels.status, handler);
  },
};
contextBridge.exposeInMainWorld('mote', api);
