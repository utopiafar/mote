/** Only production installers already registered on main belong here. Add an
 * installer after its domain registration lands, then remove its uncovered debt. */
export const installations={
 'action-capabilities-schema.ts':['actionCapabilitiesSchemaInstallation'],
 'owner-questions-schema.ts':['ownerQuestionsSchemaInstallation'],
 'admission-schema.ts':['processorAdmissionSchemaInstallation','providerAdmissionSchemaInstallation'],
 'vault-schema.ts':['vaultSchemaInstallation'],
 'capture-schema.ts':['captureSchemaInstallation','captureProjectionSchemaInstallation'],
 'perception-schema.ts':['perceptionSchemaInstallation'],
 'source-schema.ts':['sourceSchemaInstallation'],
 'file-schema.ts':['fileSchemaInstallation'],
 'file-processing-schema.ts':['fileProcessingMediaIntentsSchemaInstallation','fileDiarizationOverridesSchemaInstallation','fileConfigurationSnapshotsSchemaInstallation','fileProcessorWaitsSchemaInstallation','fileSummaryPagesSchemaInstallation','fileSemanticWithdrawalsSchemaInstallation','mediaExecutionCallsSchemaInstallation'],
 'import-schema.ts':['importUploadsSchemaInstallation','importAttributionSchemaInstallation','importIntakeOverridesSchemaInstallation','importJobsSchemaInstallation','importCreateRequestsSchemaInstallation'],
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
 'memory-lifecycle-schema.ts':['memoryLifecycleEffectiveSchemaInstallation'],
 'memory-native-stage-schema.ts':['memoryNativeStagesSchemaInstallation'],
 'plugins/memory-publication-schema.ts':['memoryPublicationSchemaInstallation'],
 'connectors/gmail-state.ts':['gmailStateSchemaInstallation'],
 'connectors/lark-state.ts':['larkStateSchemaInstallation'],
 'connectors/mcp-import-state.ts':['mcpStateSchemaInstallation'],
 'connectors/recording-state.ts':['recordingMediaSchemaInstallation','recordingSyncSchemaInstallation'],
 'assistant-task-runtime-schema.ts':['assistantTaskRuntimeSchemaInstallation'],
 'memory-input-plans-schema.ts':['memoryInputPlansSchemaInstallation'],
 'source-state-schema.ts':['sourceArchiveSchemaInstallation','sourceContextSchemaInstallation','sourcePipelineSchemaInstallation'],
 'memory-input-authorization.ts':['memoryInputAuthorizationSchemaInstallation'],
 'memory-extraction-drafts.ts':['memoryExtractionDraftsSchemaInstallation'],
 'memory-phase-outputs.ts':['memoryPhaseOutputsSchemaInstallation'],
 'plugin-control-storage.ts':['pluginControlSchemaInstallation'],
 'plugin-instance-state-storage.ts':['instanceStateSchemaInstallation'],
 'actions-schema.ts':['actionsSchemaInstallation','actionsExecutionSchemaInstallation','actionsRetirementSchemaInstallation'],
 'processing-runtime-schema.ts':['processingRuntimeSchemaInstallation'],
 "background-model-authorization-schema.ts":["backgroundModelAuthorizationSchemaInstallation"],
 "plugin-surface-schema.ts":[
 "pluginReleasePreviewsSchemaInstallation",
 "developerAccessSchemaInstallation",
 "outboundExportSchemaInstallation"
],
 "delegation-schema.ts":[
 "delegationJournalSchemaInstallation",
 "delegationSourceContextSchemaInstallation"
],
 "asset-evidence-schema.ts":[
 "assetSchemaInstallation",
 "archivedFilesSchemaInstallation",
 "evidenceMaterialLineageSchemaInstallation",
 "assetSnapshotInputsReferencesInstallation",
 "assetSnapshotTextReferencesInstallation",
 "assetFileVersionsReferencesInstallation",
 "assetFileAssetsReferencesInstallation",
 "assetCaptureReferencesInstallation",
 "assetArchivedFilesReferencesInstallation",
 "evidenceDependenciesWithoutMaterialsInstallation",
 "evidenceDependenciesWithMaterialsInstallation"
],
 "memory-settings-schema.ts":[
 "memoryProviderConfigurationsSchemaInstallation",
 "memoryRecipeSettingsSchemaInstallation"
],
 "auxiliary-state-schema.ts":[
 "insightRunsSchemaInstallation",
 "recordContextSchemaInstallation"
],
 "memory-binding-schema.ts":[
 "memoryBindingSchemaInstallation"
],
};

/** Exact consumer boundaries, reviewed against the existing modules. An installer
 * has its declared owner inside its function; other functions use this mapping.
 * A new file never inherits access merely from a filename prefix or directory. */
export const consumers={
 'owner-calendar-instructions.ts':'actions',
 'plugin-control-storage.ts':'plugin-control',
 'plugin-instance-state-storage.ts':'plugin-instance-state',
 'assistant-task-steering.ts':'assistant-task-runtime',
 'memory-input-authorization.ts':'memory-input-authorization',
 'memory-extraction-drafts.ts':'memory-extraction-drafts',
 'memory-phase-outputs.ts':'memory-phase-outputs',
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
 "plugin-center.ts":"plugin-release-previews",
 "plugins/outbound-export-host.ts":"outbound-export",
 "assets.ts":"assets",
 "memory-recipe-settings.ts":"memory-recipe-settings",
};

/** These exact method scopes belong to the named formal owner. Other
 * statements in the same file remain pending. */
export const consumerScopes={
 'owner-questions.ts':{
  'OwnerQuestions.row':'owner-question-services',
  'OwnerQuestions.transaction':'owner-question-services',
  'OwnerQuestions.receipt':'owner-question-services',
  'OwnerQuestions.create':'owner-question-services',
  'OwnerQuestions.save':'owner-question-services',
  'OwnerQuestions.decode':'owner-question-services',
  'OwnerQuestions.performReply':'owner-question-services',
 },
 'owner-calendar-instructions.ts':{
  'OwnerCalendarInstructions.targets':'actions',
  'OwnerCalendarInstructions.targetCurrent':'actions',
 },
 'memory-lifecycle.ts':{
  'projectMemoryLifecycleSettings':'memory-lifecycle',
  'storedMemoryLifecycleSettings':'memory-lifecycle',
 },
 'lifecycle-extensions.ts':{
  recoverableMemoryJobs:'memory',
 },
 'plugins/action-capabilities.ts':{'ActionCapabilities.command':'action-capabilities','ActionCapabilities.declare':'action-capabilities','ActionCapabilities.declarations':'action-capabilities','ActionCapabilities.inventory':'action-capabilities','ActionCapabilities.saveDraft':'action-capabilities','ActionCapabilities.revokeDraft':'action-capabilities','ActionCapabilities.grants':'action-capabilities','ActionCapabilities.revokeGrant':'action-capabilities'},
 'actions.ts':{'Actions.proposeAuthorizedCalendar':'actions','Actions.recoverCurrentCalendar':'actions','Actions.connectorClaim':'actions','Actions.discover':'actions'},
 'external-calendar-actions.ts':{'ExternalCalendarActions.read':'actions','ExternalCalendarActions.accept':'actions'},
 'processor-admission.ts':{
  'ProcessorAdmission.check':'processor-admission',
  'ProcessorAdmission.run':'processor-admission',
 },
 'provider-admission.ts':{
  'ProviderAdmission.check':'provider-admission',
  'ProviderAdmission.run':'provider-admission',
  'ProviderAdmission.snapshot':'provider-admission',
 },
 'memory-input-plans.ts':{
  'MemoryInputPlans.list':'memory-input-plans',
  'MemoryInputPlans.get':'memory-input-plans',
  'MemoryInputPlans.put':'memory-input-plans',
 },
 'source-context.ts':{
  'SourceContextStore.constructor':'source-context',
  'SourceContextStore.source':'source',
  'SourceContextStore.getAtVersion':'source-context',
  'SourceContextStore.set':'source',
  'SourceContextStore.export':'source-context',
  'SourceContextStore.restore':'source-context',
 },
 'source-archive.ts':{
  'SourceArchive.ensureIndexed':'source-archive',
  'SourceArchive.ensureGroup':'source-archive',
  'SourceArchive.indexedCheckpoint':'source-archive',
  'SourceArchive.hasSource':'source-archive',
  'SourceArchive.versionInfo':'source-archive',
  'SourceArchive.readVersion':'source-archive',
  'SourceArchive.currentHeadsPage':'source-archive',
  'SourceArchive.currentSnapshot':'source-archive',
  'SourceArchive.receive':'source-archive',
  'SourceArchive.forget':'source-archive',
 },
 'source-pipelines.ts':{
  'SourcePipelineRuntime.row':'source-pipeline',
  'SourcePipelineRuntime.enqueueWork':'source-pipeline',
  'SourcePipelineRuntime.validWork':'source-pipeline',
  'SourcePipelineRuntime.admitWork':'source-pipeline',
  'SourcePipelineRuntime.organizeGroup':'source-pipeline',
  'SourcePipelineRuntime.publishGroup':'source-pipeline',
  'SourcePipelineRuntime.projectWork':'source-pipeline',
  'SourcePipelineRuntime.selected':'source-pipeline',
  'SourcePipelineRuntime.receive':'source-pipeline',
  'SourcePipelineRuntime.tick':'source-pipeline',
  'SourcePipelineRuntime.drainPipeline':'source-pipeline',
  'SourcePipelineRuntime.storedOptions':'source-pipeline',
  'SourcePipelineRuntime.configure':'source-pipeline',
  'SourcePipelineRuntime.memoryAllowed':'source-pipeline',
  'SourcePipelineRuntime.status':'source-pipeline',
 },
 'assistant-tasks.ts':{
  'AssistantTasks.currentBatch':'assistant-task-runtime',
  'AssistantTasks.continueSteering':'assistant-task-runtime',
 },
 'processing-runtime.ts':{
  "ProcessingRuntime.enqueue": "processing-runtime",
  "ProcessingRuntime.completePolicy": "processing-runtime",
  "ProcessingRuntime.job": "processing-runtime",
  "ProcessingRuntime.project": "processing-runtime",
  "ProcessingRuntime.tick": "processing-runtime",
  "ProcessingRuntime.commit": "processing-runtime"
 },
 "background-model-authorization.ts":{
 "BackgroundModelAuthorization.state": "background-model-authorization",
 "BackgroundModelAuthorization.transaction": "background-model-authorization",
 "BackgroundModelAuthorization.command": "background-model-authorization",
 "BackgroundModelAuthorization.receive": "background-model-authorization",
 "BackgroundModelAuthorization.derive": "background-model-authorization",
 "BackgroundModelAuthorization.roots": "background-model-authorization",
 "BackgroundModelAuthorization.freshTriggers": "background-model-authorization",
 "BackgroundModelAuthorization.save": "background-model-authorization",
 "BackgroundModelAuthorization.saved": "background-model-authorization",
 "BackgroundModelAuthorization.automatic": "background-model-authorization",
 "BackgroundModelAuthorization.bindStep": "background-model-authorization",
 "BackgroundModelAuthorization.stepAuthority": "background-model-authorization",
 "BackgroundModelAuthorization.assertStep": "background-model-authorization",
 "BackgroundModelAuthorization.runStep": "background-model-authorization"
},
 "developer-access.ts":{
 "DeveloperAccessHost.init": "developer-access",
 "DeveloperAccessHost.deliveries": "developer-access",
 "DeveloperAccessHost.deliverDue": "developer-access",
 "DeveloperAccessHost.attempt": "developer-access",
 "DeveloperAccessHost.failDelivery": "developer-access",
 "DeveloperAccessHost.failPending": "developer-access",
 "DeveloperAccessHost.prune": "developer-access"
},
 "delegation-store.ts":{
 "DelegationStore.payload": "delegation",
 "DelegationStore.savePayload": "delegation",
 "DelegationStore.result": "delegation",
 "DelegationStore.saveResult": "delegation",
 "DelegationStore.artifact": "delegation",
 "DelegationStore.saveArtifact": "delegation"
},
 "delegation-runtime.ts":{
 "DelegationRuntime.constructor": "delegation",
 "DelegationRuntime.raw": "delegation",
 "DelegationRuntime.units": "delegation",
 "DelegationRuntime.unit": "delegation",
 "DelegationRuntime.save": "delegation",
 "DelegationRuntime.saveUnit": "delegation",
 "DelegationRuntime.event": "delegation",
 "DelegationRuntime.get": "delegation",
 "DelegationRuntime.page": "delegation",
 "DelegationRuntime.activeIds": "delegation",
 "DelegationRuntime.artifactMetadata": "delegation",
 "DelegationRuntime.start": "delegation",
 "DelegationRuntime.transaction": "delegation",
 "DelegationRuntime.submit": "delegation",
 "DelegationRuntime.retryUnit": "delegation",
 "DelegationRuntime.resumeExternalUnit": "delegation",
 "DelegationRuntime.activeExecutionIds": "delegation",
 "DelegationRuntime.dependencyIds": "delegation",
 "DelegationRuntime.sourceContextDependencies": "delegation",
 "DelegationRuntime.recordSourceContextDependencies": "delegation",
 "DelegationRuntime.recordEvidence": "delegation"
},
 "archived-files.ts":{
 "ArchivedFileStore.savePrepared": "archived-files",
 "ArchivedFileStore.get": "archived-files",
 "ArchivedFileStore.attach": "archived-files",
 "ArchivedFileStore.listForCapture": "archived-files",
 "ArchivedFileStore.portableEstimate": "archived-files",
 "ArchivedFileStore.exportPortable": "archived-files",
 "ArchivedFileStore.preparePortable": "archived-files",
 "ArchivedFileStore.restorePortable": "archived-files",
 "ArchivedFileStore.removeUnreferenced": "archived-files"
},
 "evidence-dependencies.ts":{
 "materialEvidenceInstalled": "evidence-dependencies",
 "evidenceDependents": "evidence-dependencies",
 "invalidateRetiredFileEvidence": "memory"
},
 /** Only this scan reads this owner's saved provider configurations. The
  * configuration() path also reads dynamic plan/binding relations and stays pending. */
 "memory-adapters.ts":{
 "MemoryAdapters.erasePreparedEvidence": "memory-provider-configurations"
},
 "record-context.ts":{
 "RecordContextStore.constructor": "record-context",
 "RecordContextStore.bind": "record-context",
 "RecordContextStore.insert": "record-context",
 "RecordContextStore.identities": "record-context",
 "RecordContextStore.open": "record-context",
 "RecordContextStore.export": "record-context",
 "RecordContextStore.restore": "record-context"
},
 "insight-runs.ts":{
 "InsightRuns.save": "insight-runs",
 "InsightRuns.raw": "insight-runs",
 "InsightRuns.list": "insight-runs",
 "InsightRuns.start": "insight-runs"
},
 "memory-bindings.ts":{
 "MemoryBindings.constructor": "memory-binding",
 "MemoryBindings.binding": "memory-binding",
 "MemoryBindings.saveBinding": "memory-binding",
 "MemoryBindings.preparation": "memory-binding",
 "MemoryBindings.savePreparation": "memory-binding",
 "MemoryBindings.currentRecords": "memory-binding",
 "MemoryBindings.command": "memory-binding",
 "MemoryBindings.copy": "memory-binding"
},
};

