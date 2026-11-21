import {useEffect,useState} from 'react';
import {Link2,X} from 'lucide-react';
import {formatAboutRef,parseAboutRef,parseEvidenceId,parseEvidenceRef,type AboutRef} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';

/** A referenced object is display state tied to the current address. The
 * summary stays in this page; the next message carries only the existing
 * scope or anchor identities, never this text. */
export type ChatAbout =
  | {status:'loading';ref:AboutRef}
  | {status:'ready';ref:AboutRef;title:string;sourceIds?:string[];anchorEvidenceIds?:string[];anchorMaterialRef?:string}
  | {status:'expired';ref:AboutRef};

const allScope = JSON.stringify({kind:'all'});
const scopeQuery = () => new URLSearchParams({scope:allScope}).toString();

/** The query contract accepts at most 30 exact originals. More than that is a
 * visible reference without a silently narrowed selection. */
function evidenceRange(values:readonly (string | undefined)[]):string[] | undefined {
  const ids = [...new Set(values.flatMap(value => {
    const id = value ? parseEvidenceId(value) : undefined;
    return id ? [id] : [];
  }))];
  return ids.length > 0 && ids.length <= 30 ? ids : undefined;
}

const evidenceAnchor = (values:readonly (string | undefined)[]) => {
  const ids = evidenceRange(values);
  return ids ? {anchorEvidenceIds:ids} : {};
};

async function resolveChatAbout(api:Api,ref:AboutRef,signal:AbortSignal):Promise<ChatAbout> {
  switch (ref.kind) {
    case 'material': {
      const id = ref.ref.slice(0,ref.ref.indexOf('@'));
      const material = await api.request<{id:string;ref:string;title:string;origin?:{sourceId?:string}}>(
        '/api/materials/' + encodeURIComponent(id),{signal});
      if (material.ref !== 'material:' + ref.ref) throw new Error('Material reference changed');
      return {status:'ready',ref,title:material.title,anchorMaterialRef:material.ref,
        ...(material.origin?.sourceId ? {sourceIds:[material.origin.sourceId]} : {})};
    }
    case 'evidence': {
      const record = await api.request<{id:string;windowTitle?:string;appName?:string}>(
        '/api/capture-browser/' + encodeURIComponent(ref.id),{signal});
      if (record.id !== ref.id) throw new Error('Capture reference changed');
      return {status:'ready',ref,title:record.windowTitle || record.appName || moteText('原始记录'),anchorEvidenceIds:[ref.id]};
    }
    case 'memory': {
      const memory = await api.request<{id:string;title:string;evidenceIds?:string[];evidence?:{id:string}[]}>(
        '/api/memories/' + encodeURIComponent(ref.id),{signal});
      if (memory.id !== ref.id) throw new Error('Memory reference changed');
      return {status:'ready',ref,title:memory.title,
        ...evidenceAnchor([...(memory.evidenceIds ?? []),...(memory.evidence ?? []).map(item => item.id)])};
    }
    case 'question': {
      const question = await api.request<{id:string;title:string;evidence?:{id:string;ref?:string}[]}>(
        '/api/owner-questions/' + encodeURIComponent(ref.id),{signal});
      if (question.id !== ref.id) throw new Error('Question reference changed');
      return {status:'ready',ref,title:question.title,
        ...evidenceAnchor((question.evidence ?? []).flatMap(item => [item.id,item.ref ? parseEvidenceRef(item.ref)?.id : undefined]))};
    }
    case 'card': {
      const card = await api.request<{id:string;title:string;evidenceDependencies?:{ids?:string[]}}>(
        '/api/assistant-cards/' + encodeURIComponent(ref.id) + '?' + scopeQuery(),{signal});
      if (card.id !== ref.id) throw new Error('Card reference changed');
      return {status:'ready',ref,title:card.title,...evidenceAnchor(card.evidenceDependencies?.ids ?? [])};
    }
    case 'commitment': {
      const commitment = await api.request<{id:string;title:string;evidenceDependencies?:{ids?:string[]};
        timeline?:{evidenceDependencies?:{ids?:string[]}}[]}>(
        '/api/assistant/commitments/' + encodeURIComponent(ref.id) + '?' + scopeQuery(),{signal});
      if (commitment.id !== ref.id) throw new Error('Commitment reference changed');
      return {status:'ready',ref,title:commitment.title,
        ...evidenceAnchor([...(commitment.evidenceDependencies?.ids ?? []),
          ...(commitment.timeline ?? []).flatMap(item => item.evidenceDependencies?.ids ?? [])])};
    }
    case 'todo': {
      const todo = await api.request<{id:string;title:string;evidenceIds:string[]}>(
        '/api/assistant/goals/todos/' + encodeURIComponent(ref.id),{signal});
      if (todo.id !== ref.id) throw new Error('Todo reference changed');
      return {status:'ready',ref,title:todo.title,...evidenceAnchor(todo.evidenceIds)};
    }
    case 'matter': {
      const detail = await api.request<{matter:{id:string;goal:string;evidenceIds?:string[]};linkedEvidence?:{id:string}[]}>(
        '/api/assistant/matters/' + encodeURIComponent(ref.id) + '?' + scopeQuery(),{signal});
      if (detail.matter.id !== ref.id) throw new Error('Matter reference changed');
      return {status:'ready',ref,title:detail.matter.goal,
        ...evidenceAnchor([...(detail.matter.evidenceIds ?? []),...(detail.linkedEvidence ?? []).map(item => item.id)])};
    }
  }
}

