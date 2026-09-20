import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {CaptureRecord} from '@mote/shared';
import type {Store,Range} from './store.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const artifactOutput=z.object({kind:z.string().min(1).max(80),text:z.string().max(12000),metadata:z.record(z.unknown()).default({})}).strict();
export type ArtifactOutput=z.infer<typeof artifactOutput>;
export type Artifact={id:string;revision:string;kind:string;processor:string;processorVersion:string;configFingerprint:string;generatedAt:string;firstAt:string;lastAt:string;deviceId:string;appId:string;source:string;members:string[];representatives:string[];contentHash:string;metadata:Record<string,unknown>};
export function observationKey(record:{id:string;deviceId:string;capturedAt:string;source:string;appId?:string;windowTitle?:string;provenance?:CaptureRecord['provenance']}){
  // Mechanical boundaries, not an assertion that an app/window is one human task.
  // Only screen/UI samples can coalesce. Authored records keep their own identity.
  return hash([record.deviceId,record.source,record.appId,record.windowTitle,record.provenance?.sourceId,
    record.source==='screen'||record.source==='ui_page'?Math.floor(Date.parse(record.capturedAt)/300000):record.id]);
}
export class EvidenceArchive {
  constructor(readonly store:Store){
    const db=store.db;
    db.function('mote_observation_key',{deterministic:true},json=>observationKey(JSON.parse(String(json))));
    if(db.prepare('PRAGMA table_info(context_dirty)').all().length&&!db.prepare('PRAGMA table_info(context_dirty)').all().some(row=>row.name==='error'))db.exec('ALTER TABLE context_dirty ADD COLUMN error TEXT');
    db.exec(`
      DROP TRIGGER IF EXISTS context_observation_insert;
      DROP TRIGGER IF EXISTS context_observation_delete;
      DROP TRIGGER IF EXISTS context_observation_update;
      DROP TRIGGER IF EXISTS context_evidence_change;
      CREATE TABLE IF NOT EXISTS context_contents(hash TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_observations(id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,group_key TEXT NOT NULL,content_hash TEXT REFERENCES context_contents(hash));
      CREATE INDEX IF NOT EXISTS observations_group ON context_observations(group_key,id);
      CREATE INDEX IF NOT EXISTS observations_content ON context_observations(content_hash);
      CREATE TABLE IF NOT EXISTS context_dirty(group_key TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 1,error TEXT);
      CREATE TABLE IF NOT EXISTS context_artifacts(id TEXT PRIMARY KEY,group_key TEXT NOT NULL,revision TEXT NOT NULL,kind TEXT NOT NULL,first_at TEXT NOT NULL,last_at TEXT NOT NULL,device_id TEXT NOT NULL,app_id TEXT NOT NULL,source TEXT NOT NULL,content_hash TEXT NOT NULL REFERENCES context_contents(hash),json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_group ON context_artifacts(group_key);
      CREATE INDEX IF NOT EXISTS artifacts_time ON context_artifacts(last_at DESC,id);
      CREATE INDEX IF NOT EXISTS artifacts_content ON context_artifacts(content_hash);
      CREATE TABLE IF NOT EXISTS artifact_inputs(artifact_id TEXT NOT NULL REFERENCES context_artifacts(id) ON DELETE CASCADE,observation_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,PRIMARY KEY(artifact_id,observation_id));
      CREATE INDEX IF NOT EXISTS artifact_input_observation ON artifact_inputs(observation_id);
      CREATE TABLE IF NOT EXISTS artifact_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity TEXT NOT NULL,operation TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS context_observation_insert AFTER INSERT ON captures BEGIN
        INSERT INTO context_observations(id,group_key) VALUES(new.id,mote_observation_key(new.json));
        DELETE FROM context_artifacts WHERE id IN (SELECT artifact_id FROM artifact_inputs WHERE observation_id IN (SELECT id FROM context_observations WHERE group_key=mote_observation_key(new.json)));
        INSERT INTO context_dirty(group_key) VALUES(mote_observation_key(new.json)) ON CONFLICT(group_key) DO UPDATE SET generation=generation+1,error=NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS context_observation_delete BEFORE DELETE ON captures BEGIN
        INSERT INTO context_dirty(group_key) SELECT group_key FROM context_observations WHERE id=old.id ON CONFLICT(group_key) DO UPDATE SET generation=generation+1,error=NULL;
        DELETE FROM context_artifacts WHERE id IN (SELECT artifact_id FROM artifact_inputs WHERE observation_id=old.id);
      END;
      CREATE TRIGGER IF NOT EXISTS context_observation_update AFTER UPDATE OF json ON captures WHEN new.json!=old.json BEGIN
        DELETE FROM context_artifacts WHERE id IN (SELECT artifact_id FROM artifact_inputs WHERE observation_id=new.id);
        INSERT INTO context_dirty(group_key) SELECT group_key FROM context_observations WHERE id=new.id ON CONFLICT(group_key) DO UPDATE SET generation=generation+1,error=NULL;
        UPDATE context_observations SET group_key=mote_observation_key(new.json),content_hash=NULL WHERE id=new.id;
        INSERT INTO context_dirty(group_key) VALUES(mote_observation_key(new.json)) ON CONFLICT(group_key) DO UPDATE SET generation=generation+1,error=NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS context_evidence_change AFTER INSERT ON changes WHEN new.operation='supersede' BEGIN
        DELETE FROM context_artifacts WHERE id IN (SELECT artifact_id FROM artifact_inputs WHERE observation_id=new.id);
        INSERT INTO context_dirty(group_key) SELECT group_key FROM context_observations WHERE id=new.id ON CONFLICT(group_key) DO UPDATE SET generation=generation+1,error=NULL;
      END;
    `);
    if(!db.prepare('PRAGMA table_info(context_dirty)').all().some(row=>row.name==='error'))db.exec('ALTER TABLE context_dirty ADD COLUMN error TEXT');
    if(!db.prepare("SELECT 1 FROM settings WHERE key='evidence-archive-v1'").get())db.exec(`BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO context_observations(id,group_key) SELECT id,mote_observation_key(json) FROM captures;
      INSERT OR IGNORE INTO context_dirty(group_key) SELECT DISTINCT group_key FROM context_observations;
      INSERT INTO settings VALUES('evidence-archive-v1','1'); COMMIT;`);
  }
  fingerprint(id:string){const row=this.store.db.prepare('SELECT fingerprint FROM captures WHERE id=?').get(id);if(!row||!this.store.isCurrentEvidence(id))return null;return hash([row.fingerprint,this.store.db.prepare("SELECT kind,json_extract(json,'$.text') AS text FROM perception_results WHERE capture_id=? AND current=1 ORDER BY kind").all(id)]);}
  /** Incremental, deterministic exact-text reduction. No semantic inference or model calls. */
  aggregate(limit=32){
    const db=this.store.db,groups=db.prepare('SELECT group_key,generation FROM context_dirty WHERE error IS NULL LIMIT ?').all(Math.min(100,Math.max(1,limit)));
    for(const group of groups){
      // A 5-minute bucket may contain a replay burst: page on identity, bound every artifact.
      const ids=db.prepare('SELECT o.id FROM context_observations o JOIN captures c ON c.id=o.id WHERE o.group_key=? ORDER BY c.captured_at,o.id LIMIT 1001').all(group.group_key);
      if(ids.length>1000){db.prepare("UPDATE context_dirty SET error='group_member_limit' WHERE group_key=?").run(group.group_key);continue;}
      const parts:CaptureRecord[][]=[];let part:CaptureRecord[]=[],characters=0;const texts=new Set<string>();
      for(const row of ids){
        if(!this.store.isCurrentEvidence(String(row.id)))continue;
        const record=this.store.evidence([String(row.id)])[0];if(!record)continue;
        const text=record.ocrText;
        // Large originals remain directly pageable; segments carry a bounded preview and mark it.
        const cost=texts.has(text)?0:Math.min(text.length,12000);
        if(part.length&&(part.length>=100||characters+cost>12000)){parts.push(part);part=[];characters=0;texts.clear();}
        part.push(record);if(!texts.has(text)){characters+=Math.min(text.length,12000);texts.add(text);}
      }
      if(part.length)parts.push(part);
      db.exec('BEGIN IMMEDIATE');
      try{
        const retained=new Set<string>();
        for(const records of parts){
          records.sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt)||a.id.localeCompare(b.id));
          const entries=new Map<string,{text:string;ids:string[];firstAt:string;lastAt:string;complete:boolean}>();
          for(const record of records){
            const contentHash=hash(record.ocrText),entry=entries.get(contentHash)??{text:record.ocrText.slice(0,12000),ids:[],firstAt:record.capturedAt,lastAt:record.capturedAt,complete:record.ocrText.length<=12000};
            entry.ids.push(record.id);entry.lastAt=record.capturedAt;entries.set(contentHash,entry);
            db.prepare('INSERT OR IGNORE INTO context_contents VALUES(?,?)').run(contentHash,JSON.stringify({text:record.ocrText}));
            db.prepare('UPDATE context_observations SET content_hash=? WHERE id=?').run(contentHash,record.id);
          }
          if(!records.some(r=>r.ocrText.length))continue;
          const inputs=records.map(r=>({id:r.id,fingerprint:this.fingerprint(r.id)!}));
          const text=[...entries.values()].map(e=>e.text).filter(Boolean).join('\n\n').slice(0,12000);
          const metadata={grouping:'fixed_time_and_explicit_identity',semanticGrouping:false,observationCount:records.length,uniqueTexts:entries.size,complete:[...entries.values()].every(e=>e.complete)&&[...entries.values()].reduce((n,e)=>n+e.text.length+2,0)<=12002,entries:[...entries.values()].map(({text,...e})=>({...e,characters:text.length})),originalCharacters:records.reduce((n,r)=>n+r.ocrText.length,0),characters:text.length};
          const revision=hash([inputs,'mote.exact-segment','1',metadata]),id=hash([group.group_key,records[0].id]);retained.add(id);
          if(db.prepare('SELECT 1 FROM context_artifacts WHERE id=? AND revision=?').get(id,revision))continue;
          this.save(id,String(group.group_key),revision,{kind:'segment',text,metadata},inputs,'mote.exact-segment','1',hash({windowMs:300000,maxCharacters:12000,maxMembers:100}),[...entries.values()].map(e=>e.ids[0]));
        }
        for(const row of db.prepare("SELECT id FROM context_artifacts WHERE group_key=? AND kind='segment'").all(group.group_key))if(!retained.has(String(row.id)))db.prepare('DELETE FROM context_artifacts WHERE id=?').run(row.id);
        db.prepare('DELETE FROM context_dirty WHERE group_key=? AND generation=?').run(group.group_key,group.generation);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    return groups.length;
  }
  save(id:string,group:string,revision:string,output:ArtifactOutput,inputs:{id:string;fingerprint:string}[],processor:string,version:string,configFingerprint:string,representatives=inputs.map(i=>i.id)){
    const db=this.store.db,records=this.store.evidence(inputs.map(i=>i.id));
    if(!records.length||inputs.some(i=>this.fingerprint(i.id)!==i.fingerprint))throw new Error('evidence_changed');
    const times=records.map(r=>r.capturedAt).sort(),contentHash=hash(output.text);
    const artifact:Artifact={id,revision,kind:output.kind,processor,processorVersion:version,configFingerprint,generatedAt:new Date().toISOString(),firstAt:times[0],lastAt:times.at(-1)!,deviceId:records.every(r=>r.deviceId===records[0].deviceId)?records[0].deviceId:'',appId:records.every(r=>r.appId===records[0].appId)?records[0].appId:'',source:records.every(r=>r.source===records[0].source)?records[0].source:'',members:inputs.map(i=>i.id),representatives,contentHash,metadata:output.metadata};
    this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(artifact))+Buffer.byteLength(output.text)+4096);
    db.prepare('INSERT OR IGNORE INTO context_contents VALUES(?,?)').run(contentHash,JSON.stringify({text:output.text}));
    db.prepare('DELETE FROM context_artifacts WHERE id=?').run(id);
    db.prepare('INSERT INTO context_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,group,revision,output.kind,artifact.firstAt,artifact.lastAt,artifact.deviceId,artifact.appId,artifact.source,contentHash,JSON.stringify(artifact));
    const insert=db.prepare('INSERT INTO artifact_inputs VALUES(?,?,?)');for(const input of inputs)insert.run(id,input.id,input.fingerprint);
    db.prepare("INSERT INTO artifact_events(entity,operation) VALUES(?,'ready')").run(id);
    return artifact;
  }
  get(id:string){const row=this.store.db.prepare('SELECT a.json,c.json AS content FROM context_artifacts a JOIN context_contents c ON c.hash=a.content_hash WHERE a.id=?').get(id);return row?{...JSON.parse(String(row.json)) as Artifact,text:String(JSON.parse(String(row.content)).text)}:undefined;}
  page(args:Range&{query?:string;id?:string;maxCharacters?:number}={}){
    const db=this.store.db,where=['1=1'],values:(string|number)[]=[],budget=Math.max(1000,Math.min(args.maxCharacters??(args.id?24000:12000),24000));
    for(const [key,column] of [['deviceId','device_id'],['appId','app_id'],['source','source'],['id','id']] as const)if(args[key]){where.push(`a.${column}=?`);values.push(args[key]!);}
    // Only fully contained segments are disclosed under a narrowed query scope.
    if(args.after){where.push('a.first_at>=?');values.push(args.after);}if(args.before){where.push('a.last_at<?');values.push(args.before);}
    if(args.collection==='activity')where.push("a.source='activity'");else if(args.collection==='content')where.push("a.source!='activity'");
    if(args.query)for(const term of args.query.trim().split(/\s+/u).slice(0,12)){where.push("instr(lower(json_extract(c.json,'$.text')),lower(?))>0");values.push(term);}
    const scopeHash=hash({...args,cursor:undefined});let cursor:{at:string;id:string;scope:string}|undefined;
    if(args.cursor){cursor=z.object({at:z.string(),id:z.string(),scope:z.literal(scopeHash)}).parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString()));where.push('(a.last_at<? OR (a.last_at=? AND a.id>?))');values.push(cursor.at,cursor.at,cursor.id);}
    const rows=db.prepare(`SELECT a.id FROM context_artifacts a JOIN context_contents c ON c.hash=a.content_hash WHERE ${where.join(' AND ')} ORDER BY a.last_at DESC,a.id LIMIT ?`).all(...values,Math.min(args.limit??20,100)+1);
    const items:ReturnType<EvidenceArchive['get']>[]=[];let used=0,truncated=false;
    for(const row of rows){const artifact=this.get(String(row.id))!;const {text,...metadata}=artifact;const {entries:memberDetails,...detailMetadata}=artifact.metadata;const value={...metadata,metadata:detailMetadata,...(!args.id?{members:artifact.members.slice(0,3),representatives:artifact.representatives.slice(0,3),metadata:{observationCount:artifact.members.length,uniqueTexts:artifact.metadata.uniqueTexts,complete:artifact.metadata.complete,characters:artifact.metadata.characters,detail:artifact.id}}:{}),text:text.slice(0,args.id?12000:400),textRange:{offset:0,total:text.length,complete:args.id?true:text.length<=400}};const cost=JSON.stringify(value).length;if(items.length>=Math.min(args.limit??20,100)||used+cost>budget){truncated=true;break;}items.push(value);used+=cost;}
    const last=items.at(-1);
    return {items,nextCursor:truncated&&last?Buffer.from(JSON.stringify({at:last.lastAt,id:last.id,scope:scopeHash})).toString('base64url'):null,truncated,characters:used,budget,coverage:{pendingGroups:Number(db.prepare('SELECT COUNT(*) AS n FROM context_dirty').get()!.n),blockedGroups:Number(db.prepare('SELECT COUNT(*) AS n FROM context_dirty WHERE error IS NOT NULL').get()!.n),scope:'processed_segments_only',fallback:'search_context',originalsPreserved:true}};
  }
  stats(){const db=this.store.db;return {observations:Number(db.prepare('SELECT COUNT(*) AS n FROM context_observations').get()!.n),contents:Number(db.prepare('SELECT COUNT(*) AS n FROM context_contents').get()!.n),artifacts:Number(db.prepare('SELECT COUNT(*) AS n FROM context_artifacts').get()!.n),pendingGroups:Number(db.prepare('SELECT COUNT(*) AS n FROM context_dirty').get()!.n),blockedGroups:Number(db.prepare('SELECT COUNT(*) AS n FROM context_dirty WHERE error IS NOT NULL').get()!.n)};}
  collect(){this.store.db.exec('DELETE FROM context_contents WHERE hash NOT IN (SELECT content_hash FROM context_observations WHERE content_hash IS NOT NULL) AND hash NOT IN (SELECT content_hash FROM context_artifacts)');}
}
