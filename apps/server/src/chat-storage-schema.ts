import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';
import {retireTaskRecordsSql} from './task-evidence.js';

// Each helper contains only its original DDL. The public consumer keeps its
// storage registration, private history repair and recovery outside installation.

class ConversationTurnStorage {
 constructor(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS conversation_turns(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,idx INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,json TEXT NOT NULL,PRIMARY KEY(conversation_id,idx));
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_client_request ON conversation_turns(json_extract(json,'$.clientRequestId')) WHERE json_extract(json,'$.clientRequestId') IS NOT NULL;`);}
}

export const conversationTurnsSchemaInstallation={
 owner:'conversation-turn-storage',requires:[],
 prerequisites:[{owner:'conversation',objects:[{type:'table',name:'conversations'}]}],
 install(db:DatabaseSync){new ConversationTurnStorage(db);},
} as const satisfies SchemaInstallation;

class QueryRunStorage {
 constructor(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS query_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL)');}
}

export const queryRunSchemaInstallation={
 owner:'query-run-storage',requires:[],
 install(db:DatabaseSync){new QueryRunStorage(db);},
} as const satisfies SchemaInstallation;

class AssistantTaskStorage {
 constructor(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS assistant_task_scopes(
   task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,scope_hash TEXT NOT NULL,snapshot_json TEXT);
   CREATE TABLE IF NOT EXISTS assistant_task_turns(
   task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,
   conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,scope_hash TEXT NOT NULL,draft_revision INTEGER NOT NULL,
   UNIQUE(conversation_id,turn_id,draft_revision));
   CREATE INDEX IF NOT EXISTS assistant_task_turns_turn ON assistant_task_turns(conversation_id,turn_id);
   CREATE TRIGGER IF NOT EXISTS assistant_task_scope_stale AFTER UPDATE OF state ON task_records WHEN new.state='stale' AND old.state!='stale' BEGIN
    UPDATE assistant_task_scopes SET snapshot_json=NULL WHERE task_id=new.id;
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_task_turn_deleted BEFORE DELETE ON conversation_turns BEGIN
    ${retireTaskRecordsSql('SELECT task_id FROM assistant_task_turns WHERE turn_id=old.id AND conversation_id=old.conversation_id')}
   END;`);}
}

export const assistantTaskStorageSchemaInstallation={
 owner:'assistant-task-storage',requires:[],
 prerequisites:[
  {owner:'task-records',objects:[{type:'table',name:'task_records'}]},
  {owner:'conversation-turn-storage',objects:[{type:'table',name:'conversation_turns'}]},
 ],
 install(db:DatabaseSync){new AssistantTaskStorage(db);},
} as const satisfies SchemaInstallation;