/** Narrow shared reads: exact consumer + SQL fingerprint + table. Never a write
 * grant or a whole-file/table exemption. Stale grants fail just like debt. */
export const sharedReads=[
 {"from":"apps/server/src/material-organizers.ts","to":"execution_steps","symbol":"0222a27909ae40647fefd0c860b859b7b2f7783492cfe6144ad209818012f372","scope":"MaterialOrganizerRuntime.repairStale","scopeFingerprint":"95b2de2d4d944163cd0138cc98e42fd33d6987ebe9ce4286f99442d02b4acae9","reason":"Find stale steps of the exact active organizer operations before validating and restoring their current generations through the execution engine."},
 {"from":"apps/server/src/evidence-dependencies.ts","to":"file_artifacts","symbol":"44269e8865cec6e074225aeb1ff1cec3682b08bbb48d2d476c858245908eff14","scope":"invalidateRetiredFileEvidence","scopeFingerprint":"1b1b48015c6637df86e1e7f14364d031964851908c11f948b7a7ae657ee16fa3","reason":"Check which artifacts replaced the requested file's original derived chunks before retiring dependent Memory."},
 {"from":"apps/server/src/evidence-dependencies.ts","to":"file_chunks","symbol":"44269e8865cec6e074225aeb1ff1cec3682b08bbb48d2d476c858245908eff14","scope":"invalidateRetiredFileEvidence","scopeFingerprint":"1b1b48015c6637df86e1e7f14364d031964851908c11f948b7a7ae657ee16fa3","reason":"Read the exact retired chunk IDs for the requested file without reading their bodies."},
 {"from":"apps/server/src/evidence-dependencies.ts","to":"material_evidence","symbol":"44269e8865cec6e074225aeb1ff1cec3682b08bbb48d2d476c858245908eff14","scope":"invalidateRetiredFileEvidence","scopeFingerprint":"1b1b48015c6637df86e1e7f14364d031964851908c11f948b7a7ae657ee16fa3","reason":"Preserve canonical Material anchor identity if it overlaps a retired file chunk ID."},
 {"from":"apps/server/src/evidence-dependencies.ts","to":"material_evidence_dependencies","symbol":"44269e8865cec6e074225aeb1ff1cec3682b08bbb48d2d476c858245908eff14","scope":"invalidateRetiredFileEvidence","scopeFingerprint":"1b1b48015c6637df86e1e7f14364d031964851908c11f948b7a7ae657ee16fa3","reason":"Follow the exact indexed Formal anchor links from affected originals so only dependent Memory is retired."},
 {
  "from": "apps/server/src/memory-phase-outputs.ts",
  "to": "execution_steps",
  "symbol": "2e1128caba8c3b159f4b649b774acea3a41b23ad0d4873acd83a505bcd8ff366",
  "scope": "MemoryPhaseOutputs.retryReview",
  "scopeFingerprint": "d6a8c82c865d67b99ea3585950f8543cc4b2e2e80ae658dc02daf145af61105e",
  "reason": "Select only saved Memory review step IDs for this batch before removing the owned phase output and retrying through ExecutionEngine."
 },
 {
  "from": "apps/server/src/memory-phase-outputs.ts",
  "to": "execution_steps",
  "symbol": "89fc8681b552931e4612f37ff4c1049c74cf625114a7e87a0b61c1619176dc4d",
  "scope": "MemoryPhaseOutputs.retryFailed",
  "scopeFingerprint": "7c30bd5a6554bc02f7f726e6952775c22e757a00ce0a8610735b6a6fb73b0d0d",
  "reason": "Select only failed or blocked Memory phase step IDs for this exact batch and generation before retrying through ExecutionEngine."
 },
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
 },
 {
  "from": "apps/server/src/source-context.ts",
  "to": "source_connections",
  "symbol": "5a26256857fe0bd59feb0fa0b2e0df0f5e9149b4bba3ff45d2f29817278a60ba",
  "scope": "SourceContextStore.restore",
  "scopeFingerprint": "bdf5f2bc1ae9f68a44d2b00b8819b8ba3bcbfa2f2ed210a74195cedcd0a956f3",
  "reason": "Validate restored declaration history against canonical Source IDs whose current metadata already carries a context pin; do not rewrite the Source pointer."
 },
 {
  "from": "apps/server/src/source-pipelines.ts",
  "to": "source_connections",
  "symbol": "1a90286d107264d340491e42abc94a6c10feb415d90983a220a27c2a1702de05",
  "scope": "SourcePipelineRuntime.validWork",
  "scopeFingerprint": "41100c9d5c3ae3a338f481179aa4aadb4dd5acc06a91f86c5bedd8daf3f30b8b",
  "reason": "Compare the current Source identity with the accepted immutable work fingerprint before continuing the pinned archive group."
 },
 {
  "from": "apps/server/src/source-pipelines.ts",
  "to": "source_connections",
  "symbol": "51a199494c714e32e24760b4907024dcadd8475ae68d30656f27348f179dc813",
  "scope": "SourcePipelineRuntime.admitWork",
  "scopeFingerprint": "1b9d6700cf85000d90bf994b49d80ad1a989604f6353842feea8b14f4a4c21f4",
  "reason": "Check the Source kind against the selected pipeline and exact installed recipe before admitting existing archive work."
 },
 {
  "from": "apps/server/src/source-pipelines.ts",
  "to": "source_connections",
  "symbol": "5a66ecfff8e22e1c2533b084aa36f7ac6297d0ba389fc75e8c9e49ccc636ecb0",
  "scope": "SourcePipelineRuntime.tick",
  "scopeFingerprint": "63e8fbe0804b6be34f054ffc4de42b75284673e97584a7f117431204435a15b9",
  "reason": "Reconcile deterministic recipe upgrades only against the previously accepted Source and configuration fingerprints."
 },
 {
  "from": "apps/server/src/source-pipelines.ts",
  "to": "source_connections",
  "symbol": "a19fe332bad6f19db42e41be2e8694d7d5bc7a3ad4f0d8208cd3f7109a3503b7",
  "scope": "SourcePipelineRuntime.memoryAllowed",
  "scopeFingerprint": "9d4c059bac1b8474c96186d7998d8f6553f52fb54eff4138a2fcafd8b3622899",
  "reason": "Resolve the existing Source kind and archive pipeline for ongoing Material Memory authority without admitting new Source receipts."
 },
 {
  "from": "apps/server/src/source-pipelines.ts",
  "to": "source_connections",
  "symbol": "aa75c5fc792542902afecdb595e45e2b1c1fd8258c0d59d1dd2d65b99fbb3e25",
  "scope": "SourcePipelineRuntime.publishGroup",
  "scopeFingerprint": "50bab93515605686c551fa3a93584c19023210db6c715515db3f39af8369319f",
  "reason": "Recheck Source identity against the prepared result inside fenced Material publication; the read grants no Source mutation."
 },
 {
  "from": "apps/server/src/source-pipelines.ts",
  "to": "source_connections",
  "symbol": "cc2ab50248ab7058b9519e11d5cc0696861d76bce2f507d457969b13b4c646d1",
  "scope": "SourcePipelineRuntime.organizeGroup",
  "scopeFingerprint": "1f6718a619519e1e172f1bb1d9a61e1f041daddf69f8e7f9c630ec91b7b16f06",
  "reason": "Read Source identity metadata for the selected recipe and the accepted group while preparing its bounded Material draft."
 },
 {
  "from": "apps/server/src/source-pipelines.ts",
  "to": "source_connections",
  "symbol": "dd03852f0ac8ea26d2b18bdadf01e575ce7a66867db754d794ff889ccacb6d47",
  "scope": "SourcePipelineRuntime.configure",
  "scopeFingerprint": "62066ed8811f9c0f0eeeea2e49ef4c9e1ca3eb94da80228e027aedd2e691b2d5",
  "reason": "Validate Source kind and the existing physical storage contract before writing only pipeline-owned bindings and configuration."
 },
 {
  "from": "apps/server/src/source-pipelines.ts",
  "to": "source_connections",
  "symbol": "def4469d98bdf5ba5cb7229cddb238f11d8c2f07ed6ba26ea704df320fb1086c",
  "scope": "SourcePipelineRuntime.enqueueWork",
  "scopeFingerprint": "abf3962e943a71b4f523f936443a2172e5df4896ecf0c33dcbadfe253b72e924",
  "reason": "Pin the accepted archive work to its existing Source identity and pipeline configuration before enqueueing its execution generation."
 },
 {
  "from": "apps/server/src/plugin-instance-state-storage.ts",
  "to": "source_connections",
  "symbol": "2f759e3921782b241e17e54714ba24586a9886226de682df0ac51b78062f8365",
  "scope": "InstanceState.write",
  "scopeFingerprint": "50cd8ec210a04e376136ad146c42d2244486a73ad5d8d2627f23862c9ba83b65",
  "reason": "Fence the existing conditional instance-state CAS against its exact enabled Source connection, permitted source kind and sync scope version in the same write transaction."
 },
 {
  "from": "apps/server/src/processing-runtime.ts",
  "to": "execution_steps",
  "symbol": "fb446ea0f8c28fa81827000b98fc125b46a42ee90cbd3f8efd45ef906e2c1318",
  "scope": "ProcessingRuntime.completePolicy",
  "scopeFingerprint": "69f157a709dec4a604dc9226561c86ab0db39893239cd63974a66a1757111027",
  "reason": "Read only blocked Processing step IDs and owned lane metadata before retrying re-enabled work through ExecutionEngine."
 },
 {
  "from": "apps/server/src/processing-runtime.ts",
  "to": "execution_steps",
  "symbol": "515703e003d897109e42addb2a958ca7b6b9250abfaa211d3bc906f49c7439ce",
  "scope": "ProcessingRuntime.tick",
  "scopeFingerprint": "4fe9dfe57084647a10a9117cbd3a69539952bf902ea7ce1312331632db58e585",
  "reason": "Read at most 1000 ready or expired-lease Processing step IDs before draining those IDs through ExecutionEngine."
 }
