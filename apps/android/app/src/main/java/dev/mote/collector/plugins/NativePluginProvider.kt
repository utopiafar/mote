package dev.mote.collector.plugins

/** Build-native provider descriptor for the Android host. Providers ship inside
 * the APK and register at startup; nothing arrives over the network. Matching
 * is exact (capability + apiVersion + platform), mirroring the shared U01
 * descriptor contract — a Kotlin projection of the same identity, not a second
 * manifest. */
data class NativePluginProvider(
    val capability: String,
    val apiVersion: String,
    val platform: String = "android",
    val buildId: String,
    val osGrants: List<String> = emptyList(),
)

/** A capability requirement a plugin manifest declares. */
data class NativeRequirement(val capability: String, val apiVersion: String)

/** Availability mirrors the shared contract vocabulary. */
enum class PluginAvailability { ACTIVE, UNAVAILABLE, REQUIRES_BUILD, UNSUPPORTED, REVOKED, WAITING_DEVICE }

class NativePluginRegistry(private val platform: String = "android") {
    private val providers = LinkedHashMap<String, NativePluginProvider>()

    fun register(provider: NativePluginProvider): NativePluginProvider {
        require(provider.platform == platform) { "provider platform ${provider.platform} cannot serve host $platform" }
        val key = "${provider.capability}@${provider.apiVersion}"
        require(!providers.containsKey(key)) { "native provider already registered: $key" }
        providers[key] = provider
        return provider
    }

    fun satisfies(requirement: NativeRequirement): Boolean =
        providers.values.any { it.capability == requirement.capability && it.apiVersion == requirement.apiVersion }

    fun availability(requirement: NativeRequirement): PluginAvailability =
        if (satisfies(requirement)) PluginAvailability.ACTIVE else PluginAvailability.REQUIRES_BUILD

    fun provider(capability: String, apiVersion: String): NativePluginProvider? = providers["$capability@$apiVersion"]
    fun list(): List<NativePluginProvider> = providers.values.toList()
}
