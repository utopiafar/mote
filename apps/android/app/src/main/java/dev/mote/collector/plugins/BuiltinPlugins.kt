package dev.mote.collector.plugins

/** Build-native providers shipped in the APK. Each native plugin unit adds its
 * own provider file and one registration line here; the application bootstrap
 * only builds the host. */
fun NativePluginRegistry.registerBuiltinPlugins(buildId: String) {
    CapturePlugin.register(this, buildId)
    registerDurableTransport(buildId)
    SourceProviderPlugin.register(this, buildId)
    StorageBackupPlugin.register(this, buildId)
    SystemEntriesPlugin.register(this, buildId)
    NotesPlugin.register(this, buildId)
    NativeLibraryPlugin.register(this, buildId)
    NativeAskPlugin.register(this, buildId)
    DailyHomePlugin.register(this, buildId)
    NativeWorkDiscoveryPlugin.register(this, buildId)
    ManagedCalendarPlugin.register(this, buildId)
    registerPluginCenter(buildId)
    NativeAdministrationPlugin.register(this, buildId)
    NativeSystemToolsPlugin.register(this, buildId)
    AssistantPlugin.register(this, buildId)
}
