/** Renderer/main data contract. Keep platform and implementation dependencies outside this module. */
import type { ReleaseChannel } from '@mote/shared/release';

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type RuntimeLogPolicy = {enabled: boolean; level: RuntimeLogLevel};

export interface UploadGateConfig {
  enabled: boolean;
  blockedText: string[];
  failureAction: 'drop' | 'hold' | 'allow';
}
export type ImageDedupeMode = 'off' | 'exact' | 'conservative' | 'balanced' | 'aggressive';
export interface CompressionPreview {original:string;compressed:string;originalBytes:number;compressedBytes:number;width:number;height:number;originalWidth:number;originalHeight:number}
export interface UpdateStatus {
  manualDownload?: boolean;
  currentVersion: string; channel: ReleaseChannel;
  state: 'idle' | 'checking' | 'available' | 'up_to_date' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error';
  message: string; received: number; total: number; canInstall: boolean; installReason: string;
  availableVersion?: string; notesUrl?: string; checkedAt?: string;
}
