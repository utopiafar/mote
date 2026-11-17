/** Only production installers already registered on main belong here. Add an
 * installer after its domain registration lands, then remove its uncovered debt. */
export const installations={
 'vault-schema.ts':['vaultSchemaInstallation'],
 'capture-schema.ts':['captureSchemaInstallation','captureProjectionSchemaInstallation'],
 'perception-schema.ts':['perceptionSchemaInstallation'],
 'source-schema.ts':['sourceSchemaInstallation'],
 'file-schema.ts':['fileSchemaInstallation'],
 'memory-storage-schema.ts':['memoryStorageSchemaInstallation'],
 'conversation-schema.ts':['conversationSchemaInstallation'],
 'insight-schema.ts':['insightSchemaInstallation'],
 'todo-schema.ts':['todoSchemaInstallation'],
 'read-models.ts':['captureReadModelsSchemaInstallation'],
 'source-catalog.ts':['sourceCatalogSchemaInstallation'],
 'material-schema.ts':['materialSchemaInstallation'],
 'material-catalog.ts':['materialCatalogSchemaInstallation'],
 'execution-schema.ts':['executionSchemaInstallation'],
 'operation-projection.ts':['operationProjectionSchemaInstallation'],
 'task-records.ts':['taskRecordsSchemaInstallation'],
 'task-evidence.ts':['taskEvidenceSchemaInstallation'],
 'run-execution.ts':['runExecutionSchemaInstallation'],
 'memory-search-schema.ts':['memorySearchSchemaInstallation'],
 'connectors/gmail-state.ts':['gmailStateSchemaInstallation'],
 'connectors/lark-state.ts':['larkStateSchemaInstallation'],
 'connectors/mcp-import-state.ts':['mcpStateSchemaInstallation'],
 'connectors/recording-state.ts':['recordingMediaSchemaInstallation','recordingSyncSchemaInstallation'],
};

/** Exact consumer boundaries, reviewed against the existing modules. An installer
 * has its declared owner inside its function; other functions use this mapping.
 * A new file never inherits access merely from a filename prefix or directory. */
export const consumers={
 'evidence-store.ts':'capture',
 'capture-browser.ts':'capture',
 'capture-context.ts':'capture',
 'capture-timeline.ts':'capture',
 'capture-raw-reader.ts':'capture',
 'capture-session-members.ts':'capture',
 'capture-library-version.ts':'capture',
 'capture-memory-source.ts':'capture',
 'capture-admission.ts':'capture',
 'capture-memory-intake.ts':'capture',
 'sources.ts':'source',
 'source-archive-reader.ts':'source',
 'source-catalog.ts':'source-catalog',
 'source-context-lineage.ts':'source',
 'source-context.ts':'source',
 'source-context-catalog.ts':'source',
 'source-context-contract.ts':'source',
 'source-material-view.ts':'source',
 'file-processing.ts':'file',
 'file-observations.ts':'file',
 'file-transcript-chunks.ts':'file',
 'file-raw-reader.ts':'file',
 'file-reviews.ts':'file',
 'file-evidence.ts':'file',
 'file-attachments.ts':'file',
 'material-catalog.ts':'material-catalog',
 'materials.ts':'material',
 'material-index.ts':'material',
 'material-portable.ts':'material',
 'material-source-pin.ts':'material',
 'material-derivation.ts':'material',
 'material-readiness.ts':'material',
 'material-note-deletion.ts':'material',
 'material-memory-work.ts':'material',
 'material-consumers.ts':'material',
 'material-organizers.ts':'material',
};

/** Narrow shared reads: exact consumer + SQL fingerprint + table. Never a write
 * grant or a whole-file/table exemption. Stale grants fail just like debt. */
