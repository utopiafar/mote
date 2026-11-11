import {SaveConversationRecord} from './SaveConversationRecord';
import {queryRecovery,type OwnedQuery} from './query-recovery';
import {unsentDrafts,unsentImages,type ChatAttachment,type ChatImageUpload} from './chat-drafts';
import {useOriginalReference} from '../../ask-original-reference';
import {containDialogFocus} from '../../dialog-focus';
import {conversationFailure,ConversationDialog,ConversationTurnDetails} from './ConversationTurnDetails';
import {useResource} from '../../useResource';
import {useOperationUpdates} from '../../useOperationUpdates';
import {readResource,resources} from '../../resource-cache';
import {failureMessage} from '../../failure-message';
import {ModelSelector} from '../../ModelSelector';
import { moteText } from '@mote/shared/i18n';
import {QueryProgress,type QueryRun} from './QueryProgress';
import {uploadChatImage} from '../notes/note-attachments';
import React,{useCallback,useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {AlertCircle, ArrowRight, ArrowUp, ImagePlus, LoaderCircle, MessageSquare, Monitor, Plus, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Trash2, X} from 'lucide-react';
import {ApiError,dateTime, type Answer, type Api, type Device, type Range} from '../../api';
import {ConversationHeading,ConversationComposer} from './ConversationShell';
import {FeaturePanels} from '../../features/runtime';
import {readOwnerQuestion} from '../../owner-question-route';
import {readOriginTurn} from './conversation-origin';
import {type AskController,useAskController} from './controller';
import { Loading, LoadingText } from '../../Loading';

const StableModelSelector=React.memo(ModelSelector);

// File objects remain private to this Api session; routes and storage contain no file bytes.
const localImageFiles=new WeakMap<Api,Map<string,File>>();
function ChatDraftThumbnail({file}:{file?:File}){
 const [image,setImage]=useState<{file:File;url:string}>();
 useEffect(()=>{if(!file)return;const url=URL.createObjectURL(file);setImage({file,url});return()=>URL.revokeObjectURL(url);},[file]);
 return file&&image?.file===file?<img className="chat-draft-thumbnail" src={image.url} alt=""/>:<ImagePlus size={14}/>;
}
interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  scope: Range & {timeZone?: string;evidenceIds?:string[];anchorEvidenceIds?:string[];anchorMaterialRef?:string};
  status: 'completed'|'failed';
}
interface ConversationTurn {
  id: string;
  question: string;
  result?: Answer;
  status: 'completed'|'failed';
  error?: {code: string; message: string};
  createdAt: string;
  evidenceDeleted?: boolean;
  evidenceStale?: boolean;
  evidenceUnavailable?: boolean;
  unavailableEvidenceIds?: string[];
  attachments?: {id:string;name:string;mimeType:string}[];
}
interface Conversation extends ConversationSummary {turns: ConversationTurn[];revision?:number;nextCursor?:string|null}
interface OlderTurns {api:Api;id:string;revision?:number;turns:ConversationTurn[];nextCursor:string|null}
interface HistoryPage {items: ConversationSummary[]; nextCursor?: string | null}

function createQuestionDraft(onChange?:(question:string)=>void){
 let value='';const listeners=new Set<()=>void>();
 return {
  getSnapshot:()=>value,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  set:(next:string)=>{if(next===value)return;value=next;onChange?.(next);listeners.forEach(listener=>listener());},
 };
}
/** Only the controlled composer subscribes to typing. The session still owns
 * draft clear/restore timing, including while supplemental routes hide it. */