,{"from":"apps/server/src/delegation-runtime.ts","to":"execution_operation_steps","symbol":"653ef180a3dc7da2d215f7b2f0b130db8e215f0bbec096e83a5e4d21fea5e9ab","scope":"DelegationRuntime.activeIds","scopeFingerprint":"7bbd52589abedfda666c147fb325bb96efca8922c080237cc82e3439790371aa","reason":"Find only existing Delegation work whose owned units or operation membership still have active Execution steps before recovery through ExecutionEngine."},{"from":"apps/server/src/delegation-runtime.ts","to":"execution_steps","symbol":"653ef180a3dc7da2d215f7b2f0b130db8e215f0bbec096e83a5e4d21fea5e9ab","scope":"DelegationRuntime.activeIds","scopeFingerprint":"7bbd52589abedfda666c147fb325bb96efca8922c080237cc82e3439790371aa","reason":"Find only existing Delegation work whose owned units or operation membership still have active Execution steps before recovery through ExecutionEngine."},{"from":"apps/server/src/delegation-runtime.ts","to":"execution_steps","symbol":"b455d3ccd33a2e3849625660212a2e289fdb9c0e5436f729b91911af9877e5f4","scope":"DelegationRuntime.activeExecutionIds","scopeFingerprint":"003b5daa00702ce5f708103c98226c02ebc4ddd484a4e0f8c96f507b09f341e3","reason":"Read only active step IDs of this Delegation operation before cancelling or blocking through ExecutionEngine."},{"from":"apps/server/src/memory-recipe-settings.ts","to":"source_connections","symbol":"def4469d98bdf5ba5cb7229cddb238f11d8c2f07ed6ba26ea704df320fb1086c","scope":"MemoryRecipeSettings.sourceDefault","scopeFingerprint":"127942509f92fbfe1b3bc50bcdfcfe5db1d510045fdf7cb8f092747710b5c78c","reason":"Read only the canonical Source kind/device metadata that chooses the inherited recipe category default; the FK is a schema dependency, not Source data authority."},{"from":"apps/server/src/memory-recipe-settings.ts","to":"source_connections","symbol":"e419071df7f985c66e1b34bb6eacf5f186d94c309ce5fff1d135b751440a6494","scope":"MemoryRecipeSettings.source","scopeFingerprint":"b47a5a72021ca0a39ed13f525492e455e3b8542a3f2518f0b95ff12321f919e3","reason":"Verify an exact owner-selected Source exists before reading or writing only its Memory recipe override; this never mutates the Source row."},{"from":"apps/server/src/record-context.ts","to":"captures","symbol":"e8e8fe01b55b0ff78af4072e48a99077e72a7c54cac38ae936246708110db73e","scope":"RecordContextStore.bind","scopeFingerprint":"5ec2a2c351dfbcb6b2325ced3df3b03d9da7b25e70472514eb8c7c9a82ff4c38","reason":"Read the original capture fingerprint inside the receive transaction before storing a private declaration for that exact original."},{"from":"apps/server/src/record-context.ts","to":"captures","symbol":"d6472b609d4ca786bb318c27333c2a81b1c97fffe5e7a096f58c21928c5395b2","scope":"RecordContextStore.identities","scopeFingerprint":"9a5f3e95d58545d68dfb263a18687bcf7895812fa437f1dff66d53d36e673167","reason":"Resolve only exact parent lineage of requested originals before inheriting their private record context."},{"from":"apps/server/src/record-context.ts","to":"file_evidence_links","symbol":"d6472b609d4ca786bb318c27333c2a81b1c97fffe5e7a096f58c21928c5395b2","scope":"RecordContextStore.identities","scopeFingerprint":"9a5f3e95d58545d68dfb263a18687bcf7895812fa437f1dff66d53d36e673167","reason":"Follow exact parent links only; a shared file or another capture never inherits record context."},{"from":"apps/server/src/record-context.ts","to":"captures","symbol":"0ef54931bc767d4b330d3b814ec24db3dbbc775bcf4b080bc9484985f1d7c098","scope":"RecordContextStore.open","scopeFingerprint":"a90c24ce5715b6e434152ebb3d04a45a81ec839aa8e4acec83fad18148bf5097","reason":"Revalidate the private declaration against its still-current original fingerprint before returning pinned prose."},{"from":"apps/server/src/record-context.ts","to":"captures","symbol":"d4fda12b40b7311a3f59e09467d051e9082b1e7221c631074c35dc19e1b07c35","scope":"RecordContextStore.export","scopeFingerprint":"d7425103bda6f63976928375cc55da4a20c013585903b466553d9aed54bb3e8e","reason":"Export only declarations whose original capture fingerprint is still current."},{"from":"apps/server/src/record-context.ts","to":"captures","symbol":"4378de29e7fbc1e30b4b1f16cc32d72ed5c92f228b8f9d7fbcc53f493283d2e1","scope":"RecordContextStore.restore","scopeFingerprint":"2ef1a4b2f2de403a5c6f7b2eb69e8f2b5e7a0b0291e5a3fa52435d87a1afe456","reason":"Validate restored declaration identity against the destination original capture fingerprint; do not rewrite the capture."},{"from":"apps/server/src/memory-bindings.ts","to":"memories","symbol":"22416992d875335bee538032d88d19478dd210e3c1d492e8e24beb0c0e5d5d31","scope":"MemoryBindings.currentRecords","scopeFingerprint":"05f20c8b891087cea0322c68ea5b6ac63729f18d53f9c10f73a7872d3c486fb5","reason":"Freeze only canonical Memory bodies while the active binding verifies a preparation snapshot."}];

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
export const finiteInstallations=['executionSchemaInstallation','operationProjectionSchemaInstallation','taskRecordsSchemaInstallation','taskEvidenceSchemaInstallation','runExecutionSchemaInstallation','memorySearchSchemaInstallation','gmailStateSchemaInstallation','larkStateSchemaInstallation','mcpStateSchemaInstallation','recordingMediaSchemaInstallation','recordingSyncSchemaInstallation','assistantTaskRuntimeSchemaInstallation','sourceArchiveSchemaInstallation','sourceContextSchemaInstallation','sourcePipelineSchemaInstallation','memoryInputAuthorizationSchemaInstallation','memoryExtractionDraftsSchemaInstallation','memoryPhaseOutputsSchemaInstallation','pluginControlSchemaInstallation','instanceStateSchemaInstallation','memoryInputPlansSchemaInstallation','actionsSchemaInstallation','actionsExecutionSchemaInstallation','actionsRetirementSchemaInstallation','processingRuntimeSchemaInstallation','processorAdmissionSchemaInstallation','providerAdmissionSchemaInstallation',"backgroundModelAuthorizationSchemaInstallation","pluginReleasePreviewsSchemaInstallation","developerAccessSchemaInstallation","outboundExportSchemaInstallation","delegationJournalSchemaInstallation","delegationSourceContextSchemaInstallation","materialSchemaInstallation","assetSchemaInstallation","archivedFilesSchemaInstallation","evidenceMaterialLineageSchemaInstallation","assetSnapshotInputsReferencesInstallation","assetSnapshotTextReferencesInstallation","assetFileVersionsReferencesInstallation","assetFileAssetsReferencesInstallation","assetCaptureReferencesInstallation","assetArchivedFilesReferencesInstallation","evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithMaterialsInstallation","insightRunsSchemaInstallation","recordContextSchemaInstallation","memoryBindingSchemaInstallation",'actionCapabilitiesSchemaInstallation'];
export const schemaMaintenance=[
 {
  "from": "apps/server/src/memory-extraction-drafts.ts",
  "to": "memory_batch_dependencies",
  "kind": "observe",
  "symbol": "02fd4cfa94a222515cbef223917abacd8c109e94f95411dd0172b88bf835602c",
  "statementFingerprint": "a8f8156a0c0bd4690e80c0a6f8061d50563246b4c35d609a4f165b3657734a13",
  "installer": "memoryExtractionDraftsSchemaInstallation",
  "callPath": [
   "memoryExtractionDraftsSchemaInstallation",
   "memoryExtractionDraftsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs"
  ],
  "reason": "Install the existing Memory draft retirement triggers: observe Memory batch/job/dependency lifecycle and read only batch IDs while deleting this owner's private drafts."
 },
 {
  "from": "apps/server/src/memory-extraction-drafts.ts",
  "to": "memory_batches",
  "kind": "observe",
  "symbol": "02fd4cfa94a222515cbef223917abacd8c109e94f95411dd0172b88bf835602c",
  "statementFingerprint": "a8f8156a0c0bd4690e80c0a6f8061d50563246b4c35d609a4f165b3657734a13",
  "installer": "memoryExtractionDraftsSchemaInstallation",
  "callPath": [
   "memoryExtractionDraftsSchemaInstallation",
   "memoryExtractionDraftsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs"
  ],
  "reason": "Install the existing Memory draft retirement triggers: observe Memory batch/job/dependency lifecycle and read only batch IDs while deleting this owner's private drafts."
 },
 {
  "from": "apps/server/src/memory-extraction-drafts.ts",
  "to": "memory_batches",
  "kind": "read",
  "symbol": "02fd4cfa94a222515cbef223917abacd8c109e94f95411dd0172b88bf835602c",
  "statementFingerprint": "a8f8156a0c0bd4690e80c0a6f8061d50563246b4c35d609a4f165b3657734a13",
  "installer": "memoryExtractionDraftsSchemaInstallation",
  "callPath": [
   "memoryExtractionDraftsSchemaInstallation",
   "memoryExtractionDraftsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs"
  ],
  "reason": "Install the existing Memory draft retirement triggers: observe Memory batch/job/dependency lifecycle and read only batch IDs while deleting this owner's private drafts."
 },
 {
  "from": "apps/server/src/memory-extraction-drafts.ts",
  "to": "memory_jobs",
  "kind": "observe",
  "symbol": "02fd4cfa94a222515cbef223917abacd8c109e94f95411dd0172b88bf835602c",
  "statementFingerprint": "a8f8156a0c0bd4690e80c0a6f8061d50563246b4c35d609a4f165b3657734a13",
  "installer": "memoryExtractionDraftsSchemaInstallation",
  "callPath": [
   "memoryExtractionDraftsSchemaInstallation",
   "memoryExtractionDraftsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs"
  ],
  "reason": "Install the existing Memory draft retirement triggers: observe Memory batch/job/dependency lifecycle and read only batch IDs while deleting this owner's private drafts."
 },
 {
  "from": "apps/server/src/memory-phase-outputs.ts",
  "to": "memory_batch_dependencies",
  "kind": "observe",
  "symbol": "cd9253b956d2323f5fabc8fe8c80cce0b53f5bddd075788fad67cbddbbfd9753",
  "statementFingerprint": "e56e8d7b50759181c1449b0c952255dcc2b95716dfe97087359a5dbd91d0bd0a",
  "installer": "memoryPhaseOutputsSchemaInstallation",
  "callPath": [
   "memoryPhaseOutputsSchemaInstallation",
   "memoryPhaseOutputsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs",
   "memory_phase_outputs"
  ],
  "reason": "Install the existing Memory phase checkpoint retirement and late-insert fence: observe Memory batch/job/dependency lifecycle and read current batch/job state while changing only this owner's phase outputs."
 },
 {
  "from": "apps/server/src/memory-phase-outputs.ts",
  "to": "memory_batches",
  "kind": "observe",
  "symbol": "cd9253b956d2323f5fabc8fe8c80cce0b53f5bddd075788fad67cbddbbfd9753",
  "statementFingerprint": "e56e8d7b50759181c1449b0c952255dcc2b95716dfe97087359a5dbd91d0bd0a",
  "installer": "memoryPhaseOutputsSchemaInstallation",
  "callPath": [
   "memoryPhaseOutputsSchemaInstallation",
   "memoryPhaseOutputsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs",
   "memory_phase_outputs"
  ],
  "reason": "Install the existing Memory phase checkpoint retirement and late-insert fence: observe Memory batch/job/dependency lifecycle and read current batch/job state while changing only this owner's phase outputs."
 },
 {
  "from": "apps/server/src/memory-phase-outputs.ts",
  "to": "memory_batches",
  "kind": "read",
  "symbol": "cd9253b956d2323f5fabc8fe8c80cce0b53f5bddd075788fad67cbddbbfd9753",
  "statementFingerprint": "e56e8d7b50759181c1449b0c952255dcc2b95716dfe97087359a5dbd91d0bd0a",
  "installer": "memoryPhaseOutputsSchemaInstallation",
  "callPath": [
   "memoryPhaseOutputsSchemaInstallation",
   "memoryPhaseOutputsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs",
   "memory_phase_outputs"
  ],
  "reason": "Install the existing Memory phase checkpoint retirement and late-insert fence: observe Memory batch/job/dependency lifecycle and read current batch/job state while changing only this owner's phase outputs."
 },
 {
  "from": "apps/server/src/memory-phase-outputs.ts",
  "to": "memory_jobs",
  "kind": "observe",
  "symbol": "cd9253b956d2323f5fabc8fe8c80cce0b53f5bddd075788fad67cbddbbfd9753",
  "statementFingerprint": "e56e8d7b50759181c1449b0c952255dcc2b95716dfe97087359a5dbd91d0bd0a",
  "installer": "memoryPhaseOutputsSchemaInstallation",
  "callPath": [
   "memoryPhaseOutputsSchemaInstallation",
   "memoryPhaseOutputsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs",
   "memory_phase_outputs"
  ],
  "reason": "Install the existing Memory phase checkpoint retirement and late-insert fence: observe Memory batch/job/dependency lifecycle and read current batch/job state while changing only this owner's phase outputs."
 },
 {
  "from": "apps/server/src/memory-phase-outputs.ts",
  "to": "memory_jobs",
  "kind": "read",
  "symbol": "cd9253b956d2323f5fabc8fe8c80cce0b53f5bddd075788fad67cbddbbfd9753",
  "statementFingerprint": "e56e8d7b50759181c1449b0c952255dcc2b95716dfe97087359a5dbd91d0bd0a",
  "installer": "memoryPhaseOutputsSchemaInstallation",
  "callPath": [
   "memoryPhaseOutputsSchemaInstallation",
   "memoryPhaseOutputsSchema"
  ],
  "sourceRelations": [
   "memory_batch_dependencies",
   "memory_batches",
   "memory_jobs",
   "memory_phase_outputs"
  ],
  "reason": "Install the existing Memory phase checkpoint retirement and late-insert fence: observe Memory batch/job/dependency lifecycle and read current batch/job state while changing only this owner's phase outputs."
 },
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
  "from": "apps/server/src/chat-storage-schema.ts",
  "to": "conversation_turns",
  "kind": "observe",
  "symbol": "22c21d3bf441b58d3edae8ac255f03f580428a4e8f81d0e21f720a954465715a",
  "statementFingerprint": "7241408afabccd57333b9782790ad9549a6b2ab234853b3d5f9ab1f6651c667f",
  "installer": "AssistantTaskStorage.constructor",
  "callPath": [
   "apps/server/src/chat-storage-schema.ts#assistantTaskStorageSchemaInstallation.install",
   "AssistantTaskStorage.constructor"
  ],
  "sourceRelations": [
   "conversation_turns",
   "task_records"
  ],
  "reason": "Observe the deletion of a source conversation turn to retire its dependent formal Task and erase private Task bodies."
 },
 {
  "rule": "sql-schema-maintenance",
  "from": "apps/server/src/chat-storage-schema.ts",
  "to": "task_records",
  "kind": "observe",
  "symbol": "22c21d3bf441b58d3edae8ac255f03f580428a4e8f81d0e21f720a954465715a",
  "statementFingerprint": "7241408afabccd57333b9782790ad9549a6b2ab234853b3d5f9ab1f6651c667f",
  "installer": "AssistantTaskStorage.constructor",
  "callPath": [
   "apps/server/src/chat-storage-schema.ts#assistantTaskStorageSchemaInstallation.install",
   "AssistantTaskStorage.constructor"
  ],
  "sourceRelations": [
   "conversation_turns",
   "task_records"
  ],
  "reason": "Observe stale Task state to erase its private scope snapshot in the same transaction."
 },
 {
  "rule": "sql-schema-maintenance",
  "from": "apps/server/src/chat-storage-schema.ts",
  "to": "task_records",
  "kind": "update",
  "symbol": "22c21d3bf441b58d3edae8ac255f03f580428a4e8f81d0e21f720a954465715a",
  "statementFingerprint": "7241408afabccd57333b9782790ad9549a6b2ab234853b3d5f9ab1f6651c667f",
  "installer": "AssistantTaskStorage.constructor",
  "callPath": [
   "apps/server/src/chat-storage-schema.ts#assistantTaskStorageSchemaInstallation.install",
   "AssistantTaskStorage.constructor"
  ],
  "sourceRelations": [
   "conversation_turns",
   "task_records"
  ],
  "reason": "Retire dependent Task revision and erase input/result bodies when its original conversation turn is deleted."
 },
 {
  "from": "apps/server/src/actions-schema.ts",
  "to": "captures",
  "kind": "observe",
  "symbol": "1eef015b456b4d2e9a36dd0d2a526fc45a8e369184676e02f709201dde0f31c7",
  "statementFingerprint": "a927bba01aa5c097a66f443d5d0cc0d4e629b6ddbb1e172090ead1330d20c53b",
  "installer": "actionsRetirementSchemaInstallation",
  "callPath": [
   "actionsRetirementSchemaInstallation",
   "actionsRetirementSchema"
  ],
  "sourceRelations": [
   "captures"
  ],
  "reason": "Observe original deletion to erase Action quotations and related pending snapshots in the same deletion transaction."
 },
 {
  "from": "apps/server/src/actions-schema.ts",
  "to": "captures",
  "kind": "observe",
  "symbol": "3be741035a5a00a1a0b806caf0a4c76d968101b6993ae964cc405efcbb5e3e56",
  "statementFingerprint": "fe627c3e3a2894cf68519e57035780a48c604a7e454758cfd49c457502e04277",
  "installer": "actionsRetirementSchemaInstallation",
  "callPath": [
   "actionsRetirementSchemaInstallation",
   "actionsRetirementSchema"
  ],
  "sourceRelations": [
   "captures"
  ],
  "reason": "Observe original deletion to erase Action quotations and related pending snapshots in the same deletion transaction."
 },
 {
  "from": "apps/server/src/actions-schema.ts",
  "to": "execution_steps",
  "kind": "observe",
  "symbol": "964f03614342d3c0dc7d93342ae37e60b51c23960ef778c478085dc27c39ca52",
  "statementFingerprint": "de83fcf9e19234be907f7121ff03c07fe617e42bef6c5413e8676647b1b74816",
  "installer": "actionsExecutionSchemaInstallation",
  "callPath": [
   "actionsExecutionSchemaInstallation",
   "actionsExecutionSchemaInstallation.install"
  ],
  "sourceRelations": [
   "execution_steps"
  ],
  "reason": "Observe actions.extract transitions of the existing Engine to project only Action job status and attempt counts."
 },
 {
  "from": "apps/server/src/actions-schema.ts",
  "to": "file_artifacts",
  "kind": "observe",
  "symbol": "694a4074dd91cab0509d431dd00f480b0b8bf75a5c221d832c04c586a9436512",
  "statementFingerprint": "e3a33ec70c81f2f9df7db8dfdec434589cbecfa16405fc145f489e35635710cd",
  "installer": "actionsSchemaInstallation",
  "callPath": [
   "actionsSchemaInstallation",
   "actionsSchema"
  ],
  "sourceRelations": [
   "file_artifacts",
   "file_chunks"
  ],
  "reason": "Observe canonical file artifact selection changes to enqueue only affected Action input IDs."
 },
 {
  "from": "apps/server/src/actions-schema.ts",
  "to": "file_chunks",
  "kind": "observe",
  "symbol": "265004b22b5f78c46dd74c4a98f9b013f2fe9012a2d1800f06b8ae373385bb94",
  "statementFingerprint": "a927bba01aa5c097a66f443d5d0cc0d4e629b6ddbb1e172090ead1330d20c53b",
  "installer": "actionsRetirementSchemaInstallation",
  "callPath": [
   "actionsRetirementSchemaInstallation",
   "actionsRetirementSchema"
  ],
  "sourceRelations": [
   "file_chunks"
  ],
  "reason": "Observe chunk deletion to erase Action quotations and related pending snapshots in the same deletion transaction."
 },
 {
  "from": "apps/server/src/actions-schema.ts",
  "to": "file_chunks",
  "kind": "observe",
  "symbol": "694a4074dd91cab0509d431dd00f480b0b8bf75a5c221d832c04c586a9436512",
  "statementFingerprint": "e3a33ec70c81f2f9df7db8dfdec434589cbecfa16405fc145f489e35635710cd",
  "installer": "actionsSchemaInstallation",
  "callPath": [
   "actionsSchemaInstallation",
   "actionsSchema"
  ],
  "sourceRelations": [
   "file_artifacts",
   "file_chunks"
  ],
  "reason": "Observe installed file-chunk changes to update only the Actions dirty-input queue."
 },
 {
  "from": "apps/server/src/actions-schema.ts",
  "to": "file_chunks",
  "kind": "observe",
  "symbol": "9b131c584ee83eb7480965bdf7d77e9b395c7ffbf89338a82c4195cb45455100",
  "statementFingerprint": "fe627c3e3a2894cf68519e57035780a48c604a7e454758cfd49c457502e04277",
  "installer": "actionsRetirementSchemaInstallation",
  "callPath": [
   "actionsRetirementSchemaInstallation",
   "actionsRetirementSchema"
  ],
  "sourceRelations": [
   "file_chunks"
  ],
  "reason": "Observe chunk deletion to erase Action quotations and related pending snapshots in the same deletion transaction."
 },
 {
  "from": "apps/server/src/actions-schema.ts",
  "to": "file_chunks",
  "kind": "read",
  "symbol": "694a4074dd91cab0509d431dd00f480b0b8bf75a5c221d832c04c586a9436512",
  "statementFingerprint": "e3a33ec70c81f2f9df7db8dfdec434589cbecfa16405fc145f489e35635710cd",
  "installer": "actionsSchemaInstallation",
  "callPath": [
   "actionsSchemaInstallation",
   "actionsSchema"
  ],
  "sourceRelations": [
   "file_artifacts",
   "file_chunks"
  ],
  "reason": "Read only chunk IDs of the changed artifact into the Actions-owned dirty-input queue."
 }
