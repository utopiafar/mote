import type {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {catalogParent} from '../source-catalog-path.js';

export const ASK_DOMAIN='ask';
export class AskError extends Error{constructor(readonly code:string,readonly statusCode=400){super(code);}}
export const askHash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time=z.string().datetime({offset:true});
export const askInputSchema=z.object({modelReference:z.object({kind:z.enum(['shared','personal']),id:z.string().min(1).max(256)}).strict().optional(),modelOverride:z.string().trim().min(1).max(512).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)).optional(),question:z.string().trim().min(1).max(8000),attachmentIds:z.array(z.string().uuid()).max(8).refine(ids=>new Set(ids).size===ids.length).optional(),conversationId:z.string().uuid().optional(),turnId:z.string().uuid().optional(),after:time.optional(),before:time.optional(),deviceId:z.string().min(1).max(128).optional(),timeZone:z.string().max(100).default('UTC'),language:z.enum(['zh-CN','en']).default('zh-CN')}).strict().refine(v=>!v.after||!v.before||Date.parse(v.after)<Date.parse(v.before),'Invalid time range');
export const insightInputSchema=askInputSchema.innerType().extend({question:z.string().trim().min(1).max(8000).optional(),prompt:z.string().trim().max(8000).optional()}).strict().refine(v=>!v.question||!v.prompt,'Choose one prompt').transform(({question,prompt,...value})=>askInputSchema.parse({...value,question:question||prompt||(value.language==='en'?'Review this period of personal context. Choose findings supported by evidence, distinguish facts, inferences and gaps, retain source citations and produce a complete personal-insight report and static HTML.':'请回顾这段时间的个人上下文，选择有证据支撑的发现。区分事实、推断与信息缺口，保留来源引用，用 personal-insight Skill 生成完整文字报告和静态 HTML 展示。')}));
export type AskInput=z.infer<typeof askInputSchema>;
export const askTaskSchema=z.object({runId:z.string().uuid(),generation:z.number().int().nonnegative(),fragment:z.number().int().nonnegative().optional(),unitId:z.string().min(1).max(128).optional(),mode:z.enum(['chat','insight','compact'])}).strict();
export type AskTask=z.infer<typeof askTaskSchema>;
export type AskSnapshot={at:string;materials:{id:string;revision:string}[];captures:{id:string;receipt:string}[];memories:{id:string;version:number;fingerprint:string}[]};
export type AskScope={sourceIds?:readonly string[];snapshot?:AskSnapshot;assertCurrent:()=>void};
export type EvidencePin={id:string;hash:string;receipt?:string;kind?:'measurement'|'history'|'attachment';headId?:string;source?:{id:string;incarnation:string}};
export type MaterialPin={id:string;revision:string;sources?:{id:string;incarnation:string}[];sourceContext?:{sourceId:string;version:number;fingerprint:string}};
export type AskRow={id:string;input:string;fingerprint:string;mode:'chat'|'insight'|'compact';status:string;generation:number;fragment:number;task_id:string|null;model:string;scope:string;context:string;conversation_revision:number;conversation_incarnation:string;pins:string;materials:string;memory_pins:string;events:string;workspace:string|null;request_bound:number;created_at:string;updated_at:string;result:string|null};
export function installAsk(db:DatabaseSync){
 db.exec('SAVEPOINT ma_schema_install');try{
 // Backfill is a one-time schema migration. Normal publication triggers keep
 // the journal current; repeating it would turn personal imports into new work.
 const initializeEvents=!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ma_auto_events'").get();
 db.function('ma_catalog_parent',{deterministic:true},catalogParent);db.exec(`
 CREATE TABLE IF NOT EXISTS ma_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),cursor_key TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ma_sources(user_id TEXT NOT NULL,id TEXT NOT NULL,incarnation TEXT NOT NULL,PRIMARY KEY(user_id,id));
 INSERT OR IGNORE INTO ma_sources SELECT user_id,id,lower(hex(randomblob(16))) FROM pd_sources;
 CREATE TRIGGER IF NOT EXISTS ma_source_created AFTER INSERT ON pd_sources BEGIN INSERT INTO ma_sources VALUES(new.user_id,new.id,lower(hex(randomblob(16)))) ON CONFLICT(user_id,id) DO UPDATE SET incarnation=excluded.incarnation; END;
 CREATE TRIGGER IF NOT EXISTS ma_source_deleted AFTER DELETE ON pd_sources BEGIN DELETE FROM ma_sources WHERE user_id=old.user_id AND id=old.id; END;
 CREATE TABLE IF NOT EXISTS ma_originals(user_id TEXT NOT NULL,id TEXT NOT NULL,incarnation TEXT NOT NULL,PRIMARY KEY(user_id,id));
 INSERT OR IGNORE INTO ma_originals SELECT user_id,id,lower(hex(randomblob(16))) FROM pd_captures;
 CREATE TRIGGER IF NOT EXISTS ma_original_created AFTER INSERT ON pd_captures BEGIN INSERT INTO ma_originals VALUES(new.user_id,new.id,lower(hex(randomblob(16)))) ON CONFLICT(user_id,id) DO UPDATE SET incarnation=excluded.incarnation; END;
 CREATE TRIGGER IF NOT EXISTS ma_original_deleted AFTER DELETE ON pd_captures BEGIN DELETE FROM ma_originals WHERE user_id=old.user_id AND id=old.id; END;
 CREATE TABLE IF NOT EXISTS ma_read_cursors(user_id TEXT NOT NULL,id TEXT NOT NULL,position TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ma_state(user_id TEXT PRIMARY KEY,deleted INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS ma_conversations(user_id TEXT NOT NULL,id TEXT NOT NULL,incarnation TEXT NOT NULL,scope TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,summary TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ma_turns(user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,pins TEXT NOT NULL,materials TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,id),UNIQUE(user_id,conversation_id,position),FOREIGN KEY(user_id,conversation_id) REFERENCES ma_conversations(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ma_runs(user_id TEXT NOT NULL,id TEXT NOT NULL,input TEXT NOT NULL,fingerprint TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,fragment INTEGER NOT NULL DEFAULT 0,task_id TEXT,model TEXT NOT NULL,scope TEXT NOT NULL,context TEXT NOT NULL,conversation_revision INTEGER NOT NULL,conversation_incarnation TEXT NOT NULL,pins TEXT NOT NULL DEFAULT '[]',materials TEXT NOT NULL DEFAULT '[]',memory_pins TEXT NOT NULL DEFAULT '[]',events TEXT NOT NULL DEFAULT '[]',workspace TEXT,request_bound INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result TEXT,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ma_fragments(user_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(user_id,run_id,id),FOREIGN KEY(user_id,run_id) REFERENCES ma_runs(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ma_units(user_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,input TEXT NOT NULL,task_id TEXT,PRIMARY KEY(user_id,run_id,id),FOREIGN KEY(user_id,run_id) REFERENCES ma_runs(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ma_artifacts(user_id TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,fragment_id TEXT NOT NULL,json TEXT NOT NULL,pins TEXT NOT NULL,materials TEXT NOT NULL,PRIMARY KEY(user_id,id),UNIQUE(user_id,run_id,fragment_id),FOREIGN KEY(user_id,run_id) REFERENCES ma_runs(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ma_traces(user_id TEXT NOT NULL,run_id TEXT NOT NULL,sequence INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,run_id,sequence),FOREIGN KEY(user_id,run_id) REFERENCES ma_runs(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ma_insight_snapshots(user_id TEXT NOT NULL,run_id TEXT NOT NULL,series_id TEXT NOT NULL,version INTEGER NOT NULL,manifest TEXT NOT NULL,json TEXT NOT NULL,memory_coverage TEXT NOT NULL,PRIMARY KEY(user_id,run_id),FOREIGN KEY(user_id,run_id) REFERENCES ma_runs(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ma_auto_restore(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
 CREATE TABLE IF NOT EXISTS ma_auto_state(user_id TEXT PRIMARY KEY,deleted INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS ma_automations(user_id TEXT NOT NULL,id TEXT NOT NULL,generation TEXT NOT NULL,state TEXT NOT NULL,input TEXT NOT NULL,settings TEXT NOT NULL,sources TEXT NOT NULL,task_id TEXT,cursor INTEGER NOT NULL,last_success INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ma_auto_events(user_id TEXT NOT NULL,seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,entity TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS ma_auto_event_owner ON ma_auto_events(user_id,kind,seq);
 CREATE TRIGGER IF NOT EXISTS ma_auto_material_insert AFTER INSERT ON pd_materials BEGIN INSERT INTO ma_auto_events(user_id,kind,entity) VALUES(new.user_id,'insights',new.id); END;
 CREATE TRIGGER IF NOT EXISTS ma_auto_material_update AFTER UPDATE ON pd_materials WHEN new.revision!=old.revision OR new.min_visible_sequence!=old.min_visible_sequence BEGIN INSERT INTO ma_auto_events(user_id,kind,entity) VALUES(new.user_id,'insights',new.id); END;
 CREATE TRIGGER IF NOT EXISTS ma_auto_turn AFTER INSERT ON ma_turns BEGIN INSERT INTO ma_auto_events(user_id,kind,entity) VALUES(new.user_id,'working',new.conversation_id); END;
 CREATE TABLE IF NOT EXISTS ma_auto_windows(user_id TEXT NOT NULL,id TEXT NOT NULL,policy_id TEXT NOT NULL,generation TEXT NOT NULL,state TEXT NOT NULL,through INTEGER NOT NULL,plan TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ma_auto_runs(user_id TEXT NOT NULL,run_id TEXT NOT NULL,window_id TEXT NOT NULL,policy_id TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(user_id,run_id));
 CREATE TABLE IF NOT EXISTS ma_restore(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
 `);if(initializeEvents)db.exec("INSERT INTO ma_auto_events(user_id,kind,entity) SELECT m.user_id,'insights',m.id FROM pd_materials m");db.prepare('INSERT OR IGNORE INTO ma_meta VALUES(1,?)').run(randomBytes(32).toString('hex'));const cursorKey=String(db.prepare('SELECT cursor_key FROM ma_meta WHERE singleton=1').get()!.cursor_key);db.exec('RELEASE ma_schema_install');return cursorKey;}catch(error){db.exec('ROLLBACK TO ma_schema_install;RELEASE ma_schema_install');throw error;}}