export const sharedReads=[
 {
  "from": "apps/server/src/material-catalog.ts",
  "to": "material_heads",
  "symbol": "4822a99ad71da94dc831a3ecb69992ad5d9315e7a738ea853cf2da0b182d9853",
  "reason": "Library catalog source facets project visible Material head counts and source labels; bounded metadata read in MaterialCatalog.list."
 },
 {
  "from": "apps/server/src/material-catalog.ts",
  "to": "source_connections",
  "symbol": "4822a99ad71da94dc831a3ecb69992ad5d9315e7a738ea853cf2da0b182d9853",
  "reason": "Library catalog source facets project visible Material head counts and source labels; bounded metadata read in MaterialCatalog.list."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "0dd485591e5f9ab69267a5b17b73abfab96438447b67eef56107a8ebe57db5eb",
  "reason": "Repair only Activity coverage/rank projections from Memory batch state."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "1af176b3d1b24b54d4928b2d6542e58f5373a1b7f5d18f0da337441961e0b03d",
  "reason": "Replay a saved Memory batch into its Activity batch projection."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "26f9ad74ffc22a4977bbf27e0552242bfca13f5cbb6e36ef91a1994842791721",
  "reason": "Activity TEMP subscriptions observe Memory products and read their metadata to maintain only Activity-owned projection rows."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "35fa3ed42683077a8781ba1ed5646932b565a7a0f6d6aecc29c1e4b676303138",
  "reason": "Read Memory batch output IDs into the Activity output projection."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "3f19bf5d9ec3fafe510c67c75266d14949f05f55c0f26ed0dd008dbbb128a909",
  "reason": "Read saved Memory batch coverage into the Activity coverage projection."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "51c299f6f9a006ba9928dcc8c3f4991e2b83584849157eccb6889e78d6ad0ec5",
  "reason": "Rebuild disposable Activity job, source, output and coverage projections from current Memory products when Activity is selected again."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "721530689f27f4d1e536ce099dbae37a620874f8b5d20fcf4ad7e8092d3dbf9a",
  "reason": "Restore Activity output IDs from Memory batch metadata."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "daa1d44278d93125cae3f97edd3a13bcd65c7c8250da20a49920027b6759bd32",
  "reason": "Find saved Memory handoff parent batches for Activity projection replay."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_jobs",
  "symbol": "26f9ad74ffc22a4977bbf27e0552242bfca13f5cbb6e36ef91a1994842791721",
  "reason": "Activity TEMP subscriptions observe Memory products and read their metadata to maintain only Activity-owned projection rows."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_jobs",
  "symbol": "3a6c6709c1aada94565816689a2ede1118817c3fa108805c4c99bbd3fd9c1338",
  "reason": "Enumerate Memory jobs to rebuild Activity evidence-item projections."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_jobs",
  "symbol": "516012d09ef9342dd0668b496043cd022d0b1b5c05edb95d0c19227848c2856d",
  "reason": "Read saved parent and child Memory pins to reconcile Activity item-key ancestry."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_jobs",
  "symbol": "51c299f6f9a006ba9928dcc8c3f4991e2b83584849157eccb6889e78d6ad0ec5",
  "reason": "Rebuild disposable Activity job, source, output and coverage projections from current Memory products when Activity is selected again."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_jobs",
  "symbol": "94a76eba43422923886f2ea47393f610cdb410fd4e7a85532618ac9088db35a7",
  "reason": "Rebuild Activity evidence-item identities from Memory job metadata."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_jobs",
  "symbol": "96d20cfae87779bf953be5a0a39aa944957e222328cfe77d22001c9a90795be1",
  "reason": "Read saved Memory continuation ancestry into the Activity continuation projection."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_jobs",
  "symbol": "9d650abd5603d386b6ad46d88111371ea740d0f5256aaee18fa31c1f23e99e71",
  "reason": "Read Memory job output IDs into the Activity output projection."
 }
];

/** Activity's already formal feature owns only this disposable projection
 * construction and subscription retirement. This is a projection claim, separate from schema installation. */
export const projections=[{
 owner:'activity-memory-projection',file:'activity-memory-index.ts',scope:'ActivityMemoryIndex.constructor',
 lifecycleScopes:['retireActivityMemorySubscriptions'],
 activationFile:'plugins/activity-services.ts',activation:'activityServicesPlugin',feature:'mote.activity',
}];
export const sharedObservations=[
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_batches",
  "symbol": "26f9ad74ffc22a4977bbf27e0552242bfca13f5cbb6e36ef91a1994842791721",
  "reason": "Activity TEMP subscriptions observe Memory products and read their metadata to maintain only Activity-owned projection rows."
 },
 {
  "from": "apps/server/src/activity-memory-index.ts",
  "to": "memory_jobs",
  "symbol": "26f9ad74ffc22a4977bbf27e0552242bfca13f5cbb6e36ef91a1994842791721",
  "reason": "Activity TEMP subscriptions observe Memory products and read their metadata to maintain only Activity-owned projection rows."
 }
];

