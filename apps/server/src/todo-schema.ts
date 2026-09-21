import type {DatabaseSync} from 'node:sqlite';
export function ensureTodoSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS todos(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,request_hash TEXT NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS todos_page ON todos(status,created_at DESC,id DESC)');}
