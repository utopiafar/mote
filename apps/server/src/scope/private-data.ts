import {createHash} from 'node:crypto';
import {z} from 'zod';
import {sourceConnectionSchema,sourceItemSchema,sourceContentTime,captureSchema,ownerRelationSchema,sourceContextUpdateSchema,type AttributionContext,type SourceConnection,type CaptureInput,type CaptureRecord,type SourceItemRecord} from '@mote/shared';
import {materialDraftSchema,type MaterialDraft} from './material-model.js';
import {PrivateSql,PrivateCursor,PrivateDataError,missing} from './private-data-sql.js';
import {storeCapture,type StoredCapture} from './capture-original.js';

export const PRIVATE_DATA_DOMAIN='private-data';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
const materialId=(sourceId:string,externalId:string)=>'mat_'+hash([sourceId,externalId]);
const sourcePatch=z.object({name:z.string().trim().min(1).max(200).optional(),enabled:z.boolean().optional(),initialSync:z.enum(['all','new_only']).optional(),retention:z.enum(['snapshot','reference','archive']).optional(),ownerRelation:ownerRelationSchema.nullable().optional()}).strict();
export const privateListSchema=z.object({sourceId:z.string().min(1).max(128).optional(),deviceId:z.string().min(1).max(128).optional(),kind:z.string().min(1).max(128).optional(),after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),limit:z.coerce.number().int().min(1).max(200).default(50),cursor:z.string().max(8192).optional()}).strict();
type ListInput=z.input<typeof privateListSchema>;
type Row=Record<string,any>;
const json=<T>(row:Row|undefined):T=>{if(!row)throw missing();return JSON.parse(row.json);};
function ref(value:string){const match=/^(?:material:)?(mat_[a-f0-9]{64})(?:@([a-f0-9]{64}))?$/.exec(value);if(!match)throw new PrivateDataError('invalid_data');return {id:match[1],revision:match[2]};}
const conflict=()=>new PrivateDataError('conflict',409);

/** Host-created per-user repository, never constructed from an HTTP owner ID.
 * Intake/publication are host APIs for M03/M05/M06. Their transport routes stay
 * closed until those modules implement credentials, originals and task fences. */