/** Host-only M05 validation, before a task context exists. Owner comes only from the engine's durable ownership record. */
export function persistedAskRun(db:DatabaseSync,userId:string,id:string){return db.prepare('SELECT * FROM ma_runs WHERE user_id=? AND id=?').get(userId,id) as AskRow|undefined;}
export function askUserDeleted(db:DatabaseSync,userId:string){return Boolean(db.prepare('SELECT 1 FROM ma_state WHERE user_id=? AND deleted=1').get(userId));}

export function persistedAutomationCurrent(db:DatabaseSync,userId:string,runId:string){const link=db.prepare('SELECT policy_id,generation FROM ma_auto_runs WHERE user_id=? AND run_id=?').get(userId,runId);return !link||Boolean(db.prepare("SELECT 1 FROM ma_automations a WHERE user_id=? AND id=? AND generation=? AND state='active' AND NOT EXISTS(SELECT 1 FROM ma_auto_state s WHERE s.user_id=a.user_id AND s.deleted=1)").get(userId,link.policy_id,link.generation));}


/** Read-only M08 admission predicate. The engine supplies the durable owner and
 * validates the root task before consulting this; no context or grant is minted.
 * Admit real coordination when a unit needs scheduling or a fragment can advance.
 */
export function persistedAskChildrenPending(db:DatabaseSync,userId:string,runId:string){
 const row=persistedAskRun(db,userId,runId);if(!row||askUserDeleted(db,userId))return false;
 // Waiting must not conceal an error that normal coordination would detect.
 // A stale conversation enters the existing execute/current failure path now,
 // even when a physical child is still held and has not produced another event.
 let conversationId:unknown;try{conversationId=JSON.parse(row.input).conversationId;}catch{return false;}
 if(typeof conversationId!=='string')return false;
 const conversation=db.prepare('SELECT scope,incarnation,revision FROM ma_conversations WHERE user_id=? AND id=?').get(userId,conversationId);
 if(!conversation||conversation.scope!==row.scope||conversation.incarnation!==row.conversation_incarnation||conversation.revision!==row.conversation_revision)return false;
 const units=db.prepare('SELECT u.id,u.task_id,e.state,f.id fragment FROM ma_units u LEFT JOIN execution_steps e ON e.user_id=u.user_id AND e.id=u.task_id LEFT JOIN ma_fragments f ON f.user_id=u.user_id AND f.run_id=u.run_id AND f.task_id=u.task_id WHERE u.user_id=? AND u.run_id=?').all(userId,runId);
 if(units.some(unit=>!unit.task_id||unit.state!=='succeeded'&&unit.fragment!=='unit:'+unit.id+':'+row.generation))return false;
 const fragment='main:'+row.generation+':'+row.fragment,step=db.prepare('SELECT e.state FROM ma_fragments f JOIN execution_steps e ON e.user_id=f.user_id AND e.id=f.task_id WHERE f.user_id=? AND f.run_id=? AND f.id=?').get(userId,runId,fragment);
 if(!step)return false;
 if(step.state==='waiting'||step.state==='running')return true;
 if(step.state!=='succeeded')return false;
 const artifact=db.prepare('SELECT json FROM ma_artifacts WHERE user_id=? AND run_id=? AND fragment_id=?').get(userId,runId,fragment);if(!artifact)return false;
 let result:{kind?:string;wait?:{unitIds:string[];mode:'any'|'all'}};try{result=JSON.parse(String(artifact.json));}catch{return false;}
 if(!result||result.kind!=='yield'||result.wait&&(!Array.isArray(result.wait.unitIds)||result.wait.unitIds.some(id=>typeof id!=='string')||!['any','all'].includes(result.wait.mode)))return false;
 const states=units.filter(unit=>!result.wait||result.wait.unitIds.includes(String(unit.id))).map(unit=>Boolean(unit.task_id)&&!['waiting','running'].includes(String(unit.state)));
 return states.length>0&&!(result.wait?.mode==='any'?states.some(Boolean):states.every(Boolean));
}
