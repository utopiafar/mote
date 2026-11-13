import {moteText} from '@mote/shared/i18n';
import {conversationSettingsSchema,type ConversationSettings as Settings} from '@mote/shared';
import {type Api,errorMessage} from '../../api';
import {invalidateConfiguration} from '../../configuration-cache';
import {useEffect,useState} from 'react';

const conservative:Settings={multipleConversations:false,context:{historyRatio:0.5,lowWatermarkRatio:0.5,contextWindow:null,contextWindowSource:'conservative'}};

/** Owner preferences only. The server resolves the model window and the request
 * budget; this form never estimates a history target in the browser. */
export function ConversationSettingsView({api,settings,revision,onSaved}:{api:Api;settings:Settings|undefined;revision:number|undefined;onSaved:(value:Settings)=>void}){
  const [draft,setDraft]=useState<Settings>(settings??conservative);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{setDraft(settings??conservative);setError('');setNotice('');},[api,settings]);
  const change=(value:Partial<Settings>)=>setDraft(current=>({...current,...value}));
  const changeContext=(value:Partial<Settings['context']>)=>setDraft(current=>({...current,context:{...current.context,...value}}));
  async function save(){
    if(busy)return;
    const context=draft.context;
    if(!Number.isFinite(context.historyRatio)||context.historyRatio<0||context.historyRatio>1){setError(moteText('历史预算比例需要在 0 到 1 之间。'));return;}
    if(!Number.isFinite(context.lowWatermarkRatio)||context.lowWatermarkRatio<0||context.lowWatermarkRatio>=1){setError(moteText('低水位比例需要大于等于 0 且小于 1。'));return;}
    if(context.contextWindowSource==='configured'&&(!Number.isSafeInteger(context.contextWindow)||(context.contextWindow??0)<=0)){setError(moteText('指定模型窗口需要填写正整数。'));return;}
    if(revision===undefined){setError(moteText('设置尚未读取完成，请稍后重试。'));return;}
    setBusy(true);setError('');setNotice('');
    try{
      const view=await api.request<{revision:number;domains:{id:string;effective:unknown}[]}>('/api/configuration/conversations',{method:'PUT',body:JSON.stringify({value:draft,revision})});
      const effective=view?.domains?.find(domain=>domain.id==='conversations')?.effective;
      const parsed=conversationSettingsSchema.safeParse(effective);
      if(!parsed.success)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
      setDraft(parsed.data);onSaved(parsed.data);invalidateConfiguration(api);setNotice(moteText('对话设置已保存。'));
    }catch(cause){setError(errorMessage(cause));}
    finally{setBusy(false);}
  }
  return <section className="conversation-settings" aria-label={moteText('对话设置')}><form onSubmit={event=>{event.preventDefault();void save();}}>
    <p>{moteText('默认打开主对话。多个对话默认关闭；关闭不会删除已有对话。')}</p>
    <label className="preference-toggle"><span><strong>{moteText('允许多个对话')}</strong><small>{moteText('开启后可以新建独立对话。关闭后历史仍可查看，默认提问回到主对话。')}</small></span><input type="checkbox" role="switch" disabled={busy} checked={draft.multipleConversations} onChange={event=>change({multipleConversations:event.target.checked})}/></label>
    <fieldset disabled={busy}><legend>{moteText('上下文设置')}</legend>
      <p className="fine-print">{moteText('服务端按当前模型窗口和完整请求预算计算历史目标；这里只保存比例与窗口偏好，不在浏览器中估算。')}</p>
      <div className="conversation-settings-grid">
        <label>{moteText('历史预算比例')}<input type="number" min={0} max={1} step={0.05} required value={draft.context.historyRatio} onChange={event=>changeContext({historyRatio:Number(event.target.value)})}/></label>
        <label>{moteText('低水位比例')}<input type="number" min={0} max={0.99} step={0.05} required value={draft.context.lowWatermarkRatio} onChange={event=>changeContext({lowWatermarkRatio:Number(event.target.value)})}/></label>
        <label>{moteText('模型窗口')}<select value={draft.context.contextWindowSource} onChange={event=>changeContext(event.target.value==='configured'?{contextWindowSource:'configured',contextWindow:draft.context.contextWindow??8192}:{contextWindowSource:'conservative',contextWindow:null})}><option value="conservative">{moteText('使用服务端标注的保守窗口')}</option><option value="configured">{moteText('指定模型窗口')}</option></select></label>
        {draft.context.contextWindowSource==='configured'&&<label>{moteText('窗口大小（tokens）')}<input type="number" min={1} step={1} required value={draft.context.contextWindow??''} onChange={event=>changeContext({contextWindow:Number(event.target.value)})}/></label>}
      </div>
      <p className="fine-print">{moteText('缺少可信能力信息时使用保守窗口。历史目标是比例与请求预算的较小值，由服务端在每次请求时计算。')}</p>
    </fieldset>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    <div className="conversation-settings-footer"><button className="button primary" type="submit" disabled={busy||!settings||revision===undefined}>{busy?moteText('正在保存…'):moteText('保存对话设置')}</button></div>
  </form></section>;
}