export class PrivateData{
  constructor(private readonly sql:PrivateSql,private readonly cursor:PrivateCursor){}
  sources():SourceConnection[]{return this.sql.all('SELECT json FROM pd_sources WHERE user_id=$user ORDER BY id').map(r=>json<SourceConnection>(r));}
  source(id:string):SourceConnection{return json(this.sql.get('SELECT json FROM pd_sources WHERE user_id=$user AND id=?',id));}
  registerSource(raw:unknown){
    const input=sourceConnectionSchema.parse(raw);
    if(input.sourceContext||input.ownerRelationVersion)throw new PrivateDataError('invalid_data');
    return this.sql.transaction(()=>{
      const prior=this.sql.get('SELECT json FROM pd_sources WHERE user_id=$user AND id=?',input.id);
      if(prior){const current=json<SourceConnection>(prior);if(current.kind!==input.kind||current.deviceId!==input.deviceId||current.platform!==input.platform)throw conflict();return current;}
      const at=now(),value={...input,...(input.ownerRelation?{ownerRelationVersion:1}:{}),createdAt:at,updatedAt:at};
      this.sql.run('INSERT INTO pd_sources VALUES($user,?,?,?,?)',input.id,JSON.stringify(value),at,at);return value;
    });
  }
  updateSource(id:string,raw:unknown){
    const patch=sourcePatch.parse(raw);
    return this.sql.transaction(()=>{
      const current=this.source(id),value={...current,...patch,ownerRelation:patch.ownerRelation===null?undefined:patch.ownerRelation??current.ownerRelation,updatedAt:now()};
      if('ownerRelation' in patch&&patch.ownerRelation!==(current.ownerRelation??null)){
        value.ownerRelationVersion=(current.ownerRelationVersion??0)+1;
      }
      this.sql.run('UPDATE pd_sources SET json=?,updated_at=? WHERE user_id=$user AND id=?',JSON.stringify(value),value.updatedAt,id);
      if('ownerRelation' in patch&&patch.ownerRelation!==(current.ownerRelation??null))this.refreshSourceMaterials(id);
      return value;
    });
  }
  sourceContext(id:string,version?:number){
    this.source(id);
    const row=version===undefined?this.sql.get('SELECT * FROM pd_source_contexts WHERE user_id=$user AND source_id=? ORDER BY version DESC LIMIT 1',id):this.sql.get('SELECT * FROM pd_source_contexts WHERE user_id=$user AND source_id=? AND version=?',id,version);
    if(!row&&version!==undefined)throw missing();
    return row?{sourceId:id,version:Number(row.version),description:String(row.description),fingerprint:String(row.fingerprint),updatedAt:String(row.updated_at)}:{sourceId:id,version:0,description:''};
  }
  updateSourceContext(id:string,raw:unknown){
    const patch=sourceContextUpdateSchema.parse(raw);
    return this.sql.transaction(()=>{
      const current=this.sourceContext(id);
      if(patch.expectedVersion!==current.version){if(patch.expectedVersion===current.version-1&&patch.description===current.description)return current;throw conflict();}
      if(patch.description===current.description)return current;
      const value={sourceId:id,version:current.version+1,description:patch.description,updatedAt:now()};
      const fingerprint=hash({sourceId:id,version:value.version,description:value.description});
      this.sql.run('INSERT INTO pd_source_contexts VALUES($user,?,?,?,?,?)',id,value.version,fingerprint,value.description,value.updatedAt);
      const source={...this.source(id),sourceContext:{version:value.version,fingerprint},updatedAt:value.updatedAt};
      this.sql.run('UPDATE pd_sources SET json=?,updated_at=? WHERE user_id=$user AND id=?',JSON.stringify(source),value.updatedAt,id);
      this.refreshSourceMaterials(id);
      return {...value,fingerprint};
    });
  }
  receiveCaptures(raw:unknown[],original?:{sourceId?:string;verify:(input:CaptureInput)=>void}){
    const inputs=z.array(captureSchema).min(1).max(500).parse(raw);
    if(inputs.some(c=>c.provenance||((c.imageBase64||c.imageMime)&&!original)))throw new PrivateDataError('scope_unavailable',503);
    return this.sql.transaction(()=>inputs.map(input=>{if(input.imageBase64)original!.verify(input);if(original?.sourceId){const source=this.source(original.sourceId);if(!source.enabled||source.deviceId!==input.deviceId||source.platform!==input.platform)throw conflict();}return this.insertCapture(input,undefined,original?.sourceId);}));
  }
  private insertCapture(input:CaptureInput,sourceFingerprint?:string,ingressSourceId?:string){
    const at=now(),record={...storeCapture({...input,capturedAt:new Date(input.capturedAt).toISOString()}),...(ingressSourceId?{ingressSourceId}:{})},fingerprint=sourceFingerprint??hash(record);
    if(Date.parse(record.capturedAt)>Date.now()+86400000)throw new PrivateDataError('invalid_data');
    const prior=this.sql.get('SELECT fingerprint FROM pd_captures WHERE user_id=$user AND id=?',record.id);
    if(prior){if(prior.fingerprint!==fingerprint)throw conflict();return {id:record.id,duplicate:true};}
    const p=record.provenance;
    this.sql.run('INSERT INTO pd_captures VALUES($user,?,?,?,?,?,?,?,?)',record.id,p?.sourceId??null,p?.externalId??null,p?.revision??null,fingerprint,new Date(sourceContentTime(record)).toISOString(),at,JSON.stringify(record));
    return {id:record.id,duplicate:false};
  }
  receiveSourceItems(sourceId:string,raw:unknown[],archiveOriginal?:{verify:(item:import('@mote/shared').SourceItem)=>void}){
    const items=z.array(sourceItemSchema).min(1).max(500).parse(raw);
    if(new Set(items.map(i=>JSON.stringify([i.externalId,i.revision]))).size!==items.length)throw conflict();
    return this.sql.transaction(()=>{
      const source=this.source(sourceId);if(!source.enabled)throw conflict();
      if(source.retention==='archive'&&!archiveOriginal)throw new PrivateDataError('scope_unavailable',503);
      return {receipts:items.map(item=>{
        // Archive originals remain behind M03's restricted reader. Public data
        // candidates never index raw Coding transcripts or transport payloads.
        if(source.retention==='archive'){archiveOriginal!.verify(item);item={...item,text:''};}
        if(source.retention==='reference'&&item.layer!=='reference')throw conflict();
        const {observedAt,...semantic}=item,fingerprint=hash(semantic);
        const previous=this.sql.get('SELECT id,fingerprint FROM pd_captures WHERE user_id=$user AND source_id=? AND external_id=? AND revision=?',sourceId,item.externalId,item.revision);
        if(previous){if(previous.fingerprint!==fingerprint)throw conflict();return {id:String(previous.id),sourceId,externalId:item.externalId,revision:item.revision,duplicate:true};}
        const digest=hash([sourceId,item.externalId,item.revision]);
        const id=`${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
        const {externalId,revision,layer,mimeType,uri,modifiedAt,calendar,deleted,metadata,document}=item;
        const capture=captureSchema.parse({id,deviceId:source.deviceId,deviceName:source.name,platform:source.platform,capturedAt:observedAt,durationMs:0,appId:`mote.source.${source.kind}`,appName:source.name,windowTitle:item.title,ocrText:item.text,source:item.kind,provenance:{sourceId,externalId,revision,layer,mimeType,uri,modifiedAt,calendar,deleted,metadata,document},privacy:{excluded:false,redacted:false,mode:'none'}});
        const receipt=this.insertCapture(capture,fingerprint);
        const head=this.sql.get('SELECT capture_id,observed_at FROM pd_source_heads WHERE user_id=$user AND source_id=? AND external_id=?',sourceId,item.externalId);
        if(!head||Date.parse(item.observedAt)>=Date.parse(String(head.observed_at))){
          if(head)this.hideMaterials(this.sql.all('SELECT DISTINCT d.material_id AS id FROM pd_material_captures d JOIN pd_materials h ON h.user_id=d.user_id AND h.id=d.material_id AND h.revision=d.revision WHERE d.user_id=$user AND h.user_id=$user AND d.capture_id=?',String(head.capture_id)).map(r=>String(r.id)));
          this.sql.run('INSERT INTO pd_source_heads VALUES($user,?,?,?,?) ON CONFLICT(user_id,source_id,external_id) DO UPDATE SET capture_id=excluded.capture_id,observed_at=excluded.observed_at',sourceId,item.externalId,id,new Date(observedAt).toISOString());
        }
        return {...receipt,sourceId,externalId,revision};
      })};
    });
  }
  capture(id:string):CaptureRecord{
    const row=this.sql.get('SELECT json,received_at FROM pd_captures WHERE user_id=$user AND id=?',id);
    const {originalImage,ingressSourceId:_,...input}=json<StoredCapture>(row);
    return {...input,receivedAt:String(row!.received_at),blobHash:originalImage?.hash??null,imageMime:originalImage?.mime??null,indexingStatus:originalImage?'pending':'indexed'};
  }
  sourceItem(sourceId:string,externalId:string):SourceItemRecord|null{
    this.source(sourceId);const row=this.sql.get('SELECT capture_id FROM pd_source_heads WHERE user_id=$user AND source_id=? AND external_id=?',sourceId,externalId);
    return row?this.item(String(row.capture_id),true):null;
  }
  private item(id:string,current:boolean):SourceItemRecord{
    const c=this.capture(id),p=c.provenance!;
    return {...p,observedAt:c.capturedAt,title:c.windowTitle,text:c.ocrText,kind:c.source as SourceItemRecord['kind'],captureId:id,receivedAt:c.receivedAt,current};
  }
  sourceHistory(sourceId:string,externalId:string){
    const head=this.sourceItem(sourceId,externalId);
    return this.sql.all('SELECT id FROM pd_captures WHERE user_id=$user AND source_id=? AND external_id=? ORDER BY received_at DESC,id DESC LIMIT 100',sourceId,externalId).map(r=>this.item(String(r.id),r.id===head?.captureId));
  }
  private filter(raw:ListInput,collection:'captures'|'source-items'|'materials'){
    const args=privateListSchema.parse(raw),{cursor,limit,...filters}=args;
    if(filters.sourceId)this.source(filters.sourceId);
    const query={collection,...filters},position=cursor?this.cursor.decode(cursor,query):undefined;
    return {args,query,position,limit};
  }
  captures(raw:ListInput={},heads=false){
    const {args,query,position,limit}=this.filter(raw,heads?'source-items':'captures');
    const clauses=['1'],values:(string|number)[]=[];
    if(heads)clauses.push("EXISTS(SELECT 1 FROM pd_source_heads h WHERE h.user_id=$user AND h.capture_id=c.id) AND COALESCE(json_extract(c.json,'$.provenance.deleted'),0)=0");
    if(args.sourceId){clauses.push('c.source_id=?');values.push(args.sourceId);}
    if(args.deviceId){clauses.push("json_extract(c.json,'$.deviceId')=?");values.push(args.deviceId);}
    if(args.kind){clauses.push("json_extract(c.json,'$.source')=?");values.push(args.kind);}
    if(args.after){clauses.push(heads?"julianday(COALESCE(json_extract(c.json,'$.provenance.calendar.end'),c.context_at))>=julianday(?)":'c.context_at>=?');values.push(new Date(args.after).toISOString());}
    if(args.before){clauses.push(heads?"julianday(COALESCE(json_extract(c.json,'$.provenance.calendar.start'),c.context_at))<julianday(?)":'c.context_at<?');values.push(new Date(args.before).toISOString());}
    if(position){clauses.push('(c.context_at<? OR(c.context_at=? AND c.id<?))');values.push(position.at,position.at,position.id);}
    const rows=this.sql.all(`SELECT c.id,c.context_at FROM pd_captures c WHERE c.user_id=$user AND ${clauses.join(' AND ')} ORDER BY c.context_at DESC,c.id DESC LIMIT ?`,...values,limit+1);
    const visible=rows.slice(0,limit),last=visible.at(-1);
    return {items:visible.map(r=>heads?this.item(String(r.id),true):this.capture(String(r.id))),nextCursor:rows.length>limit&&last?this.cursor.encode(query,{at:String(last.context_at),id:String(last.id)}):null};
  }
  publishMaterial(raw:unknown,expectedRevision?:string){
    return this.publishVersion(raw,expectedRevision);
  }
  private publishVersion(raw:unknown,expectedRevision?:string,correctionOverride?:NonNullable<AttributionContext['correction']>){
    let draft=materialDraftSchema.parse(raw);
    if(draft.blocks.some(b=>b.kind==='asset'))throw new PrivateDataError('scope_unavailable',503);
    if(draft.id!==materialId(draft.origin.sourceId,draft.origin.externalId))throw new PrivateDataError('invalid_data');
    if(new Set(draft.blocks.map(b=>b.id)).size!==draft.blocks.length||new Set(draft.members.map(m=>m.id)).size!==draft.members.length||draft.blocks.some(b=>b.memberIds.some(id=>!draft.members.some(m=>m.id===id))))throw new PrivateDataError('invalid_data');
    return this.sql.transaction(()=>{
      const original=this.source(draft.origin.sourceId);
      const prior=this.sql.get('SELECT * FROM pd_materials WHERE user_id=$user AND id=?',draft.id);
      const priorDraft=prior?json<MaterialDraft>(this.sql.get('SELECT json FROM pd_material_versions WHERE user_id=$user AND material_id=? AND revision=?',draft.id,prior.revision)):undefined;
      const correction=correctionOverride??priorDraft?.attributionContext?.correction;
      const declaredSource=draft.attributionContext?.sourceDeclaration;
      const attributionSource=declaredSource?this.source(declaredSource.sourceId):original;
      if(declaredSource&&(attributionSource.ownerRelationVersion!==declaredSource.version||(attributionSource.ownerRelation??null)!==declaredSource.ownerRelation))throw conflict();
      const {correction:_,sourceDeclaration:__,...requested}=draft.attributionContext??{};
      draft.attributionContext={...requested,version:1,ownerRelation:correction?.ownerRelation??attributionSource.ownerRelation??'unknown',basis:correction?.ownerRelation?'owner_material':attributionSource.ownerRelation?'owner_source':'default',...(attributionSource.ownerRelationVersion?{sourceDeclaration:{sourceId:attributionSource.id,version:attributionSource.ownerRelationVersion,ownerRelation:attributionSource.ownerRelation??null}}:{}),...(correction?{correction}:{})};
      for(const block of draft.blocks)if(block.kind==='text'&&block.evidenceContext){const context=block.evidenceContext.attributionContext;block.evidenceContext.attributionContext={...context,version:1,ownerRelation:draft.attributionContext.ownerRelation,basis:draft.attributionContext.basis,...(correction?{correction}:{})};}
      const pins=new Map<string,{version:number;fingerprint:string}>();
      const sources=new Set<string>([draft.origin.sourceId]);
      const context=this.sourceContext(draft.origin.sourceId);
      if(context.version)pins.set(draft.origin.sourceId,{version:context.version,fingerprint:context.fingerprint!});
      const checkAttribution=(value:AttributionContext|undefined)=>{
        if(!value)return;
        // Those control-plane domains are deliberately unavailable until their
        // owner modules supply a scoped resolver. Never retain dangling IDs.
        if(value.declarations?.length||value.ownerStatements?.length||value.importDeclarations?.length||value.importStatements?.length||value.materialDeclarations)throw new PrivateDataError('scope_unavailable',503);
        if(value.sourceDeclaration){const pin=value.sourceDeclaration,source=this.source(pin.sourceId);if(source.ownerRelationVersion!==pin.version||(source.ownerRelation??null)!==pin.ownerRelation)throw conflict();sources.add(pin.sourceId);}
        for(const pin of value.sourceContextDeclarations??[]){
          const declared=this.sourceContext(pin.sourceId,pin.version);if(declared.fingerprint!==pin.fingerprint)throw conflict();
          const existing=pins.get(pin.sourceId);if(existing&&(existing.version!==pin.version||existing.fingerprint!==pin.fingerprint))throw conflict();
          pins.set(pin.sourceId,pin);
          sources.add(pin.sourceId);
        }
        for(const statement of value.sourceContextStatements??[]){const declared=this.sourceContext(statement.sourceId,statement.version);if(declared.description!==statement.description||pins.get(statement.sourceId)?.version!==statement.version)throw conflict();}
      };
      checkAttribution(draft.attributionContext);
      for(const block of draft.blocks)if(block.kind==='text')checkAttribution(block.evidenceContext?.attributionContext);
      const captureInputs=new Set<string>(),captureLinks:{memberId:string;id:string}[]=[],materialLinks:{memberId:string;id:string;revision:string}[]=[];
      for(const member of draft.members){
        if(member.kind==='capture'){
          if(!member.ref.startsWith('capture:'))throw new PrivateDataError('invalid_data');
          const id=member.ref.slice(8),capture=this.capture(id);
          const stored=json<StoredCapture>(this.sql.get('SELECT json FROM pd_captures WHERE user_id=$user AND id=?',id));
          if(stored.ingressSourceId)sources.add(stored.ingressSourceId);
          if(capture.provenance?.deleted||member.revision&&member.revision!==capture.provenance?.revision)throw conflict();
          if(capture.provenance){
            const p=capture.provenance,head=this.sourceItem(p.sourceId,p.externalId);if(head?.captureId!==id)throw conflict();
            sources.add(p.sourceId);
          }
          captureLinks.push({memberId:member.id,id});captureInputs.add(id);
        }else if(member.kind==='material'){
          const input=ref(member.ref);if(!input.revision||member.revision&&member.revision!==input.revision)throw new PrivateDataError('invalid_data');
          if(input.id===draft.id)throw new PrivateDataError('invalid_data');
          this.material(input.id,input.revision);
          if(this.material(input.id).revision!==input.revision)throw conflict();
          for(const row of this.sql.all('SELECT source_id FROM pd_material_sources WHERE user_id=$user AND material_id=? AND revision=?',input.id,input.revision))sources.add(String(row.source_id));
          materialLinks.push({memberId:member.id,id:input.id,revision:input.revision});
        }else throw new PrivateDataError('scope_unavailable',503);
      }
      for(const block of draft.blocks)if(block.evidenceIds?.some(id=>!captureInputs.has(id)))throw new PrivateDataError('invalid_data');
      for(const sourceId of sources){
        const current=this.sourceContext(sourceId),pin=pins.get(sourceId);
        if(pin&&(pin.version!==current.version||pin.fingerprint!==current.fingerprint))throw conflict();
        if(current.version)pins.set(sourceId,{version:current.version,fingerprint:current.fingerprint!});
      }
      if(pins.size)draft.attributionContext.sourceContextDeclarations=[...pins].sort(([a],[b])=>a.localeCompare(b)).map(([sourceId,pin])=>({sourceId,...pin}));
      draft=materialDraftSchema.parse(draft);
      const revision=hash(draft),exists=this.sql.get('SELECT json FROM pd_material_versions WHERE user_id=$user AND material_id=? AND revision=?',draft.id,revision);
      if(prior&&prior.revision===revision&&Number(prior.sequence)>=Number(prior.min_visible_sequence))return this.material(draft.id);
      if(expectedRevision!==undefined&&prior?.revision!==expectedRevision)throw conflict();
      // An old immutable revision cannot silently become the new head.
      if(exists)throw conflict();
      const at=now(),sequence=Number(prior?.sequence??0)+1;
      // Dependents pinned to the old authority must be republished explicitly.
      this.hideMaterials(this.sql.all('SELECT DISTINCT d.material_id AS id FROM pd_material_inputs d JOIN pd_materials h ON h.user_id=d.user_id AND h.id=d.material_id AND h.revision=d.revision WHERE d.user_id=$user AND h.user_id=$user AND d.input_material_id=?',draft.id).map(r=>String(r.id)));
      // Replacing A may withdraw B which is itself an input of the new A.
      // Recheck after propagation so an authority cycle cannot publish a head
      // that already points at a hidden input. The transaction rolls back all
      // provisional visibility changes on conflict.
      for(const link of materialLinks){const input=this.sql.get('SELECT revision,sequence,min_visible_sequence FROM pd_materials WHERE user_id=$user AND id=?',link.id);if(!input||input.revision!==link.revision||Number(input.sequence)<Number(input.min_visible_sequence))throw conflict();}
      this.sql.run('INSERT INTO pd_materials VALUES($user,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence,updated_at=excluded.updated_at',draft.id,draft.origin.sourceId,draft.origin.externalId,revision,sequence,prior?.created_at??at,at,prior?.min_visible_sequence??1);
      const text=draft.blocks.flatMap(b=>b.kind==='text'?[b.text]:[]).join('\n');
      this.sql.run('INSERT INTO pd_material_versions VALUES($user,?,?,?,?,?,?)',draft.id,revision,sequence,JSON.stringify(draft),text,at);
      for(const link of captureLinks)this.sql.run('INSERT INTO pd_material_captures VALUES($user,?,?,?,?)',draft.id,revision,link.memberId,link.id);
      for(const link of materialLinks)this.sql.run('INSERT INTO pd_material_inputs VALUES($user,?,?,?,?,?)',draft.id,revision,link.memberId,link.id,link.revision);
      for(const sourceId of sources)this.sql.run('INSERT INTO pd_material_sources VALUES($user,?,?,?)',draft.id,revision,sourceId);
      for(const [sourceId,pin] of pins)this.sql.run('INSERT INTO pd_material_contexts VALUES($user,?,?,?,?,?)',draft.id,revision,sourceId,pin.version,pin.fingerprint);
      return this.material(draft.id);
    });
  }
  material(id:string,revision?:string){
    const key=ref(id);revision??=key.revision;
    const head=this.sql.get('SELECT * FROM pd_materials WHERE user_id=$user AND id=?',key.id);if(!head)throw missing();
    const version=this.sql.get('SELECT * FROM pd_material_versions WHERE user_id=$user AND material_id=? AND revision=?',key.id,revision??String(head.revision));
    if(!version||Number(version.sequence)<Number(head.min_visible_sequence))throw missing();
    const {blocks,members,...manifest}=json<MaterialDraft>(version);
    return {...manifest,revision:String(version!.revision),ref:`material:${key.id}@${version!.revision}`,sequence:Number(version!.sequence),createdAt:String(version!.created_at),updatedAt:String(head.updated_at),blockCount:blocks.length,memberCount:members.length,textLength:String(version!.text).length,assetCount:0,indexing:{state:'indexed'}};
  }
  materials(raw:ListInput={}){
    const {args,query,position,limit}=this.filter(raw,'materials'),clauses=['v.material_id=h.id','v.revision=h.revision','h.sequence>=h.min_visible_sequence'],values:(string|number)[]=[];
    if(args.sourceId){clauses.push('h.source_id=?');values.push(args.sourceId);}
    if(args.deviceId){clauses.push("json_extract(v.json,'$.origin.deviceId')=?");values.push(args.deviceId);}
    if(args.kind){clauses.push("json_extract(v.json,'$.kind')=?");values.push(args.kind);}
    if(args.after){clauses.push('h.updated_at>=?');values.push(new Date(args.after).toISOString());}
    if(args.before){clauses.push('h.updated_at<?');values.push(new Date(args.before).toISOString());}
    if(position){clauses.push('(h.updated_at<? OR(h.updated_at=? AND h.id<?))');values.push(position.at,position.at,position.id);}
    const rows=this.sql.all(`SELECT h.id,h.updated_at FROM pd_materials h JOIN pd_material_versions v ON v.user_id=h.user_id AND v.material_id=h.id WHERE h.user_id=$user AND v.user_id=$user AND ${clauses.join(' AND ')} ORDER BY h.updated_at DESC,h.id DESC LIMIT ?`,...values,limit+1),last=rows.slice(0,limit).at(-1);
    return {items:rows.slice(0,limit).map(r=>this.material(String(r.id))),nextCursor:rows.length>limit&&last?this.cursor.encode(query,{at:String(last.updated_at),id:String(last.id)}):null};
  }
  readMaterial(id:string,options:{revision?:string;offset?:number;length?:number}={}){
    const material=this.material(id,options.revision),offset=z.number().int().min(0).parse(options.offset??0),length=z.number().int().min(1).max(12000).parse(options.length??12000);
    const row=this.sql.get('SELECT json,text FROM pd_material_versions WHERE user_id=$user AND material_id=? AND revision=?',material.id,material.revision)!;
    const text=String(row.text),draft=json<MaterialDraft>(row);let position=0;
    const spans=draft.blocks.flatMap(block=>{
      if(block.kind!=='text')return [];
      const start=position,end=start+block.text.length;position=end+1;
      const left=Math.max(offset,start),right=Math.min(offset+length,end);
      return left<right?[{blockId:block.id,kind:block.kind,format:block.format,memberIds:block.memberIds,attributionContext:block.evidenceContext?.attributionContext??material.attributionContext,materialRange:{start:left,end:right},pageRange:{start:left-offset,end:right-offset}}]:[];
    });
    return {material,text:text.slice(offset,offset+length),spans,textRange:{offset,total:text.length,nextOffset:offset+length<text.length?offset+length:null}};
  }
  materialMembers(id:string,options:{revision?:string;offset?:number;limit?:number}={}){
    const material=this.material(id,options.revision),offset=z.number().int().min(0).parse(options.offset??0),limit=z.number().int().min(1).max(200).parse(options.limit??50);
    const draft=json<MaterialDraft>(this.sql.get('SELECT json FROM pd_material_versions WHERE user_id=$user AND material_id=? AND revision=?',material.id,material.revision));
    return {items:draft.members.slice(offset,offset+limit),total:draft.members.length,nextOffset:offset+limit<draft.members.length?offset+limit:null};
  }
  correctMaterialContext(id:string,expectedRevision:string,relation:unknown){
    const ownerRelation=ownerRelationSchema.nullable().parse(relation);
    return this.sql.transaction(()=>{
      const current=this.material(id);if(current.revision!==expectedRevision)throw conflict();
      const draft=json<MaterialDraft>(this.sql.get('SELECT json FROM pd_material_versions WHERE user_id=$user AND material_id=? AND revision=?',current.id,current.revision));
      const source=this.source(draft.origin.sourceId);
      draft.attributionContext={...draft.attributionContext,version:1,ownerRelation:ownerRelation??source.ownerRelation??'unknown',basis:ownerRelation?'owner_material':source.ownerRelation?'owner_source':'default',correction:{version:(draft.attributionContext?.correction?.version??0)+1,ownerRelation}};
      return this.publishVersion(draft,expectedRevision,draft.attributionContext.correction!);
    });
  }
  statistics(){
    const count=(table:'pd_sources'|'pd_captures'|'pd_materials')=>Number(this.sql.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=$user ${table==='pd_materials'?'AND sequence>=min_visible_sequence':''}`)!.n);
    return {sources:count('pd_sources'),captures:count('pd_captures'),materials:count('pd_materials')};
  }
  /** FTS only generates lexical candidates. Owner filtering occurs inside the
   * materialized candidate CTE before ORDER/LIMIT. We deliberately do not use
   * global bm25 corpus statistics; M07 may rerank only this returned slice. */
  search(raw:{query:string;limit?:number}){
    const {query,limit}=z.object({query:z.string().trim().min(1).max(500),limit:z.number().int().min(1).max(200).default(50)}).strict().parse(raw);
    const match='"'+query.replaceAll('"','""')+'"',short=Array.from(query).length<3;
    return {items:this.sql.all(`WITH candidates AS MATERIALIZED (
      SELECT kind,entity_id,revision,text FROM pd_fts WHERE user_id=$user AND ${short?'instr(lower(text),lower(?))>0':'pd_fts MATCH ?'}
      AND ((kind='capture' AND EXISTS(SELECT 1 FROM pd_captures c WHERE c.user_id=$user AND c.id=pd_fts.entity_id
        AND (c.source_id IS NULL OR EXISTS(SELECT 1 FROM pd_source_heads h WHERE h.user_id=$user AND h.capture_id=c.id AND COALESCE(json_extract(c.json,'$.provenance.deleted'),0)=0))))
        OR (kind='material' AND EXISTS(SELECT 1 FROM pd_materials m WHERE m.user_id=$user AND m.id=pd_fts.entity_id AND m.revision=pd_fts.revision AND m.sequence>=m.min_visible_sequence))))
      SELECT kind,entity_id,revision,text FROM candidates ORDER BY kind,entity_id,revision LIMIT ?`,short?query:match,limit).map(r=>({kind:r.kind,id:r.entity_id,revision:r.revision,text:r.text}))};
  }
  private removeCaptureMaterials(id:string){this.removeMaterials(this.sql.all('SELECT DISTINCT material_id AS id FROM pd_material_captures WHERE user_id=$user AND capture_id=?',id).map(r=>String(r.id)));}
  /** Withdraw stale projections without discarding originals or user edits.
   * M05/M06 can rebuild using the old head's retained correction and sequence. */
  private hideMaterials(ids:string[]){
    const pending=[...ids],seen=new Set<string>();
    while(pending.length){
      const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);
      pending.push(...this.sql.all('SELECT DISTINCT d.material_id AS id FROM pd_material_inputs d JOIN pd_materials h ON h.user_id=d.user_id AND h.id=d.material_id AND h.revision=d.revision WHERE d.user_id=$user AND h.user_id=$user AND d.input_material_id=?',id).map(r=>String(r.id)));
      this.sql.run('UPDATE pd_materials SET min_visible_sequence=sequence+1 WHERE user_id=$user AND id=?',id);
    }
  }
  /** Source control-plane edits reissue existing content in dependency order.
   * No processing or model call is authorized by a metadata edit. */
  private refreshSourceMaterials(sourceId:string){
    const rows=this.sql.all('SELECT h.id,h.revision,v.json FROM pd_materials h JOIN pd_material_versions v ON v.user_id=h.user_id AND v.material_id=h.id AND v.revision=h.revision JOIN pd_material_sources s ON s.user_id=h.user_id AND s.material_id=h.id AND s.revision=h.revision WHERE h.user_id=$user AND v.user_id=$user AND s.user_id=$user AND s.source_id=? AND h.sequence>=h.min_visible_sequence',sourceId);
    const snapshots=new Map(rows.map(row=>[String(row.id),{revision:String(row.revision),draft:json<MaterialDraft>(row)}])),completed=new Set<string>(),visiting=new Set<string>();
    const current=this.sourceContext(sourceId),source=this.source(sourceId);
    const update=(context:AttributionContext|undefined)=>{
      if(!context)return;
      const pins=(context.sourceContextDeclarations??[]).filter(pin=>pin.sourceId!==sourceId);
      if(current.version)pins.push({sourceId,version:current.version,fingerprint:current.fingerprint!});
      context.sourceContextDeclarations=pins;
      if(context.sourceContextStatements)context.sourceContextStatements=context.sourceContextStatements.map(statement=>statement.sourceId===sourceId?{sourceId,version:current.version,description:current.description}:statement);
      if(context.sourceDeclaration?.sourceId===sourceId)context.sourceDeclaration={sourceId,version:source.ownerRelationVersion!,ownerRelation:source.ownerRelation??null};
    };
    const refresh=(id:string)=>{
      if(completed.has(id))return;if(visiting.has(id))throw conflict();
      const snapshot=snapshots.get(id);if(!snapshot)return;
      visiting.add(id);
      for(const member of snapshot.draft.members)if(member.kind==='material'){
        const input=ref(member.ref);refresh(input.id);
        if(completed.has(input.id)){const next=this.material(input.id);member.ref=next.ref;if(member.revision)member.revision=next.revision;}
      }
      update(snapshot.draft.attributionContext);
      for(const block of snapshot.draft.blocks)if(block.kind==='text')update(block.evidenceContext?.attributionContext);
      this.sql.run('UPDATE pd_materials SET min_visible_sequence=sequence+1 WHERE user_id=$user AND id=?',id);
      this.publishVersion(snapshot.draft,snapshot.revision);
      visiting.delete(id);completed.add(id);
    };
    for(const id of snapshots.keys())refresh(id);
  }
  private removeMaterials(ids:string[]){
    const pending=[...ids],all=new Set<string>();
    while(pending.length){const id=pending.pop()!;if(all.has(id))continue;all.add(id);pending.push(...this.sql.all('SELECT DISTINCT material_id AS id FROM pd_material_inputs WHERE user_id=$user AND input_material_id=?',id).map(r=>String(r.id)));}
    for(const id of all)this.sql.run('DELETE FROM pd_material_inputs WHERE user_id=$user AND material_id=?',id);
    for(const id of all)this.sql.run('DELETE FROM pd_materials WHERE user_id=$user AND id=?',id);
  }
  deleteMaterial(id:string){return this.sql.transaction(()=>{const key=ref(id).id;if(!this.sql.get('SELECT id FROM pd_materials WHERE user_id=$user AND id=?',key))throw missing();this.removeMaterials([key]);return {deleted:true};});}
  deleteCapture(id:string){return this.sql.transaction(()=>{this.capture(id);this.removeCaptureMaterials(id);this.sql.run('DELETE FROM pd_captures WHERE user_id=$user AND id=?',id);return {deleted:true};});}
  deleteSource(id:string){return this.sql.transaction(()=>{
    this.source(id);
    this.removeMaterials(this.sql.all('SELECT DISTINCT material_id AS id FROM pd_material_sources WHERE user_id=$user AND source_id=?',id).map(r=>String(r.id)));
    this.sql.run('DELETE FROM pd_sources WHERE user_id=$user AND id=?',id);return {deleted:true};
  });}
}
