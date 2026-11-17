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
