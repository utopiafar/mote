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
 }
];