function DraftComposer({draft,children}:{draft:ReturnType<typeof createQuestionDraft>;children:(question:string)=>ReactNode}){
 const question=useSyncExternalStore(draft.subscribe,draft.getSnapshot,draft.getSnapshot);
 return children(question);
}
export function Conversations({api, configured, devices, renderAnswer,onOpen=()=>{},controller:provided}: {
  api: Api;
  configured: boolean;
  devices: Device[];
  renderAnswer: (answer: Answer, openReference:(ref:string)=>void) => ReactNode;
  onOpen?: (ref:string)=>void;
  controller?: AskController;
}) {
  const runController=useAskController(api,provided);
  const reference=useOriginalReference(api);
  const referenceScope=useRef({api,key:reference.key});
  useEffect(()=>{if(referenceScope.current.api===api&&referenceScope.current.key!==reference.key)queryRecovery.contextChanged(api);referenceScope.current={api,key:reference.key};},[api,reference.key]);
  const recovery=useSyncExternalStore(useCallback(listener=>queryRecovery.subscribe(api,listener),[api]),useCallback(()=>queryRecovery.get(api),[api]),useCallback(()=>queryRecovery.get(api),[api]));
  const [recheck,setRecheck]=useState(0);
  const [unavailableReference,setUnavailableReference]=useState<{opener:HTMLElement|null}|null>(null);
  const [modelProfileId,setModelProfileId]=useState(''),[modelOverride,setModelOverride]=useState('');
  const changeModelProfile=useCallback((value:string)=>{queryRecovery.draftEdited(api);setModelProfileId(value);},[api]);
  const changeModelOverride=useCallback((value:string)=>{queryRecovery.draftEdited(api);setModelOverride(value);},[api]);
  const [items, setItems] = useState<ConversationSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [clearedScope,setClearedScope]=useState<{owner:Api;id:string}|null>(null);
  const [selectedId,setSelectedId]=useState<string|null>(null),[older,setOlder]=useState<OlderTurns|null>(null),[pageRevoked,setPageRevoked]=useState(false);
  const [historyOpen,setHistoryOpen]=useState(false),[moreOpen,setMoreOpen]=useState(false),[moreTurn,setMoreTurn]=useState<{owner:Api;conversationId:string;turnId:string}|null>(null),[pendingSwitch,setPendingSwitch]=useState<{owner:Api;id:string|null}|null>(null),[dialogOwner,setDialogOwner]=useState(api);
  const [targetTurn,setTargetTurn]=useState<string|null>(null);
  const [selectedOwnerQuestion,setSelectedOwnerQuestion]=useState<string|null>(()=>readOwnerQuestion(window.location.hash));
  const detail=useResource<Conversation>(api,selectedId?`/api/conversations/${encodeURIComponent(selectedId)}`:null);
  const currentOlder=older?.api===api&&older.id===detail.data?.id&&older.revision===detail.data?.revision?older:null;
  // A newer revision can withdraw prior evidence. Never merge copied pages from
  // an older revision while their replacement is still being fetched.
  const conversation=detail.data&&!pageRevoked?{...detail.data,turns:[...(currentOlder?.turns??[]).filter(turn=>!detail.data!.turns.some(next=>next.id===turn.id)),...detail.data.turns],...(currentOlder?{nextCursor:currentOlder.nextCursor}:{})}:null;
  const historyReferenceRequest=useRef<AbortController|null>(null);
  const latestDetail=useRef({api,selectedId,data:detail.data,error:detail.error,conversation});
  latestDetail.current={api,selectedId,data:detail.data,error:detail.error,conversation};
  const cancelHistoryReference=()=>{historyReferenceRequest.current?.abort();historyReferenceRequest.current=null;};
  useEffect(()=>{cancelHistoryReference();return cancelHistoryReference;},[api,selectedId]);
  const openHistoryReference=(ref:string,turnId?:string)=>{
    if(!conversation||!ref.startsWith('capture:')){onOpen(ref);return;}
    const id=ref.slice('capture:'.length),opener=document.activeElement instanceof HTMLElement?document.activeElement:null,owner=api,conversationId=conversation.id;
    const expected=turnId?conversation.turns.find(turn=>turn.id===turnId):undefined;
    const matches=(turn:Pick<ConversationTurn,'evidenceDeleted'|'result'|'question'>|undefined)=>Boolean(turn&&!turn.evidenceDeleted&&turn.result&&expected?.result&&turn.question===expected.question&&turn.result.answer===expected.result.answer&&turn.result.citations.some(citation=>citation.id===id));
    if(turnId&&!matches(expected)){setUnavailableReference({opener});return;}
    historyReferenceRequest.current?.abort();const controller=new AbortController();historyReferenceRequest.current=controller;
    const current=()=>{const latest=latestDetail.current;return !controller.signal.aborted&&historyReferenceRequest.current===controller&&latest.api===owner&&latest.selectedId===conversationId&&Boolean(latest.conversation)&&(!turnId||matches(latest.conversation?.turns.find(turn=>turn.id===turnId)));};
    void (async()=>{
      try{
        const value=await api.request<{id:string;available:boolean}>(`/api/conversations/${encodeURIComponent(conversationId)}/references/${encodeURIComponent(id)}`,{signal:controller.signal});
        if(!current())return;
        if(value.available!==true||value.id!==id){setUnavailableReference({opener});return;}
        // The conversation-level reference endpoint may be authorized by a
        // different turn. A turn citation also needs its own fresh exact read.
        if(turnId){const checked=await readOriginTurn(api,conversationId,turnId,controller.signal);if(!current())return;if(!matches(checked)){setUnavailableReference({opener});return;}}
        onOpen(ref);
      }catch(error){if(current())setError(conversationFailure(error));}
      finally{if(historyReferenceRequest.current===controller)historyReferenceRequest.current=null;}
    })();
  };
  const scopeCleared=clearedScope?.owner===api&&clearedScope.id===conversation?.id;
  useEffect(()=>{setClearedScope(null);setUnavailableReference(null);setMoreOpen(false);setMoreTurn(null);setConfirmDelete(false);setPendingSwitch(null);setDialogOwner(api);},[api,selectedId]);
  const draftOwner=useRef(api);
  const [draft]=useState(()=>createQuestionDraft(question=>{const owner=draftOwner.current;unsentDrafts.set(owner,{question,attachments:unsentDrafts.get(owner)?.attachments??[]});})),setQuestion=draft.set;
  const [attachments,updateAttachments]=useState<ChatAttachment[]>([]);
  const setAttachments=(next:React.SetStateAction<ChatAttachment[]>)=>updateAttachments(current=>{const value=typeof next==='function'?next(current):next,owner=draftOwner.current;unsentDrafts.set(owner,{question:draft.getSnapshot(),attachments:value});const files=localImageFiles.get(owner);if(files)for(const id of files.keys())if(!value.some(item=>item.id===id))files.delete(id);return value;});
  const [uploading,setUploading]=useState(false);
  const [imageUploadState,setImageUploadState]=useState<{owner:Api;items:ChatImageUpload[]}>({owner:api,items:unsentImages.get(api)??[]});
  const imageUploads=imageUploadState.owner===api?imageUploadState.items:unsentImages.get(api)??[];
  const storeImages=(change:(current:ChatImageUpload[])=>ChatImageUpload[])=>{const items=change(unsentImages.get(api)??[]);unsentImages.set(api,items);if(draftOwner.current===api)setImageUploadState({owner:api,items});};
  const attachmentInput=useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [loadingOlder,setLoadingOlder]=useState(false), [loadingPage,setLoadingPage] = useState(false);
  const [error, setError] = useState(''), [historyError, setHistoryError] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const operation = useRef<AbortController | null>(null), historyRequest = useRef<AbortController | null>(null);
  const attachmentRequest=useRef<AbortController|null>(null),cancelRequest=useRef<AbortController|null>(null);
  const selectionMade=useRef(false),olderRequest=useRef<AbortController|null>(null);
  const history=useResource<HistoryPage>(api,'/api/conversations?limit=30'),recentRuns=useResource<{items:QueryRun[]}>(api,'/api/query-runs');
  const feedError=useOperationUpdates(api);
  // Cached content remains usable while change notifications revalidate it.
  // Only an unopened/revoked conversation or explicit pagination blocks input.
  const loading=history.loading||loadingPage,opening=detail.loading&&!conversation||loadingOlder;
  const end = useRef<HTMLDivElement>(null);
  const [run,setRun]=useState<QueryRun|null>(null),[pollError,setPollError]=useState(''),[pollReceiptMissing,setPollReceiptMissing]=useState(false);
  const settledReceipts=useRef(new Set<string>());
  const activeRun=useRef<{api:Api;id?:string}>({api});activeRun.current={api,id:run?.id};

  async function loadHistory(next?: string) {
    historyRequest.current?.abort();
    if(!next){setLoadingPage(false);setHistoryError('');history.refresh();return;}
    const controller = new AbortController(); historyRequest.current = controller;
    setLoadingPage(true); setHistoryError('');
    try {
      const page = await readResource<HistoryPage>(api,`/api/conversations?limit=30&cursor=${encodeURIComponent(next)}`,controller.signal);
      if (controller.signal.aborted) return;
      setItems(previous => [...previous, ...page.items.filter(item => !previous.some(existing => existing.id === item.id))]);
      setCursor(page.nextCursor ?? null);
    } catch (e) { if (!controller.signal.aborted) setHistoryError(conversationFailure(e)); }
    finally { if (!controller.signal.aborted) setLoadingPage(false); }
  }
  useEffect(()=>{if(draftOwner.current!==api){const [route,text]=window.location.hash.split('?'),query=new URLSearchParams(text);query.delete('conversation');query.delete('turn');window.history.replaceState(null,'',route+(query.size?'?'+query:''));reference.clear();}draftOwner.current=api;settledReceipts.current.clear();const saved=unsentDrafts.get(api);selectionMade.current=false;setSelectedId(null);setOlder(null);setItems([]);setCursor(null);const retained=queryRecovery.get(api);selectionMade.current=Boolean(retained);setRun(retained?.run??null);setBusy(false);setQuestion(saved?.question??'');setAttachments(saved?.attachments??[]);setImageUploadState({owner:api,items:unsentImages.get(api)??[]});setUploading(false);setPendingQuestion('');setError('');setHistoryError('');setLoadingOlder(false);setLoadingPage(false);
    return()=>{operation.current?.abort();cancelRequest.current?.abort();cancelRequest.current=null;const retained=queryRecovery.get(api);if(retained)queryRecovery.set(api,{...retained,unknown:true});attachmentRequest.current?.abort();unsentImages.set(api,(unsentImages.get(api)??[]).map(item=>({...item,status:'failed'})));historyRequest.current?.abort();olderRequest.current?.abort();};},[api]);
  useEffect(()=>{const changed=()=>{const draftQuery=new URLSearchParams(window.location.hash.split('?')[1]??'');if(draftQuery.get('history')==='1'){setHistoryOpen(true);draftQuery.delete('history');window.history.replaceState(null,'',window.location.hash.split('?')[0]+(draftQuery.size?'?'+draftQuery:''));}const incoming=draftQuery.get('questionDraft');if(incoming!==null){
    // The navigation has explicitly replaced the draft. A late upload from the
    // discarded draft must not attach itself to the newly prepared question.
    const nextQuestion=incoming.slice(0,100000);
    attachmentRequest.current?.abort();attachmentRequest.current=null;
    // Publish the replacement before React replays the owner-restoration effect
    // (including in StrictMode); queued state updaters alone are too late.
    unsentDrafts.set(api,{question:nextQuestion,attachments:[]});unsentImages.delete(api);localImageFiles.delete(api);
    setUploading(false);setAttachments([]);storeImages(()=>[]);
    queryRecovery.contextChanged(api);selectionMade.current=true;
    // A search handoff without an explicit conversation starts a fresh context,
    // even when Ask was already mounted with a historical conversation.
    if(!draftQuery.get('conversation')){
      cancelHistoryReference();olderRequest.current?.abort();olderRequest.current=null;setLoadingOlder(false);
      setSelectedId(null);setOlder(null);setTargetTurn(null);setClearedScope(null);setHistoryOpen(false);
      if(!queryRecovery.get(api)){operation.current?.abort();operation.current=null;setRun(null);setBusy(false);setPendingQuestion('');setPollError('');setPollReceiptMissing(false);}
    }
    setQuestion(nextQuestion);draftQuery.delete('questionDraft');const route=window.location.hash.split('?')[0];window.history.replaceState(null,'',route+(draftQuery.size?'?'+draftQuery:''));window.dispatchEvent(new window.Event('mote:workspace-state'));}const questionId=readOwnerQuestion(window.location.hash);setSelectedOwnerQuestion(questionId);if(questionId)selectionMade.current=true;const next=new URLSearchParams(window.location.hash.split('?')[1]).get('conversation');if(next){if(next!==latestDetail.current.selectedId)cancelHistoryReference();const retained=queryRecovery.get(api);if(retained&&next!==retained.conversationId&&next!==retained.run?.conversationId)queryRecovery.contextChanged(api);selectionMade.current=true;setTargetTurn(draftQuery.get('turn'));setSelectedId(next);setRun(null);}};changed();window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[api]);
  const detailRevoked=detail.error instanceof ApiError&&[401,403,404,410].includes(detail.error.status);
  useLayoutEffect(()=>{
    olderRequest.current?.abort();olderRequest.current=null;setLoadingOlder(false);setOlder(null);setPageRevoked(false);
  },[api,selectedId,detail.data?.revision,detailRevoked]);
  useEffect(()=>{if(detail.data&&!detail.loading&&!detail.error)setPageRevoked(false);},[detail.data,detail.loading,detail.error]);
  useEffect(()=>{if(reference.key){selectionMade.current=true;setSelectedId(null);setRun(null);setOlder(null);setSelectedOwnerQuestion(null);}},[api,reference.key]);
  useEffect(()=>{if(history.data){setItems(history.data.items);setCursor(history.data.nextCursor??null);}else if(history.error){setItems([]);setCursor(null);}},[history.data,history.error]);
  useEffect(()=>{if(!recentRuns.data||selectionMade.current||queryRecovery.get(api))return;
    // Only an in-flight run is recoverable. A completed run stays in history
    // until the owner explicitly opens it or an incoming receipt selects it.
    const running=recentRuns.data.items.find(r=>r.status==='running');
    if(running){selectionMade.current=true;queryRecovery.set(api,{kind:'adopted',id:running.id,contextVersion:queryRecovery.versions(api).contextVersion,conversationId:running.conversationId,run:running,unknown:false});setRun(running);setBusy(true);setSelectedId(running.conversationId??null);}
  },[recentRuns.data]);
  useEffect(() => {if (!targetTurn&&conversation?.turns.length) end.current?.scrollIntoView({block: 'nearest'});}, [conversation?.id, conversation?.turns.length,targetTurn]);
  useEffect(()=>{
    if(!targetTurn||!conversation||opening||detail.error||error)return;
    const element=document.getElementById('conversation-turn-'+targetTurn);
    if(element){element.scrollIntoView({block:'center'});element.focus({preventScroll:true});}
    else if(conversation.nextCursor)void loadOlderTurns();
  },[targetTurn,conversation?.id,conversation?.turns.length,conversation?.nextCursor,opening,detail.error,error]);

  function receiveRun(current:QueryRun){
    // Every receipt path obeys the same confirmed-terminal fence. Late running
    // or duplicate terminal replies cannot revive busy state or repeat navigation.
    if(settledReceipts.current.has(current.id))return;
    const retained=queryRecovery.get(api),owned=retained?.id===current.id?retained:undefined;
    setRun(current);setPollError('');setPollReceiptMissing(false);setError('');
    if(current.status==='running'){
      if(owned)queryRecovery.set(api,{...owned,run:current,unknown:false});
      setBusy(true);return;
    }
    settledReceipts.current.add(current.id);
    const versions=queryRecovery.versions(api),sameContext=!owned||owned.contextVersion===versions.contextVersion,sameDraft=owned?.kind==='owned'&&owned.draftVersion===versions.draftVersion;
    if((current.status==='completed'||current.status==='failed')&&current.conversationId){
      if(sameContext){setSelectedId(current.conversationId);window.history.replaceState(null,'','#/ask?'+new URLSearchParams({conversation:current.conversationId}));window.dispatchEvent(new window.Event('mote:workspace-state'));}
      historyRequest.current?.abort();setLoadingPage(false);setHistoryError('');resources(api).invalidate(key=>key.startsWith('/api/conversations'));
    }
    if(owned?.kind==='owned'&&sameDraft){if(current.status==='completed'){setQuestion('');setAttachments([]);}else if(current.status==='failed')setQuestion(owned.question);}
    if(owned)queryRecovery.set(api,undefined);
    setBusy(false);setPendingQuestion('');operation.current=null;
  }
  function unconfirmed(cause:unknown){
    const retained=queryRecovery.get(api);if(retained)queryRecovery.set(api,{...retained,unknown:true});
    setBusy(false);setPendingQuestion('');setPollError(conversationFailure(cause));setPollReceiptMissing(cause instanceof ApiError&&cause.status===404);
  }
  useEffect(()=>{
    if(!run||run.status!=='running'&&settledReceipts.current.has(run.id)){runController.stopPolling();return;}
    const id=run.id;
    runController.poll(id,{onRun:current=>{if(current.id!==id)throw Error(moteText('中央响应格式无效，请刷新后重试。'));receiveRun(current);},onError:unconfirmed});
    return()=>runController.stopPolling();
  },[api,run?.id,run?.status,recheck,runController]);
  async function checkOriginal(){
    const retained=queryRecovery.get(api),id=retained?.id??run?.id;if(!id||operation.current)return;
    const controller=new AbortController();operation.current=controller;setBusy(true);setPollError('');setPollReceiptMissing(false);
    try{const current=await api.request<QueryRun>(`/api/query-runs/${id}`,{signal:controller.signal});if(controller.signal.aborted)return;if(current.id!==id)throw Error(moteText('中央响应格式无效，请刷新后重试。'));receiveRun(current);setRecheck(value=>value+1);}
    catch(cause){if(!controller.signal.aborted)unconfirmed(cause);}
    finally{if(operation.current===controller)operation.current=null;}
  }
  async function postOriginal(retained:OwnedQuery,controller:AbortController){
    let ambiguous=retained.unknown;
    for(let attempt=0;attempt<2;attempt++)try{
      const accepted=await api.request<QueryRun>('/api/query-runs',{method:'POST',signal:controller.signal,body:retained.body});
      if(controller.signal.aborted)return;
      if(accepted.id!==retained.id)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
      receiveRun(accepted);return;
    }catch(cause){
      if(controller.signal.aborted)return;
      const definite=cause instanceof ApiError&&[400,401,403,404,409,410,413,422].includes(cause.status);
      if(definite&&!ambiguous){queryRecovery.set(api,undefined);setBusy(false);setPendingQuestion('');setError(conversationFailure(cause));return;}
      ambiguous=true;queryRecovery.set(api,{...retained,unknown:true});
      if(attempt===1)unconfirmed(cause);
    }
  }
  async function retryOriginal(){
    const retained=queryRecovery.get(api);if(retained?.kind!=='owned'||operation.current||uploading||opening)return;
    const controller=new AbortController();operation.current=controller;setBusy(true);setError('');setPollError('');setPollReceiptMissing(false);
    try{await postOriginal(retained,controller);}finally{if(operation.current===controller)operation.current=null;}
  }

  async function cancelRunning(){
    if(!run||run.status!=='running'||cancelRequest.current)return;
    const controller=new AbortController(),id=run.id;cancelRequest.current=controller;
    try{const value=await api.request<QueryRun>(`/api/query-runs/${id}/cancel`,{method:'POST',signal:controller.signal});if(!controller.signal.aborted&&activeRun.current.api===api&&activeRun.current.id===id){if(value.id!==id)throw Error(moteText('中央响应格式无效，请刷新后重试。'));receiveRun(value);}}
    catch(cause){if(!controller.signal.aborted&&activeRun.current.api===api&&activeRun.current.id===id)unconfirmed(cause);}
    finally{if(cancelRequest.current===controller)cancelRequest.current=null;}
  }

  function open(id: string,force=false) {
    if (busy) return;
    if(id===selectedId){setHistoryOpen(false);return;}
    if(!force&&id!==selectedId&&(draft.getSnapshot().trim()||attachments.length||imageUploads.length||queryRecovery.get(api))){setPendingSwitch({owner:api,id});return;}
    cancelHistoryReference();queryRecovery.contextChanged(api);attachmentRequest.current?.abort();attachmentRequest.current=null;setUploading(false);
    setHistoryOpen(false);
    setTargetTurn(null);setClearedScope(null);
    selectionMade.current=true;operation.current?.abort();operation.current=null;olderRequest.current?.abort();setLoadingOlder(false);
    setRun(null);setPollError('');setPollReceiptMissing(false);setError('');setConfirmDelete(false);setQuestion('');setAttachments([]);storeImages(()=>[]);setPendingQuestion('');
    setOlder(null);setSelectedId(id);setSelectedOwnerQuestion(null);
    window.location.hash='#/ask?'+new URLSearchParams({conversation:id});
  }
  async function loadOlderTurns(){
    if(!conversation?.nextCursor||opening)return;
    const id=conversation.id,revision=conversation.revision,cursor=conversation.nextCursor,controller=new AbortController();olderRequest.current?.abort();olderRequest.current=controller;setLoadingOlder(true);setError('');
    const current=()=>!controller.signal.aborted&&olderRequest.current===controller&&latestDetail.current.api===api&&latestDetail.current.selectedId===id&&latestDetail.current.data?.id===id&&latestDetail.current.data.revision===revision&&!latestDetail.current.error;
    try{const page=await readResource<Conversation>(api,`/api/conversations/${encodeURIComponent(id)}?cursor=${encodeURIComponent(cursor)}`,controller.signal);
      if(!current())return;
      if(page.id!==id||page.revision!==revision){setOlder(null);setPageRevoked(true);detail.refresh();return;}
      setOlder(previous=>{const turns=previous?.api===api&&previous.id===id&&previous.revision===revision?previous.turns:[];return {api,id,revision,turns:[...page.turns.filter(turn=>!turns.some(old=>old.id===turn.id)),...turns],nextCursor:page.nextCursor??null};});
    }catch(e){if(current()){if(e instanceof ApiError&&[401,403,404,410].includes(e.status)){setOlder(null);setPageRevoked(true);detail.refresh();}setError(conversationFailure(e));}}
    finally{if(olderRequest.current===controller){olderRequest.current=null;setLoadingOlder(false);}}
  }
  function startNew(force=false) {
    if (busy) return;
    if(!force&&(draft.getSnapshot().trim()||attachments.length||imageUploads.length||queryRecovery.get(api))){setPendingSwitch({owner:api,id:null});return;}
    cancelHistoryReference();queryRecovery.contextChanged(api);attachmentRequest.current?.abort();attachmentRequest.current=null;setUploading(false);setHistoryOpen(false);
    setTargetTurn(null);setClearedScope(null);
    selectionMade.current=true;operation.current?.abort();operation.current=null;olderRequest.current?.abort();setLoadingOlder(false);
    setRun(null);setPollError('');setPollReceiptMissing(false);setSelectedId(null);setOlder(null);setQuestion('');setAttachments([]);storeImages(()=>[]);setPendingQuestion('');setError('');setConfirmDelete(false);setSelectedOwnerQuestion(null);
    window.location.hash='#/ask';
  }
  function retry(question: string) {
    if (busy || opening) return;
    void submit(undefined, question);
  }
  async function submit(event?: {preventDefault(): void}, sample?: string) {
    event?.preventDefault();
    const text = (sample ?? draft.getSnapshot()).trim();
    if (!text || busy || uploading || imageUploads.length>0 || opening || operation.current || queryRecovery.get(api) || !configured || !reference.ready) return;
    selectionMade.current=true;
    const controller = new AbortController(); operation.current = controller;
    setRun(null);setBusy(true); setError(''); setConfirmDelete(false); setPendingQuestion(text);
    try {
      if(!conversation)await reference.verify(controller.signal);
      if(controller.signal.aborted)return;
      const id=crypto.randomUUID();
      const body=JSON.stringify({id,input:{question:text,modelProfileId:modelProfileId||undefined,modelOverride:modelOverride||undefined,...(conversation?{conversationId:conversation.id,...(scopeCleared?{evidenceIds:null,anchorEvidenceIds:null,anchorMaterialRef:null}:{})}:reference.origin?reference.materialRef?{anchorMaterialRef:reference.materialRef}:{anchorEvidenceIds:reference.ids}:{}),attachmentIds:attachments.map(attachment=>attachment.id),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}});
      const retained:OwnedQuery={kind:'owned',id,body,question:text,attachments:attachments.map(value=>({...value})),...queryRecovery.versions(api),conversationId:conversation?.id,unknown:false};
      queryRecovery.set(api,retained);
      await postOriginal(retained,controller);
    } catch (e) {
      if (!controller.signal.aborted) {setBusy(false);setPendingQuestion(''); setError(moteText("{0} 可刷新历史检查结果后再重试。", conversationFailure(e)));}
    } finally {if (!controller.signal.aborted) {operation.current = null;}}
  }
  async function uploadImages(selected:ChatImageUpload[]) {
    if(!selected.length||uploading||busy||opening)return;
    const controller=new AbortController();attachmentRequest.current=controller;setUploading(true);setError('');
    const current=()=>!controller.signal.aborted&&draftOwner.current===api&&attachmentRequest.current===controller;
    try{
      let deviceId=localStorage.getItem('mote.chat.device.v1');
      if(!deviceId){deviceId=`web:${crypto.randomUUID()}`;localStorage.setItem('mote.chat.device.v1',deviceId);}
      for(const item of selected){
        if(!current())return;storeImages(rows=>rows.map(row=>row.key===item.key?{...row,status:'uploading'}:row));
        try{
          const id=await uploadChatImage(api,item.file,deviceId,controller.signal);
          if(!current())return;
          const files=localImageFiles.get(api)??new Map<string,File>();files.set(id,item.file);localImageFiles.set(api,files);
          setAttachments(rows=>controller.signal.aborted||draftOwner.current!==api?rows:rows.some(row=>row.id===id)?rows:[...rows,{id,name:item.file.name,mimeType:item.file.type}]);
          storeImages(rows=>rows.filter(row=>row.key!==item.key));
        }catch(cause){if(!current())return;storeImages(rows=>rows.map(row=>row.key===item.key?{...row,status:'failed'}:row));setError(conversationFailure(cause));}
      }
    }catch(cause){if(current()){storeImages(rows=>rows.map(row=>selected.some(item=>item.key===row.key)?{...row,status:'failed'}:row));setError(conversationFailure(cause));}}finally{if(current()){setUploading(false);if(attachmentInput.current)attachmentInput.current.value='';}if(attachmentRequest.current===controller)attachmentRequest.current=null;}
  }
  async function addImages(files:FileList|null){
    if(!files?.length||uploading||busy||opening)return;
    if(attachments.length+imageUploads.length+files.length>4){setError(moteText("最多添加 4 张图片"));return;}
    const selected=Array.from(files);
    if(selected.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024||file.size===0)){
      setError(moteText("聊天图片仅支持 PNG、JPEG、WebP，每张不超过 8 MiB。"));return;
    }
    queryRecovery.draftEdited(api);const rows=selected.map(file=>({key:crypto.randomUUID(),file,status:'uploading' as const}));storeImages(current=>[...current,...rows]);await uploadImages(rows);
  }
  async function remove() {
    if (!conversation || operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError('');
    try {
      await api.request(`/api/conversations/${encodeURIComponent(conversation.id)}`, {method: 'DELETE', signal: controller.signal});
      if (controller.signal.aborted) return;
      setRun(null);setSelectedId(null);setOlder(null);resources(api).invalidate(key=>key.startsWith('/api/conversations')||key.startsWith('/api/query-runs'));setQuestion(''); setConfirmDelete(false); void loadHistory();
    } catch (e) {if (!controller.signal.aborted) setError(conversationFailure(e));}
    finally {if (!controller.signal.aborted) {setBusy(false); operation.current = null;}}
  }
  return <div className={"conversation-layout final-conversation"+(historyOpen?" history-open":"")+(!conversation?" conversation-fresh":"")} aria-busy={loading||opening||recentRuns.loading}>
    <ConversationDialog open={pendingSwitch?.owner===api} title={moteText('还有未发送的内容')} onClose={()=>setPendingSwitch(null)} footer={<><button className="button" onClick={()=>setPendingSwitch(null)}>{moteText('继续编辑')}</button><button className="button primary" onClick={()=>{const next=pendingSwitch;setPendingSwitch(null);if(next?.owner===api){if(next.id===null)startNew(true);else open(next.id,true);}}}>{moteText('舍弃并切换')}</button></>}><p>{pendingSwitch?.id===null?moteText('还有未发送的问题。舍弃原输入并新建对话？'):moteText('有未保存的修改。离开并丢弃修改？')}</p></ConversationDialog>
    {unavailableReference&&<UnavailableReference opener={unavailableReference.opener} close={()=>setUnavailableReference(null)}/>}
    <div className="conversation-toolbar"><button className="text-button" aria-expanded={historyOpen} aria-controls="conversation-history" onClick={()=>setHistoryOpen(value=>!value)}>{historyOpen?moteText("返回对话"):moteText("对话历史")}</button><div><button className="text-button" disabled={opening} onClick={()=>{detail.refresh();recentRuns.refresh();}}>{moteText("刷新")}</button><button className="button subtle" disabled={busy} onClick={()=>startNew()}><Plus size={15}/>{moteText("新对话")}</button>{conversation&&!historyOpen&&<button className="text-button conversation-more" aria-label={moteText("对话更多")} onClick={()=>setMoreOpen(true)}>{moteText("更多")}</button>}</div></div>
    <aside id="conversation-history" hidden={!historyOpen} className="conversation-history panel" aria-label={moteText("对话历史")}>
      <div className="conversation-history-heading"><div className="chat-section-title"><div className="chat-section-icon"><MessageSquare size={15}/></div><div><h1>{moteText("对话历史")}</h1></div></div><button className="icon-button" aria-label={moteText("刷新对话历史")} disabled={loading} onClick={() => void loadHistory()}><RefreshCw size={16} className={loading ? 'spin' : ''}/></button></div>
      <button className="button subtle full new-conversation-button" disabled={busy} onClick={()=>startNew()}><Plus size={16}/>{moteText("新对话")}</button>
      <FeaturePanels api={api} onOpen={onOpen} value={{kind:'mote.ask.history',schemaVersion:1,representation:'workspace',ref:selectedOwnerQuestion??'',revision:'1',title:'',text:''}}/>
      {Boolean(historyError||history.error)&&<p className="notice error" role="alert">{historyError||conversationFailure(history.error)}</p>}
      {history.data && !loadingPage && !historyError && !history.error && !items.length && <p className="fine-print">{moteText("回答会自动保存在中央，随时回来继续。")}</p>}
      <div className="conversation-list">{items.map(item => <button key={item.id} className={`conversation-item ${!selectedOwnerQuestion&&conversation?.id === item.id ? 'active' : ''} ${item.status === 'failed' ? 'failed' : ''}`} aria-current={!selectedOwnerQuestion&&conversation?.id === item.id ? 'true' : undefined} disabled={busy} onClick={() => void open(item.id)}>
        <strong>{item.title}</strong><span>{item.status === 'failed' ? <><AlertCircle size={12}/>{moteText("未完成")}{' · '}</> : null}{dateTime(item.updatedAt)} · {item.turnCount}{' '}{moteText("轮")}</span>
      </button>)}</div>
      {loading && (!history.data||loadingPage) && <Loading label={moteText('正在读取历史…')}/>}
      {cursor && <button className="text-button" disabled={loading} onClick={() => void loadHistory(cursor)}>{moteText("加载更早的对话")}</button>}
    </aside>
    {selectedOwnerQuestion?<FeaturePanels api={api} onOpen={onOpen} unavailable={<section className="conversation-content"><p role="status">{moteText('此补充对话暂不可用，请刷新或查看相关资料。')}</p></section>} value={{kind:'mote.ask.question',schemaVersion:1,representation:'workspace',ref:selectedOwnerQuestion,revision:'1',title:'',text:''}}/>:<section className="conversation-content" aria-label={moteText("当前对话")} aria-busy={busy || opening}>
      <ConversationHeading plain title={conversation?.title??moteText('想从留下的内容里找什么？')}/>
      <ConversationDialog open={dialogOwner===api&&moreOpen&&Boolean(conversation)} title={moteText('对话')} onClose={()=>setMoreOpen(false)}>{conversation&&<><div className="conversation-more-list"><button className="text-button" disabled={busy} onClick={()=>{setMoreOpen(false);setError('');setConfirmDelete(true);}}>{moteText('删除这段对话')}</button></div></>}</ConversationDialog>
      <ConversationDialog open={dialogOwner===api&&confirmDelete} busy={busy} title={moteText('删除整段对话？')} onClose={()=>{setConfirmDelete(false);setError('');}} footer={<><button className="button" disabled={busy} onClick={()=>{setConfirmDelete(false);setError('');}}>{moteText('取消')}</button><button className="button primary" disabled={busy} onClick={()=>void remove()}>{moteText('删除对话')}</button></>}>{confirmDelete&&<div className="conversation-delete-confirm"><p>{moteText('会删除这段对话的所有问答。已单独保存的记录保留。')}</p>{error&&<p role="alert">{error}</p>}</div>}</ConversationDialog>
      {opening && <Loading label={moteText('正在打开对话…')}/>}
      {targetTurn&&conversation&&!opening&&!conversation.nextCursor&&!conversation.turns.some(turn=>turn.id===targetTurn)&&<p role="status">{moteText('原始轮次暂不可读。')}</p>}
      <div className="conversation-messages">
      {conversation?.nextCursor&&<button className="text-button" disabled={opening} onClick={()=>void loadOlderTurns()}>{moteText("加载更早的对话")}</button>}
      {conversation?.turns.map((turn,index) => <article className={`answer-panel conversation-turn ${turn.status === 'failed' ? 'failed' : ''}${index===0&&!conversation.nextCursor&&turn.question===conversation.title?' first-question-duplicate':''}`} key={turn.id} id={'conversation-turn-'+turn.id} tabIndex={-1} data-source-turn={targetTurn===turn.id?'true':undefined}>
        <div className="asked-question"><MessageSquare size={16}/><span>{turn.question}</span></div>{Boolean(turn.attachments?.length)&&<div className="chat-attached-images">{turn.attachments?.map(attachment=><span key={attachment.id}><ImagePlus size={13}/>{attachment.name}</span>)}</div>}
        {turn.status === 'failed' || !turn.result ? <div className="failed-answer" role="alert"><div className="failed-answer-icon"><AlertCircle size={18}/></div><div><strong>{moteText("这次回答没有完成")}</strong><p>{failureMessage(turn.error)}</p><button className="button primary" disabled={busy || opening} onClick={() => retry(turn.question)}><RotateCcw size={14}/>{moteText("再次提问")}</button></div></div> : <>{turn.evidenceDeleted ? <p className="notice">{moteText("相关证据已删除，这条历史回答已清除。可以继续提问查阅现有记录。")}</p> : <>{turn.evidenceUnavailable?<p className="notice">{moteText('引用原文已删除，历史问答仍保留。')}</p>:turn.evidenceStale&&<p className="notice">{moteText("这是历史版本，当前资料已更新。")}</p>}{renderAnswer(turn.result,ref=>openHistoryReference(ref,turn.id))}<div className="conversation-turn-actions"><SaveConversationRecord inDialog formatError={conversationFailure} api={api} conversationId={conversation.id} messageId={turn.id} question={turn.question} answer={turn.result.answer} answerDetails={turn.result} onOpen={onOpen}/><button className="text-button" aria-label={moteText('本轮详情')+' '+turn.question} onClick={()=>setMoreTurn({owner:api,conversationId:conversation.id,turnId:turn.id})}>{moteText('更多')}</button></div><ConversationTurnDetails api={api} conversationId={conversation.id} id={turn.id} question={turn.question} answer={turn.result} open={moreTurn?.owner===api&&moreTurn.conversationId===conversation.id&&moreTurn.turnId===turn.id} onClose={()=>setMoreTurn(null)} onOpen={ref=>{setMoreTurn(null);openHistoryReference(ref,turn.id);}} run={run?.turnId===turn.id?run:undefined} pollError={pollError}/></>}</>}
      </article>)}
      {busy&&!run&&pendingQuestion&&<p className="query-admission-status" role="status">{moteText('正在提交问题…')}</p>}
      {pendingQuestion && <div className="asked-question"><MessageSquare size={16}/><span>{pendingQuestion}</span></div>}
      {(recovery?.unknown||pollError&&run?.status==='running')&&<section className="query-unconfirmed notice" aria-label={recovery?.kind==='adopted'?moteText('请刷新检查结果，避免重复发送。'):moteText('结果尚未确认，请检查或重试原请求。')}><p role="status">{recovery?.kind==='adopted'?moteText('请刷新检查结果，避免重复发送。'):moteText('上次提交结果尚未确认；先重试原要求，当前草稿会保留。')}</p>{recovery?.kind==='owned'&&<p>{recovery.question}</p>}{pollError&&!pollReceiptMissing&&<p>{pollError}</p>}<div className="source-toolbar"><button className="button" disabled={busy} onClick={()=>void checkOriginal()}>{moteText('检查结果')}</button>{recovery?.kind==='owned'&&<button className="button" disabled={busy||uploading||opening} onClick={()=>void retryOriginal()}>{moteText('重试同一请求')}</button>}</div>{(run||pollReceiptMissing&&pollError)&&<details className="conversation-run-details"><summary>{moteText('运行详情')}</summary>{run?<QueryProgress api={api} run={run} error={pollError}/>:<p>{pollError}</p>}</details>}</section>}
      {run&&run.status!=='completed'&&!recovery?.unknown&&!(pollError&&run.status==='running')&&<QueryProgress compact api={api} run={run} error={pollError}/>}
      {run?.status==='running'&&<button className="button subtle" onClick={()=>void cancelRunning()}>{moteText("停止生成")}</button>}
      <div ref={end}/>
      </div>
      {Boolean(error||detail.error||recentRuns.error||feedError)&&<p className="notice error" role="alert">{error||conversationFailure(detail.error||recentRuns.error||feedError)}</p>}
      <div className="conversation-compose">
      {!reference.origin&&!conversation&&<a className="conversation-add-reference text-button" href="#/library">＋ {moteText('参考资料')}</a>}
      {!conversation&&reference.origin&&<nav className="filter-bar ask-original-reference" aria-label={moteText('参考记录')}><span>{reference.origin.kind==='memory'?moteText('这条记忆的原始依据'):reference.origin.kind==='material'?moteText('参考这份资料'):reference.origin.kind==='insight'?moteText('原始依据'):moteText('参考这条记录，自动查找相关上下文')}{reference.title?' · '+reference.title:''}</span>{reference.loading?<LoadingText/>:reference.error?<span role="alert">{reference.error}</span>:reference.origin.kind==='material'?<button className="text-button" onClick={()=>onOpen(reference.origin!.id)}>{moteText('查看参考资料')}</button>:reference.ids.map((id,index)=><button className="text-button" key={id} onClick={()=>onOpen('capture:'+id)}>{moteText('查看原文依据')} {index+1}</button>)}<a className="text-button" href={reference.origin.kind==='memory'?'#/library?view=memories&memory='+encodeURIComponent(reference.origin.id):reference.returnRoute??'#/library?view=materials&selected='+encodeURIComponent(reference.origin.kind==='material'?reference.origin.id:'capture:'+reference.origin.id)}>{reference.origin.kind==='memory'?moteText('返回记忆'):moteText('返回资料')}</a><button className="text-button" disabled={busy||opening} onClick={()=>{queryRecovery.contextChanged(api);reference.clear();}}>{moteText('清除参考记录')}</button></nav>}
      {Boolean(conversation?.scope.evidenceIds?.length)&&<nav className="filter-bar" aria-label={moteText('查询范围')}>{scopeCleared?<span>{moteText('全部资料')}</span>:<><span>{moteText('{0} 条证据',conversation!.scope.evidenceIds!.length)}</span>{conversation!.scope.evidenceIds!.map((id,index)=><button className="text-button" key={id} onClick={()=>openHistoryReference('capture:'+id)}>{moteText('查看原文依据')} {index+1}</button>)}<button className="text-button" disabled={busy||opening} onClick={()=>{queryRecovery.contextChanged(api);setClearedScope({owner:api,id:conversation!.id});}}>{moteText('清除范围')}</button></>}</nav>}
      {conversation?.scope.anchorMaterialRef&&<nav className="filter-bar" aria-label={moteText('参考资料')}>{scopeCleared?<span>{moteText('全部资料')}</span>:<><span>{moteText('参考这份资料')}</span><button className="text-button" onClick={()=>onOpen(conversation.scope.anchorMaterialRef!)}>{moteText('查看参考资料')}</button></>}<button className="text-button" disabled={busy||opening} onClick={()=>{queryRecovery.contextChanged(api);setClearedScope({owner:api,id:conversation.id});}}>{moteText('清除参考记录')}</button></nav>}
      {Boolean(conversation?.scope.anchorEvidenceIds?.length)&&<nav className="filter-bar" aria-label={moteText('参考记录')}>{scopeCleared?<span>{moteText('全部资料')}</span>:<><span>{moteText('参考这条记录，自动查找相关上下文')}</span>{conversation!.scope.anchorEvidenceIds!.map((id,index)=><button className="text-button" key={id} onClick={()=>openHistoryReference('capture:'+id)}>{moteText('查看原文依据')} {index+1}</button>)}<button className="text-button" disabled={busy||opening} onClick={()=>{queryRecovery.contextChanged(api);setClearedScope({owner:api,id:conversation!.id});}}>{moteText('清除参考记录')}</button></>}</nav>}
      <DraftComposer draft={draft}>{question=><ConversationComposer label={moteText('向 Mote 提问')} placeholder={conversation?moteText('接着问，Mote 会结合前面的对话。'):moteText('比如，我最近都在忙什么？')} value={question} onChange={value=>{queryRecovery.draftEdited(api);setQuestion(value);}} onSubmit={()=>void submit()} disabled={busy||opening} hintId="composer-hint">
        {Boolean(attachments.length||imageUploads.length)&&<div className="chat-attachment-list">{attachments.map(attachment=><span key={attachment.id} className="chat-attachment"><ChatDraftThumbnail file={localImageFiles.get(api)?.get(attachment.id)}/><span><strong>{attachment.name}</strong><small>{moteText('已添加')}</small></span><button type="button" disabled={busy||uploading} aria-label={moteText("移除图片 {0}",attachment.name)} onClick={()=>{queryRecovery.draftEdited(api);setAttachments(current=>current.filter(item=>item.id!==attachment.id));}}><X size={13}/></button></span>)}{imageUploads.map(item=><span key={item.key} className="chat-attachment chat-image-upload" data-status={item.status}><ChatDraftThumbnail file={item.file}/><span><strong>{item.file.name}</strong><small role={item.status==='uploading'?'status':undefined}>{item.status==='uploading'?moteText('正在上传'):moteText('图片上传失败')}</small></span>{item.status==='failed'&&<button type="button" disabled={busy||uploading||opening} onClick={()=>{queryRecovery.draftEdited(api);void uploadImages([item]);}}>{moteText('重试')}</button>}<button type="button" disabled={busy||uploading} aria-label={moteText('移除图片 {0}',item.file.name)} onClick={()=>{queryRecovery.draftEdited(api);storeImages(rows=>rows.filter(row=>row.key!==item.key));setError('');}}><X size={13}/></button></span>)}</div>}
        <details className="chat-model-options"><summary>{moteText("本次模型")}</summary><StableModelSelector api={api} feature="chat" value={modelProfileId} onChange={changeModelProfile} model={modelOverride} onModelChange={changeModelOverride} disabled={busy||opening} detachedFromForm/></details>
        <div><span><ShieldCheck size={14}/>{moteText("只读查询 · 回答附带原始证据")}</span><input ref={attachmentInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event=>void addImages(event.target.files)}/><button className="chat-image-button" type="button" aria-label={moteText("添加图片")} title={moteText("聊天图片最多 4 张，每张不超过 8 MiB，支持 PNG、JPEG、WebP。") } disabled={busy||uploading||opening||attachments.length+imageUploads.length>=4} onClick={()=>attachmentInput.current?.click()}>{uploading?<LoaderCircle className="spin" size={17}/>:<ImagePlus size={17}/>}</button><span id="composer-hint" className="composer-hint">{moteText("Enter 发送 · Shift+Enter 换行")}</span><button className="send-button" type="submit" disabled={busy || uploading || imageUploads.length>0 || opening || Boolean(recovery)||Boolean(pollError&&run?.status==='running') || !question.trim() || !configured || !reference.ready} aria-label={moteText("发送问题")}>{busy ? <LoaderCircle className="spin" size={19}/> : <ArrowUp size={19}/>}</button></div>
      </ConversationComposer>}</DraftComposer>
      </div>
      {!conversation && !busy && !opening && <div className="suggestions"><span>{moteText("从一个小问题开始")}</span>{[moteText("我最近都做了些什么？"), moteText("这周的时间主要花在了哪里？"), moteText("最近有哪些值得接着做的事情？")].map(sample => <button key={sample} disabled={!configured} onClick={() => void submit(undefined, sample)}>{sample}<ArrowRight size={14}/></button>)}</div>}
    </section>}
  </div>;
}

function UnavailableReference({opener,close}:{opener:HTMLElement|null;close:()=>void}){
 const panel=useRef<HTMLElement>(null);
 useEffect(()=>panel.current?containDialogFocus(panel.current,opener):undefined,[opener]);
 return <div className="conversation-dialog-backdrop" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}}}><section ref={panel} className="conversation-dialog" role="dialog" aria-modal="true" aria-label={moteText('引用不可用')}>
  <header><h2>{moteText('引用不可用')}</h2></header><div className="conversation-dialog-body"><p>{moteText('引用原文已删除，历史问答仍保留。')}</p></div><footer><button className="button" onClick={close}>{moteText('返回原对话')}</button></footer>
 </section></div>;
}
