package dev.mote.collector.plugins

/** Build-native providers shipped in the APK. Each native plugin unit adds its
 * own provider file and one registration line here; the application bootstrap
 * only builds the host. */
fun NativePluginRegistry.registerBuiltinPlugins(buildId: String) {
    register(NativePluginProvider("mote.capture.projection", "1", buildId = buildId, osGrants = listOf("projection")))
    register(NativePluginProvider("mote.capture.accessibility", "1", buildId = buildId, osGrants = listOf("accessibility")))
    registerDurableTransport(buildId)
    SystemEntriesPlugin.register(this, buildId)
    NotesPlugin.register(this, buildId)
    NativeLibraryPlugin.register(this, buildId)
    NativeAskPlugin.register(this, buildId)
    registerPluginCenter(buildId)
}
