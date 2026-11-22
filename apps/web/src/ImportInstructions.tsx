import {moteText} from '@mote/shared/i18n';
/** The parent owns this exact job draft so the old preview cannot be confirmed. */
export function ImportInstructions({instruction,value,busy,status,onChange,onPrepare}:{instruction:string;value:string;busy:boolean;status:string;onChange:(value:string)=>void;onPrepare:(value:string)=>void}){
 const dirty=value!==instruction;
 return <details className="import-instructions import-instruction-edit" open={dirty||undefined}><summary>{moteText('补充说明，重新理解资料')}</summary><label className="field-label">{moteText('格式、作者与归属说明')}<textarea aria-label={moteText('格式、作者与归属说明')} disabled={busy} rows={3} maxLength={12000} value={value} onChange={event=>onChange(event.target.value)}/><small>{moteText('可说明格式、时间、作者和归属。引用保留原角色。')}</small></label><button className="button" disabled={busy||status==='awaiting_confirmation'&&!dirty} onClick={()=>onPrepare(value)}>{moteText('重新生成预览')}</button></details>;
}
