export type Platform = 'macos' | 'windows' | 'linux';
export type Rectangle = { x: number; y: number; width: number; height: number };
export interface Config {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  intervalMs: number;
  maxQueueBytes: number;
  maxQueueEvents: number;
  excludedAppIds: string[];
  masks: Rectangle[];
  idlePauseSeconds: number;
  ocrEnabled: boolean;
  privacyModelUrl: string;
  nsfwEnabled: boolean;
  reviewPolicy: string;
  reviewMaxTokens: number;
  reviewMaxSide: number;
  nsfwThreads: number;
  nsfwTimeoutMs: number;
  nsfwSource: 'auto' | 'mirror' | 'official' | 'custom';
  nsfwCustomUrl: string;
  diagnosticsEnabled: boolean;
  diagnosticIntervalSeconds: number;
  jpegQuality: number;
  captureMaxSide: number;
  pauseOnBattery: boolean;
  batteryPauseBelowPct: number;
  openAtLogin: boolean;
  token?: string;
}
export type PublicConfig = Omit<Config, 'token'> & { tokenConfigured: boolean };
export type ConfigUpdate = Omit<Config, 'token' | 'deviceId'> & { token?: string };
export interface CaptureEvent {
  id: string;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  capturedAt: string;
  durationMs: number;
  appId: string;
  appName: string;
  imageMime?: 'image/jpeg';
  ocrText?: string;
  source: 'screen' | 'note';
  mood?: string;
  privacy: { excluded: false; redacted: boolean; mode: 'local' | 'none'; reason?: string };
}
export interface Status {
  running: boolean;
  state: 'stopped' | 'capturing' | 'paused' | 'permission_required' | 'error';
  message: string;
  queueDepth: number;
  queueBytes: number;
  lastCaptureAt?: string;
  lastUploadAt?: string;
  lastUploadError?: string;
  nextRetryAt?: string;
  screenPermission: string;
  platform: Platform;
  encryptedTokenStorage: boolean;
  config: PublicConfig;
  nsfw?: NsfwStatus;
  diagnostics?: import('@mote/diagnostics').DiagnosticsStatus;
}
export interface NsfwStatus {
  modelState: 'missing' | 'partial' | 'ready' | 'invalid' | 'verifying';
  modelId: string;
  modelRevision: string;
  bytes: number;
  totalBytes: number;
  downloading: boolean;
  downloadSource?: string;
  inferenceState: 'stopped' | 'starting' | 'ready' | 'running' | 'error';
  lastAllowed?: boolean;
  lastLoadMs?: number;
  lastVisionMs?: number;
  lastTokens?: number;
  lastDurationMs?: number;
  blockedCount: number;
  error?: string;
}
export interface NsfwGate {
  status(): NsfwStatus;
  ensureReady(): Promise<void>;
  classify(image: { bitmap: Buffer; width: number; height: number }, config: Config, signal?: AbortSignal): Promise<{ allow: boolean; blocked: boolean }>;
  reset(): void;
  close(): void;
}
export interface DesktopApi {
  status(): Promise<Status>;
  noteDraft(): Promise<import('./note-draft').NoteDraft>;
  updateNoteDraft(input: import('./note-draft').NoteDraft): Promise<import('./note-draft').NoteDraft>;
  saveNote(input: import('./note-draft').NoteDraft): Promise<{ id: string; draft: import('./note-draft').NoteDraft }>;
  openCentral(): Promise<void>;
  exportDiagnostics(): Promise<{ canceled: boolean }>;
  sampleDiagnostics(): Promise<Status>;
  configure(update: ConfigUpdate): Promise<Status>;
  start(): Promise<Status>;
  stop(): Promise<Status>;
  retry(): Promise<Status>;
  openPermissions(): Promise<void>;
  openDataFolder(): Promise<void>;
  exportQueue(): Promise<{ canceled: boolean; path?: string }>;
  importQueue(): Promise<{ canceled: boolean; imported?: number }>;
  downloadModel(): Promise<Status>;
  cancelModelDownload(): Promise<Status>;
  importModel(): Promise<{ canceled: boolean }>;
  reloadModel(): Promise<Status>;
  onStatus(callback: (status: Status) => void): () => void;
}
