import { extractFileText } from './file-index';

export interface ContentReadResult { text: string; parser: string; status: 'ready'|'pending'|'unsupported'; coverage?: 'full'|'partial'|'none'; warnings?: string[] }
export interface ContentAdapter {
  readonly name: string;
  supports(mimeType: string): boolean;
  read(bytes: Buffer, mimeType: string, signal?: AbortSignal): Promise<ContentReadResult>;
}

/** Ordinary files share one discovery/index contract and delegate decoding here. */
export class FileContentAdapter implements ContentAdapter {
  readonly name = 'file';
  supports(_mimeType: string): boolean { return true; }
  read(bytes: Buffer, mimeType: string, signal?: AbortSignal): Promise<ContentReadResult> {
    // Audio bytes are uploaded as an original first; transcription is a
    // separate durable processing job and must never block discovery.
    if (mimeType.startsWith('audio/')) return Promise.resolve({ text: '', parser: 'audio-original', status: 'pending' });
    return extractFileText(bytes, mimeType, signal);
  }
}

/** JSONL sources use the append cursor in coding-agents.ts instead of this full reader. */
export class JsonlContentAdapter implements ContentAdapter {
  readonly name = 'jsonl-append';
  supports(mimeType: string): boolean { return mimeType === 'application/x-ndjson' || mimeType === 'application/jsonl'; }
  async read(_bytes: Buffer, _mimeType: string): Promise<ContentReadResult> { return { text: '', parser: this.name, status: 'unsupported' }; }
}

const fileAdapter = new FileContentAdapter();
const jsonlAdapter = new JsonlContentAdapter();
export function contentAdapter(mimeType: string): ContentAdapter { return jsonlAdapter.supports(mimeType) ? jsonlAdapter : fileAdapter; }
