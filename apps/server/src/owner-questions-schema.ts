import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** The owner-question-services plugin owns the durable question ledger.
 * Cross-owner retirement triggers stay in the OwnerQuestions constructor at
 * their original conditional point because they depend on Capture/File/Material
 * tables and do not extend this domain's schema ownership. */
export const ownerQuestionsSchemaInstallation={
 owner:'owner-question-services',requires:[],
 install:ownerQuestionsSchema,
} as const satisfies SchemaInstallation;

function ownerQuestionsSchema(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS owner_questions(id TEXT PRIMARY KEY,identity TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS owner_questions_recent ON owner_questions(updated_at DESC,id DESC);
   CREATE TABLE IF NOT EXISTS owner_question_surfaces(watermark INTEGER PRIMARY KEY,questions TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS owner_question_dependencies(question_id TEXT NOT NULL REFERENCES owner_questions(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(question_id,evidence_id));
   CREATE INDEX IF NOT EXISTS owner_question_evidence ON owner_question_dependencies(evidence_id,question_id);
   CREATE TABLE IF NOT EXISTS owner_question_replies(question_id TEXT NOT NULL REFERENCES owner_questions(id) ON DELETE CASCADE,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,PRIMARY KEY(question_id,request_id));`);
}