,{"rule":"sql-schema-maintenance","from":"apps/server/src/delegation-schema.ts","to":"changes","kind":"observe","symbol":"de1094b0b7667e4c918b0e65bbbc6dbe8c04ebe09b89aadf1445ba53f9af00e3","statementFingerprint":"b6bcadd99f84cbccf0652d5f6dd45683bd0d0a9cc0bdb613f688b1389af99952","installer":"delegationJournalSchemaInstallation","callPath":["delegationJournalSchemaInstallation","delegationJournalSchemaInstallation.install"],"sourceRelations":["changes"],"reason":"Observe only original deletion events from Capture changes; retire private Delegation rows and metadata only within this same journal owner."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"archived_files","kind":"observe","symbol":"2085d0a071d7db6b0c208c4f2898b7491755243dd6e650c8ad7b4640e1df5eab","statementFingerprint":"3db5ef14762f21ddfbb798bde000ebb1e4c80068e7112d958a1e06c7869376e0","installer":"assetArchivedFilesReferencesInstallation","callPath":["assetArchivedFilesReferencesInstallation","assetArchivedFilesReferencesSchema"],"sourceRelations":["archived_files"],"reason":"Original fixed schema construction: observe on archived_files is limited to assetArchivedFilesReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"artifact_dependencies","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on artifact_dependencies is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"artifact_dependencies","kind":"read","symbol":"55cfdbfc6bf9dfe80e39f8a5ff312fee096f55cc9d478d2a58beabee7f9d3469","statementFingerprint":"c25c60a624722088a31b95a9a4a5c77b4b5e83e98cc05d2921027e6a4c7c2df3","installer":"evidenceDependenciesWithoutMaterialsInstallation","callPath":["evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithoutMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on artifact_dependencies is limited to evidenceDependenciesWithoutMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"artifact_inputs","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on artifact_inputs is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"artifact_inputs","kind":"read","symbol":"55cfdbfc6bf9dfe80e39f8a5ff312fee096f55cc9d478d2a58beabee7f9d3469","statementFingerprint":"c25c60a624722088a31b95a9a4a5c77b4b5e83e98cc05d2921027e6a4c7c2df3","installer":"evidenceDependenciesWithoutMaterialsInstallation","callPath":["evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithoutMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on artifact_inputs is limited to evidenceDependenciesWithoutMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"delete","symbol":"0f024c319f4b00e5a788af32d14d8e3e75bfeb0d0b08dae37615b357aadcb23b","statementFingerprint":"859b2d1edc34fa0144e5b89b4a775bc4ed5b10eafee159c04f3d13401a95eb98","installer":"assetSnapshotInputsReferencesInstallation","callPath":["assetSnapshotInputsReferencesInstallation","assetSnapshotInputsReferencesSchema"],"sourceRelations":["file_snapshot_inputs"],"reason":"Original fixed schema construction: delete on asset_references is limited to assetSnapshotInputsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"delete","symbol":"2085d0a071d7db6b0c208c4f2898b7491755243dd6e650c8ad7b4640e1df5eab","statementFingerprint":"3db5ef14762f21ddfbb798bde000ebb1e4c80068e7112d958a1e06c7869376e0","installer":"assetArchivedFilesReferencesInstallation","callPath":["assetArchivedFilesReferencesInstallation","assetArchivedFilesReferencesSchema"],"sourceRelations":["archived_files"],"reason":"Original fixed schema construction: delete on asset_references is limited to assetArchivedFilesReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"delete","symbol":"24e25c0b15c85bae08ec3502944c7286beeda4b7fa61d2af77143df4b3e1c7a8","statementFingerprint":"9f947cbc07f08dcd1e4b939c6e944030da7c9e7712b1205751010705af3a45a4","installer":"assetFileAssetsReferencesInstallation","callPath":["assetFileAssetsReferencesInstallation","assetFileAssetsReferencesSchema"],"sourceRelations":["file_assets"],"reason":"Original fixed schema construction: delete on asset_references is limited to assetFileAssetsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"delete","symbol":"378b05d3ebeb7b45daa2164ec344812f6ba9bad1492c98e7028ddb3435ebbfde","statementFingerprint":"65f86ecd49d673bbd5c74e1be3c88324b38fba78c61d691738bd79ae6a07588b","installer":"assetFileVersionsReferencesInstallation","callPath":["assetFileVersionsReferencesInstallation","assetFileVersionsReferencesSchema"],"sourceRelations":["file_versions"],"reason":"Original fixed schema construction: delete on asset_references is limited to assetFileVersionsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"delete","symbol":"996aec6f066971ed7d2c9fdd6238e6f9649a8de7f97577ac7b81e93f360db77b","statementFingerprint":"6d23ea1878fd66cfe2ceaf4c6656acbae2c1628c50df26a32751e76e3e172bac","installer":"assetCaptureReferencesInstallation","callPath":["assetCaptureReferencesInstallation","assetCaptureReferencesSchema"],"sourceRelations":["captures"],"reason":"Original fixed schema construction: delete on asset_references is limited to assetCaptureReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"delete","symbol":"f2918daadfbbed46d1f6fc09526384f9ac58e25884c8ad2c1e9db69e6d42e2ec","statementFingerprint":"dd93fa7f55a5209f826a5cf9e6f70da9b311e22baac50d0cf39e6654208600f7","installer":"assetSnapshotTextReferencesInstallation","callPath":["assetSnapshotTextReferencesInstallation","assetSnapshotTextReferencesSchema"],"sourceRelations":["file_snapshot_text"],"reason":"Original fixed schema construction: delete on asset_references is limited to assetSnapshotTextReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"insert","symbol":"0f024c319f4b00e5a788af32d14d8e3e75bfeb0d0b08dae37615b357aadcb23b","statementFingerprint":"859b2d1edc34fa0144e5b89b4a775bc4ed5b10eafee159c04f3d13401a95eb98","installer":"assetSnapshotInputsReferencesInstallation","callPath":["assetSnapshotInputsReferencesInstallation","assetSnapshotInputsReferencesSchema"],"sourceRelations":["file_snapshot_inputs"],"reason":"Original fixed schema construction: insert on asset_references is limited to assetSnapshotInputsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"insert","symbol":"2085d0a071d7db6b0c208c4f2898b7491755243dd6e650c8ad7b4640e1df5eab","statementFingerprint":"3db5ef14762f21ddfbb798bde000ebb1e4c80068e7112d958a1e06c7869376e0","installer":"assetArchivedFilesReferencesInstallation","callPath":["assetArchivedFilesReferencesInstallation","assetArchivedFilesReferencesSchema"],"sourceRelations":["archived_files"],"reason":"Original fixed schema construction: insert on asset_references is limited to assetArchivedFilesReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"insert","symbol":"24e25c0b15c85bae08ec3502944c7286beeda4b7fa61d2af77143df4b3e1c7a8","statementFingerprint":"9f947cbc07f08dcd1e4b939c6e944030da7c9e7712b1205751010705af3a45a4","installer":"assetFileAssetsReferencesInstallation","callPath":["assetFileAssetsReferencesInstallation","assetFileAssetsReferencesSchema"],"sourceRelations":["file_assets"],"reason":"Original fixed schema construction: insert on asset_references is limited to assetFileAssetsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"insert","symbol":"378b05d3ebeb7b45daa2164ec344812f6ba9bad1492c98e7028ddb3435ebbfde","statementFingerprint":"65f86ecd49d673bbd5c74e1be3c88324b38fba78c61d691738bd79ae6a07588b","installer":"assetFileVersionsReferencesInstallation","callPath":["assetFileVersionsReferencesInstallation","assetFileVersionsReferencesSchema"],"sourceRelations":["file_versions"],"reason":"Original fixed schema construction: insert on asset_references is limited to assetFileVersionsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"insert","symbol":"996aec6f066971ed7d2c9fdd6238e6f9649a8de7f97577ac7b81e93f360db77b","statementFingerprint":"6d23ea1878fd66cfe2ceaf4c6656acbae2c1628c50df26a32751e76e3e172bac","installer":"assetCaptureReferencesInstallation","callPath":["assetCaptureReferencesInstallation","assetCaptureReferencesSchema"],"sourceRelations":["captures"],"reason":"Original fixed schema construction: insert on asset_references is limited to assetCaptureReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"asset_references","kind":"insert","symbol":"f2918daadfbbed46d1f6fc09526384f9ac58e25884c8ad2c1e9db69e6d42e2ec","statementFingerprint":"dd93fa7f55a5209f826a5cf9e6f70da9b311e22baac50d0cf39e6654208600f7","installer":"assetSnapshotTextReferencesInstallation","callPath":["assetSnapshotTextReferencesInstallation","assetSnapshotTextReferencesSchema"],"sourceRelations":["file_snapshot_text"],"reason":"Original fixed schema construction: insert on asset_references is limited to assetSnapshotTextReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"captures","kind":"observe","symbol":"996aec6f066971ed7d2c9fdd6238e6f9649a8de7f97577ac7b81e93f360db77b","statementFingerprint":"6d23ea1878fd66cfe2ceaf4c6656acbae2c1628c50df26a32751e76e3e172bac","installer":"assetCaptureReferencesInstallation","callPath":["assetCaptureReferencesInstallation","assetCaptureReferencesSchema"],"sourceRelations":["captures"],"reason":"Original fixed schema construction: observe on captures is limited to assetCaptureReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"context_artifacts","kind":"delete","symbol":"ab79c0730d3def38c2ca77601d039b566cd4078326b6e754c1c8a4b8afa518f0","statementFingerprint":"cbd50b2ef94b8ae4b9301cd3a810ce77c77ce03f84c8a119e4c46c60490738a0","installer":"evidenceMaterialLineageSchemaInstallation","callPath":["evidenceMaterialLineageSchemaInstallation","evidenceMaterialLineageSchema"],"sourceRelations":["material_heads"],"reason":"Original fixed schema construction: delete on context_artifacts is limited to evidenceMaterialLineageSchemaInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"file_artifacts","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on file_artifacts is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"file_artifacts","kind":"read","symbol":"55cfdbfc6bf9dfe80e39f8a5ff312fee096f55cc9d478d2a58beabee7f9d3469","statementFingerprint":"c25c60a624722088a31b95a9a4a5c77b4b5e83e98cc05d2921027e6a4c7c2df3","installer":"evidenceDependenciesWithoutMaterialsInstallation","callPath":["evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithoutMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on file_artifacts is limited to evidenceDependenciesWithoutMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"file_assets","kind":"observe","symbol":"24e25c0b15c85bae08ec3502944c7286beeda4b7fa61d2af77143df4b3e1c7a8","statementFingerprint":"9f947cbc07f08dcd1e4b939c6e944030da7c9e7712b1205751010705af3a45a4","installer":"assetFileAssetsReferencesInstallation","callPath":["assetFileAssetsReferencesInstallation","assetFileAssetsReferencesSchema"],"sourceRelations":["file_assets"],"reason":"Original fixed schema construction: observe on file_assets is limited to assetFileAssetsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"file_chunks","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on file_chunks is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"file_chunks","kind":"read","symbol":"55cfdbfc6bf9dfe80e39f8a5ff312fee096f55cc9d478d2a58beabee7f9d3469","statementFingerprint":"c25c60a624722088a31b95a9a4a5c77b4b5e83e98cc05d2921027e6a4c7c2df3","installer":"evidenceDependenciesWithoutMaterialsInstallation","callPath":["evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithoutMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on file_chunks is limited to evidenceDependenciesWithoutMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"file_snapshot_inputs","kind":"observe","symbol":"0f024c319f4b00e5a788af32d14d8e3e75bfeb0d0b08dae37615b357aadcb23b","statementFingerprint":"859b2d1edc34fa0144e5b89b4a775bc4ed5b10eafee159c04f3d13401a95eb98","installer":"assetSnapshotInputsReferencesInstallation","callPath":["assetSnapshotInputsReferencesInstallation","assetSnapshotInputsReferencesSchema"],"sourceRelations":["file_snapshot_inputs"],"reason":"Original fixed schema construction: observe on file_snapshot_inputs is limited to assetSnapshotInputsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"file_snapshot_text","kind":"observe","symbol":"f2918daadfbbed46d1f6fc09526384f9ac58e25884c8ad2c1e9db69e6d42e2ec","statementFingerprint":"dd93fa7f55a5209f826a5cf9e6f70da9b311e22baac50d0cf39e6654208600f7","installer":"assetSnapshotTextReferencesInstallation","callPath":["assetSnapshotTextReferencesInstallation","assetSnapshotTextReferencesSchema"],"sourceRelations":["file_snapshot_text"],"reason":"Original fixed schema construction: observe on file_snapshot_text is limited to assetSnapshotTextReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"file_versions","kind":"observe","symbol":"378b05d3ebeb7b45daa2164ec344812f6ba9bad1492c98e7028ddb3435ebbfde","statementFingerprint":"65f86ecd49d673bbd5c74e1be3c88324b38fba78c61d691738bd79ae6a07588b","installer":"assetFileVersionsReferencesInstallation","callPath":["assetFileVersionsReferencesInstallation","assetFileVersionsReferencesSchema"],"sourceRelations":["file_versions"],"reason":"Original fixed schema construction: observe on file_versions is limited to assetFileVersionsReferencesInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"material_evidence_dependencies","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on material_evidence_dependencies is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"material_evidence","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on material_evidence is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"material_heads","kind":"observe","symbol":"ab79c0730d3def38c2ca77601d039b566cd4078326b6e754c1c8a4b8afa518f0","statementFingerprint":"cbd50b2ef94b8ae4b9301cd3a810ce77c77ce03f84c8a119e4c46c60490738a0","installer":"evidenceMaterialLineageSchemaInstallation","callPath":["evidenceMaterialLineageSchemaInstallation","evidenceMaterialLineageSchema"],"sourceRelations":["material_heads"],"reason":"Original fixed schema construction: observe on material_heads is limited to evidenceMaterialLineageSchemaInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"memories","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on memories is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"memories","kind":"read","symbol":"55cfdbfc6bf9dfe80e39f8a5ff312fee096f55cc9d478d2a58beabee7f9d3469","statementFingerprint":"c25c60a624722088a31b95a9a4a5c77b4b5e83e98cc05d2921027e6a4c7c2df3","installer":"evidenceDependenciesWithoutMaterialsInstallation","callPath":["evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithoutMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on memories is limited to evidenceDependenciesWithoutMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"memory_artifact_dependencies","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on memory_artifact_dependencies is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"memory_artifact_dependencies","kind":"read","symbol":"55cfdbfc6bf9dfe80e39f8a5ff312fee096f55cc9d478d2a58beabee7f9d3469","statementFingerprint":"c25c60a624722088a31b95a9a4a5c77b4b5e83e98cc05d2921027e6a4c7c2df3","installer":"evidenceDependenciesWithoutMaterialsInstallation","callPath":["evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithoutMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on memory_artifact_dependencies is limited to evidenceDependenciesWithoutMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"memory_batch_dependencies","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on memory_batch_dependencies is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"memory_batch_dependencies","kind":"read","symbol":"55cfdbfc6bf9dfe80e39f8a5ff312fee096f55cc9d478d2a58beabee7f9d3469","statementFingerprint":"c25c60a624722088a31b95a9a4a5c77b4b5e83e98cc05d2921027e6a4c7c2df3","installer":"evidenceDependenciesWithoutMaterialsInstallation","callPath":["evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithoutMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on memory_batch_dependencies is limited to evidenceDependenciesWithoutMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"memory_dependencies","kind":"read","symbol":"31fc3eee2c89bab78b70d3cb90ce5fcdf06fcfbfe2d85f041f16ff4e5950149d","statementFingerprint":"7eaefd5bdf5c38b76c9b12ce39b1a312231dbbcae07c2aa89290fbfa2377ca5d","installer":"evidenceDependenciesWithMaterialsInstallation","callPath":["evidenceDependenciesWithMaterialsInstallation","evidenceDependenciesWithMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on memory_dependencies is limited to evidenceDependenciesWithMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/asset-evidence-schema.ts","to":"memory_dependencies","kind":"read","symbol":"55cfdbfc6bf9dfe80e39f8a5ff312fee096f55cc9d478d2a58beabee7f9d3469","statementFingerprint":"c25c60a624722088a31b95a9a4a5c77b4b5e83e98cc05d2921027e6a4c7c2df3","installer":"evidenceDependenciesWithoutMaterialsInstallation","callPath":["evidenceDependenciesWithoutMaterialsInstallation","evidenceDependenciesWithoutMaterialsSchema"],"sourceRelations":[],"reason":"Original fixed schema construction: read on memory_dependencies is limited to evidenceDependenciesWithoutMaterialsInstallation and its concrete installation path."},{"from":"apps/server/src/material-organizers.ts","to":"capture_files","kind":"observe","symbol":"ccba42261fb838f35661c9e9469d52441d4256560e71ed62a891e7574cdc2ef3","statementFingerprint":"760f84b827b8766cb65d46c2a7bf74627a5bea88837fae0940bb4cd087d8014d","installer":"MaterialOrganizerRuntime.constructor","callPath":["apps/server/src/plugins/material-organizer-service.ts#createMaterialOrganizerService","MaterialOrganizerRuntime.constructor"],"sourceRelations":["capture_files","captures","file_artifacts","file_chunks","file_jobs"],"reason":"Original fixed schema construction: observe on capture_files is limited to MaterialOrganizerRuntime.constructor and its concrete installation path."},{"from":"apps/server/src/material-organizers.ts","to":"captures","kind":"observe","symbol":"ccba42261fb838f35661c9e9469d52441d4256560e71ed62a891e7574cdc2ef3","statementFingerprint":"760f84b827b8766cb65d46c2a7bf74627a5bea88837fae0940bb4cd087d8014d","installer":"MaterialOrganizerRuntime.constructor","callPath":["apps/server/src/plugins/material-organizer-service.ts#createMaterialOrganizerService","MaterialOrganizerRuntime.constructor"],"sourceRelations":["capture_files","captures","file_artifacts","file_chunks","file_jobs"],"reason":"Original fixed schema construction: observe on captures is limited to MaterialOrganizerRuntime.constructor and its concrete installation path."},{"from":"apps/server/src/material-organizers.ts","to":"changes","kind":"insert","symbol":"ccba42261fb838f35661c9e9469d52441d4256560e71ed62a891e7574cdc2ef3","statementFingerprint":"760f84b827b8766cb65d46c2a7bf74627a5bea88837fae0940bb4cd087d8014d","installer":"MaterialOrganizerRuntime.constructor","callPath":["apps/server/src/plugins/material-organizer-service.ts#createMaterialOrganizerService","MaterialOrganizerRuntime.constructor"],"sourceRelations":["capture_files","captures","file_artifacts","file_chunks","file_jobs"],"reason":"Original fixed schema construction: insert on changes is limited to MaterialOrganizerRuntime.constructor and its concrete installation path."},{"from":"apps/server/src/material-organizers.ts","to":"file_artifacts","kind":"observe","symbol":"ccba42261fb838f35661c9e9469d52441d4256560e71ed62a891e7574cdc2ef3","statementFingerprint":"760f84b827b8766cb65d46c2a7bf74627a5bea88837fae0940bb4cd087d8014d","installer":"MaterialOrganizerRuntime.constructor","callPath":["apps/server/src/plugins/material-organizer-service.ts#createMaterialOrganizerService","MaterialOrganizerRuntime.constructor"],"sourceRelations":["capture_files","captures","file_artifacts","file_chunks","file_jobs"],"reason":"Original fixed schema construction: observe on file_artifacts is limited to MaterialOrganizerRuntime.constructor and its concrete installation path."},{"from":"apps/server/src/material-organizers.ts","to":"file_chunks","kind":"observe","symbol":"ccba42261fb838f35661c9e9469d52441d4256560e71ed62a891e7574cdc2ef3","statementFingerprint":"760f84b827b8766cb65d46c2a7bf74627a5bea88837fae0940bb4cd087d8014d","installer":"MaterialOrganizerRuntime.constructor","callPath":["apps/server/src/plugins/material-organizer-service.ts#createMaterialOrganizerService","MaterialOrganizerRuntime.constructor"],"sourceRelations":["capture_files","captures","file_artifacts","file_chunks","file_jobs"],"reason":"Original fixed schema construction: observe on file_chunks is limited to MaterialOrganizerRuntime.constructor and its concrete installation path."},{"from":"apps/server/src/material-organizers.ts","to":"file_jobs","kind":"observe","symbol":"ccba42261fb838f35661c9e9469d52441d4256560e71ed62a891e7574cdc2ef3","statementFingerprint":"760f84b827b8766cb65d46c2a7bf74627a5bea88837fae0940bb4cd087d8014d","installer":"MaterialOrganizerRuntime.constructor","callPath":["apps/server/src/plugins/material-organizer-service.ts#createMaterialOrganizerService","MaterialOrganizerRuntime.constructor"],"sourceRelations":["capture_files","captures","file_artifacts","file_chunks","file_jobs"],"reason":"Original fixed schema construction: observe on file_jobs is limited to MaterialOrganizerRuntime.constructor and its concrete installation path."},{"from":"apps/server/src/material-schema.ts","to":"asset_references","kind":"delete","symbol":"01f4536b0d171d4d9bf94c862a9e6e67f5eae71d1488d364b92cfee5f60cdf10","statementFingerprint":"798a8e28445985ecc9b573c3aff41b154a7fe7070ec83bea771b47b0845640a6","installer":"materialSchemaInstallation","callPath":["materialSchemaInstallation","materialSchema"],"sourceRelations":["captures","material_block_versions","material_blocks","material_heads"],"reason":"Original fixed schema construction: delete on asset_references is limited to materialSchemaInstallation and its concrete installation path."},{"from":"apps/server/src/material-schema.ts","to":"asset_references","kind":"insert","symbol":"01f4536b0d171d4d9bf94c862a9e6e67f5eae71d1488d364b92cfee5f60cdf10","statementFingerprint":"798a8e28445985ecc9b573c3aff41b154a7fe7070ec83bea771b47b0845640a6","installer":"materialSchemaInstallation","callPath":["materialSchemaInstallation","materialSchema"],"sourceRelations":["captures","material_block_versions","material_blocks","material_heads"],"reason":"Original fixed schema construction: insert on asset_references is limited to materialSchemaInstallation and its concrete installation path."},{"from":"apps/server/src/material-schema.ts","to":"captures","kind":"observe","symbol":"01f4536b0d171d4d9bf94c862a9e6e67f5eae71d1488d364b92cfee5f60cdf10","statementFingerprint":"798a8e28445985ecc9b573c3aff41b154a7fe7070ec83bea771b47b0845640a6","installer":"materialSchemaInstallation","callPath":["materialSchemaInstallation","materialSchema"],"sourceRelations":["captures","material_block_versions","material_blocks","material_heads"],"reason":"Original fixed schema construction: observe on captures is limited to materialSchemaInstallation and its concrete installation path."}];

/** Scope witnesses preserve existing unresolved access debt when its table owner becomes known. They are not grants. */
export const retainedClassificationScopes=[
 // The portable Material export already read these import declarations before
 // the import owner existed. Keep the exact unresolved reads as debt rather
 // than turning the new table owner into a cross-owner grant.
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/material-portable.ts",
  "to": "capture_import_declarations",
  "kind": "read",
  "symbol": "55e847dc44b3999d331aa725573531fabd46c710080332a2bdee41d0374f7354",
  "scope": "exportPortableMaterials",
  "scopeFingerprint": "d2c17a00575b5ae5ba932c51364e2830442ef3f5e3d5abde4d4e9306c00105e5",
  "operation": "read",
  "completeSql": true
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/material-portable.ts",
  "to": "import_owner_declarations",
  "kind": "read",
  "symbol": "0d51c79fb1a122d191ea2177fd8b68ec1b38026c20e3946d5524307c80536ad1",
  "scope": "portableMaterialEstimate",
  "scopeFingerprint": "6476a4b2469e481d21325287e2b67b452f4c9dd3d57a9652358b92b13e631dff",
  "operation": "read",
  "completeSql": true
 },
 // Keep the original Material-forget DELETE as exact unresolved write debt;
 // knowing its target owner does not grant this trigger any new write access.
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/material-memory-work.ts",
  "to": "memory_input_authorizations",
  "kind": "write",
  "symbol": "4519c685db0ff9e34515bd3054321837fdf0d9477526b80d152e1145d1b7b548",
  "scope": "MaterialMemoryWork.constructor",
  "scopeFingerprint": "2220edebc9aa3497c04ff01e2b53d46e6d96ca81904b97ea16b36b758991ddbe",
  "operation": "delete",
  "completeSql": true
 },
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
  "constructionFingerprint": "a3370f7fd36de943baa47b12eec02ba38434c7afaebbdc4ab759f8a8b668941a"
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
  "constructionFingerprint": "a3370f7fd36de943baa47b12eec02ba38434c7afaebbdc4ab759f8a8b668941a"
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
  "constructionFingerprint": "a3370f7fd36de943baa47b12eec02ba38434c7afaebbdc4ab759f8a8b668941a"
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
  "constructionFingerprint": "0b0b40b5b633f69ac9b0753705f6c42174104b0a020e9e47aaa8f6fad1e1dc7e"
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/evidence-store.ts",
  "to": "source_pipeline_bindings",
  "kind": "read",
  "symbol": "3cf81441c93e2b10bbd1e5e64c037517e3d898fb8b467ac209dddbc825756e7d",
  "scope": "EvidenceStore.exportArchive",
  "scopeFingerprint": "ec3905d1000d6389813a97e87f2bce4e214f168ed88d2a92d495fa9a154353d7",
  "operation": "read",
  "completeSql": true
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/material-portable.ts",
  "to": "source_context_declarations",
  "kind": "read",
  "symbol": "4d57227e9a17d096f28ed077fc8f5997542ae2e574cbcc92f7bb7feb43aa13bc",
  "scope": "exportPortableMaterials",
  "scopeFingerprint": "d2c17a00575b5ae5ba932c51364e2830442ef3f5e3d5abde4d4e9306c00105e5",
  "operation": "read",
  "completeSql": true
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/material-portable.ts",
  "to": "source_context_declarations",
  "kind": "read",
  "symbol": "61b67decb19ddea3c358d654a2197177bd7d6d3eed6cac1a5360fee13e5b9eb6",
  "scope": "portableMaterialEstimate",
  "scopeFingerprint": "6476a4b2469e481d21325287e2b67b452f4c9dd3d57a9652358b92b13e631dff",
  "operation": "read",
  "completeSql": true
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/material-source-pin.ts",
  "to": "source_pipeline_work",
  "kind": "read",
  "symbol": "0ee060d35490c8c76644aaf5106e44b3efef9c8fd888ed0c559f5331507cc97e",
  "scope": "materialSourcePin",
  "scopeFingerprint": "9b9816cac8adc40782be42f7fe85225278e7d61f9a0695e66aa0aa83eddfac4c",
  "operation": "read",
  "completeSql": true
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/source-archive-reader.ts",
  "to": "source_archive_sizes",
  "kind": "read",
  "symbol": "899ab76b784556136dc92b7741dbb381a07422a81b709da084076ce9764945a0",
  "scope": "SourceArchiveRawReader.page",
  "scopeFingerprint": "c8a3ef7f38c4a1395571a3dcc4c827992743d85edbc31a0cb8bedfc53d5cbe54",
  "operation": "read",
  "completeSql": true
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/source-archive-reader.ts",
  "to": "source_archive_sizes",
  "kind": "read",
  "symbol": "89feecf1ca3ce06c8bd9d53658c2a5e172832f9602ed3751f50dcb95308f2659",
  "scope": "SourceArchiveRawReader.sourceId",
  "scopeFingerprint": "e0641fdd33c510229d6ef2171b3cb0eabe91afd0d045748e7c75cb062310d0b2",
  "operation": "read",
  "completeSql": true
 },
 {
  "rule": "sql-uncovered-table",
  "from": "apps/server/src/source-context.ts",
  "to": "source_context_declarations",
  "kind": "write",
  "symbol": "8a86d33da7db56ad9b600ff5c33089ed8af48f7fda5134b4607d4ef267d5a274",
  "scope": "SourceContextStore.set",
  "scopeFingerprint": "32606ba9704638f033d828f7b0ba3aa84230c420a913ea7850973d8df6b673d8",
  "operation": "insert",
  "completeSql": true
 }
,{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_dependencies","kind":"read","symbol":"13209992d4444951c9bb99311bf1f99c5e56ae1252cad27b5f293c9351c9c11e","scope":"EvidenceStore.invalidateConversationAnswers","scopeFingerprint":"6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0","operation":"read","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_dependencies","kind":"read","symbol":"4741849b0a7d33abbf38d15f9f3a2b546f6753755e94a82cad2a5e9816559950","scope":"EvidenceStore.installContextHistoryInvalidation","scopeFingerprint":"f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0","operation":"read","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_dependencies","kind":"read","symbol":"524142fd89ac5599b22cadded9a3c0d21f5462fedf3432d3c3b2c5dc8d38e13b","scope":"EvidenceStore.installContextHistoryInvalidation","scopeFingerprint":"f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0","operation":"read","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_dependencies","kind":"read","symbol":"aaec58b0731ec21bb902f8dfd29d1ea5c305306d9cc172ec816d0bc014409215","scope":"EvidenceStore.installContextHistoryInvalidation","scopeFingerprint":"f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0","operation":"read","completeSql":true},{"rule":"sql-unproved-relation","from":"apps/server/src/evidence-store.ts","to":"delegation_dependencies","kind":"read","symbol":"f8a6f87c0dba154b6d531cedc62bb08d65a618b189aca78ff122f56341c8fb97","scope":"EvidenceStore.installContextHistoryInvalidation","scopeFingerprint":"f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0","operation":"read","completeSql":false},{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_units","kind":"write","symbol":"007f1921387668c8e1247827900acfb24c743fcfd4d696b8c3cc600037b997ac","scope":"EvidenceStore.invalidateConversationAnswers","scopeFingerprint":"6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0","operation":"update","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_units","kind":"write","symbol":"4741849b0a7d33abbf38d15f9f3a2b546f6753755e94a82cad2a5e9816559950","scope":"EvidenceStore.installContextHistoryInvalidation","scopeFingerprint":"f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0","operation":"update","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_works","kind":"read","symbol":"1d381cafb5711c30e41bfbe84af72906b91ed4965cb101167ffdbfd3256c4595","scope":"EvidenceStore.invalidateConversationAnswers","scopeFingerprint":"6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0","operation":"read","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_works","kind":"write","symbol":"524142fd89ac5599b22cadded9a3c0d21f5462fedf3432d3c3b2c5dc8d38e13b","scope":"EvidenceStore.installContextHistoryInvalidation","scopeFingerprint":"f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0","operation":"update","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/evidence-store.ts","to":"delegation_works","kind":"write","symbol":"7c7138c44a6ebea76bf7d00f5fc96c139d2241ec1f96dc99b9020c612bdc1fea","scope":"EvidenceStore.invalidateConversationAnswers","scopeFingerprint":"6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0","operation":"update","completeSql":true},{"from":"apps/server/src/evidence-store.ts","to":"archived_files","kind":"read","symbol":"a5718107bd946e3a83c450ac754aee4559db2f1eb7f52c254db7e6780638a825","scope":"EvidenceStore.importArchive","scopeFingerprint":"a0c7005591494ec2ea58ced654a2ded7ef9881bd7d783822c4bbedff02a3acb0","operation":"read","completeSql":true},{"from":"apps/server/src/evidence-store.ts","to":"capture_files","kind":"read","symbol":"00d756c1271bf8b0d7d3e800444b115d122c718b01a1ba2f717b77f0532859a3","scope":"EvidenceStore.exportArchive","scopeFingerprint":"ec3905d1000d6389813a97e87f2bce4e214f168ed88d2a92d495fa9a154353d7","operation":"read","completeSql":true},{"from":"apps/server/src/file-attachments.ts","to":"archived_files","kind":"read","symbol":"4a2ebe9754b7ba58aeab0c7d0995ca08fb7c5750dd8f9a7433c16c3addceecde","scope":"fileAttachmentParent","scopeFingerprint":"4e13390042fbad785ed9e054d4a0a01c36b61dd26e484b9c16434a25087b6ab5","operation":"read","completeSql":true},{"from":"apps/server/src/file-attachments.ts","to":"capture_files","kind":"read","symbol":"4a2ebe9754b7ba58aeab0c7d0995ca08fb7c5750dd8f9a7433c16c3addceecde","scope":"fileAttachmentParent","scopeFingerprint":"4e13390042fbad785ed9e054d4a0a01c36b61dd26e484b9c16434a25087b6ab5","operation":"read","completeSql":true},{"from":"apps/server/src/file-attachments.ts","to":"capture_files","kind":"read","symbol":"8901b00938d55abe1614d8725d433c682e04f07461bdbf41aee7ac7daafdef61","scope":"FileAttachments.prepare","scopeFingerprint":"301e1a06a7ade75c52f82c3fd26b4abcdf8b9d48b57ce8845508d75c1e8dd3ef","operation":"read","completeSql":true},{"from":"apps/server/src/file-raw-reader.ts","to":"archived_files","kind":"read","symbol":"9a9cd5755869fbb18591a91ddd4232fdf437cae45b322d0ce2591863c3d69d44","scope":"FileRawReader.page","scopeFingerprint":"6ec75b29a830b950a9b7c4fdbdd47eda3473172f224166c7cdc4a2addb6a0a16","operation":"read","completeSql":true},{"from":"apps/server/src/material-organizers.ts","to":"archived_files","kind":"read","symbol":"ab997bb66c36184abbf7ecd199e059f6624b3389e259005bbcb88da55e59b707","scope":"organizerReader","scopeFingerprint":"b9cce37b8e194aa5f139052aa9b30e65d4f2efc32e7167600337ab7ff2dc2fca","operation":"read","completeSql":true},{"from":"apps/server/src/material-organizers.ts","to":"capture_files","kind":"read","symbol":"ab997bb66c36184abbf7ecd199e059f6624b3389e259005bbcb88da55e59b707","scope":"organizerReader","scopeFingerprint":"b9cce37b8e194aa5f139052aa9b30e65d4f2efc32e7167600337ab7ff2dc2fca","operation":"read","completeSql":true},{"from":"apps/server/src/material-portable.ts","to":"assets","kind":"read","symbol":"013d228ad792f3a89766b4795eb2336b0ac9fdddc13e11179b25c633dcd5b9b2","scope":"portableMaterialEstimate","scopeFingerprint":"6476a4b2469e481d21325287e2b67b452f4c9dd3d57a9652358b92b13e631dff","operation":"read","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/material-portable.ts","to":"record_context_declarations","kind":"read","symbol":"761c26403ff7ec7c33e506df60dc4d5d79eced19cdaba690e15434ff5c1a4287","scope":"exportPortableMaterials","scopeFingerprint":"d2c17a00575b5ae5ba932c51364e2830442ef3f5e3d5abde4d4e9306c00105e5","operation":"read","completeSql":true},{"rule":"sql-uncovered-table","from":"apps/server/src/material-portable.ts","to":"record_context_declarations","kind":"read","symbol":"dccbb45dbcc3a08f362338e38cd694e6ad80ad33f8547f74ac61d37b87dfb245","scope":"portableMaterialEstimate","scopeFingerprint":"6476a4b2469e481d21325287e2b67b452f4c9dd3d57a9652358b92b13e631dff","operation":"read","completeSql":true}];

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
  "moduleFingerprint": "f049045c4327b55ca3dadcae2c2eae9bdb06339ab946c1382cc569284ea00ebf",
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
  "moduleFingerprint": "8fbb9b878b096eda4c5da562e5185da94b5f4046e5b66e75d9f5c94c4b81f9c1",
  "scopeFingerprint": "94f1d4ce571c3d0d412b5fced7cded68fdc47b21b999bdb7237578209e7f4b1c",
  "callFingerprint": "3d906b2269f1ad4ee39e3c5161d750d5f20bab1ccac157f6b30bc6d8ad1663cc",
  "bindingFingerprint": "2d05845989f54f3e2c061756d456fbc2b7c19054c00fbd8549f74b294877cf4c",
  "assignmentFingerprint": "e30ea9bd2415ba9abdc28b809cc47c018cb799506b2c67923c3706231c4b14a3",
  "importFingerprint": "91c632ad6f9ebcd86c2183a7d687309531b2c04f4e2d976be04799cb9366e3c9",
  "definitionModuleFingerprint": "24ffcf6df74bbef1921c520e114abc96a4dfd688699af5285608c3b9dfc20e38",
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
  "moduleFingerprint": "8fbb9b878b096eda4c5da562e5185da94b5f4046e5b66e75d9f5c94c4b81f9c1",
  "scopeFingerprint": "94f1d4ce571c3d0d412b5fced7cded68fdc47b21b999bdb7237578209e7f4b1c",
  "callFingerprint": "1a8498f52fc1e958977fa07a005043d951c0beddeb51997bfa9b2eb241ad7507",
  "bindingFingerprint": "61cf8fed3926ae5cd5698e04777fd48667042dccb961ed0470425f89c0b22f8a",
  "assignmentFingerprint": "40acd4e8a4e63ee3ce8741171a182adb1c7fe024aba9c5ec1d640ccd426fef72",
  "importFingerprint": "a26883f189017cf6e9d1abb3403624641d4e16008537a6dd7b3fb617d77eb137",
  "definitionModuleFingerprint": "cf5aceedc1534d4478ec3061c467771b499d12470895c645b1dae1d73e68de6f",
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
  "moduleFingerprint": "a0ca20ef6a7a56c09fc581d761fef06442c733283b921a49f8a0f90ebd58b04f",
  "scopeFingerprint": "bc1e5ce99a96e675d0de9b078fcd85a31f8798fe60150ecab8ba92bb82f501c1",
  "callFingerprint": "9104236b78880379928fdb6b2d187dac91fbc78fef00cba42700d3204be1cb92",
  "bindingFingerprint": "24b35046071f00a309bc8d34c268875e54380dbd8cafd6cead740e73c2cbda69",
  "assignmentFingerprint": "a1f49ec32ae112722e98331323257c139ebaca1d2e3a0604c1a96a75ae8755c1",
  "importFingerprint": "2ea0a997a5352c58cc652eeb49a1073b2cafef6aca8d1d603f16e5aaebcd0e05",
  "definitionModuleFingerprint": "8fbb9b878b096eda4c5da562e5185da94b5f4046e5b66e75d9f5c94c4b81f9c1",
  "definitionFingerprint": "94f1d4ce571c3d0d412b5fced7cded68fdc47b21b999bdb7237578209e7f4b1c",
  "reason": "Exact imported Task adapter prepares a QueryInput through its statically bound class method; the call is not a SQLite statement."
 },
 {
   "kind": "local-resource-method",
   "from": "apps/server/src/agent-runtime-registry.ts",
   "scope": "AgentRuntimeRegistry.prepareModels",
   "receiver": "super",
   "method": "prepare",
   "className": "AgentRuntimeRegistry",
   "entryType": "ReloadableAgent",
   "definitionFile": "apps/server/src/agent-runtime-registry.ts",
   "parameterType": "QueryAgent",
   "occurrence": 1,
   "classHeaderFingerprint": "5a677d9189c951705fa439130d705e0c56b1bade1088242a06a294fce5a94665",
   "definitionClassHeaderFingerprint": "d7665abb488a010289aaf150b03742143a8465bb11e2d06842b35d03bcce701c",
   "definitionFingerprint": "38beea3354d0491f0d8608da64b52ccbf8094168558c5bd44b2a966cf5d5f698",
   "callFingerprint": "68f98e9fbdd9be78073a97ec0648d7bd4df6b4dd425dda921362011fb30cd77b",
   "argumentBindingsFingerprint": "afc76f13965c1b19dcf79b6d4520925b83403dd6ace97456243a29f4264346ea",
   "reason": "Exact super.prepare resource lifecycle call, bound to its local class declaration, direct heritage where applicable, implementation and actual argument bindings; database calls inside the method remain scanned."
 },
 {
   "kind": "local-resource-method",
   "from": "apps/server/src/model-settings.ts",
   "scope": "ModelSettingsStore.initialize",
   "receiver": "this",
   "method": "prepare",
   "className": "ModelSettingsStore",
   "entryType": "ModelSettingsStore",
   "definitionFile": "apps/server/src/model-settings.ts",
   "parameterType": "ModelDomain",
   "occurrence": 1,
   "classHeaderFingerprint": "f3e638dbc62adc62e601350f633f1e6ac8ed972c0f8b440c57af36dcc97737f0",
   "definitionClassHeaderFingerprint": "f3e638dbc62adc62e601350f633f1e6ac8ed972c0f8b440c57af36dcc97737f0",
   "definitionFingerprint": "57ba8eba1cc00f33b770a3eaaa9e84592648f0ae8f4034f0fd036dc3d22ec0e2",
   "callFingerprint": "1ef836fd9a53701bbe4b3df3597e206ce9cc5b3813da953f321ea70b50391734",
   "argumentBindingsFingerprint": "1da0e0d2cbc8d4fa35a80d55b718cceed9f02857fc8f8ebe3f59b74afbd198ff",
   "reason": "Exact this.prepare resource lifecycle call, bound to its local class declaration, direct heritage where applicable, implementation and actual argument bindings; database calls inside the method remain scanned."
 },
 {
   "kind": "working-memory-port",
   "from": "apps/server/src/plugins/query-preparation.ts",
   "scope": "prepare",
   "receiver": "working",
   "method": "prepare",
   "entryType": "WorkingMemory",
   "occurrence": 1,
   "callFingerprint": "a15f54de6ed5c2de279f62007d8cdc008819b82814105588ad9ce4fffbefc438",
   "scopeFingerprint": "d1a9e0aa81637036e60db398181603f1bd897c647c99ee406bbebac39edebfca",
   "queryRunsFingerprint": "0020572e46126aa45ba9b48ca4bd473be185d6f355483ac8134243ae4f56ccc5",
   "queryAssemblyFingerprint": "cc3a3fe08c1ec5c73c1e8727baa45f4dc806c8877cf5ba316da723b346ae2f73",
   "hostFingerprint": "653e7156cc23a1bb9722144be4dda3c070d7457c6a66491a2dc1c7f977d81367",
   "memoryAssemblyFingerprint": "4e43052f63a33cd9ace516a8fd15a5014f523d996941eebf024611e22dd86705",
   "lifecycleFingerprint": "4f89c902c1471d00c6d7ca0f001894998918aaec22cb047004986cc1d0d7bf18",
   "definitionFingerprint": "2297635951754863c6388ee6a479d3f10c4b425f2a35a905f2a735a9aef352f6",
   "reason": "Only the exact WorkingMemory conversation-context method reached through the fixed typed production injection chain is non-SQL; its internal storage and all other prepare calls remain checked."
 }
];