/** Read one address reference and re-read it after scope or revision changes.
 * A withdrawn object keeps its identity in the address but contributes no
 * range, so the next message falls back to the ordinary conversation scope. */
export function useChatAbout(api:Api,value:string | null):ChatAbout | undefined {
  const ref = value ? parseAboutRef(value) : null;
  const key = ref ? formatAboutRef(ref) : '';
  const [read,setRead] = useState<{owner:Api;key:string;about:ChatAbout}>();
  useEffect(() => {
    if (!ref) {setRead(undefined);return;}
    const controller = new AbortController();
    setRead({owner:api,key,about:{status:'loading',ref}});
    void resolveChatAbout(api,ref,controller.signal).then(about => {
      if (!controller.signal.aborted) setRead({owner:api,key,about});
    }).catch(() => {
      if (!controller.signal.aborted) setRead({owner:api,key,about:{status:'expired',ref}});
    });
    return () => controller.abort();
  },[api,key]);
  const about = read?.owner === api && read.key === key ? read.about : undefined;
  return about ?? (ref ? {status:'loading',ref} : undefined);
}

const rangeKey = (value:ChatAbout) => value.status === 'ready'
  ? JSON.stringify({
    sourceIds:value.sourceIds ? [...value.sourceIds].sort() : null,
    evidence:value.anchorEvidenceIds ? [...value.anchorEvidenceIds].sort() : null,
    material:value.anchorMaterialRef ?? null,
  })
  : '';

/** Admission is irreversible. Re-read the exact displayed object first so a
 * revision change becomes a failed send, never a quietly different pin. */
export async function verifyChatAbout(api:Api,about:ChatAbout,signal:AbortSignal):Promise<void> {
  if (about.status !== 'ready') return;
  const fresh = await resolveChatAbout(api,about.ref,signal);
  signal.throwIfAborted();
  if (fresh.status !== 'ready' || rangeKey(fresh) !== rangeKey(about)) throw new Error('Reference changed');
}

export function readChatAbout(hash:string):string | null {
  return new URLSearchParams(hash.split('?')[1]).get('about');
}

function aboutKindLabel(kind:AboutRef['kind']):string {
  switch (kind) {
    case 'material': return moteText('资料');
    case 'matter': return moteText('事项');
    case 'commitment': return moteText('承诺');
    case 'todo': return moteText('待办');
    case 'memory': return moteText('记忆');
    case 'evidence': return moteText('原始记录');
    default: return moteText('引用');
  }
}

/** The reference itself is not a conversation turn; it only appears at the top
 * of this page and never enters the stored thread. */
export function ChatAboutReference({about}:{about:ChatAbout}) {
  if (about.status === 'loading') return null;
  const expired = about.status === 'expired';
  return <aside className="chat-about-reference" data-state={about.status} aria-label={moteText('引用')}>
    <Link2 size={18} aria-hidden="true"/>
    <div><strong>{expired ? moteText('已失效') : about.title}</strong><small>{aboutKindLabel(about.ref.kind)}</small></div>
  </aside>;
}

export function ChatAboutTag({about,onClear,disabled=false}:{about:ChatAbout;onClear:()=>void;disabled?:boolean}) {
  if (about.status === 'loading') return null;
  const expired = about.status === 'expired';
  return <span className="chat-about-tag" data-state={about.status}>
    <span>{expired ? moteText('已失效') : about.title}</span>
    <button type="button" aria-label={moteText('清除范围')} disabled={disabled} onClick={onClear}><X size={13}/></button>
  </span>;
}
