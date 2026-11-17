import type {SchemaInstallation} from './schema-installation.js';

/** The existing authorization prepare boundary installs the switch and its
 * original-receipt state together. It activates no model or other owner. */
export const backgroundModelAuthorizationSchemaInstallation={
  owner:'background-model-authorization',requires:[],
  install(db){
    db.exec(`CREATE TABLE IF NOT EXISTS background_model_authorization(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,identity TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL,eligible INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_lineage(identity TEXT NOT NULL,original TEXT NOT NULL,PRIMARY KEY(identity,original));
      CREATE TABLE IF NOT EXISTS background_model_work(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_trigger_claims(original TEXT NOT NULL,purpose TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES background_model_work(id),PRIMARY KEY(original,purpose));
      CREATE TABLE IF NOT EXISTS background_model_step_authority(step_id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES background_model_work(id));`);
    if(!db.prepare('SELECT 1 FROM background_model_authorization WHERE id=1').get()){
      const json=JSON.stringify({revision:0,state:'off',excludedSourceIds:[]});
      db.prepare('INSERT INTO background_model_authorization VALUES(1,?)').run(json);
    }
  },
} as const satisfies SchemaInstallation;
