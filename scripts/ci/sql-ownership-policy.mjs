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
 'assistant-task-runtime-schema.ts':['assistantTaskRuntimeSchemaInstallation'],
 'memory-input-plans-schema.ts':['memoryInputPlansSchemaInstallation'],
};

/** Exact consumer boundaries, reviewed against the existing modules. An installer
 * has its declared owner inside its function; other functions use this mapping.
 * A new file never inherits access merely from a filename prefix or directory. */
export const consumers={
 'assistant-task-steering.ts':'assistant-task-runtime',
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

/** These Task adapter methods belong to the formal runtime marker owner. The
 * older Task schema and other consumers in the same file remain pending. */
export const consumerScopes={
 'memory-input-plans.ts':{
  'MemoryInputPlans.list':'memory-input-plans',
  'MemoryInputPlans.get':'memory-input-plans',
  'MemoryInputPlans.put':'memory-input-plans',
 },
 'assistant-tasks.ts':{
  'AssistantTasks.currentBatch':'assistant-task-runtime',
  'AssistantTasks.continueSteering':'assistant-task-runtime',
 },
};

/** Narrow shared reads: exact consumer + SQL fingerprint + table. Never a write
 * grant or a whole-file/table exemption. Stale grants fail just like debt. */
export const sharedReads=[
 {
  "from": "apps/server/src/assistant-task-steering.ts",
  "to": "execution_steps",
  "symbol": "14f01632dbe3b3591017cd3e0337e007ffa0ff7a3cc637550e87ea577c375f71",
  "reason": "Read the current running batch execution fence before delivering the owner supplement.",
  "scope": "AssistantTaskSteering.apply",
  "scopeFingerprint": "9c604fe80392197544ba209c98429e6378a5676c76577266ab733623fd7637a3"
 },
 {
  "from": "apps/server/src/assistant-task-steering.ts",
  "to": "execution_steps",
  "symbol": "b8d15fabe5b267973864611d968e2b3169b5134a0dad22d555880160d3fb8ba8",
  "reason": "Read the existing running batch fence before pinning Task model selection and admitting execution.",
  "scope": "AssistantTaskSteering.execute",
  "scopeFingerprint": "bd6e98d9308d7b1ab5898a0f85e70e23962ba13ffd2a75eeb23bdc6e336d8e91"
 },
 {
  "from": "apps/server/src/assistant-task-steering.ts",
  "to": "task_records",
  "symbol": "5aab174673531c298703a8f5148b3aaf6a37f739375e5c2cc144f92d33a2ca92",
  "reason": "Match the immutable formal Task request identity to its runtime marker.",
  "scope": "AssistantTaskSteering.inputHash",
  "scopeFingerprint": "6c12201cf84405264bf89f378191f68ebdcf8e4d1039bf000984aa6617f98314"
 },
 {
  "from": "apps/server/src/assistant-task-steering.ts",
  "to": "task_records",
  "symbol": "5eb0b632111172c78d9c94655f02c7a338655e2667907d3f98a8193113493154",
  "reason": "Find current formal assistant Tasks for the owner supplement target list.",
  "scope": "AssistantTaskSteering.candidates",
  "scopeFingerprint": "a655d6cef415bfc0b34ebaffb3838d9bf8cc73959fbd88732254ba5f53fd0b01"
 },
 {
  "from": "apps/server/src/assistant-tasks.ts",
  "to": "execution_steps",
  "symbol": "6727a888d1a02598928891d4a0920fd86729fff9ab462fd3dedefc423de9b82a",
  "reason": "Retain the existing batch item identity when admitting an owner-requested continuation.",
  "scope": "AssistantTasks.continueSteering",
  "scopeFingerprint": "498e74a085961f108d7f22c62d2b243af3246b7e2de81c621fcfb7eaf984f125"
 },
 {
  "from": "apps/server/src/assistant-tasks.ts",
  "to": "task_records",
  "symbol": "e838d54b89e6ec4ee7ab0732df7eb155895e32605395d6254d69f5abfd0dc697",
  "reason": "Select the latest formal batch receipt for this Task operation.",
  "scope": "AssistantTasks.currentBatch",
  "scopeFingerprint": "92badb8e67f3b47446cf6f4ae1595372f08c1d0fe53bb324868b707952d00e4e"
 },
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
 },
 {
  "from": "apps/server/src/assistant-task-steering.ts",
  "to": "conversation_turns",
  "symbol": "ff1c2ac2e13a4362d92fea720ab3ba65695e6f170148f61794ed77c8372cb634",
  "scope": "AssistantTaskSteering.messages",
  "scopeFingerprint": "68cc6b2b73574ba7a62b21cc53d77c337ce0bca88dc2a50e7632bc5784dbbace",
  "reason": "Read the exact saved owner supplement message IDs for this Task and delegate message decoding to Conversations."
 },
 {
  "from": "apps/server/src/assistant-task-steering.ts",
  "to": "query_runs",
  "symbol": "a0d387aede75c7286d66a1fd6e5ac63defe9f5e813a73152df5e2a6e5e4d8289",
  "scope": "AssistantTaskSteering.amendments",
  "scopeFingerprint": "01a52b68362dfd69df721a5cf7926532c4d04a34449006fcd2a4034934d2da43",
  "reason": "Check the original accepted supplement request hash against its saved QueryRun receipt."
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
export const finiteInstallations=['executionSchemaInstallation','operationProjectionSchemaInstallation','taskRecordsSchemaInstallation','taskEvidenceSchemaInstallation','runExecutionSchemaInstallation','memorySearchSchemaInstallation','gmailStateSchemaInstallation','larkStateSchemaInstallation','mcpStateSchemaInstallation','recordingMediaSchemaInstallation','recordingSyncSchemaInstallation','assistantTaskRuntimeSchemaInstallation','memoryInputPlansSchemaInstallation'];
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
 },
 {
  "rule": "sql-schema-maintenance",
  "from": "apps/server/src/assistant-tasks.ts",
  "to": "conversation_turns",
  "kind": "observe",
  "symbol": "22c21d3bf441b58d3edae8ac255f03f580428a4e8f81d0e21f720a954465715a",
  "statementFingerprint": "7241408afabccd57333b9782790ad9549a6b2ab234853b3d5f9ab1f6651c667f",
  "installer": "AssistantTasks.constructor",
  "callPath": [
   "apps/server/src/host.ts#buildHost",
   "AssistantTasks.constructor"
  ],
  "sourceRelations": [
   "conversation_turns",
   "task_records"
  ],
  "reason": "Observe the deletion of a source conversation turn to retire its dependent formal Task and erase private Task bodies."
 },
 {
  "rule": "sql-schema-maintenance",
  "from": "apps/server/src/assistant-tasks.ts",
  "to": "task_records",
  "kind": "observe",
  "symbol": "22c21d3bf441b58d3edae8ac255f03f580428a4e8f81d0e21f720a954465715a",
  "statementFingerprint": "7241408afabccd57333b9782790ad9549a6b2ab234853b3d5f9ab1f6651c667f",
  "installer": "AssistantTasks.constructor",
  "callPath": [
   "apps/server/src/host.ts#buildHost",
   "AssistantTasks.constructor"
  ],
  "sourceRelations": [
   "conversation_turns",
   "task_records"
  ],
  "reason": "Observe stale Task state to erase its private scope snapshot in the same transaction."
 },
 {
  "rule": "sql-schema-maintenance",
  "from": "apps/server/src/assistant-tasks.ts",
  "to": "task_records",
  "kind": "update",
  "symbol": "22c21d3bf441b58d3edae8ac255f03f580428a4e8f81d0e21f720a954465715a",
  "statementFingerprint": "7241408afabccd57333b9782790ad9549a6b2ab234853b3d5f9ab1f6651c667f",
  "installer": "AssistantTasks.constructor",
  "callPath": [
   "apps/server/src/host.ts#buildHost",
   "AssistantTasks.constructor"
  ],
  "sourceRelations": [
   "conversation_turns",
   "task_records"
  ],
  "reason": "Retire dependent Task revision and erase input/result bodies when its original conversation turn is deleted."
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
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "conversation_turns",
  "kind": "read",
  "symbol": "0a9735804b2608df2a545a030992ddd7fad7d23e4fff3e48454dfd544c0aa9da",
  "scope": "EvidenceStore.installContextHistoryInvalidation",
  "scopeFingerprint": "f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0",
  "operation": "read",
  "completeSql": false
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "conversation_turns",
  "kind": "read",
  "symbol": "1c00a5ed15ce39e1c55825afe49e12523e5af15177c7e84b8874d1b7ce3ece21",
  "scope": "EvidenceStore.invalidateConversationAnswers",
  "scopeFingerprint": "6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0",
  "operation": "read",
  "completeSql": false
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "conversation_turns",
  "kind": "read",
  "symbol": "26ec2b82a0c8236f2801709d73f74b7974180f7dd326ba320bcd8213c5ea6929",
  "scope": "EvidenceStore.invalidateConversationAnswers",
  "scopeFingerprint": "6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0",
  "operation": "read",
  "completeSql": false
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "conversation_turns",
  "kind": "read",
  "symbol": "6a5d4ad07a8a6d5b53a1c409a460ff5d384af517bd3b67c0aa047f2cfed6ea25",
  "scope": "EvidenceStore.invalidateConversationAnswers",
  "scopeFingerprint": "6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0",
  "operation": "read",
  "completeSql": false
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/evidence-store.ts",
  "to": "conversation_turns",
  "kind": "write",
  "symbol": "d6a6841bc30bb2a5010056e3ba5ce4a7e8d2e5d238bb935057b06777a8ab808a",
  "scope": "EvidenceStore.invalidateConversationAnswers",
  "scopeFingerprint": "6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0",
  "operation": "update",
  "completeSql": true
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "query_runs",
  "kind": "read",
  "symbol": "8905df4d81d744522e2f01fbf5b0e6a5d678f649c89646939ad73ef76219b0c6",
  "scope": "EvidenceStore.invalidateConversationAnswers",
  "scopeFingerprint": "6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0",
  "operation": "read",
  "completeSql": false
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/evidence-store.ts",
  "to": "query_runs",
  "kind": "write",
  "symbol": "716904af2c58f39700b192899a9343cfc67078da072c009f3204e8728682e606",
  "scope": "EvidenceStore.invalidateConversationAnswers",
  "scopeFingerprint": "6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0",
  "operation": "update",
  "completeSql": true
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "conversation_turns",
  "kind": "write",
  "symbol": "27b6a3fef209a72d4c9948043b844600def67489e72967085d22ffefd8d8dfff",
  "scope": "EvidenceStore.invalidateConversationAnswers",
  "scopeFingerprint": "6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0",
  "operation": "update",
  "completeSql": false,
  "classification": "write-unproved-pending",
  "targetOwner": "conversation-turn-storage",
  "constructionFingerprint": "e1262fd857067f2c2d6d688dc9c757ca08d0aff0995c24ddcbb16e869a07c04d"
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "conversation_turns",
  "kind": "write",
  "symbol": "6dc7d5da2aae87bc877b4a581e069faf9f1fcb91726833c4e4cf9c8407266f23",
  "scope": "EvidenceStore.installContextHistoryInvalidation",
  "scopeFingerprint": "f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0",
  "operation": "update",
  "completeSql": false,
  "classification": "write-unproved-pending",
  "targetOwner": "conversation-turn-storage",
  "constructionFingerprint": "e1262fd857067f2c2d6d688dc9c757ca08d0aff0995c24ddcbb16e869a07c04d"
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "conversation_turns",
  "kind": "write",
  "symbol": "b340e894b67fac3c9910715ca8dfadeb92492285fb9f1751372247435b551ebd",
  "scope": "EvidenceStore.invalidateConversationAnswers",
  "scopeFingerprint": "6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0",
  "operation": "update",
  "completeSql": false,
  "classification": "write-unproved-pending",
  "targetOwner": "conversation-turn-storage",
  "constructionFingerprint": "e1262fd857067f2c2d6d688dc9c757ca08d0aff0995c24ddcbb16e869a07c04d"
 },
 {
  "rule": "sql-unproved-relation",
  "from": "apps/server/src/evidence-store.ts",
  "to": "query_runs",
  "kind": "write",
  "symbol": "28af07719a5d788f47a7da12619447756846cb0eec3442aa3e68f639855ba287",
  "scope": "EvidenceStore.installContextHistoryInvalidation",
  "scopeFingerprint": "f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0",
  "operation": "update",
  "completeSql": false,
  "classification": "write-unproved-pending",
  "targetOwner": "query-run-storage",
  "constructionFingerprint": "3e00d98ef0ac2640ea837f7562561477554e367e696e1d2b655e6eda04866902"
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
  "moduleFingerprint": "6c9ba785c4162eb5096aaafaa0620843ffcbc2221792879c528511aaf5ab68e3",
  "scopeFingerprint": "b89970c81770586b1876add64a75d7b1bbd5ff732f53e8d4e4f646108ca1ce1c",
  "callFingerprint": "a0fd506d67a3351b4dcbbefc3fe3c990b97f317c4c2037f575de667df2bcfce1",
  "bindingFingerprint": "fcaf741687d2a4e2042051f224e563f6b827b722b1cf843b34d19c351ea5649c",
  "parameterFingerprint": "b484735fd50769615edbc3d043abd0b8499316f5b1117cf8ff4568943fbb1d4e",
  "registryFingerprint": "b08bd4bb6ffcb44a9ac9c20bdaf13b3d59aae37fcb67880705c15bb6ec47fbd0",
  "registrationFingerprint": "9691359f2a8be8dd84265f759fc2ab7a63e310fef696aac980c8897318cad7d0",
  "aliasFingerprint": "f63efb0f051ed10651b0fb3f1c77c2b1a3b09aedc13525edd013bd487ba2635d",
  "resultFingerprint": "8f7756929d7885a638709e641aecbe547de915e7bee4c1f18d7d392185a6494a",
  "reason": "Typed local ConfigDomainRegistration callback prepares a resource change for the configuration registry; its result is PreparedConfigChange, not a SQLite statement."
 },
 {
  "kind": "class-method",
  "from": "apps/server/src/assistant-tasks.ts",
  "scope": "AssistantTasks.prepare",
  "receiver": "this.questions",
  "method": "prepare",
  "className": "AssistantTaskQuestions",
  "entryType": "AssistantTaskQuestions",
  "definitionFile": "apps/server/src/assistant-task-questions.ts",
  "occurrence": 1,
  "moduleFingerprint": "12bfddc3fb7eaf7d1d30af5a88ee06415dbfb86e7c03457c7a35ae84db28c800",
  "scopeFingerprint": "e338633cf97c5f0616a6dc895eef9ec7a600730df58bffc28580c282a7a13b31",
  "callFingerprint": "3d906b2269f1ad4ee39e3c5161d750d5f20bab1ccac157f6b30bc6d8ad1663cc",
  "bindingFingerprint": "2d05845989f54f3e2c061756d456fbc2b7c19054c00fbd8549f74b294877cf4c",
  "assignmentFingerprint": "80c8c1d5a0eba12c2d4f4f40f801ccea705053dfc27143d4388efe74bf0c9610",
  "importFingerprint": "91c632ad6f9ebcd86c2183a7d687309531b2c04f4e2d976be04799cb9366e3c9",
  "definitionModuleFingerprint": "6aa34bb3950e19a727e66805433262b774bc8be519e04cb0b60081c2a15a8810",
  "definitionFingerprint": "b65951dae7702e66406f51295ffe91f152a42b347de0d9257558ce8fc46f1289",
  "reason": "Exact imported Task adapter prepares a QueryInput through its statically bound class method; the call is not a SQLite statement."
 },
 {
  "kind": "class-method",
  "from": "apps/server/src/assistant-tasks.ts",
  "scope": "AssistantTasks.prepare",
  "receiver": "this.steering",
  "method": "prepare",
  "className": "AssistantTaskSteering",
  "entryType": "AssistantTaskSteering",
  "definitionFile": "apps/server/src/assistant-task-steering.ts",
  "occurrence": 1,
  "moduleFingerprint": "12bfddc3fb7eaf7d1d30af5a88ee06415dbfb86e7c03457c7a35ae84db28c800",
  "scopeFingerprint": "e338633cf97c5f0616a6dc895eef9ec7a600730df58bffc28580c282a7a13b31",
  "callFingerprint": "1a8498f52fc1e958977fa07a005043d951c0beddeb51997bfa9b2eb241ad7507",
  "bindingFingerprint": "61cf8fed3926ae5cd5698e04777fd48667042dccb961ed0470425f89c0b22f8a",
  "assignmentFingerprint": "40acd4e8a4e63ee3ce8741171a182adb1c7fe024aba9c5ec1d640ccd426fef72",
  "importFingerprint": "a26883f189017cf6e9d1abb3403624641d4e16008537a6dd7b3fb617d77eb137",
  "definitionModuleFingerprint": "fb8c8d6ed38adcd0c0ca63d75f08ca45000772351c57640ad00165b74434dc4c",
  "definitionFingerprint": "2f72c76bedf245ce8f756a71c7c7d81c02d1d4b488ffccbe73d021d813b598d9",
  "reason": "Exact imported Task adapter prepares a QueryInput through its statically bound class method; the call is not a SQLite statement."
 },
 {
  "kind": "class-method",
  "from": "apps/server/src/host.ts",
  "scope": "buildHost",
  "receiver": "assistantTasks",
  "method": "prepare",
  "className": "AssistantTasks",
  "entryType": "AssistantTasks",
  "definitionFile": "apps/server/src/assistant-tasks.ts",
  "occurrence": 1,
  "moduleFingerprint": "0d6486c7656cc26d90a03526715700f08d4bfc4c476a3e22aa6aedc93dc9a373",
  "scopeFingerprint": "5fad8e46b082e6311efcc7a0ee5acd178f3be9a570587ae8e3862878f793917e",
  "callFingerprint": "9104236b78880379928fdb6b2d187dac91fbc78fef00cba42700d3204be1cb92",
  "bindingFingerprint": "24b35046071f00a309bc8d34c268875e54380dbd8cafd6cead740e73c2cbda69",
  "assignmentFingerprint": "a1f49ec32ae112722e98331323257c139ebaca1d2e3a0604c1a96a75ae8755c1",
  "importFingerprint": "2ea0a997a5352c58cc652eeb49a1073b2cafef6aca8d1d603f16e5aaebcd0e05",
  "definitionModuleFingerprint": "12bfddc3fb7eaf7d1d30af5a88ee06415dbfb86e7c03457c7a35ae84db28c800",
  "definitionFingerprint": "e338633cf97c5f0616a6dc895eef9ec7a600730df58bffc28580c282a7a13b31",
  "reason": "Exact imported Task adapter prepares a QueryInput through its statically bound class method; the call is not a SQLite statement."
 }
];

