package dev.mote.collector.plugins

/** The build-native default inventory. Every component declared by the APK
 * manifest belongs to exactly one plugin package or to the explicit shell
 * primitive; every registered capability belongs to one package. */
internal data class NativeComponentOwner(
    val kind: String,
    val component: String,
    val packageId: String,
    val capability: String?,
)

internal data class NativeDefaultPackage(
    val packageId: String,
    val capabilities: List<String>,
    val optional: Boolean = true,
)

/** One manifest component plus the owner tag it carries in the packaged APK. */
internal data class NativeManifestComponent(
    val kind: String,
    val name: String,
    val owner: String?,
)

internal object NativeDefaultPluginInventory {
    const val HOST_SHELL = "host.shell"
    const val APPLICATION_CLASS = "dev.mote.collector.MoteApplication"

    val packages: List<NativeDefaultPackage> = listOf(
        NativeDefaultPackage("dev.mote.capture", listOf(CapturePlugin.PROJECTION_CAPABILITY, CapturePlugin.ACCESSIBILITY_CAPABILITY)),
        NativeDefaultPackage("dev.mote.durable-upload", listOf("mote.durable-upload")),
        NativeDefaultPackage("dev.mote.sources", listOf(SourceProviderPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.storage-backup", listOf(StorageBackupPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.system-entries", listOf(SystemEntriesPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.notes", listOf(NotesPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.library", listOf(NativeLibraryPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.ask", listOf(NativeAskPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.home", listOf(DailyHomePlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.work-discovery", listOf(NativeWorkDiscoveryPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.managed-calendar", listOf(ManagedCalendarPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.plugin-center", listOf(PluginCenterPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.administration", listOf(NativeAdministrationPlugin.CAPABILITY)),
        NativeDefaultPackage("dev.mote.system-tools", listOf(NativeSystemToolsPlugin.CAPABILITY)),
    )

    /** Activity, Service, Receiver and Provider entries exactly as the manifest
     * spells them after package-name normalization. */
    val componentOwners: List<NativeComponentOwner> = listOf(
        NativeComponentOwner("application", APPLICATION_CLASS, HOST_SHELL, null),
        NativeComponentOwner("activity", component("MainActivity"), HOST_SHELL, null),
        NativeComponentOwner("activity", component("CentralActivity"), HOST_SHELL, null),

        NativeComponentOwner("activity", component("CaptureStatusActivity"), "dev.mote.capture", CapturePlugin.PROJECTION_CAPABILITY),
        NativeComponentOwner("activity", component("CompressionPreviewActivity"), "dev.mote.capture", CapturePlugin.PROJECTION_CAPABILITY),
        NativeComponentOwner("service", component("ProjectionService"), "dev.mote.capture", CapturePlugin.PROJECTION_CAPABILITY),
        NativeComponentOwner("service", component("MediaCollectionService"), "dev.mote.capture", CapturePlugin.ACCESSIBILITY_CAPABILITY),
        NativeComponentOwner("service", component("CaptureAccessibilityService"), "dev.mote.capture", CapturePlugin.ACCESSIBILITY_CAPABILITY),
        NativeComponentOwner("receiver", component("StopReceiver"), "dev.mote.capture", CapturePlugin.PROJECTION_CAPABILITY),
        NativeComponentOwner("receiver", component("PauseScreenReceiver"), "dev.mote.capture", CapturePlugin.PROJECTION_CAPABILITY),

        NativeComponentOwner("activity", component("QuickEntryActivity"), "dev.mote.system-entries", SystemEntriesPlugin.CAPABILITY),
        NativeComponentOwner("service", component("ScreenCaptureTileService"), "dev.mote.system-entries", SystemEntriesPlugin.CAPABILITY),
        NativeComponentOwner("receiver", component("QuickEntryWidget"), "dev.mote.system-entries", SystemEntriesPlugin.CAPABILITY),

        NativeComponentOwner("activity", component("RecordEditorActivity"), "dev.mote.notes", NotesPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("ConversationRecordEditorActivity"), "dev.mote.notes", NotesPlugin.CAPABILITY),
        NativeComponentOwner("provider", "androidx.core.content.FileProvider", "dev.mote.notes", NotesPlugin.CAPABILITY),

        NativeComponentOwner("activity", component("CalendarActionsActivity"), "dev.mote.managed-calendar", ManagedCalendarPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("LibrarySourceReaderActivity"), "dev.mote.library", NativeLibraryPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("CaptureRecordsActivity"), "dev.mote.library", NativeLibraryPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("FileContentActivity"), "dev.mote.sources", SourceProviderPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("SourcesActivity"), "dev.mote.sources", SourceProviderPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("FileTaskActivity"), "dev.mote.sources", SourceProviderPlugin.CAPABILITY),

        NativeComponentOwner("activity", component("UploadHistorySettingsActivity"), "dev.mote.durable-upload", "mote.durable-upload"),
        NativeComponentOwner("activity", component("UploadOriginalActivity"), "dev.mote.durable-upload", "mote.durable-upload"),
        NativeComponentOwner("activity", component("UploadBatchActivity"), "dev.mote.durable-upload", "mote.durable-upload"),
        NativeComponentOwner("activity", component("SyncQueueActivity"), "dev.mote.durable-upload", "mote.durable-upload"),
        NativeComponentOwner("activity", component("SyncRecoveryActivity"), "dev.mote.durable-upload", "mote.durable-upload"),

        NativeComponentOwner("activity", component("StartUsingActivity"), "dev.mote.administration", NativeAdministrationPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("ConnectionActivity"), "dev.mote.administration", NativeAdministrationPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("ConnectionScanActivity"), "dev.mote.administration", NativeAdministrationPlugin.CAPABILITY),

        NativeComponentOwner("activity", component("StorageStatisticsActivity"), "dev.mote.storage-backup", StorageBackupPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("StorageActivity"), "dev.mote.storage-backup", StorageBackupPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("BackupActivity"), "dev.mote.storage-backup", StorageBackupPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("ActivityStatsActivity"), "dev.mote.storage-backup", StorageBackupPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("BulkDedupeActivity"), "dev.mote.storage-backup", StorageBackupPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("ImageDedupeDiagnosticsActivity"), "dev.mote.storage-backup", StorageBackupPlugin.CAPABILITY),

        NativeComponentOwner("activity", component("AppUpdatesActivity"), "dev.mote.system-tools", NativeSystemToolsPlugin.CAPABILITY),
        NativeComponentOwner("activity", component("LogViewerActivity"), "dev.mote.system-tools", NativeSystemToolsPlugin.CAPABILITY),
        NativeComponentOwner("receiver", component("AppUpdateResultReceiver"), "dev.mote.system-tools", NativeSystemToolsPlugin.CAPABILITY),
    )

    private fun component(name: String) = "dev.mote.collector.$name"

    /** Resolve the manifest spelling used by the APK (`.Name` or a full class
     * name) into the inventory spelling. */
    fun canonical(name: String): String = if (name.startsWith(".")) "dev.mote.collector$name" else name

    fun owner(kind: String, component: String): NativeComponentOwner? =
        componentOwners.firstOrNull { it.kind == kind && it.component == canonical(component) }

    /** Full reconciliation. A missing, duplicated or stale component is an
     * error, never a skipped row. */
    fun reconcile(manifestComponents: List<NativeManifestComponent>): List<String> {
        val errors = mutableListOf<String>()
        val seen = LinkedHashSet<String>()
        for (entry in manifestComponents) {
            val key = "${entry.kind}:${canonical(entry.name)}"
            if (!seen.add(key)) errors += "component declared twice: $key"
            val matches = componentOwners.filter { it.kind == entry.kind && it.component == canonical(entry.name) }
            when {
                entry.owner == null -> errors += "component has no plugin owner tag: $key"
                matches.isEmpty() -> errors += "component has no plugin owner: $key"
                matches.size > 1 -> errors += "component has more than one owner: $key"
                matches.single().packageId != entry.owner -> errors += "component owner tag ${entry.owner} does not match ${matches.single().packageId}: $key"
                matches.single().capability != null && packages.none { it.packageId == matches.single().packageId && matches.single().capability in it.capabilities } ->
                    errors += "component ${matches.single().packageId} capability is not declared by its package: $key"
            }
        }
        for (owner in componentOwners) {
            if ("${owner.kind}:${owner.component}" !in seen) errors += "inventory owner is missing from the manifest: ${owner.kind}:${owner.component}"
        }
        val packageIds = packages.map { it.packageId }
        if (packageIds.toSet().size != packageIds.size) errors += "duplicate default package id"
        val capabilities = packages.flatMap { it.capabilities }
        if (capabilities.toSet().size != capabilities.size) errors += "capability has more than one default owner"
        return errors
    }
}
