import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

export const conversationSchemaInstallation={owner:'conversation',requires:[],install:conversationSchema} as const satisfies SchemaInstallation;

/** Conversation metadata is installed with the vault; turn history is installed by Conversations. */
export function conversationSchema(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at DESC,id DESC);
 CREATE TABLE IF NOT EXISTS conversation_retired_roots(id TEXT PRIMARY KEY,json TEXT NOT NULL,expires_at TEXT);
 CREATE TABLE IF NOT EXISTS conversation_retired_turn_roots(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,turn_id TEXT NOT NULL,evidence_id TEXT NOT NULL REFERENCES conversation_retired_roots(id) ON DELETE CASCADE,result_run_id TEXT NOT NULL,PRIMARY KEY(turn_id,evidence_id));
 CREATE INDEX IF NOT EXISTS conversation_retired_turn_roots_conversation ON conversation_retired_turn_roots(conversation_id);
`);}
