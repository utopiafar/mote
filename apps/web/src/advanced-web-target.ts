import {parseEvidenceRef} from '@mote/shared';

export type RecordingTool='speakers'|'compare'|'raw';
export type PreparationTarget='dialogue'|'ocr'|'local-image';
/** These query parameters select an existing private view, never an action.
 * A recording tool belongs to the exact readable capture mounted by its reader. */
export function recordingToolFromHash(hash:string,id:string):RecordingTool|null {
 const [route,query='']=hash.split('?'),params=new URLSearchParams(query);
 if(route!=='#/library'||params.getAll('evidence').length!==1||params.getAll('recordingTool').length!==1)return null;
 const reference=parseEvidenceRef(params.get('evidence')??''),tool=params.get('recordingTool');
 return reference?.kind==='capture'&&reference.id===id&&['speakers','compare','raw'].includes(tool??'')?tool as RecordingTool:null;
}
export function preparationTargetFromHash(hash:string,kind?:'images'|'audio'|'documents'):PreparationTarget|null {
 const [route,query='']=hash.split('?'),params=new URLSearchParams(query),target=params.get('prepare'),category=params.get('category');
 if(route!=='#/system/models'||params.getAll('category').length!==1||params.getAll('prepare').length!==1||kind!==undefined&&category!==kind)return null;
 return category==='audio'&&target==='dialogue'||category==='images'&&(target==='ocr'||target==='local-image')?target as PreparationTarget:null;
}