/** Only these formally registered installers use the bounded schema helper proof. */
export const finiteInstallations=['executionSchemaInstallation','operationProjectionSchemaInstallation','taskRecordsSchemaInstallation','taskEvidenceSchemaInstallation','runExecutionSchemaInstallation','memorySearchSchemaInstallation','gmailStateSchemaInstallation','larkStateSchemaInstallation','mcpStateSchemaInstallation','recordingMediaSchemaInstallation','recordingSyncSchemaInstallation'];
export const schemaMaintenance=[
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_operation_steps",
  "kind": "delete",
  "symbol": "7ee1a857f28f48398a31521f47acf88051b7b7de48e55d58f31f52380bcb066a",
  "statementFingerprint": "6ba8410f785db2942b3f82add992bb9a3ff381c71fef448247bd707b36666673",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema"
  ],
  "sourceRelations": [
   "execution_operation_steps",
   "execution_steps",
   "memories",
   "operation_changes",
   "operation_progress"
  ],
  "reason": "Remove operation membership when the canonical execution step is deleted."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_operation_steps",
  "kind": "delete",
  "symbol": "81383a42317ad4d45d30029b78314e1db5a0de6646eef633aaa060f0d6f0a767",
  "statementFingerprint": "482769e2f9100b16389a08ced976a4e1e8bf85a9f1c99c4ce1110c98a43ce514",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema",
   "installOperationHierarchy"
  ],
  "sourceRelations": [
   "execution_operation_steps"
  ],
  "reason": "Keep parent operation membership synchronized with child insertion, membership changes and deletion; execution state is not copied."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_operation_steps",
  "kind": "index",
  "symbol": "7ee1a857f28f48398a31521f47acf88051b7b7de48e55d58f31f52380bcb066a",
  "statementFingerprint": "6ba8410f785db2942b3f82add992bb9a3ff381c71fef448247bd707b36666673",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema"
  ],
  "sourceRelations": [
   "execution_operation_steps",
   "execution_steps",
   "memories",
   "operation_changes",
   "operation_progress"
  ],
  "reason": "Index operation membership generation for current-definition progress projection."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_operation_steps",
  "kind": "insert",
  "symbol": "81383a42317ad4d45d30029b78314e1db5a0de6646eef633aaa060f0d6f0a767",
  "statementFingerprint": "482769e2f9100b16389a08ced976a4e1e8bf85a9f1c99c4ce1110c98a43ce514",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema",
   "installOperationHierarchy"
  ],
  "sourceRelations": [
   "execution_operation_steps"
  ],
  "reason": "Keep parent operation membership synchronized with child insertion, membership changes and deletion; execution state is not copied."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_operation_steps",
  "kind": "observe",
  "symbol": "7ee1a857f28f48398a31521f47acf88051b7b7de48e55d58f31f52380bcb066a",
  "statementFingerprint": "6ba8410f785db2942b3f82add992bb9a3ff381c71fef448247bd707b36666673",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema"
  ],
  "sourceRelations": [
   "execution_operation_steps",
   "execution_steps",
   "memories",
   "operation_changes",
   "operation_progress"
  ],
  "reason": "Observe execution state/membership and read their metadata to maintain current operation progress and change receipts."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_operation_steps",
  "kind": "observe",
  "symbol": "81383a42317ad4d45d30029b78314e1db5a0de6646eef633aaa060f0d6f0a767",
  "statementFingerprint": "482769e2f9100b16389a08ced976a4e1e8bf85a9f1c99c4ce1110c98a43ce514",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema",
   "installOperationHierarchy"
  ],
  "sourceRelations": [
   "execution_operation_steps"
  ],
  "reason": "Keep parent operation membership synchronized with child insertion, membership changes and deletion; execution state is not copied."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_operation_steps",
  "kind": "read",
  "symbol": "7ee1a857f28f48398a31521f47acf88051b7b7de48e55d58f31f52380bcb066a",
  "statementFingerprint": "6ba8410f785db2942b3f82add992bb9a3ff381c71fef448247bd707b36666673",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema"
  ],
  "sourceRelations": [
   "execution_operation_steps",
   "execution_steps",
   "memories",
   "operation_changes",
   "operation_progress"
  ],
  "reason": "Observe execution state/membership and read their metadata to maintain current operation progress and change receipts."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_operation_steps",
  "kind": "update",
  "symbol": "81383a42317ad4d45d30029b78314e1db5a0de6646eef633aaa060f0d6f0a767",
  "statementFingerprint": "482769e2f9100b16389a08ced976a4e1e8bf85a9f1c99c4ce1110c98a43ce514",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema",
   "installOperationHierarchy"
  ],
  "sourceRelations": [
   "execution_operation_steps"
  ],
  "reason": "Keep parent operation membership synchronized with child insertion, membership changes and deletion; execution state is not copied."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_steps",
  "kind": "observe",
  "symbol": "7ee1a857f28f48398a31521f47acf88051b7b7de48e55d58f31f52380bcb066a",
  "statementFingerprint": "6ba8410f785db2942b3f82add992bb9a3ff381c71fef448247bd707b36666673",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema"
  ],
  "sourceRelations": [
   "execution_operation_steps",
   "execution_steps",
   "memories",
   "operation_changes",
   "operation_progress"
  ],
  "reason": "Observe execution state/membership and read their metadata to maintain current operation progress and change receipts."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "7ee1a857f28f48398a31521f47acf88051b7b7de48e55d58f31f52380bcb066a",
  "statementFingerprint": "6ba8410f785db2942b3f82add992bb9a3ff381c71fef448247bd707b36666673",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema"
  ],
  "sourceRelations": [
   "execution_operation_steps",
   "execution_steps",
   "memories",
   "operation_changes",
   "operation_progress"
  ],
  "reason": "Observe execution state/membership and read their metadata to maintain current operation progress and change receipts."
 },
 {
  "from": "apps/server/src/operation-projection.ts",
  "to": "memories",
  "kind": "observe",
  "symbol": "7ee1a857f28f48398a31521f47acf88051b7b7de48e55d58f31f52380bcb066a",
  "statementFingerprint": "6ba8410f785db2942b3f82add992bb9a3ff381c71fef448247bd707b36666673",
  "installer": "operationProjectionSchemaInstallation",
  "callPath": [
   "operationProjectionSchemaInstallation",
   "operationProjectionSchema"
  ],
  "sourceRelations": [
   "execution_operation_steps",
   "execution_steps",
   "memories",
   "operation_changes",
   "operation_progress"
  ],
  "reason": "Publish an operation-change receipt when canonical Memory products change or are removed."
 },
 {
  "from": "apps/server/src/task-evidence.ts",
  "to": "captures",
  "kind": "observe",
  "symbol": "f4722e6e57f6ce1bc220f37bf14d34810e34ff2461902ca030db8546929f9b14",
  "statementFingerprint": "9cf6a1d5e29d6eb38630e8f949f6ea328bd5bfe4ea59a5c2b42790880c14660f",
  "installer": "taskEvidenceSchemaInstallation",
  "callPath": [
   "taskEvidenceSchemaInstallation",
   "taskEvidenceSchema"
  ],
  "sourceRelations": [
   "captures"
  ],
  "reason": "Persist deletion protection on captures; erasure executes in the same maintenance/forget transaction."
 },
 {
  "from": "apps/server/src/task-evidence.ts",
  "to": "context_artifacts",
  "kind": "observe",
  "symbol": "b8f4b6f5817e41074c19062c72e616955ce5225a33d4099b035b8cb7e425c581",
  "statementFingerprint": "9cf6a1d5e29d6eb38630e8f949f6ea328bd5bfe4ea59a5c2b42790880c14660f",
  "installer": "taskEvidenceSchemaInstallation",
  "callPath": [
   "taskEvidenceSchemaInstallation",
   "taskEvidenceSchema"
  ],
  "sourceRelations": [
   "context_artifacts"
  ],
  "reason": "Persist deletion protection on context_artifacts; erasure executes in the same maintenance/forget transaction."
 },
 {
  "from": "apps/server/src/task-evidence.ts",
  "to": "file_chunks",
  "kind": "observe",
  "symbol": "341b43635c36cd360c33363b6cfcc532f31b6470fa1cd5afe12e6bbccaddf567",
  "statementFingerprint": "9cf6a1d5e29d6eb38630e8f949f6ea328bd5bfe4ea59a5c2b42790880c14660f",
  "installer": "taskEvidenceSchemaInstallation",
  "callPath": [
   "taskEvidenceSchemaInstallation",
   "taskEvidenceSchema"
  ],
  "sourceRelations": [
   "file_chunks"
  ],
  "reason": "Persist deletion protection on file_chunks; erasure executes in the same maintenance/forget transaction."
 },
 {
  "from": "apps/server/src/task-evidence.ts",
  "to": "memories",
  "kind": "observe",
  "symbol": "f354f147a2622cf2e70af8d11ba9acd715ae32faa5adbfc3ea5d68d7cb1753b6",
  "statementFingerprint": "9cf6a1d5e29d6eb38630e8f949f6ea328bd5bfe4ea59a5c2b42790880c14660f",
  "installer": "taskEvidenceSchemaInstallation",
  "callPath": [
   "taskEvidenceSchemaInstallation",
   "taskEvidenceSchema"
  ],
  "sourceRelations": [
   "memories"
  ],
  "reason": "Persist deletion protection on memories; erasure executes in the same maintenance/forget transaction."
 },
 {
  "from": "apps/server/src/task-evidence.ts",
  "to": "task_records",
  "kind": "update",
  "symbol": "341b43635c36cd360c33363b6cfcc532f31b6470fa1cd5afe12e6bbccaddf567",
  "statementFingerprint": "9cf6a1d5e29d6eb38630e8f949f6ea328bd5bfe4ea59a5c2b42790880c14660f",
  "installer": "taskEvidenceSchemaInstallation",
  "callPath": [
   "taskEvidenceSchemaInstallation",
   "taskEvidenceSchema"
  ],
  "sourceRelations": [
   "file_chunks"
  ],
  "reason": "Invalidate dependent TaskRecords, increment revision and erase private input/result bodies when their original evidence is deleted."
 },
 {
  "from": "apps/server/src/task-evidence.ts",
  "to": "task_records",
  "kind": "update",
  "symbol": "b8f4b6f5817e41074c19062c72e616955ce5225a33d4099b035b8cb7e425c581",
  "statementFingerprint": "9cf6a1d5e29d6eb38630e8f949f6ea328bd5bfe4ea59a5c2b42790880c14660f",
  "installer": "taskEvidenceSchemaInstallation",
  "callPath": [
   "taskEvidenceSchemaInstallation",
   "taskEvidenceSchema"
  ],
  "sourceRelations": [
   "context_artifacts"
  ],
  "reason": "Invalidate dependent TaskRecords, increment revision and erase private input/result bodies when their original evidence is deleted."
 },
 {
  "from": "apps/server/src/task-evidence.ts",
  "to": "task_records",
  "kind": "update",
  "symbol": "f354f147a2622cf2e70af8d11ba9acd715ae32faa5adbfc3ea5d68d7cb1753b6",
  "statementFingerprint": "9cf6a1d5e29d6eb38630e8f949f6ea328bd5bfe4ea59a5c2b42790880c14660f",
  "installer": "taskEvidenceSchemaInstallation",
  "callPath": [
   "taskEvidenceSchemaInstallation",
   "taskEvidenceSchema"
  ],
  "sourceRelations": [
   "memories"
  ],
  "reason": "Invalidate dependent TaskRecords, increment revision and erase private input/result bodies when their original evidence is deleted."
 },
 {
  "from": "apps/server/src/task-evidence.ts",
  "to": "task_records",
  "kind": "update",
  "symbol": "f4722e6e57f6ce1bc220f37bf14d34810e34ff2461902ca030db8546929f9b14",
  "statementFingerprint": "9cf6a1d5e29d6eb38630e8f949f6ea328bd5bfe4ea59a5c2b42790880c14660f",
  "installer": "taskEvidenceSchemaInstallation",
  "callPath": [
   "taskEvidenceSchemaInstallation",
   "taskEvidenceSchema"
  ],
  "sourceRelations": [
   "captures"
  ],
  "reason": "Invalidate dependent TaskRecords, increment revision and erase private input/result bodies when their original evidence is deleted."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "captures",
  "kind": "observe",
  "symbol": "fb83ede99d3d77a241d253238f06890e0bf3f5ac8e325692e7568d4c1d5cc878",
  "statementFingerprint": "8d1f489fbe76ea558541b80cbc2c5066b5b3cecd44d488b754bc4b5a829f16c7",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryCatalog"
  ],
  "sourceRelations": [
   "captures",
   "memories"
  ],
  "reason": "Maintain Memory search/catalog projections and evidence-validity subscriptions from canonical Memory and original capture events."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "memories",
  "kind": "delete",
  "symbol": "fb83ede99d3d77a241d253238f06890e0bf3f5ac8e325692e7568d4c1d5cc878",
  "statementFingerprint": "8d1f489fbe76ea558541b80cbc2c5066b5b3cecd44d488b754bc4b5a829f16c7",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryCatalog"
  ],
  "sourceRelations": [
   "captures",
   "memories"
  ],
  "reason": "Delete dependent canonical Memories on original capture removal unless the exact released-original fingerprint is retained."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "memories",
  "kind": "index",
  "symbol": "ba7919c0a92ab9483b7df3cdf46d69cb71fa9c32be6d60f448eb1493bf60fb2d",
  "statementFingerprint": "c144ec51fe340e0bd0985f41da25828195c510cde67cbe1eb21713f7c0bb7914",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryIndex"
  ],
  "sourceRelations": [
   "memories"
  ],
  "reason": "Index canonical Memory context priority for the existing search projection."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "memories",
  "kind": "observe",
  "symbol": "ba7919c0a92ab9483b7df3cdf46d69cb71fa9c32be6d60f448eb1493bf60fb2d",
  "statementFingerprint": "c144ec51fe340e0bd0985f41da25828195c510cde67cbe1eb21713f7c0bb7914",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryIndex"
  ],
  "sourceRelations": [
   "memories"
  ],
  "reason": "Maintain Memory search/catalog projections and evidence-validity subscriptions from canonical Memory and original capture events."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "memories",
  "kind": "observe",
  "symbol": "fb83ede99d3d77a241d253238f06890e0bf3f5ac8e325692e7568d4c1d5cc878",
  "statementFingerprint": "8d1f489fbe76ea558541b80cbc2c5066b5b3cecd44d488b754bc4b5a829f16c7",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryCatalog"
  ],
  "sourceRelations": [
   "captures",
   "memories"
  ],
  "reason": "Maintain Memory search/catalog projections and evidence-validity subscriptions from canonical Memory and original capture events."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "memories",
  "kind": "update",
  "symbol": "fb83ede99d3d77a241d253238f06890e0bf3f5ac8e325692e7568d4c1d5cc878",
  "statementFingerprint": "8d1f489fbe76ea558541b80cbc2c5066b5b3cecd44d488b754bc4b5a829f16c7",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryCatalog"
  ],
  "sourceRelations": [
   "captures",
   "memories"
  ],
  "reason": "Mark canonical Memories stale when their original capture JSON changes."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "memory_dependencies",
  "kind": "read",
  "symbol": "fb83ede99d3d77a241d253238f06890e0bf3f5ac8e325692e7568d4c1d5cc878",
  "statementFingerprint": "8d1f489fbe76ea558541b80cbc2c5066b5b3cecd44d488b754bc4b5a829f16c7",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryCatalog"
  ],
  "sourceRelations": [
   "captures",
   "memories"
  ],
  "reason": "Read canonical Memory dependencies to identify Memories affected by an original evidence edit or deletion."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "memory_provider_evidence_revocations",
  "kind": "read",
  "symbol": "fb83ede99d3d77a241d253238f06890e0bf3f5ac8e325692e7568d4c1d5cc878",
  "statementFingerprint": "8d1f489fbe76ea558541b80cbc2c5066b5b3cecd44d488b754bc4b5a829f16c7",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryCatalog"
  ],
  "sourceRelations": [
   "captures",
   "memories"
  ],
  "reason": "Read released-original fingerprint guards so original deletion preserves the explicitly retained Memory revision."
 },
 {
  "from": "apps/server/src/memory-search-schema.ts",
  "to": "memory_provider_evidence_revocations",
  "kind": "update",
  "symbol": "ba7919c0a92ab9483b7df3cdf46d69cb71fa9c32be6d60f448eb1493bf60fb2d",
  "statementFingerprint": "c144ec51fe340e0bd0985f41da25828195c510cde67cbe1eb21713f7c0bb7914",
  "installer": "memorySearchSchemaInstallation",
  "callPath": [
   "memorySearchSchemaInstallation",
   "memorySearchSchemaInstallation.install",
   "memoryIndex"
  ],
  "sourceRelations": [
   "memories"
  ],
  "reason": "When a canonical Memory is deleted, remove only its saved released-original fingerprint from revocation metadata."
 }
];

