package dev.mote.collector.plugins

/** Build-native position for the assistant domain. The package owns one
 * capability and no page yet: page/action cards add routes and components to
 * this package when their modules land. Registering the provider never starts
 * work or mounts a page. */
internal object AssistantPlugin {
    const val CAPABILITY = "mote.assistant"
    const val API_VERSION = "1"

    fun register(registry: NativePluginRegistry, buildId: String) {
        registry.register(NativePluginProvider(CAPABILITY, API_VERSION, buildId = buildId))
    }

    fun requirement() = NativeRequirement(CAPABILITY, API_VERSION)
}
