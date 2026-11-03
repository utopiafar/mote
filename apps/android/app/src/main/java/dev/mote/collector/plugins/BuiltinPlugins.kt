package dev.mote.collector.plugins

/** Build-native providers shipped in the APK. Each native plugin unit adds its
 * own provider file and one registration line here; the application bootstrap
 * only builds the host. */
fun NativePluginRegistry.registerBuiltinPlugins(buildId: String) {
    CapturePlugin.register(this, buildId)
    registerDurableTransport(buildId)
    SourceProviderPlugin.register(this, buildId)
    SystemEntriesPlugin.register(this, buildId)
    NotesPlugin.register(this, buildId)
    NativeAskPlugin.register(this, buildId)
    registerPluginCenter(buildId)
}
