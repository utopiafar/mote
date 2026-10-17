import {z} from 'zod';
import type {DatabaseSync} from 'node:sqlite';
import {fileTypePattern} from '@mote/shared';
import {exportTar,type ExportTarEntry} from '../file-export-tar.js';
import {identityHash} from './originals.js';
import {attachmentVisible} from './ingress-attachments.js';
import {fileOriginalGeneration,captureIncarnationGeneration} from './ingress-file-forget.js';
import {PrivateSql,PrivateDataError} from './private-data-sql.js';
import type {IngressHost} from './ingress.js';
import type {Configurations} from './configuration.js';
import {registerUserRoute,type ScopedRuntime} from './http.js';

const query=z.object({mode:z.enum(['metadata','data']),selection:z.enum(['current','history']),type:fileTypePattern}).strict();
/** A bounded original Files export, separate from portable account recovery.
 * Metadata never opens a byte reader; data reads existing M03 chunks lazily.
 * No stored export, signed download grant or additional archive store exists. */
export function registerFileExport(runtime:ScopedRuntime,db:DatabaseSync,ingress:IngressHost,configuration:Configurations){
 registerUserRoute(runtime,{scope:'user',service:'ingress',method:'GET',url:'/api/files/export',handle:({context,request,reply})=>{
  const selected=query.parse(request.query),assert=()=>runtime.authority.assert(context),sql=new PrivateSql(db,context.userId,assert),source=ingress.forUser(context);
  const limit=configuration.instance.current<{maxExportBytes:number}>('storage').maxExportBytes;
  const live=`COALESCE(json_extract(c.json,'$.privacy.excluded'),0)=0 AND COALESCE(json_extract(c.json,'$.provenance.deleted'),0)=0
   AND s.id IS NOT NULL AND COALESCE(json_extract(s.json,'$.enabled'),1)=1
   ${selected.selection==='current'?"AND(c.source_id IS NULL OR EXISTS(SELECT 1 FROM pd_source_heads h WHERE h.user_id=c.user_id AND h.capture_id=c.id))":''}`;
  const pattern=selected.type.replaceAll('\\','\\\\').replaceAll('_','\\_').replaceAll('%','\\%').replace('*','%');
  const originals=()=>sql.all(`SELECT r.id,r.hash,o.bytes,r.mime,r.retention,c.id capture_id,c.json,c.fingerprint,s.id source_id,(c.source_id IS NULL OR EXISTS(SELECT 1 FROM pd_source_heads h WHERE h.user_id=c.user_id AND h.capture_id=c.id)) is_current
   FROM ig_originals r JOIN ig_objects o ON o.user_id=r.user_id AND o.hash=r.hash JOIN pd_captures c ON c.user_id=r.user_id AND c.id=r.capture_id
   LEFT JOIN ig_capture_scopes b ON b.user_id=c.user_id AND b.capture_id=c.id
   JOIN pd_sources s ON s.user_id=c.user_id AND s.id=coalesce(c.source_id,b.source_id)
   WHERE r.user_id=$user AND c.user_id=$user AND s.user_id=$user AND r.mime LIKE ? ESCAPE '\\' AND ${live} AND ${attachmentVisible()}
   ORDER BY r.id`,pattern);
  const attachments=()=>sql.all(`SELECT f.id,f.hash,f.json file,c.id capture_id,c.json,c.fingerprint,s.id source_id,(c.source_id IS NULL OR EXISTS(SELECT 1 FROM pd_source_heads h WHERE h.user_id=c.user_id AND h.capture_id=c.id)) is_current
   FROM ig_archive_files f JOIN ig_archive_links a ON a.user_id=f.user_id AND a.file_id=f.id
   JOIN pd_captures c ON c.user_id=a.user_id AND c.id=a.capture_id
   LEFT JOIN ig_capture_scopes b ON b.user_id=c.user_id AND b.capture_id=c.id
   JOIN pd_sources s ON s.user_id=c.user_id AND s.id=coalesce(c.source_id,b.source_id)
   WHERE f.user_id=$user AND c.user_id=$user AND s.user_id=$user AND json_extract(f.json,'$.mimeType') LIKE ? ESCAPE '\\' AND ${live}
   AND EXISTS(SELECT 1 FROM json_each(c.json,'$.provenance.document.attachments') d WHERE json_extract(d.value,'$.id')=f.id)
   ORDER BY c.id,f.id`,pattern);
  const initial=sql.changeToken(),files=originals(),attached=attachments();
  const proof=(rows=originals(),links=attachments())=>identityHash([rows.map(row=>[row.id,row.hash,row.fingerprint,fileOriginalGeneration(sql,'original:'+row.id)]),links.map(row=>[row.capture_id,row.id,row.hash,row.fingerprint,captureIncarnationGeneration(sql,String(row.capture_id))])]);
  const expected=proof(files,attached);if(sql.changeToken()!==initial)throw new PrivateDataError('conflict',409);let observed=initial;
  const current=()=>{assert();const next=sql.changeToken();if(next===observed)return;if(proof()!==expected||sql.changeToken()!==next)throw new PrivateDataError('conflict',409);observed=next;};
  const manifest={format:'mote-files-export',version:1,...selected,
   originals:files.map(row=>({ref:'original:'+row.id,captureId:row.capture_id,sourceId:row.source_id,sha256:row.hash,sizeBytes:Number(row.bytes),mimeType:row.mime,retention:row.retention,current:Boolean(row.is_current),member:'originals/'+row.id+'.blob',record:JSON.parse(String(row.json)),originalGeneration:fileOriginalGeneration(sql,'original:'+row.id)})),
   attachments:attached.map(row=>({parentCaptureId:row.capture_id,sourceId:row.source_id,current:Boolean(row.is_current),member:'attachments/'+row.id+'.blob',file:JSON.parse(String(row.file))})),
   coverage:{originals:true,declaredAttachments:true,processingProducts:false,privateCredentials:false,portableRecovery:false}};
  const metadata=Buffer.from(JSON.stringify(manifest)),entries:ExportTarEntry[]=[{name:'metadata.json',bytes:metadata}];
  let size=metadata.length;
  if(selected.mode==='data'){
   for(const row of files){
    const ref='original:'+row.id,info=source.readOriginal(ref,{length:0});if(info.available===false)throw new PrivateDataError('snapshot_input_expired',410);size+=Number(row.bytes);
    entries.push({name:'originals/'+row.id+'.blob',sizeBytes:Number(row.bytes),chunks:function*(){for(let offset=0;offset<Number(row.bytes);){current();const part=source.readOriginal(ref,{offset,length:Math.min(64*1024,Number(row.bytes)-offset)});if(!part.bytes.length)throw new PrivateDataError('conflict',409);offset+=part.bytes.length;yield part.bytes;}}});
   }
   const seen=new Set<string>();for(const row of attached){if(seen.has(String(row.id)))continue;seen.add(String(row.id));const file=source.archivedFile(String(row.id));size+=file.sizeBytes;
    entries.push({name:'attachments/'+row.id+'.blob',sizeBytes:file.sizeBytes,chunks:function*(){current();source.captureArchivedFiles(String(row.capture_id));const bytes=source.archivedBytes(String(row.id));for(let offset=0;offset<bytes.length;offset+=64*1024){current();yield bytes.subarray(offset,offset+64*1024);}}});
   }
  }
  if(size>limit)throw new PrivateDataError('invalid_data',413);
  current();return reply.header('Cache-Control','no-store').header('Content-Disposition','attachment; filename="mote-files-'+selected.mode+'.tar.gz"').type('application/gzip').send(exportTar(entries,current));
 }});
}