/** Existing construction claims are separate from formal SchemaInstallation owners. */
export const importedHelpers=[
 {
  "from": "apps/server/src/assistant-tasks.ts",
  "scope": "AssistantTasks.constructor",
  "name": "retireTaskRecordsSql",
  "definitionFile": "apps/server/src/task-evidence.ts",
  "importFingerprint": "0a8d6d050a8c11b626663efcfaa80307447f96813fffc41432b3a5cf1b65e9c1",
  "definitionModuleFingerprint": "0e5b1904d581a4d7201ddcc1477caef5b22ff51cb569b89a81c5fe8ec4a854fd",
  "definitionFingerprint": "5766030cc8f3da30e11feef88294493278724ff72f915de19eebbfd74dcfa02f",
  "callFingerprint": "ce0fa4e1dbee71c6501b0713390f072d64dfbcb340c0658b8ea83b9bc881ac67",
  "reason": "Resolve the exact pure Task retirement SQL in the existing constructor trigger; no runtime call inherits construction authority."
 }
];
export const storageConstructions=[
 {
  "owner": "conversation-turn-storage",
  "file": "conversations.ts",
  "scope": "Conversations.constructor",
  "scopeFingerprint": "e167ad52f735fc4d4ac11c1a7f7d4291b7b4e161be115fff12feaf0034cade96",
  "statementFingerprint": "34dc14d97f7033b8bbe77138838d5e170d8a9e944733c3ea31f85b39c9d06e22",
  "sqlFingerprint": "8035dc47ba89154593130d6fad082d1e7223f1cc73083bf0bce6f7551c8a98ed",
  "calls": [
   {
    "from": "apps/server/src/plugins/conversations.ts",
    "scope": "createConversations",
    "scopeFingerprint": "9a66331b6f8c05c2efdc9f38c604b04b35c3ea137cddd68aa7c1c18179d056c5",
    "callFingerprint": "33f6346366823a218e13462722baab5f2ccecd3ff832d0ac6eb8b0d60a280f0c",
    "importFingerprint": "06e1d623b7647c3fe48de03bfa7612f491182f035c20b75bdeee7def250b2e30"
   }
  ],
  "reason": "Existing exact constructor DDL and production construction path; H5 installer migration remains pending."
 },
 {
  "owner": "query-run-storage",
  "file": "delegated-query-runs.ts",
  "scope": "DelegatedQueryRuns.constructor",
  "scopeFingerprint": "3be06c77794f3bd1dcbb914c0eb1cf8df0b6912eeb4a6c1bba4d26d487c9a76e",
  "statementFingerprint": "723e8df86dd441990b9c07d808e4b90688b0a97c609260080f58a7c574ed8082",
  "sqlFingerprint": "c981996000b54780c85af51a3f56feb414bd8f405e5b521ec94bbb0b999ba46d",
  "calls": [
   {
    "from": "apps/server/src/plugins/query-runs.ts",
    "scope": "createQueryRunsPlatform",
    "scopeFingerprint": "f12f1f765bdf43d79c5b0fa4f77c02c8bbb85a4d79b8d78e6ab0de7ceb72711b",
    "callFingerprint": "249b48994d475a9a183939fad7736d8c7ea5f30ae1c260e1ccd21db59f71f1b7",
    "importFingerprint": "4e0f5e207113b5f1cf953eb88dd3b570947025ff999567c8eb1734b45c296025"
   }
  ],
  "reason": "Existing exact constructor DDL and production construction path; H5 installer migration remains pending."
 },
 {
  "owner": "assistant-task-storage",
  "file": "assistant-tasks.ts",
  "scope": "AssistantTasks.constructor",
  "scopeFingerprint": "945d47677833cb6f576a9db01a764882f8e4ea349d7b532654c955e71f36cb13",
  "statementFingerprint": "7241408afabccd57333b9782790ad9549a6b2ab234853b3d5f9ab1f6651c667f",
  "sqlFingerprint": "22c21d3bf441b58d3edae8ac255f03f580428a4e8f81d0e21f720a954465715a",
  "calls": [
   {
    "from": "apps/server/src/host.ts",
    "scope": "buildHost",
    "scopeFingerprint": "5fad8e46b082e6311efcc7a0ee5acd178f3be9a570587ae8e3862878f793917e",
    "callFingerprint": "3104364775643689599971ecfdccf278aa2c597fd6bed3e7756bef6ea52d3ac1",
    "importFingerprint": "2ea0a997a5352c58cc652eeb49a1073b2cafef6aca8d1d603f16e5aaebcd0e05"
   }
  ],
  "reason": "Existing exact constructor DDL and production construction path; H5 installer migration remains pending."
 }
];