/** Scope witnesses preserve existing unresolved access debt when its table owner becomes known. They are not grants. */
export const retainedClassificationScopes=[
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_operation_steps",
  "kind": "read",
  "symbol": "03b7dbe53e65a1d1c504e26bcd4c1ffd8fdb50a20b38f1eb2adac1a8d7e251f9",
  "scope": "FileProcessing.reconcileSummaryMembership",
  "scopeFingerprint": "78ab0673fd68dc61dd920be7407865c0d28d517801e5fa299e52f22b1d48de11",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_operation_steps",
  "kind": "read",
  "symbol": "94b17078e6cfdd68d8c2f040db1130b676ca86462ae31e7782c2ec570f504254",
  "scope": "FileProcessing.retry",
  "scopeFingerprint": "08ac69cdfeb170c931677a70f41a4e32154d9e6ab1c438a6d4b226d24d5b92cf",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_operation_steps",
  "kind": "read",
  "symbol": "a950db2edd5c43a7cc50b77c72eb3e8fc29a1a185db0885e86d6f7c6f4f1ea6f",
  "scope": "FileProcessing.prepare",
  "scopeFingerprint": "3aa34b2feb615317bb057812cd9b401ab23c0071307e35ac4738e7847e0a2c73",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_operation_steps",
  "kind": "read",
  "symbol": "deaeeb01fe813ca41668e997031e08331959b9334922a0d0303939f83c46a351",
  "scope": "FileProcessing.retry",
  "scopeFingerprint": "08ac69cdfeb170c931677a70f41a4e32154d9e6ab1c438a6d4b226d24d5b92cf",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_operation_steps",
  "kind": "write",
  "symbol": "395581133733dc3a8584136726703f864772d287171a72927cc2b3976db41507",
  "scope": "FileProcessing.reconcileSummaryMembership",
  "scopeFingerprint": "78ab0673fd68dc61dd920be7407865c0d28d517801e5fa299e52f22b1d48de11",
  "operation": "update",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "03b7dbe53e65a1d1c504e26bcd4c1ffd8fdb50a20b38f1eb2adac1a8d7e251f9",
  "scope": "FileProcessing.reconcileSummaryMembership",
  "scopeFingerprint": "78ab0673fd68dc61dd920be7407865c0d28d517801e5fa299e52f22b1d48de11",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "1178f226c6f21b04671437471c7e1ace421a50abe92ecacd13ffdb0d1e985e56",
  "scope": "FileProcessing.invalidateSourceContext",
  "scopeFingerprint": "b4845f723d561beebe32c7e2b0ab58f6f82904f512a438fc66a0a06ef9197a72",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "6b06751838687fffdf4bfb830ba5353ba8dfb7a991635826e1f146f11798e134",
  "scope": "FileProcessing.cancel",
  "scopeFingerprint": "fd608092b3ee3cfc9ed4a57d3b2d909ee43dc3d3b73a35752c61b48909da8b6c",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "7e49947ed54d590ed5c61521c82bc5f64f44d43ddedcfe07b4a5cebd89124899",
  "scope": "FileProcessing.step",
  "scopeFingerprint": "4ee5bb5eb61d6d5cded6bb355efcd64b525bba2ebf1c81d28fe633b7b8192d48",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "94b17078e6cfdd68d8c2f040db1130b676ca86462ae31e7782c2ec570f504254",
  "scope": "FileProcessing.retry",
  "scopeFingerprint": "08ac69cdfeb170c931677a70f41a4e32154d9e6ab1c438a6d4b226d24d5b92cf",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "a561a2703b452cd2cd23299923d4d9aade03e094e26cbc0714bac31eefb43f1a",
  "scope": "FileProcessing.requeueChanged",
  "scopeFingerprint": "b5583493ad63e8cd1c0d94611b63f4dc022274e30c7fe98ab9f68e3067a0bb3b",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "a950db2edd5c43a7cc50b77c72eb3e8fc29a1a185db0885e86d6f7c6f4f1ea6f",
  "scope": "FileProcessing.prepare",
  "scopeFingerprint": "3aa34b2feb615317bb057812cd9b401ab23c0071307e35ac4738e7847e0a2c73",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "deaeeb01fe813ca41668e997031e08331959b9334922a0d0303939f83c46a351",
  "scope": "FileProcessing.retry",
  "scopeFingerprint": "08ac69cdfeb170c931677a70f41a4e32154d9e6ab1c438a6d4b226d24d5b92cf",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "f70b089f7d1376c6cb2459abffb3285923711301766413b9a003749c4d07274c",
  "scope": "FileProcessing.reconcileConfigurations",
  "scopeFingerprint": "dcebaec1b7f20bb52b50c8601c1987ea3e4721e738543c07b5c7fcb74db249f3",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "f8c8aad9a8269243922732bc0645f44caec81c2f681f38f0888a7c090cdca576",
  "scope": "FileProcessing.invalidateSourceContext",
  "scopeFingerprint": "b4845f723d561beebe32c7e2b0ab58f6f82904f512a438fc66a0a06ef9197a72",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "task_evidence",
  "kind": "read",
  "symbol": "a7e6475d5f2c2512becc2e527320e72af0af2b700afa3197b8d8d29f942dd6ba",
  "scope": "FileProcessing.completedReprocess",
  "scopeFingerprint": "da701e23886fc063a8e052a3f3d7a72ad7caf9acf9e39e5fe2d2d7f6c74acde3",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "task_records",
  "kind": "read",
  "symbol": "64d9b92a69ebc80feac5556fca0ffc947029275c1186ed572d8b32399003445a",
  "scope": "FileProcessing.cancelPreview",
  "scopeFingerprint": "c04674e4f2adc76ff3aebe2b625263bc81656d15e5aa7539b804932d23457e3e",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/file-processing.ts",
  "to": "task_records",
  "kind": "read",
  "symbol": "76ea1782c7280ef3811da1418aac3419d0c4db7fed39c1dc116683723bf0ac59",
  "scope": "FileProcessing.completedReprocess",
  "scopeFingerprint": "da701e23886fc063a8e052a3f3d7a72ad7caf9acf9e39e5fe2d2d7f6c74acde3",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/material-organizers.ts",
  "to": "execution_dependencies",
  "kind": "read",
  "symbol": "38a49e699f33478e6ca5487b349a9c9b84b3eeec45a713bed739ed8897323d36",
  "scope": "MaterialOrganizerRuntime.retryReadyRetirements",
  "scopeFingerprint": "5d9186e9137c184aa998ed7b118624c99c923f09e0a862068dc5e85b80c61a37",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/material-organizers.ts",
  "to": "execution_operation_steps",
  "kind": "read",
  "symbol": "d389ca025bf469752478909e84b6e40e4f76d794bc6dd40d0adde2f7e7895d35",
  "scope": "MaterialOrganizerRuntime.status",
  "scopeFingerprint": "72d120039f2945c48a51ba055a8da0c9e06526c33fdee1bf50658d7ff85ba00b",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/material-organizers.ts",
  "to": "execution_operation_steps",
  "kind": "write",
  "symbol": "40c34a5fb515d5f10a0c94f910efca60947d83617da48a20031f14125e05abd4",
  "scope": "MaterialOrganizerRuntime.reconcileOperationGenerations",
  "scopeFingerprint": "6e9e417f063430c43a0ed356e9d89d57cd9598f19d868c56cbe0a68841447cb7",
  "operation": "update",
  "completeSql": true
 },
 {
  "from": "apps/server/src/material-organizers.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "38a49e699f33478e6ca5487b349a9c9b84b3eeec45a713bed739ed8897323d36",
  "scope": "MaterialOrganizerRuntime.retryReadyRetirements",
  "scopeFingerprint": "5d9186e9137c184aa998ed7b118624c99c923f09e0a862068dc5e85b80c61a37",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/material-organizers.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "3f36a1e4015290876cc813af5504a5bf6f78dc5d3f46ccdfdd2b5de1c737d9d4",
  "scope": "MaterialOrganizerRuntime.drainAccepted",
  "scopeFingerprint": "762af11d1b38f7c7bedeb18921828c0e76d1e2ded72771b0de7818ea1a9c6ecf",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/material-organizers.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "6c2b67b68305e5f8cb5672e2a487bad87d462af119d9ac10681815d218a27203",
  "scope": "MaterialOrganizerRuntime.tick",
  "scopeFingerprint": "3fe116023a77f61aec64351cd43be29e88a170a0876aeec6e5fab7d60ff205ff",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/material-organizers.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "8929c9f77b8c57416f0ce8089be54c02741a32a8e09deaaa06b7503170109eab",
  "scope": "MaterialOrganizerRuntime.repairStale",
  "scopeFingerprint": "ee180a846a41ff388e85dddd7f19bb3966c2369f7a4d649bb99e6aec3989323e",
  "operation": "read",
  "completeSql": true
 },
 {
  "from": "apps/server/src/material-organizers.ts",
  "to": "execution_steps",
  "kind": "read",
  "symbol": "d389ca025bf469752478909e84b6e40e4f76d794bc6dd40d0adde2f7e7895d35",
  "scope": "MaterialOrganizerRuntime.status",
  "scopeFingerprint": "72d120039f2945c48a51ba055a8da0c9e06526c33fdee1bf50658d7ff85ba00b",
  "operation": "read",
  "completeSql": true
 }
];

