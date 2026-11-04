/** The single build-time inventory of owner IPC channels. Plugin modules and
 * the preload bridge import these names; main.ts registers every host channel
 * through the plugin host instead of a raw ipcMain handler. No renderer path
 * can invent a channel that is absent from this file. */

export const notesChannels = {
  draft: 'mote:note-draft',
  update: 'mote:note-draft-update',
  save: 'mote:note',
} as const;

export const libraryWorkspaceChannels = {
  contentCentral: 'mote:content-central',
  contentCentralDetail: 'mote:content-central-detail',
  contentLocal: 'mote:content-local',
  contentLocalDetail: 'mote:content-local-detail',
  capturesBrowse: 'mote:captures-browse',
  capturesDetail: 'mote:captures-detail',
  capturesImage: 'mote:captures-image',
  sourceArchivedContent: 'mote:source-archived-content',
  sourcePendingContent: 'mote:source-pending-content',
  memoryTopics: 'mote:memory-topics',
  memoryTopicPage: 'mote:memory-topic-page',
  memoryTopicDetail: 'mote:memory-topic-detail',
  memoryTopicEvidence: 'mote:memory-topic-evidence',
} as const;

export const sourcesChannels = {
  coding: 'mote:source-coding',
  list: 'mote:sources',
  context: 'mote:source-context',
  contextSave: 'mote:source-context-save',
  sync: 'mote:source-sync',
  calendarAuthorize: 'mote:calendar-authorize',
  calendar: 'mote:source-calendar',
  update: 'mote:source-update',
  select: 'mote:source-select',
  cancel: 'mote:source-cancel',
  confirm: 'mote:source-confirm',
  files: 'mote:source-files',
  calendarPermissions: 'mote:calendar-permissions',
} as const;

export const captureChannels = {
  start: 'mote:start',
  stop: 'mote:stop',
  retry: 'mote:retry',
  reviewPending: 'mote:review-pending',
  reviewReject: 'mote:review-reject',
  reviewApprove: 'mote:review-approve',
} as const;

export const chromeChannels = {
  permissions: 'mote:chrome-permissions',
  permissionsCancel: 'mote:chrome-permissions-cancel',
  extensions: 'mote:chrome-extensions',
  setup: 'mote:chrome-setup',
} as const;

export const askWorkspaceChannels = {
  request: 'mote:ask',
} as const;

export const deviceSettingsChannels = {
  connectionStatus: 'mote:connection-status',
  connectionPreview: 'mote:connection-preview',
  connectionCancel: 'mote:connection-cancel',
  connectionImport: 'mote:connection-import',
  connectionConfirm: 'mote:connection-confirm',
  connectionTest: 'mote:connection-test',
  configure: 'mote:configure',
  syncPaused: 'mote:sync-paused',
  permissionStatus: 'mote:permission-status',
  permissionSettings: 'mote:permission-settings',
  permissionRequest: 'mote:permission-request',
  permissionRestart: 'mote:permission-restart',
  permissions: 'mote:permissions',
  captureContext: 'mote:capture-context',
  captureContextSave: 'mote:capture-context-save',
  language: 'mote:language',
  setLanguage: 'mote:set-language',
} as const;

export const workHistoryWorkspaceChannels = {
  workActivity: 'mote:work-activity',
  syncHistory: 'mote:sync-history',
  syncHistoryContents: 'mote:sync-history-contents',
  syncHistoryContent: 'mote:sync-history-content',
  syncHistoryPending: 'mote:sync-history-pending',
} as const;

export const localStorageBackupChannels = {
  compressionPreview: 'mote:compression-preview',
  storageChoose: 'mote:storage-choose',
  storageOpen: 'mote:storage-open',
  exportQueue: 'mote:export-queue',
  importQueue: 'mote:import-queue',
} as const;

export const systemToolsChannels = {
  updateStatus: 'mote:update-status',
  updateChannel: 'mote:update-channel',
  updateCheck: 'mote:update-check',
  updateDownload: 'mote:update-download',
  updateCancel: 'mote:update-cancel',
  updateInstall: 'mote:update-install',
  updateReveal: 'mote:update-reveal',
  updateNotes: 'mote:update-notes',
  supportExport: 'mote:support-export',
  eventsRead: 'mote:events-read',
  eventsRaw: 'mote:events-raw',
} as const;

export const capabilityPublisherChannels = {
  calendarConnect: 'mote:action-calendar-connect',
} as const;

export const customPageChannels = {
  prepare: 'mote:custom-page-prepare',
  claim: 'mote:custom-page-claim',
} as const;

/** Host primitives: shell/window/status/appearance transport. They still pass
 * through the plugin host's caller, frame and capability checks. */
export const hostChannels = {
  appearanceInitial: 'mote:appearance-initial',
  setAppearance: 'mote:set-appearance',
  getStatus: 'mote:get-status',
  installedApplications: 'mote:installed-applications',
  feedback: 'mote:feedback',
  codingAgents: 'mote:coding-agents',
  diagnosticsSample: 'mote:diagnostics-sample',
  diagnosticsExport: 'mote:diagnostics-export',
  storageStatistics: 'mote:storage-statistics',
  storageRestart: 'mote:storage-restart',
  dataFolder: 'mote:data-folder',
  exportMetadata: 'mote:export-metadata',
  central: 'mote:central',
  centralWork: 'mote:central-work',
  quickNote: 'mote:quick-note',
  quickNoteSize: 'mote:quick-note-size',
} as const;

/** Main-to-renderer pushes and custom page events. These are not invokable
 * services; preload only subscribes to them. */
export const pushChannels = {
  appearance: 'mote:appearance',
  navigate: 'mote:navigate',
  status: 'mote:status',
  customPageRevoked: 'mote:custom-page-revoked',
} as const;

/** Durable jobs registered by plugin scopes. The inventory test stops each
 * package scope and verifies these disappear with their channels. */
export const desktopJobIds = {
  capabilityPublication: 'capability-publication',
  systemToolsUpdater: 'system-tools-updater',
  chromeNativeMessaging: 'chrome-native-messaging',
  captureRuntime: 'capture-runtime',
  sourcesManager: 'sources-manager',
  notesDraft: 'notes-draft',
} as const;
