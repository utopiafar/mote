/** Renderer/main data contract. Keep platform and implementation dependencies outside this module. */
import type { CaptureSession } from '@mote/shared/capture-sessions';
import type { SyncSource, SyncHistoryItem } from './sync-history';

export type CaptureLocation = 'local' | 'central';
export interface BrowseRequest { source?: 'screen'|'ui_page'; location: CaptureLocation; day: string; cursor?: string; grouping?: 'sessions' | 'records'; sessionId?: string }
export interface BrowserCapture {
  source?: 'screen'|'ui_page'; id: string; capturedAt: string; appName: string; appId: string;
  ocr: { status: 'pending' | 'completed' | 'disabled' | 'failed' | 'unknown'; reason?: 'charging' };
  textPreview: string; sizeBytes?: number; hasImage: boolean; syncError?: string;
}
export interface BrowserPage { items: BrowserCapture[]; totalCount: number; nextCursor?: string; sessions?: CaptureSession[]; sessionCount?: number }
export interface BrowserDetail extends BrowserCapture { ocrText: string; deviceName?: string }
export interface ContentItem { key:string;source:SyncSource;title:string;observedAt:string;preview:string;sourceName?:string;error?:string; }
export interface LocalContentPage {items:ContentItem[];total:number;nextOffset?:number;}
export interface ContentDetail {text:string;description?:string;sourceName:string;metadata:string;hasImage?:boolean;image?:string;metadataOnly?:boolean;retainsOriginal?:boolean;truncated?:boolean;}
export interface CentralContentPage {items:ContentItem[];total:number;nextCursor?:string;authorizationDenied?:true;}
export interface SyncContent {
  item: SyncHistoryItem; location: 'local' | 'central'; text: string; description?:string; image?: string;
  readiness?: 'ready'|'pending'|'failed'|'unknown'|'metadata';
  hasImage?:boolean; retainsOriginal?:boolean; truncated?:boolean;
  processing?: boolean; metadataOnly?: boolean; nextChunkOffset?: number;
  metadata?: string; captureId?: string;
}
export type TopicDirectory={items:{id:string;label:string;nodes:{id:string;label:string;parentId?:string}[]}[];classification?:{state:string}};
export type TopicMemory={id:string;title:string;statement?:string;status:string;version:number;fingerprint?:string;supersededBy?:string;uncertainty?:string;evidenceIds?:string[]};
export type TopicPage={items:TopicMemory[];nextCursor?:string|null};
export type TopicQuery={treeId?:string;nodeId?:string;cursor?:string};
export type TopicEvidence={id:string;text:string;metadata:string};
export type WorkActivityQuery={state?:'active'|'attention'|'completed';cursor?:number};