/** Existing construction claims are separate from formal SchemaInstallation owners. */
export const importedHelpers=[
 {
  "from": "apps/server/src/chat-storage-schema.ts",
  "scope": "AssistantTaskStorage.constructor",
  "name": "retireTaskRecordsSql",
  "definitionFile": "apps/server/src/task-evidence.ts",
  "importFingerprint": "78c693fc749b9a91d202cc9127cf46122227deb149e0452a1a0147bfd6f7de7d",
  "definitionModuleFingerprint": "1092b6557524a088764b93c8762469c6548bb870023a88d916326e0c1e48abb0",
  "definitionFingerprint": "5766030cc8f3da30e11feef88294493278724ff72f915de19eebbfd74dcfa02f",
  "callFingerprint": "ce0fa4e1dbee71c6501b0713390f072d64dfbcb340c0658b8ea83b9bc881ac67",
  "reason": "Resolve the exact pure Task retirement SQL in the existing constructor trigger; no runtime call inherits construction authority."
 }
];
export const storageConstructions=[
 {
  "owner": "conversation-turn-storage",
  "file": "chat-storage-schema.ts",
  "scope": "ConversationTurnStorage.constructor",
  "scopeFingerprint": "62aa1e7fabf43508ed4ec04fd3d80f6be461ed84ebea5c0bbcd120ef2e06f8e3",
  "statementFingerprint": "34dc14d97f7033b8bbe77138838d5e170d8a9e944733c3ea31f85b39c9d06e22",
  "sqlFingerprint": "8035dc47ba89154593130d6fad082d1e7223f1cc73083bf0bce6f7551c8a98ed",
  "calls": [
   {
    "from": "apps/server/src/chat-storage-schema.ts",
    "scope": "conversationTurnsSchemaInstallation.install",
    "scopeFingerprint": "81c8c9bd328b6f9e4ce14ea919cc2cc65cafb325ee4c1c4b02bd1c8beed05477",
    "callFingerprint": "0ccea4cff5629708cace77f160d06154eefc4ed283f4d07ae4673a65a7ad8d40",
    "declarationFingerprint": "c802e3144a78e5beacbf09b0e5e2c9e44f700e4ccb1d2a392d7a07a7a972a04b"
  }
  ],
  "reason": "Exact original DDL-only helper invoked by conversationTurnsSchemaInstallation at the original consumer construction stage."
 },
 {
  "owner": "query-run-storage",
  "file": "chat-storage-schema.ts",
  "scope": "QueryRunStorage.constructor",
  "scopeFingerprint": "83a0a69a83973f4a4c215cc36736d1162efba403e6cfa6e2eef3688661db7974",
  "statementFingerprint": "723e8df86dd441990b9c07d808e4b90688b0a97c609260080f58a7c574ed8082",
  "sqlFingerprint": "c981996000b54780c85af51a3f56feb414bd8f405e5b521ec94bbb0b999ba46d",
  "calls": [
   {
    "from": "apps/server/src/chat-storage-schema.ts",
    "scope": "queryRunSchemaInstallation.install",
    "scopeFingerprint": "1c2e1ba334458c10a52852d41e172ac1459cf0ee8ae1b048594eec3381387e53",
    "callFingerprint": "1b36ff134711c865ec61598291d3e826124d1a7e458e8964b102f8e183289ae1",
    "declarationFingerprint": "58ec814df0e68649c843a2f173c02ab04b660788803cbf8e86e64754e73b2281"
  }
  ],
  "reason": "Exact original DDL-only helper invoked by queryRunSchemaInstallation at the original consumer construction stage."
 },
 {
  "owner": "assistant-task-storage",
  "file": "chat-storage-schema.ts",
  "scope": "AssistantTaskStorage.constructor",
  "scopeFingerprint": "d860c25328b9d2b8ed909b4ec3b6c7cfc0ee954b6fa58d9971e7146340a56736",
  "statementFingerprint": "7241408afabccd57333b9782790ad9549a6b2ab234853b3d5f9ab1f6651c667f",
  "sqlFingerprint": "22c21d3bf441b58d3edae8ac255f03f580428a4e8f81d0e21f720a954465715a",
  "calls": [
   {
    "from": "apps/server/src/chat-storage-schema.ts",
    "scope": "assistantTaskStorageSchemaInstallation.install",
    "scopeFingerprint": "8875c71dd5a81eb10056aa75a66e4e81e51bbcaaf7adcfdfb099d3e5d5c135c6",
    "callFingerprint": "3aeab8642d7cc834211c72dd20500ab68d72462c8a4d4032e6efaa2d8215b5eb",
    "declarationFingerprint": "94b53b33d53d488ce5885d732b1cefa60b1052e0ce28132a0a3fdb6964845514"
  }
  ],
  "reason": "Exact original DDL-only helper invoked by assistantTaskStorageSchemaInstallation at the original consumer construction stage."
 }
,{"owner":"material","file":"material-organizers.ts","scope":"MaterialOrganizerRuntime.constructor","scopeFingerprint":"35e84d4c3067b9b336c1aaf1269a5c1d590086177399530b9a35fb9f65085785","statementFingerprint":"760f84b827b8766cb65d46c2a7bf74627a5bea88837fae0940bb4cd087d8014d","sqlFingerprint":"ccba42261fb838f35661c9e9469d52441d4256560e71ed62a891e7574cdc2ef3","calls":[{"from":"apps/server/src/plugins/material-organizer-service.ts","scope":"createMaterialOrganizerService","scopeFingerprint":"c6ff0f22fe689b748c5a022113be2210c5ef937bbd3f69a405e6d0326c453be9","callFingerprint":"b0b856702c10782d0f59a812e60f453b0a7e69a070da4dae02568189880f19d7","importFingerprint":"f9d0862611d40c1b72de2ac0774e1ce96d2e426970797dae2fd5f628028d50b5"}],"reason":"Exact existing Material organizer constructor DDL and its sole production construction call; only this schema statement is proved, while the constructor runtime cursor write and other scopes retain their current classification."}];
