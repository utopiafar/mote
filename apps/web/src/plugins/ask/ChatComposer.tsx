import {memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {ArrowUp, ImagePlus, LoaderCircle, Plus, X} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {ModelSelector} from '../../ModelSelector';
import {ChatDraftThumbnail, type AttachmentDraft} from './chat-attachments';

export function createChatDraft(initial: string, onChange: (value: string) => void) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {listeners.delete(listener);};
    },
    set(next: string) {
      if (next === value) return;
      value = next;
      onChange(next);
      for (const listener of listeners) listener();
    },
  };
}

const StableModelSelector = memo(ModelSelector);

export function ChatComposer({api, draft, files, busy, blocked, preparing, model, override, onModel, onOverride,
  onEdit, onSend, options, reference, scopeTag}: {
  api: Api;
  draft: ReturnType<typeof createChatDraft>;
  files: AttachmentDraft;
  busy: boolean;
  blocked: boolean;
  preparing: boolean;
  model: string;
  override: string;
  onModel: (value: string) => void;
  onOverride: (value: string) => void;
  onEdit: (value: string) => void;
  onSend: () => void;
  options: ReactNode;
  reference: ReactNode;
  scopeTag?: ReactNode;
}) {
  const question = useSyncExternalStore(draft.subscribe, draft.read, draft.read);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const add = useRef<HTMLDetailsElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const sendDisabled = busy || blocked || files.uploading || files.pending.length > 0 || !question.trim();

  useEffect(() => {
    if (!menuOpen) return;
    function closeOutside(event: PointerEvent) {
      if (add.current && !add.current.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [menuOpen]);

  function send() {
    if (!sendDisabled) onSend();
  }

  return <footer className="conversation-compose chat-dock">
    {reference}
    <form className="ask-form chat-compose-form" onSubmit={event => {event.preventDefault(); send();}}>
      {(files.attachments.length > 0 || files.pending.length > 0) && <div className="chat-attachment-list">
        {files.attachments.map(attachment => <span className="chat-attachment" key={attachment.id}>
          <ChatDraftThumbnail file={files.preview(attachment.id)}/>
          <span><strong>{attachment.name}</strong></span>
          <button type="button" disabled={busy || files.uploading} aria-label={moteText('移除图片 {0}', attachment.name)}
            onClick={() => files.remove(attachment.id, false)}><X size={14}/></button>
        </span>)}
        {files.pending.map(item => <span className="chat-attachment chat-image-upload" key={item.key} data-status={item.status}>
          <ChatDraftThumbnail file={item.file}/>
          <span><strong>{item.file.name}</strong><small role={item.status === 'failed' ? 'alert' : 'status'}>
            {item.status === 'uploading' ? moteText('正在上传') : moteText('图片上传失败')}
          </small></span>
          {item.status === 'failed' && <button type="button" disabled={busy || files.uploading || preparing}
            onClick={() => void files.retry(item)}>{moteText('重试')}</button>}
          <button type="button" disabled={busy || files.uploading} aria-label={moteText('移除图片 {0}', item.file.name)}
            onClick={() => files.remove(item.key, true)}><X size={14}/></button>
        </span>)}
      </div>}
      <div className="chat-compose-row">
        <details className="chat-add" ref={add} open={menuOpen}
          onKeyDown={event => {if (event.key === 'Escape' && add.current?.open) {
            event.stopPropagation();
            setMenuOpen(false);
            add.current.querySelector('summary')?.focus();
          }}}>
          <summary className="icon-button" aria-label={moteText('添加')} onClick={event => {
            event.preventDefault();
            setMenuOpen(open => !open);
          }}><Plus size={20}/></summary>
          <div className="chat-add-panel">
            <button className="chat-image-button text-button" type="button" disabled={busy || files.uploading || preparing ||
              files.attachments.length + files.pending.length >= 4}
              onClick={() => {setMenuOpen(false); attachmentInput.current?.click();}}>
              <ImagePlus size={16}/>{moteText('添加图片')}
            </button>
            {menuOpen && options}
            <details className="chat-model-options"><summary>{moteText('本次模型')}</summary>
              {menuOpen && <StableModelSelector api={api} feature="chat" value={model} onChange={onModel}
                model={override} onModelChange={onOverride} disabled={busy || preparing} detachedFromForm/>}
            </details>
          </div>
        </details>
        <input ref={attachmentInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden
          onChange={event => {if (!busy && !preparing) files.add(event.target.files); event.target.value = '';}}/>
        {scopeTag}
        <textarea aria-label={moteText('向 Mote 提问')} placeholder={moteText('发消息')} rows={1} maxLength={8000}
          value={question} disabled={busy} onChange={event => onEdit(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}/>
        <button type="submit" className="send-button" aria-label={moteText('发送')} disabled={sendDisabled}>
          {busy ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={18}/>}
        </button>
      </div>
    </form>
  </footer>;
}