/** Exact declared non-SQL lifecycle callback; this is not a table-access grant. */
export const nonSqlCalls=[
 {
  "from": "apps/server/src/config-service.ts",
  "scope": "ConfigService.registerPlugin",
  "receiver": "entry",
  "method": "prepare",
  "entryType": "RegisteredDomain",
  "registrationType": "ConfigDomainRegistration",
  "resultType": "PreparedConfigChange",
  "parameter": "domain",
  "registry": "domains",
  "occurrence": 1,
  "moduleFingerprint": "facc083fbd475bd7b1aef7cec83d9320bb2f42ee2446ac2f3177dd3d544d99ee",
  "scopeFingerprint": "b89970c81770586b1876add64a75d7b1bbd5ff732f53e8d4e4f646108ca1ce1c",
  "callFingerprint": "a0fd506d67a3351b4dcbbefc3fe3c990b97f317c4c2037f575de667df2bcfce1",
  "bindingFingerprint": "fcaf741687d2a4e2042051f224e563f6b827b722b1cf843b34d19c351ea5649c",
  "parameterFingerprint": "b484735fd50769615edbc3d043abd0b8499316f5b1117cf8ff4568943fbb1d4e",
  "registryFingerprint": "b08bd4bb6ffcb44a9ac9c20bdaf13b3d59aae37fcb67880705c15bb6ec47fbd0",
  "registrationFingerprint": "9691359f2a8be8dd84265f759fc2ab7a63e310fef696aac980c8897318cad7d0",
  "aliasFingerprint": "f63efb0f051ed10651b0fb3f1c77c2b1a3b09aedc13525edd013bd487ba2635d",
  "resultFingerprint": "8f7756929d7885a638709e641aecbe547de915e7bee4c1f18d7d392185a6494a",
  "reason": "Typed local ConfigDomainRegistration callback prepares a resource change for the configuration registry; its result is PreparedConfigChange, not a SQLite statement."
 }
];
