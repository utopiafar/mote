import {useEffect, useRef, useState} from 'react';
import {FileText, ImagePlus} from 'lucide-react';
import {formatEvidenceRef} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {uploadChatImage} from '../notes/note-attachments';
import {unsentDrafts, unsentImages, type ChatAttachment, type ChatImageUpload} from './chat-drafts';
import {queryRecovery} from './query-recovery';

const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
const localFiles = new WeakMap<Api, Map<string, File>>();

export type AttachmentDraft = ReturnType<typeof useChatAttachments>;

export function useChatAttachments(api: Api, setError: (value: string) => void) {
  const [attachments, setAttachments] = useState(() => unsentDrafts.get(api)?.attachments ?? []);
  const [pending, setPending] = useState(() => unsentImages.get(api) ?? []);
  const [uploading, setUploading] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);

  function saveAttachments(value: ChatAttachment[]) {
    unsentDrafts.set(api, {question: unsentDrafts.get(api)?.question ?? '', attachments: value});
    setAttachments(value);
  }

  function updatePending(change: (value: ChatImageUpload[]) => ChatImageUpload[]) {
    const value = change(unsentImages.get(api) ?? []);
    unsentImages.set(api, value);
    setPending(value);
  }

  useEffect(() => () => {
    request.current?.abort();
    request.current = undefined;
    const interrupted = unsentImages.get(api);
    if (interrupted?.length) unsentImages.set(api, interrupted.map(value => ({...value, status: 'failed'})));
  }, [api]);

  function clear() {
    request.current?.abort();
    request.current = undefined;
    setUploading(false);
    localFiles.delete(api);
    saveAttachments([]);
    updatePending(() => []);
  }

  async function upload(items: ChatImageUpload[]) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setUploading(true);
    setError('');
    try {
      let deviceId = localStorage.getItem('mote.chat.device.v1');
      if (!deviceId) {
        deviceId = 'web:' + crypto.randomUUID();
        localStorage.setItem('mote.chat.device.v1', deviceId);
      }
      for (const item of items) {
        updatePending(rows => rows.map(row => row.key === item.key ? {...row, status: 'uploading'} : row));
        try {
          const id = await uploadChatImage(api, item.file, deviceId, controller.signal);
          if (controller.signal.aborted) return;
          const current = unsentDrafts.get(api)?.attachments ?? [];
          if (!current.some(row => row.id === id)) {
            const files = localFiles.get(api) ?? new Map<string, File>();
            files.set(id, item.file);
            localFiles.set(api, files);
            saveAttachments([...current, {id, name: item.file.name, mimeType: item.file.type}]);
          }
          updatePending(rows => rows.filter(row => row.key !== item.key));
        } catch {
          if (controller.signal.aborted) return;
          updatePending(rows => rows.map(row => row.key === item.key ? {...row, status: 'failed'} : row));
        }
      }
    } catch {
      updatePending(rows => rows.map(row => items.includes(row) ? {...row, status: 'failed'} : row));
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setUploading(false);
      }
    }
  }

  return {
    attachments, pending, uploading, clear,
    preview: (id: string) => localFiles.get(api)?.get(id),
    add(files: FileList | null) {
      if (!files?.length || request.current) return;
      if ((unsentDrafts.get(api)?.attachments.length ?? 0) + (unsentImages.get(api)?.length ?? 0) + files.length > 4) {
        setError(moteText('最多添加 4 张图片'));
        return;
      }
      const selected = Array.from(files);
      if (selected.some(file => !imageTypes.includes(file.type) || file.size < 1 || file.size > 8 * 1024 * 1024)) {
        setError(moteText('聊天图片仅支持 PNG、JPEG、WebP，每张不超过 8 MiB。'));
        return;
      }
      queryRecovery.draftEdited(api);
      const rows = selected.map(file => ({key: crypto.randomUUID(), file, status: 'uploading' as const}));
      updatePending(previous => [...previous, ...rows]);
      void upload(rows);
    },
    retry(item: ChatImageUpload) {
      return upload([item]);
    },
    remove(id: string, failed: boolean) {
      queryRecovery.draftEdited(api);
      if (failed) updatePending(rows => rows.filter(row => row.key !== id));
      else {
        localFiles.get(api)?.delete(id);
        saveAttachments((unsentDrafts.get(api)?.attachments ?? []).filter(row => row.id !== id));
      }
      setError('');
    },
  };
}

export function ChatDraftThumbnail({file}: {file?: File}) {
  const [preview, setPreview] = useState<{file: File; url: string}>();
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(file);
    setPreview({file, url});
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return preview && preview.file === file ? <img className="chat-draft-thumbnail" src={preview.url} alt=""/> : <ImagePlus size={14}/>;
}

export function ChatAttachmentView({api, attachment, onOpen}: {api: Api; attachment: ChatAttachment; onOpen: (ref: string) => void}) {
  const {id, mimeType, name} = attachment;
  const image = imageTypes.includes(mimeType);
  const [preview, setPreview] = useState<{id: string; url: string}>();
  useEffect(() => {
    if (!image || typeof URL.createObjectURL !== 'function') return;
    const controller = new AbortController();
    let url: string | undefined;
    async function load() {
      try {
        const response = await api.raw('/api/files/' + encodeURIComponent(id) + '/thumbnail', {signal: controller.signal});
        const blob = await response.blob();
        if (controller.signal.aborted || !imageTypes.includes(blob.type)) return;
        url = URL.createObjectURL(blob);
        setPreview({id, url});
      } catch {
        // The authorized reader can still open the attachment when a preview is unavailable.
      }
    }
    void load();
    return () => {controller.abort(); if (url) URL.revokeObjectURL(url);};
  }, [api, id, image]);

  return <button className="chat-attachment-preview" type="button" onClick={() => onOpen(formatEvidenceRef('capture', id))}>
    {preview?.id === id ? <img src={preview.url} alt=""/> : image ? <ImagePlus size={16}/> : <FileText size={16}/>}
    <span>{name}</span>
  </button>;
}
